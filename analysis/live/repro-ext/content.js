const s = document.createElement("script");
s.src = chrome.runtime.getURL("injected.js");
document.documentElement.appendChild(s);
