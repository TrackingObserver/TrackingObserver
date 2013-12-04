"use strict";

/* CATEGORIES:
 *      A: analytics
 *      B: vanilla
 *      C: forced
 *      D: referred
 *      E: personal
 *      F: referred analytics
 */

// data storage format:
// domain -> array of Trackers
// each Tracker: {domain, referrer (if category C), time seen}
var sites = {};
var trackersPerTab = {};

// Temporary storage to keep track of category A candidates (per tab)
var analyticsCandidates = {};

// Keep track of history locally (for category E)
var hist_map = {};

// Keep track of blocked tracker domains
var blockedDomains = {};

// Keep track of blocked categories 
var blockedCategories = {};

// Keep track of trackers half-blocked (remove cookies only)
var removeCookieDomains = {};

// Need to keep track of tabs in a way that's synchronously accessible
// (so that decision to block a request or not doesn't get stuck on tab lookup)
var tabList = {};

// Keep track of registered add-ons
var registeredAddons = {}; // name --> link map


initialize();


/* ***
   INITIALIZATION FUNCTIONS.
   ***
 */

// Read in persistent data and set up all listeners.
function initialize() {

	var keys = ["sites", "histmap", "blocked", "registered", "removecookies", "blockedcat"];
	chrome.storage.local.get(keys, function(items) {
		var storageSites = items.sites;
		if (storageSites) {
			//console.log(storageSites);
			sites = JSON.parse(storageSites);
		}
        
		var historyMap = items.histmap;
		if (historyMap) {
            //console.log(historyMap);
            hist_map = JSON.parse(historyMap);
        }
        
        var blockedList = items.blocked;
        if (blockedList) {
            blockedDomains = JSON.parse(blockedList);
        }
        
        var registered = items.registered;
        if (registered) {
            registeredAddons = JSON.parse(registered);
        }
        
        var removeCookiesList = items.removecookies;
        if (removeCookiesList) {
            removeCookieDomains = JSON.parse(removeCookiesList);
        }
        
        var blockedCatList = items.blockedcat;
        if (blockedCatList) {
            blockedCategories = JSON.parse(blockedCatList);
        }
	});

	chrome.windows.onRemoved.addListener(saveSites);
    
    chrome.management.onUninstalled.addListener(handleUninstall);
    chrome.management.onDisabled.addListener(handleDisable);

	chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, {
	        urls: ["<all_urls>"]},
        	["blocking", "requestHeaders"]
	);

	chrome.history.onVisited.addListener(onHistoryItemVisited);
	chrome.history.onVisitRemoved.addListener(onHistoryItemRemoved);

	initializeCookieListeners();
	initializeTabListeners();
	initializeMessageListeners();
}

// Handle when another extension is uninstalled or disabled
function handleUninstall(id) {
    delete registeredAddons[id];
}

function handleDisable(info) {
    handleUninstall(info.id);
}

// Get more detail about the tab originating the HTTP request, and then call
// another function to continue.
function onBeforeSendHeaders(requestDetails) {
	var tabId = requestDetails.tabId;
    
    var tracker = false;
    
    // Only proceed if the request came from an open tab
    if (tabId >= 0) {
        // If there's a cookie, check for cookie tracking
        if (getValueFromDictionaryArray(requestDetails.requestHeaders, "Cookie")) {	
            tracker = checkTrackingForCookieRequest(requestDetails, tabList[tabId]);
        }
        
        // Either way, check for leak tracking
        tracker = checkTrackingForLeakRequest(requestDetails, tabList[tabId]);    
    }
    
    // Caution: this blocking is overly conservative because the checkTracking...() 
    // functions return true if they get far enough to have to make an async call (e.g.,
    // to look at cookies).
    
    var requestDomain = getDomainFromUrl(requestDetails.url);
    if (tracker)
    {
        if (blockedDomains[requestDomain]) {
            console.log("Canceling request to " + requestDetails.url);
            logBlockedTracker(requestDomain, tabId);
            
            // cancel request
            return {cancel: true};
        } 
        else if (removeCookieDomains[requestDomain]) {
            console.log("Removing cookie from request to " + requestDetails.url);
            // logBlockedTracker(requestDomain, tabId);
            // TODO: Is this correct? See note in logTracker()...
            
            // remove cookies from request
            for (var i = 0; i < requestDetails.requestHeaders.length; ++i) {
                if (requestDetails.requestHeaders[i].name === 'Cookie') {
                    requestDetails.requestHeaders.splice(i, 1);
                    break;
                }
            }
            return {requestHeaders: requestDetails.requestHeaders};
        }
    }
}

function initializeTabListeners() {

    chrome.tabs.onUpdated.addListener(
        function(tabId, changeInfo, tab) {
            tabList[tabId] = tab;
            
            // Also keep track of trackers on current tab
            // (reset this whenever tab loading starts to catch reloads
            // and switches to a new domain)
            if (changeInfo.status == "loading") {
            	trackersPerTab[tabId] = [];
                analyticsCandidates[tabId] = [];
            }
        }
    );

    chrome.tabs.onRemoved.addListener(
        function(tabId, removeInfo) {
            delete tabList[tabId];
            // Remove the tab Id and its current trackers
            delete trackersPerTab[tabId];
            delete analyticsCandidates[tabId];
        }
    );
}

function initializeCookieListeners() {

    // Since we're overwriting document.cookie by storing in a hidden div on pages, 
    // if a cookie is set via HTTP, we need to inject it back into the pages so document.cookie can read it
    chrome.cookies.onChanged.addListener( 
        function(changeInfo) {  
            // HTTP only cookies shouldn't be accessible by JavaScript!
            if (changeInfo.cookie.httpOnly) 
                return;
                
            // Need to find all tabs with domain matching cookie domain
            // (make sure to honor secure cookies)
            var queryDomain = changeInfo.cookie.domain;
            if (startsWith(queryDomain, ".")) {
                queryDomain = "*" + queryDomain;
            }
            var queryString = (changeInfo.cookie.secure ? "https://" : "*://")
                             + queryDomain + "/*";
    
            //console.log("querying with string: " + queryString);
            
            chrome.tabs.query({url: queryString},
                function(tabs) {
                    for (var i in tabs) {
                        //console.log("sending request to tab url " + tabs[i].url);
                        chrome.tabs.sendRequest(tabs[i].id,
                            {type: "cookie_onChanged", changeInfo: changeInfo});
                    }
                });
        });
}

function initializeMessageListeners() {

    // Listen for messages from the content script and popup pages
    chrome.extension.onRequest.addListener(
        function(request, sender, sendResponse) {
            if (request.type == "lookupCookies") {
                lookupCookies(request.url, sendResponse);
            }
            else if(request.type == "setCookie") {
                setCookie(request.url, request.cookieString);
            }
            else if(request.type == "categoryA") {
                // Check for a category A tracking situation
                var originatingTabUrl = request.url;
                var stackTrace = request.stackTrace;
                var cookieString = request.cookieString;

                var originatingTabDomain = getDomainFromUrl(originatingTabUrl);

                // It's a category A candidate if this cookie setting strack trace originates 
                // in a third-party script
                var cookieSetterUrl = stackTrace[stackTrace.length-1];
                var cookieSetterDomain = getDomainFromUrl(cookieSetterUrl);
	    
                if (cookieSetterDomain != originatingTabDomain) {                     
                    //parse out the cookie value
                    var cookieParts = cookieString.split(';');
                    var cookieName = cookieParts[0].split('=')[0];
                    var cookieVal = cookieParts[0].split('=')[1];
                    
                    if (!analyticsCandidates[sender.tab.id]) {
                        analyticsCandidates[sender.tab.id] = [];
                    }
                    analyticsCandidates[sender.tab.id].push({domain: cookieSetterDomain, cookieVal: cookieVal});
                    
                    //console.log("ANALYTICS CANDIDATE: " + cookieSetterDomain + " on " 
                    //            + originatingTabDomain + " with cookie value " + cookieVal);
                    
                }
            }
            else if(request.type == "clearData") {
                clearData();
            }
            else if(request.type == "getRegisteredAddons") {
                sendResponse(registeredAddons);
            }
            else if(request.type == "getTrackers") {
                getTrackers(sendResponse);
            }
            else if(request.type == "getTrackersOnCurrentTab") {
                getTrackersOnCurrentTab(sendResponse);
            }
            else if(request.type == "getTrackersBySite") {
                getTrackersBySite(sendResponse);
            }
            else if(request.type == "browseAutomatically") {
                browseAutomatically(request.urls, request.loadtime, request.visits, sendResponse);
            }
            else if(request.type == "blockTrackerDomain") {
                blockTrackerDomain(request.domain);
            }
            else if(request.type == "unblockTrackerDomain") {
                unblockTrackerDomain(request.domain);
            }
            else if(request.type == "removeCookiesForTrackerDomain") {
                removeCookiesForTrackerDomain(request.domain);
            }
            else if(request.type == "stopRemoveCookiesForTrackerDomain") {
                stopRemoveCookiesForTrackerDomain(request.domain);
            }
            else if(request.type == "trackerDomainBlocked") {
                trackerDomainBlocked(request.domain, sendResponse);
            }
            else if (request.type == "blockCategory"){
                blockCategory(request.category);
                return true;
            }
            else if (request.type == "unblockCategory"){
                unblockCategory(request.category);
                return true;
            }
            else if(request.type == "getBlockedDomains") {
                sendResponse(getBlockedDomains());
                return true;
            }
            else if (request.type == "getBlockedCategories"){
                sendResponse(getBlockedCategories());
                return true;
            }
            else if (request.type == "getRemoveCookieDomains") {
                sendResponse(getRemoveCookieDomains());
                return true;
            }
        }
    );
    
    // Listen for messages from other extensions
    // (Expose public APIs here)
    chrome.runtime.onMessageExternal.addListener(
        function(request, sender, sendResponse) {
            if (request.type == "registerAddon") {
                console.log("registering: " + "chrome-extension://" + sender.id + "/" + request.link);
                registeredAddons[sender.id] = {};
                registeredAddons[sender.id].name = request.name;
                if (request.link) {
                    registeredAddons[sender.id].link = "chrome-extension://" + sender.id + "/" + request.link;
                }
                return true;
            }
            else if(request.type == "getTrackers") {
                getTrackers(sendResponse);
                return true;
            }
            else if(request.type == "getTrackersOnCurrentTab") {
                getTrackersOnCurrentTab(sendResponse);
                return true;
            }
            else if(request.type == "getTrackersBySite") {
                getTrackersBySite(sendResponse);
                return true;
            }
            else if(request.type == "browseAutomatically") {
                browseAutomatically(request.urls, request.loadtime, request.visits, sendResponse);
                return true;
            }
            else if(request.type == "blockTrackerDomain") {
                blockTrackerDomain(request.domain);
                return true;
            }
            else if(request.type == "unblockTrackerDomain") {
                unblockTrackerDomain(request.domain);
                return true;
            }
            else if(request.type == "removeCookiesForTrackerDomain") {
                removeCookiesForTrackerDomain(request.domain);
                return true;
            }
            else if(request.type == "stopRemoveCookiesForTrackerDomain") {
                stopRemoveCookiesForTrackerDomain(request.domain);
                return true;
            }
            else if(request.type == "trackerDomainBlocked") {
                trackerDomainBlocked(request.domain, sendResponse);
                return true;
            }
            else if(request.type == "getBlockedDomains") {
                sendResponse(getBlockedDomains());
                return true;
            }
            else if (request.type == "blockCategory"){
                blockCategory(request.category);
                return true;
            }
            else if (request.type == "unblockCategory"){
                unblockCategory(request.category);
                return true;
            }
            else if (request.type == "getBlockedCategories"){
                sendResponse(getBlockedCategories());
                return true;
            }
            else if (request.type == "getRemoveCookieDomains"){
                sendResponse(getRemoveCookieDomains());
                return true;
            }
        }
    );

}



/* ***
   ACTUAL MEASUREMENT FUNCTIONS.
   ***
 */
	
// There is tracking behavior that involves leaking the referrer's cookie
function checkTrackingForLeakRequest(requestDetails, tab) {
    if(!tab) return false;
    
    var originatingTabUrl = tab.url;
	var requestUrl = requestDetails.url;
	var httpReferrer = getValueFromDictionaryArray(
			requestDetails.requestHeaders, "Referer");
            
    // If the originating tab is an extension or chrome page, skip it.
    if (startsWith(originatingTabUrl, "chrome"))
        return false;
	
	// extract domains from the URLs
	var originatingTabDomain = getDomainFromUrl(originatingTabUrl);
	var requestDomain = getDomainFromUrl(requestUrl);
    
    var possibleCookieLeakDomain = httpReferrer ? getDomainFromUrl(httpReferrer) : getDomainFromUrl(originatingTabUrl);
    
    // Get all the cookies for that domain and see if
    // any of their values are being leaked in the current request
    chrome.cookies.getAll({"domain": possibleCookieLeakDomain}, function(cookies) {
            for (var i in cookies) {
                var value = cookies[i].value;
                
                if (requestUrl.indexOf(value) != -1) {
                    // Exclude some stupid ones
                    if (value != "www" && value != "true" && value != "false" && value != "id" && value != "ID"
                        && value != "us" && value != "US" && value != "en_US" && value != "en_us" && value != "all" 
                        && value != "undefined" && value.length > 3) {
                        
                        //console.log("found a leak from " + possibleCookieLeakDomain + ": " + value + " ... to " + requestDomain);
                        
                        // Decide if this is category A (page to tracker) or category D (referred)
                        if (httpReferrer && possibleCookieLeakDomain != originatingTabDomain) {
                            
                            if (possibleCookieLeakDomain == requestDomain) 
                                return; // tracker is referring to itself, skip it
                        
                            // The referrer is itself a tracker, so category D
                            var httpReferrerDomain = getDomainFromUrl(httpReferrer);
                            /*console.log("Category D tracker (referred)\n" +
                                "\tOrigin: " + originatingTabDomain + "\n" + 
                                "\tRequest: " + requestDomain + "\n" + 
                                "\tReferrer: " + httpReferrerDomain);*/
                            logTracker(originatingTabDomain, requestDomain, 'D', tab.id, httpReferrerDomain);
                        } else if (requestDomain != originatingTabDomain) {
                            // Need to check for the pre-existing category A or F condition
                            var candidates = analyticsCandidates[tab.id];
                            
                            var found = false;
                            
                            for (var i in candidates) {
                                var candidate = candidates[i];
                                // candidate = {domain, cookieVal}
                            
                                // See if it's category A (value was set by same domain as leaked to)
                                if (candidate.domain == requestDomain
                                    && candidate.cookieVal.indexOf(value) != -1) {
                                    /*console.log("Category A confirmed (analytics)\n" +
                                        "\tOrigin: " + originatingTabDomain + "\n" +
                                        "\tCookieSetter: " + requestDomain +
                                        "\n\tCookieVal: " + value);*/
                                    logTracker(originatingTabDomain, requestDomain, 'A', tab.id);
                                    found = true;
                                }
                                else if (candidate.cookieVal.indexOf(value) != -1) {
                                    /*console.log("Category F confirmed (referred-analytics)\n" +
                                        "\tOrigin: " + originatingTabDomain + "\n" +
                                        "\tCookieSetter: " + candidate.domain +
                                        "\n\tLeaked to: " + requestDomain +
                                        "\n\tCookieVal: " + value);*/
                                    logTracker(originatingTabDomain, requestDomain, 'F', tab.id, candidate.domain);
                                    found = true;
                                }
                            }
                            
                            if (!found) {
                                // Else it's just a leak of first-party cookie
                                //console.log("PLAIN COOKIE LEAK FROM " + originatingTabDomain + " TO " + requestDomain + " with value " + value);
                            }
                            
                        }
                    }
                }

            }
    
        });
        
        // Can't wait for async call so return true if it's a third-party request
        if (requestDomain != originatingTabDomain && originatingTabDomain != "chrome://newtab/") {
            return true;
        }
        else 
        {
            return false;
        }
}

// Check for tracking behavior that involves the tracker having a cookie set
// TODO: Clean up this function
function checkTrackingForCookieRequest(requestDetails, tab) {
	if(!tab) return false;

	var originatingTabUrl = tab.url;
	var requestUrl = requestDetails.url;
	var httpReferrer = getValueFromDictionaryArray(
			requestDetails.requestHeaders, "Referer");
            
    // If the originating tab is an extension or chrome page, skip it.
    if (startsWith(originatingTabUrl, "chrome"))
        return false;
	
	// extract domains from the URLs
	var originatingTabDomain = getDomainFromUrl(originatingTabUrl);
	var requestDomain = getDomainFromUrl(requestUrl);
	
	if (httpReferrer) { // a referrer exists
		var httpReferrerDomain = getDomainFromUrl(httpReferrer)

		if (originatingTabDomain !== requestDomain) {
        
			// We definitely have a tracking situation on our heads,
			// check for category E (personal) first
			if (hist_map[requestDomain] ) {
				/*console.log("Category E tracker (personal)\n" +
						"\tOrigin: " + originatingTabDomain + "\n" +
						"\tRequest: " + requestDomain + "\n" +
						"\tReferrer: " + httpReferrerDomain);*/
				logTracker(originatingTabDomain, requestDomain, 'E', tab.id);
				return true;
			}
            
            // Else check for B or C
            chrome.windows.get(tab.windowId, function(window) {
				var popup = (window.type === "popup");
				
				if (popup) {
					/*console.log("Category C tracker (from a popup)\n" +
							"\tOrigin: " + originatingTabDomain + "\n" + 
							"\tRequest: " + requestDomain + "\n" + 
							"\tReferrer: " + httpReferrerDomain);*/
					logTracker(originatingTabDomain, requestDomain, 'C', tab.id);
				}
				else { // request not from a popup, log as category B
					/*console.log("Category B tracker (vanilla)\n" +
							"\tOrigin: " + originatingTabDomain + "\n" + 
							"\tRequest: " + requestDomain + "\n" + 
							"\tReferrer: " + httpReferrerDomain);*/
					logTracker(originatingTabDomain, requestDomain, 'B', tab.id);
				}
			});	
            
            return true;
            
            // Note: We'll never see a D here... if something has a cookie, it's B, C, or E
		}
	} else if (originatingTabDomain !== requestDomain) { // category B tracker found (originating page, no referrer)

		// Check for cateogry E
		if (hist_map[requestDomain] ) {
            /*console.log("Category E tracker (personal)\n" +
                        "\tOrigin: " + originatingTabDomain + "\n" +
                        "\tRequest: " + requestDomain + "\n" +
                        "\tReferrer: NO REFERER");*/
            logTracker(originatingTabDomain, requestDomain, 'E', tab.id);
            return true;
        }

		/*console.log("Category B tracker (vanilla)\n" +
				"\tOrigin: " + originatingTabDomain + "\n" + 
				"\tRequest: " + requestDomain + "\n" + 
				"\tReferrer: NO REFERER");*/
		logTracker(originatingTabDomain, requestDomain, 'B', tab.id);
        return true;
	}
}




/* ***
   FUNCTIONS FOR HANDLING HISTORY.
   ***
 */

// Need to keep track of history manually because Chrome's API doesn't expose
// a good function to do that... don't want to look through all history items on each request.
function onHistoryItemVisited(historyItem) {
	var historyDomain = getDomainFromUrl(historyItem.url);
	hist_map[historyDomain] = true;
}

// Need to respect user's history/privacy.
// This function is inefficient, presumably it's not called often (only when user clears history).
function onHistoryItemRemoved(removed) {
	if (removed.allHistory) {
		hist_map = {};
		sites = {};
		return;
	}

	// Need to look through all history to see if this domain is entirely gone...
	chrome.history.search({
            'text': '',
            'maxResults': 1000000000,
            'startTime': 0
            },
	    function(results) {
	    // Are there any instances of this domain left in the history?
		for (var i in removed.urls) {
			var found = false;
			var historyDomain = getDomainFromUrl(removed.urls[i]);
			for (var j in results) {
				var itemDomain = getDomainFromUrl(results[j].url);
				if (itemDomain === historyDomain) {
					found = true;
					break;
				} 
			}
			if (!found) {
                // User has deleted all instances of this domain from history
				delete hist_map[historyDomain];
				delete sites[historyDomain];
                
                // If this tracker was tagged as category E (personal) anytime,
                // need to downgrade those instances to category B (vanilla)
                for (var siteDomain in sites) {        
                    var trackerList = sites[siteDomain];
                    
                    for (var i in trackerList) {
                        var trackerData = trackerList[i];
                        
                        if (trackerData.domain == historyDomain
                            && trackerData.category == "E") {
                            //downgrade
                            trackerData.category = "B";
                            //console.log("DOWNGRADING " + historyDomain);
                        }
                    }
                }
            }
		}
    });
}




/* ***
   HELPER FUNCTIONS.
   ***
 */
 
function startsWith(str1, str2) {
    return (str1.match("^"+str2)==str2);
}

// Get domain (drop subdomains)
function getDomainFromUrl(fullUrl) {
    if (fullUrl.indexOf("//") != -1) {
        fullUrl = fullUrl.split('//')[1];
    }
    fullUrl = fullUrl.split('/')[0];
    var split = fullUrl.split('.');

    // Because googleusercontent and amazonaws domains are used to host websites that
    // are actually separate, we don't want to conflate all URLs on these domains.
    if (split[split.length-2] == "googleusercontent" || split[split.length-2] == "amazonaws") {
        return fullUrl;
    }

    // Hacky custom handling for 3-part domains.
    var domain = split[split.length-2] + '.' + split[split.length-1];
    if (split[split.length-2] == "co" || split[split.length-2] == "com" || split[split.length-2] == "ne") {
        domain = split[split.length-3] + '.' + split[split.length-2] + '.' + split[split.length-1];
    }
    if (split[split.length-2] == "go" && split.length > 2) {
        // Don't conflate espn.go.com and abcnews.go.com 
        domain = split[split.length-3] + '.' + split[split.length-2] + '.' + split[split.length-1];
    }
    return domain;    
}

function getValueFromDictionaryArray(array, key) {
	for (var i = 0; i < array.length; i += 1) {
		var item = array[i];
		
		if (item.name === key)
			return item.value;
	}
	
	return null; // key not found in array
}



/* ***
   PERSISTENT STORAGE FUNCTIONS.
   ***
 */
 
function logBlockedTracker(trackerDomain, tabId) {
    var trackerData = {
        domain: trackerDomain,
		category: ''
    };
    
    // Don't store it in the trackerList, just store it on the tab
    // so tab info can reflect that tracking was attempted
    if (!trackersPerTab[tabId]) {
		trackersPerTab[tabId] = [];
	}
    trackersPerTab[tabId].push(trackerData);    
}

function logTracker(originatingTabDomain, trackerDomain, trackerCategory, tabId, trackerReferrer) {
    // If we're going to remove the cookie, don't actually log it...
    //if (removeCookieDomains[trackerDomain]) return;
    
    // TODO: The above is questionable... request still allows tracking, just not cookie-based ... 
    // So, removing for now, and tabInfo should visualize this properly itself (e.g., by checking
    // to see if cookies were removed from domains that are reported blocked)
    
	var trackerData = {
		domain: trackerDomain,
		category: trackerCategory,
		//date: JSON.stringify(new Date())
	};

	if (trackerCategory === 'D' || trackerCategory === 'F') {
		trackerData.referrer = trackerReferrer;
        trackerData.domain = trackerDomain + "-referredby-" + trackerReferrer;
    }
	
    if(blockedCategories[trackerCategory])
    {
        blockTrackerDomain(trackerDomain);
    }
    
	var trackerList;
	if (!sites[originatingTabDomain]) {
		trackerList = new Array();
		sites[originatingTabDomain] = trackerList;
	} else {
		trackerList = sites[originatingTabDomain];
	}
	
	trackerList.push(trackerData);
   
    // Also keep track per tab
	if (!trackersPerTab[tabId]) {
		trackersPerTab[tabId] = [];
	}
    trackersPerTab[tabId].push(trackerData);

	// Notify registered extensions about tracking on this page
    for (var addon in registeredAddons) {
        chrome.runtime.sendMessage(addon, 
            {type: "trackingNotification", tabId: tabId, domain: trackerDomain},
            function(response) {}
        );
    }
	//chrome.browserAction.setBadgeText({text: "track", tabId: tabId});
    
    saveSites();
}

// Save to local storage
function saveSites() {
	chrome.storage.local.set({"sites": JSON.stringify(sites)}, function() { /*console.log("sites saved");*/ } );
	chrome.storage.local.set({"histmap": JSON.stringify(hist_map)}, function() { /*console.log("histmap saved");*/ } );
    chrome.storage.local.set({"blocked": JSON.stringify(blockedDomains)}, function() {} );
    chrome.storage.local.set({"registered": JSON.stringify(registeredAddons)}, function() {} );
    chrome.storage.local.set({"removecookies": JSON.stringify(removeCookieDomains)}, function() {} );
    chrome.storage.local.set({"blockedcat": JSON.stringify(blockedCategories)}, function() {} );
}

function clearData() {
    sites = {};
    hist_map = {};
    trackersPerTab = {};
    analyticsCandidates = {};
    blockedDomains = {};
    removeCookieDomains = {};
    blockedCategories = {};
    //registeredAddons = {};
    saveSites(); // Don't wait for browser to close to save this
}




/* ***
   API FUNCTIONS.
   For use by Graph, RawData, and other apps.
   ***
 */
 

// Returns a map of blocked domains
function getBlockedDomains() {
    return blockedDomains;
}

// Returns a boolean list of blocked categories
function getBlockedCategories() {
    return blockedCategories;
}

// Returns a map of domains for which to remove cookies (not fully block)
function getRemoveCookieDomains() {
    return removeCookieDomains;
}

// Blocks entire category of trackers
function blockCategory(category) {
    for (var siteDomain in sites) {
        
        var trackerList = sites[siteDomain];
        
        for (var i in trackerList) {
            var tracker = trackerList[i];
            //console.log(tracker.category);
            if (tracker.category == category)
            {
                blockTrackerDomain(tracker.domain);
                //console.log("blocked tracker" +tracker);
            }
        }
    }
    //console.log("Blocking Category "+category);
    blockedCategories[category]=true;
}

// Unblocks entire category of trackers
function unblockCategory(category) {
    for (var siteDomain in sites) {
        
        var trackerList = sites[siteDomain];
        
        for (var i in trackerList) {
            var tracker = trackerList[i];
            //console.log(tracker.category);
            if (tracker.category == category)
            {
                unblockTrackerDomain(tracker.domain);
                //console.log("unblocked tracker" +tracker);
            }
        }
    }
    //console.log("Unblocking Category "+category);
    blockedCategories[category]=false;
}
// Check if a tracker is blocked
function trackerDomainBlocked(domain, sendResponse) {
    if(domain.indexOf("-referredby-") != -1) {
        domain = domain.split("-referredby-")[0];
    }
    sendResponse( {blocked : blockedDomains[domain]} );
}
 
// Add tracker domain to block list
function blockTrackerDomain(domain) {
    //console.log("blocking domain " + domain);
    if(domain.indexOf("-referredby-") != -1) {
        domain = domain.split("-referredby-")[0];
    }
    //console.log("blocking domain " + domain);
    blockedDomains[domain] = true;
}

// Remove tracker domain from block list
function unblockTrackerDomain(domain) {
    //console.log("unblocking domain " + domain);
    if(domain.indexOf("-referredby-") != -1) {
        domain = domain.split("-referredby-")[0];
    }
    blockedDomains[domain] = false;
}
            
// Start removing cookies from requests to tracker domain
function removeCookiesForTrackerDomain(domain) {
    if(domain.indexOf("-referredby-") != -1) {
        domain = domain.split("-referredby-")[0];
    }
    removeCookieDomains[domain] = true;
}

// Stop removing cookies from requests to tracker domain
function stopRemoveCookiesForTrackerDomain(domain) {
    if(domain.indexOf("-referredby-") != -1) {
        domain = domain.split("-referredby-")[0];
    }
    removeCookieDomains[domain] = false;
}

// Retrieve the tracker list in raw data form, to process with own parsing.
function getTrackersRaw() {
    return sites;
}

// Retrieves the list of trackers on the current tab
function getTrackersOnCurrentTab(sendResponse) {
	chrome.tabs.query({active: true}, function(results) {
        var tabId = results[0].id;
        var trackerList = trackersPerTab[tabId];
		var trackerMap = null;

		if (trackerList && trackerList.length > 0) {
			// Remove duplicates
			trackerMap = {};
			for (var i in trackerList) {
				var tracker = trackerList[i];
				var domain = tracker.domain;
				if (!trackerMap[domain]) {
					trackerMap[domain] = [];
				}
				if (trackerMap[domain].indexOf(tracker.category) == -1) {
					trackerMap[domain].push(tracker.category);
                    trackerMap[domain].sort();
				}
			}
		}
    
    		if (sendResponse) {
			sendResponse(trackerMap); 
		} else {
			return trackerMap;
		}
    });
}

// Returns a map of pages to a map of tracker domain->categories
function getTrackersBySite(sendResponse) {
	var siteMap = {}

	for (var siteDomain in sites) {        
        // sites contains multiple instances per tracker per site, 
        // need to reduce to one per site
        var trackerMap = {};
        
        var trackerList = sites[siteDomain];
        for (var i in trackerList)
        {
            var trackerDomain = trackerList[i].domain;
            var catList = trackerMap[trackerDomain];
            if (!catList) {
                catList = [];
            }
            if (catList.indexOf(trackerList[i].category) == -1) {
                catList.push(trackerList[i].category);
                catList.sort();
            }
            trackerMap[trackerDomain] = catList;
        }
        
        siteMap[siteDomain] = trackerMap;

	}

	if (sendResponse) {
		sendResponse(siteMap);
	} else {
		return siteMap;
	}
}

// Returns a map of tracker domains to objects containing {[list of categories], [list of site domains]}
function getTrackers(sendResponse) {
    var trackers = {};
    
    // First loop through sites map and reorganize by tracker
    for (var siteDomain in sites) {
    
        var trackerList = sites[siteDomain];
        
        for (var i in trackerList) {
            var internalTrackerObject = trackerList[i];
            
            // Have we already seen this tracker?
            var trackerObject = trackers[internalTrackerObject.domain];
            if (!trackerObject) { 
                // Nope, so need to make a new object
                trackerObject = {};
                trackerObject.domain = internalTrackerObject.domain;
                trackerObject.categoryList = [];
                trackerObject.trackedSites = [];
                
                trackers[internalTrackerObject.domain] = trackerObject;
            }
            
            // Set category/ies (keep if we've seen)
            if (trackerObject.categoryList.indexOf(internalTrackerObject.category) == -1) {
                trackerObject.categoryList.push(internalTrackerObject.category);
                trackerObject.categoryList.sort();
            }
            
            // Add the siteDomain to the list of tracked sites
            if (trackerObject.trackedSites.indexOf(siteDomain) == -1) {
                trackerObject.trackedSites.push(siteDomain);
            }
        } // end trackerList for
        
    } // end sites for

    //console.log(JSON.stringify(trackers));
    
    if (sendResponse) {
        sendResponse(trackers);
    } else {
    	return trackers;
    }
}


// Functions to browse automatically
// urls: list of URLs to visit
// loadTime: how long to wait before loading the next page
// linkNum: number of links on each page in the url list to visit
function browseAutomatically(urls, loadTime, linkNum, sendResponse) {
	if (!urls) {
		sendResponse("Must provide URL file.");
		return;
	}
    
    clearData();
    
    chrome.tabs.create({url: "about:blank"}, function(tab) {            
            setTimeout(function() { browseToNext(urls, urls.length, 
                                    0, loadTime, linkNum, tab.id, sendResponse); }, 1000);
        });
}

// Helper function called recursively during automated measurement
function browseToNext(urls, originalListLength, index, loadTime, linkNum, tabId, sendResponse) {    
    // Select linkNum random links on the previously loaded page to add to the URL list
    // (as long as we're still considering URLs on the original list)
    if (index > 0 && index <= originalListLength && linkNum > 0) {
        // Need to ask the content script to do find URLs
        chrome.tabs.sendRequest(tabId, {type: "getlinks", linkNum: linkNum}, function (response) {
                if(response) {
			urls = urls.concat(response.urls);
                } 
		setUpBrowseToNext(urls, originalListLength, index, loadTime, linkNum, tabId, sendResponse);
            });
    } else {
        setUpBrowseToNext(urls, originalListLength, index, loadTime, linkNum, tabId, sendResponse)
    }
    
}

function setUpBrowseToNext(urls, originalListLength, index, loadTime, linkNum, tabId, sendResponse) {
    if (index >= urls.length || !urls[index]) {
        sendResponse("");
        return;
    }
    
    // Remove the last tab
    chrome.tabs.remove(tabId);
    
    // Navigate to the next URL in the list (in a new tab)
    var newurl = urls[index];
    if (!startsWith(newurl, "http")) {
        newurl = "http://" + urls[index];
    }
    chrome.tabs.create({url: newurl}, function(tab) {
            // Let it load for the specified number of seconds before continuing
            setTimeout(function() {browseToNext(urls, originalListLength, index+1, 
                                        loadTime, linkNum, tab.id, sendResponse); }, 
                    loadTime * 1000);
        });
}



/* ***
   COOKIE INTERPOSITION FUNCTIONS.
   Needed to help the content script re-implement document.cookie
   (thanks to this chrome bug: https://code.google.com/p/chromium/issues/detail?id=13175 )
   ***
 */


function lookupCookies(url, sendResponse) {
    
    chrome.cookies.getAll({"url": url}, function(cookies) {
    
        var cookieMap = {};
    
        // Need to be sure to exclude httpOnly cookies, 
        // as well as cookies that are marked secure if this is not an https page
        for (var i in cookies) {
            var cookie = cookies[i];
            if (!cookie.isHttpOnly
                && !(cookie.secure && !startsWith(url, "https"))) {
            
                cookieMap[cookie.name] = cookie.value;
            }
        }
        
        sendResponse(cookieMap);
    });
}

// Actually set the cookie in the internal cookie store
// (given the string provided to document.cookie's setter)
// See: http://developer.chrome.com/extensions/cookies.html#type-Cookie
function setCookie(url, cookieString) {
    var cookie = {};
    cookie.url = url;
    
    var cookieParts = cookieString.split(';'); 
    for (var i in cookieParts) {
        var part = cookieParts[i];
        var key = part.split('=')[0].trim();
        
        if (key.length == 0) continue;

        // secure doesn't have a value part
        if(key.toLowerCase() == "secure")
        {
            cookie.secure = true;
            continue;
        }
        
        // Everything else will have a value part
        var value = part.split('=')[1].trim();
        
        // First one is cookie name/value
        if (i == 0)
        {
            cookie.name = key;
            cookie.value = value;
            continue;
        }
        
        // Expires is special because need to transform to
        // different object key name, and to seconds since unix eposh
        if (key.toLowerCase() == "expires")
        {
            cookie.expirationDate = (new Date(value)).getTime() / 1000;
        }
        // All others just use key as object key and value as value
        else
        {
            cookie[key.toLowerCase()] = value;
        }
    }
    
    chrome.cookies.set(cookie);
    
}



