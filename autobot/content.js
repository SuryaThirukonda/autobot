// Autobot content script entry (isolated world). Wires messages, detection, panel and the fill engine.
(() => {
  const AB = globalThis.AB;
  if (AB.__booted) return;
  AB.__booted = true;
  let aborter = null;
  let detected = null;

  const detect = async () => {
    const configs = await AB.loadConfigs();
    detected = AB.detectATS(configs);
    if (!detected && AB.looksLikeForm()) detected = { config: configs.find((c) => c.id === "generic"), matchedBy: "heuristic" };
    return detected;
  };

  const runFill = async ({ continuous = false } = {}) => {
    const d = detected || (await detect());
    const { profile, resume, settings } = await AB.loadProfile();
    AB.debug = Boolean(settings.debug);
    const common = { fill: () => runFill(), stop, settings: openSettings, profile, resume, ats: d?.config.name || d?.config.id, matchedBy: d?.matchedBy, next: () => d && AB.advance(d.config) };
    if (!d) { AB.panel.show({ ...common, subtitle: "No application form detected on this page." }); return { ok: false, reason: "no-form" }; }
    if (!profile.first_name && !profile.email) {
      AB.panel.show({ ...common, subtitle: "Your profile is empty. Open settings (⚙) to fill it in first." });
      return { ok: false, reason: "no-profile" };
    }
    aborter?.abort();
    aborter = new AbortController();
    AB.panel.show({ ...common, subtitle: `Filling ${d.config.name || d.config.id} form…` });
    AB.panel.clear();
    AB.panel.busy(true);
    const statuses = [];
    const onStatus = (k, s, det) => { statuses.push([k, s, String(det ?? "").slice(0, 80)]); AB.panel.status(k, s, det); };
    const res = await AB.fill({ config: d.config, profile, resume, settings, signal: aborter.signal, onStatus });
    res.statuses = statuses;
    res.ats = d.config.id;
    AB.panel.busy(false);
    AB.panel.subtitle(`${res.filled} field group(s) written. Review every field, then submit yourself.`);
    if (continuous && d.config.continue && !aborter.signal.aborted) {
      // Fill subsequent pages: click continue, wait for new form content, fill again (bounded).
      for (let i = 0; i < 6 && !aborter.signal.aborted; i++) {
        const submitVisible = AB.queryAny(d.config.submit || [], document);
        if (submitVisible) break;
        if (!(await AB.advance(d.config))) break;
        await AB.sleep(800);
        await AB.fill({ config: d.config, profile, resume, settings, signal: aborter.signal, onStatus: (k, s, det) => AB.panel.status(`p${i + 2}:${k}`, s, det) });
      }
    }
    return { ok: true, ...res };
  };
  const stop = () => { aborter?.abort(); AB.panel.busy(false); AB.panel.subtitle("Stopped."); };
  const openSettings = () => chrome.runtime.sendMessage({ type: "bg:openOptions" }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "autobot:fill") { runFill({ continuous: Boolean(msg.continuous) }).then(sendResponse); return true; }
    if (msg?.type === "autobot:detect") { detect().then((d) => sendResponse(d ? { id: d.config.id, name: d.config.name, matchedBy: d.matchedBy } : null)); return true; }
    if (msg?.type === "autobot:stop") { stop(); sendResponse(true); return false; }
    if (msg?.type === "autobot:status") { sendResponse({ booted: true, detected: detected ? detected.config.id : null, top: window === window.top }); return false; }
    return false;
  });

  // Test hooks (opt-in via settings.testHooks): window.postMessage({__autobot:"cmd", type:"fill"}) triggers a fill,
  // and the result is published on <html data-autobot-done="{json}">. Detection is published on data-autobot-detected.
  const installTestHooks = async () => {
    const { settings } = await AB.loadProfile();
    if (!settings.testHooks) return;
    window.addEventListener("message", async (ev) => {
      if (ev.source !== window || ev.data?.__autobot !== "cmd") return;
      if (ev.data.type === "fill") {
        const r = await runFill({ continuous: Boolean(ev.data.continuous) });
        document.documentElement.dataset.autobotDone = JSON.stringify(r);
      }
      if (ev.data.type === "stop") stop();
    });
    document.documentElement.dataset.autobotReady = "1";
  };

  // Passive detection on load (top frame only shows the panel hint when a known ATS is present).
  const boot = async () => {
    const d = await detect();
    document.documentElement.dataset.autobotDetected = d ? d.config.id : "";
    await installTestHooks();
    if (d && d.matchedBy !== "heuristic" && window === window.top) {
      const { profile, resume, settings } = await AB.loadProfile();
      if (settings.showPanel !== false) AB.panel.show({ subtitle: `${d.config.name} application detected. Press Autofill or Alt+Shift+A.`, fill: () => runFill(), stop, settings: openSettings, next: () => AB.advance(d.config), ats: d.config.name, matchedBy: d.matchedBy, profile, resume });
      if (settings.autoFill) runFill();
    }
  };
  if (document.readyState === "complete") boot(); else window.addEventListener("load", boot, { once: true });

  // Re-detect on SPA navigations.
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; detected = null; boot(); } }, 1000);
})();
