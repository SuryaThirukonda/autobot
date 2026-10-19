// autobot background service worker: hotkey and popup relay, profile seeding. No network access, no remote config.
const sendToTab = async (tabId, msg) => {
  try { return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }); } catch (e) { return { ok: false, error: e.message }; }
};

// Seed the profile once from the bundled, git-ignored configs/profile.default.json when storage has none. The file is
// read here, from the extension's own origin, so it never has to be web-accessible to pages.
const seedProfile = async () => {
  try {
    const { profile } = await chrome.storage.local.get("profile");
    if (profile && (profile.first_name || profile.email)) return false;
    const r = await fetch(chrome.runtime.getURL("configs/profile.default.json"));
    if (!r.ok) return false;
    const p = await r.json();
    if (!p || typeof p !== "object" || !(p.first_name || p.email)) return false;
    // Re-check: never overwrite a profile written while the file was being read.
    const now = (await chrome.storage.local.get("profile")).profile;
    if (now && (now.first_name || now.email)) return false;
    await chrome.storage.local.set({ profile: p, profileSeededFrom: "configs/profile.default.json" });
    return true;
  } catch { return false; }
};

const ENGINE_FILES = ["engine/util.js", "engine/xpath.js", "engine/profile.js", "engine/detect.js", "engine/heuristics.js", "engine/writer.js", "engine/search.js", "engine/search-widgets.js", "engine/plan.js", "engine/panel.js", "content.js"];
const injectInto = async (tabId) => {
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ENGINE_FILES }); } catch (e) { console.warn("inject failed", e.message); }
};
// Relay to the tab's content script; inject it first when the tab predates the extension (re)load.
const relay = async (tabId, msg) => {
  let r = await sendToTab(tabId, msg);
  if (r && r.ok === false && /Receiving end does not exist/.test(r.error || "")) { await injectInto(tabId); r = await sendToTab(tabId, msg); }
  return r;
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "trigger-autofill") return;
  const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t?.id) return;
  await seedProfile();
  const { settings } = await chrome.storage.local.get("settings");
  await relay(t.id, { type: "autobot:fill", continuous: Boolean(settings?.continuous) });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "bg:fill": {
        await seedProfile();
        return relay(msg.tabId ?? sender.tab?.id, { type: "autobot:fill", continuous: Boolean(msg.continuous) });
      }
      case "bg:detect": return relay(msg.tabId, { type: "autobot:detect" });
      case "bg:stop": return sendToTab(msg.tabId, { type: "autobot:stop" });
      case "bg:seedProfile": return seedProfile();
      case "bg:openOptions": chrome.runtime.openOptionsPage(); return true;
      default: return null;
    }
  })().then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await seedProfile();
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { seedProfile(); });
