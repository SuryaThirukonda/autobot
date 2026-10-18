const $ = (s) => document.querySelector(s);
const status = (t) => ($("#status").textContent = t);
let tabId = null;

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const { settings = {} } = await chrome.storage.local.get("settings");
  $("#continuous").checked = Boolean(settings.continuous);
  if (!tabId) return status("No active tab.");
  const d = await chrome.runtime.sendMessage({ type: "bg:detect", tabId });
  if (d && d.id) status(`${d.name || d.id} detected (${d.matchedBy}).`);
  else if (d === null) status("No application form detected. Fill will try heuristics anyway.");
  else status("Page not ready (reload the tab).");
})();

$("#fill").onclick = async () => {
  status("Filling…");
  const r = await chrome.runtime.sendMessage({ type: "bg:fill", tabId, continuous: $("#continuous").checked });
  status(r?.ok ? `Done: ${r.filled} field group(s) written. Review before submitting.` : `Not filled: ${r?.reason || r?.error || "unknown"}`);
};
$("#stop").onclick = () => chrome.runtime.sendMessage({ type: "bg:stop", tabId }).then(() => status("Stopped."));
$("#options").onclick = () => chrome.runtime.openOptionsPage();
$("#continuous").onchange = async (e) => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, continuous: e.target.checked } });
};
