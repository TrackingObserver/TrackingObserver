"use strict";

/*
 * This content script does two things:
 * (1) finds links on a page for the automated browsing/measurement functionality
 * (2) does category A (analytics tracking) detection by overwriting  document.cookie 
*      (and helping reimplement it, since Chrome returns null for __lookupSetter__ ...
 *     https://code.google.com/p/chromium/issues/detail?id=13175 )
 */


// Listen for any update messages from the background script. 
chrome.extension.onRequest.addListener(
    function(request, sender, sendResponse){  
    
        // If cookies are updated via HTTP, background script will inform this page
        // (need to update it locally to be accessible via JavaScript)
        if(request.type == "cookie_onChanged") {
            // Double check that the domain is correct
            // (tab could have been redirected in the meantime
            var cookieDomain = request.changeInfo.cookie.domain;
            
            // Either the domains are the same, or the cookie domain is a suffic of the document domain
            if (cookieDomain.toLowerCase() == document.domain.toLowerCase()
                || document.domain.indexOf(cookieDomain) == (document.domain.length - cookieDomain.length)) {
                
                addOrUpdateCookie(request.changeInfo.cookie.name, request.changeInfo.cookie.value, request.changeInfo.removed);
            }
        }
        
        // Request for linkNum links in this document
        if(request.type == "getlinks") {
            var links = document.links;
            var urls = [];
            if (links.length > 0) {
                var tried_links = [];
                var num_tried = 0;
                for (var x = 0; x < links.length; x++) {
                    tried_links[x] = false;
                }
                for (var x = 0; x < request.linkNum; x++) {
                    var i = Math.floor(Math.random()*links.length);
                    while (tried_links[i]) {
                        i = Math.floor(Math.random()*links.length);
                    }
                    tried_links[i] = true;

                    var link = links[i];
                    if (!badLink(link)) {
                        urls.push(link.href);
                    } else {
                        x--; // This was a bad one
                    }
                    
                    num_tried++;
                    if (num_tried == links.length) {
                        break;
                    }
                }
                sendResponse({urls: urls});            
            }
        }    
    }
);


// Helper function for link finding
// Returns true if link is to a non-web document time    
function badLink(linkelem) {
    var link = linkelem.href;
    if (link.indexOf(".pdf") != -1 
        || link.indexOf(".exe") != -1 
        || link.indexOf(".doc") != -1
        || link.indexOf(".ppt") != -1 
        || link.indexOf(".pptx") != -1
        || link.indexOf(".docx") != -1 
        || link.indexOf(".xls") != -1 
        || link.indexOf(".xlsx") != -1) {
        return true;
    }
    return false;
}

// Parse a cookie string and then add it to the in-page cookie store
function addOrUpdateCookieFromString(cookieString)
{
    var cookieParts = cookieString.split(";");
    var cookieName = cookieParts[0].split("=")[0];
    var cookieValue = cookieParts[0].split("=")[1];
    addOrUpdateCookie(cookieName, cookieValue, false);
}
    
// Add a cookie to the in-page cookie store
function addOrUpdateCookie(cookieName, cookieValue, remove)
{    
    var cookieStoreDiv = document.getElementById("cookieStore");
    var cookieStore = JSON.parse(cookieStoreDiv.innerText);
    
    if (!remove) {
        cookieStore[cookieName] = cookieValue;
    } 
    else {
        delete cookieStore[cookieName];
    }
        
    cookieStoreDiv.innerText = JSON.stringify(cookieStore);
}

// Inspects the call stack, and notifies the background script of a possible category A tracking situation.
function inspectStack(cookieString) {
  var callstack = [];
  var uri_pattern = /\b((?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?������]))/ig;

  var isCallstackPopulated = false;
  try {
    i.dont.exist += 0; // Will cause exception
  } catch(e) {
      var urls = e.stack.match(uri_pattern);
      
      chrome.extension.sendRequest(
          {type:'categoryA', url : document.URL, stackTrace : urls, cookieString: cookieString});
  }

}


// Monkeypatch document.cookie
// (a real pain due to the above referenced Chrome bug... need to send updated
// cookies to background script to actually set them in Chrome's cookie store,
// and need to keep current cookies in page to make them accessible via JavaScript)

var monkeypatchCookieCode = 
    // Create a cookie store to help replace document.cookie's getter
    'var cookieStoreDiv = document.createElement("div");' +
    'cookieStoreDiv.setAttribute("id","cookieStore");' +
    'document.documentElement.appendChild(cookieStoreDiv);' +
    'cookieStoreDiv.style.display = "none";' +
    'cookieStoreDiv.innerText = "{}";' +
    
    // Event to notify background script when a cookie is set using document.cookie's setter
    'function createEvent(cookieString) { ' + 
        'document.dispatchEvent( new CustomEvent("setCookieEvent", {detail: {cookieString : cookieString}})); }'+
    
    // Actually overwrite document.cookie
    // On set, create event to notify background script
    'document.__defineSetter__("cookie", function(cookieString) { createEvent(cookieString); } );' +
    // On get, parse in-page cookie store into expected string
    'document.__defineGetter__("cookie", function() {' + 
            'var cookieStore = JSON.parse(cookieStoreDiv.innerText);' +
            'var cookieString = "";' +
            'for (var cookieName in cookieStore) {' +
                'cookieString += cookieName + "=" + cookieStore[cookieName];' +
                'cookieString += ";";' +
            '}' +
            // remove last semicolon
            'cookieString = cookieString.substring(0, cookieString.length - 1);' +
            'return cookieString;' +
        '} ); ';


// THIS CODE RUNS WHEN PAGE LOADS: 

// Actually inject the code
var scriptDiv = document.createElement('script');
scriptDiv.appendChild(document.createTextNode(monkeypatchCookieCode));
(document.head || document.documentElement).appendChild(scriptDiv);
scriptDiv.parentNode.removeChild(scriptDiv);

// First things first: Look up cookies that are already set (so they're available to JavaScript)
chrome.extension.sendRequest({type : 'lookupCookies', url : document.URL}, 
    function(cookieMap) {
        var cookieStoreDiv = document.getElementById("cookieStore");
        cookieStoreDiv.innerText = JSON.stringify(cookieMap);
    });

// Event that fires when document.cookie's setter is called.
// Send message to background script to actually set the cookie.
document.addEventListener('setCookieEvent', 
    function(e) {
        // Store cookie in in-page cookie store
        addOrUpdateCookieFromString(e.detail.cookieString);
        // Inspect stack for categoryA trackers
        inspectStack(e.detail.cookieString);
        
        chrome.extension.sendRequest(
            {type:'setCookie', url : document.URL, cookieString:e.detail.cookieString});
    
    });
