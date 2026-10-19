// Autobot engine: config loading and ATS detection (URL globs, then DOM probes).
var AB = globalThis.AB || (globalThis.AB = {});

AB.CONFIG_FILES = ["greenhouse", "lever", "ashby", "workday", "generic"];

AB.loadConfigs = async () => {
  if (AB._configs) return AB._configs;
  const out = [];
  for (const name of AB.CONFIG_FILES) {
    try {
      const r = await fetch(chrome.runtime.getURL(`configs/${name}.json`));
      const cfg = await r.json();
      cfg.id = cfg.id || name;
      out.push(cfg);
    } catch (e) { AB.log("config load failed", name, e); }
  }
  // user overrides (same grammar) stored under settings.configOverrides: { id: {...partial} }
  const { settings } = await AB.loadProfile();
  for (const [id, patch] of Object.entries(settings.configOverrides || {})) {
    const i = out.findIndex((c) => c.id === id);
    if (i >= 0) out[i] = { ...out[i], ...patch };
    else out.push({ id, ...patch });
  }
  AB._configs = out;
  return out;
};

// Returns { config, matchedBy } or null. Generic config never matches by URL; it is the fallback.
AB.detectATS = (configs, url = location.href) => {
  for (const c of configs) {
    if (c.id === "generic") continue;
    if (c.urls && AB.urlMatches(c.urls, url) && !(c.urlsExcluded && AB.urlMatches(c.urlsExcluded, url))) {
      if (c.probesExcluded && c.probesExcluded.some((g) => AB.arr(g).every((x) => AB.xpathBool(x)))) continue;
      return { config: c, matchedBy: "url" };
    }
  }
  for (const c of configs) {
    if (c.id === "generic" || !c.probes) continue;
    if (c.probes.some((g) => AB.arr(g).every((x) => AB.xpathBool(x)))) return { config: c, matchedBy: "dom-probe" };
  }
  return null;
};

// Is there anything that looks like an application form here at all?
AB.looksLikeForm = () => {
  const n = document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [role=combobox], [contenteditable=true]'
  ).length;
  return n >= 3;
};

AB.findContainer = (config) => {
  const el = config?.container ? AB.queryAny(config.container) : null;
  return el || document.body;
};
