// Autobot background service worker: hotkey + popup relay. No network access, no remote config.
const sendToTab = async (tabId, msg) => {
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); } catch (e) { return { ok: false, error: e.message }; }
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "trigger-autofill") return;
  const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t?.id) return;
  const { settings } = await chrome.storage.local.get("settings");
  const r = await sendToTab(t.id, { type: "autobot:fill", continuous: Boolean(settings?.continuous) });
  if (r && r.ok === false && /Receiving end does not exist/.test(r.error || "")) {
    // Content script not injected yet (page loaded before install): inject and retry.
    await injectInto(t.id);
    await sendToTab(t.id, { type: "autobot:fill", continuous: Boolean(settings?.continuous) });
  }
});

const ENGINE_FILES = ["engine/util.js", "engine/xpath.js", "engine/profile.js", "engine/detect.js", "engine/heuristics.js", "engine/writer.js", "engine/plan.js", "engine/panel.js", "content.js"];
const injectInto = async (tabId) => {
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ENGINE_FILES }); } catch (e) { console.warn("inject failed", e.message); }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "bg:fill": {
        const tabId = msg.tabId ?? sender.tab?.id;
        let r = await sendToTab(tabId, { type: "autobot:fill", continuous: Boolean(msg.continuous) });
        if (r && r.ok === false && /Receiving end does not exist/.test(r.error || "")) { await injectInto(tabId); r = await sendToTab(tabId, { type: "autobot:fill", continuous: Boolean(msg.continuous) }); }
        return r;
      }
      case "bg:detect": {
        let r = await sendToTab(msg.tabId, { type: "autobot:detect" });
        if (r && r.ok === false) { await injectInto(msg.tabId); r = await sendToTab(msg.tabId, { type: "autobot:detect" }); }
        return r;
      }
      case "bg:stop": return sendToTab(msg.tabId, { type: "autobot:stop" });
      case "bg:openOptions": chrome.runtime.openOptionsPage(); return true;
      default: return null;
    }
  })().then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
