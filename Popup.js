// JavaScript associated with popup page

document.addEventListener('DOMContentLoaded', function () {
    chrome.extension.sendRequest({type : 'getRegisteredAddons'},
        function(addonMap) {
            createHtmlForAddons(addonMap);
    });

	var button = document.getElementById("clearbutton");
	button.addEventListener('click', function() {
		chrome.extension.sendRequest({type: 'clearData'});
        location.reload(true);
	});
});

function createHtmlForAddons(addonMap) {
    var html = "<b>Installed Add-Ons:</b><br>";
    
    for (addon in addonMap) {
        if (addonMap[addon].link) {
            html += "<a href='" + addonMap[addon].link 
                    + "' >" + addonMap[addon].name + "</a><br>";
        }
    }

    if (html == "<b>Installed Add-Ons:</b><br>") {
        html = "(Add-Ons will appear here if any are installed.)";
    }

    var navDiv = document.getElementById("navbar");
    navDiv.innerHTML = html;
    
    // Make the links actually work... (Chrome bug? used to work w/o this)
    var links = document.getElementsByTagName("a");
    for (var i = 0; i < links.length; i++) {
        (function () {
            var ln = links[i];
            var location = ln.href;
            ln.onclick = function () {
                chrome.tabs.create({active: true, url: location});
            };
        })();
    }
}