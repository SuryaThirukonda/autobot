// Autobot engine: shared utilities (isolated world).
// All engine files share one global object `AB`.
var AB = globalThis.AB || (globalThis.AB = {});

AB.VERSION = "0.2.0";
AB.log = (...a) => { if (AB.debug) console.debug("[autobot]", ...a); };
AB.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
AB.arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

// Normalize text for matching: lowercase, strip punctuation/required markers, collapse spaces.
AB.norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(new RegExp("[\\u2019\\u2018\\u201b\\u02bc\\u00b4`]", "g"), "'")
    .replace(/[*∗＊]/g, " ")
    .replace(/\(required\)|\(optional\)|required|optional/g, " ")
    .replace(new RegExp("[/:_\\-,.;()?!&\\u00a0\\u2002\\u2003\\u2009\\u2028\\u202f\\u3000\\u200b\\u200c\\u200d\\u2060\\ufeff\"'\\[\\]{}<>|+=~^$%#@]", "g"), " ")
    .replace(/\s+/g, " ")
    .trim();

// Chrome match-pattern style glob ("*://*.host.com/path*") to RegExp. "**" allowed anywhere.
AB.globToRegExp = (glob) => {
  let g = glob.replace(/\*\*/g, "*");
  const esc = g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$", "i");
};
AB.urlMatches = (patterns, url) => AB.arr(patterns).some((p) => AB.globToRegExp(p).test(url));

AB.isVisible = (el) => {
  if (!(el instanceof Element)) return false;
  if (el.closest("[hidden]")) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  // Inputs inside collapsed custom widgets are often 1x1 or 0x0 but still the real control.
  if (r.width === 0 && r.height === 0 && el.tagName !== "INPUT") return false;
  return true;
};

AB.textOf = (el) => (el ? AB.norm(el.innerText || el.textContent) : "");

// Deterministic best-match of a wanted value against a list of option labels.
// Returns index or -1. Exact > exact-normalized > synonym > startsWith > contains > token overlap.
AB.bestOption = (wanted, labels, synonyms) => {
  const wants = AB.arr(wanted).map(String);
  const nl = labels.map(AB.norm);
  const tryEach = (fn) => {
    for (const w of wants) {
      const nw = AB.norm(w);
      if (!nw) continue;
      for (let i = 0; i < nl.length; i++) if (fn(nw, nl[i], w, labels[i])) return i;
    }
    return -1;
  };
  let i = tryEach((nw, l, w, raw) => raw === w);
  if (i < 0) i = tryEach((nw, l) => nw === l);
  if (i < 0 && synonyms) {
    for (const w of wants) {
      const alts = synonyms[AB.norm(w)] || synonyms[w];
      if (!alts) continue;
      for (const a of AB.arr(alts)) {
        const na = AB.norm(a);
        const j = nl.findIndex((l) => l === na);
        if (j >= 0) return j;
      }
    }
  }
  if (i < 0) i = tryEach((nw, l) => l.startsWith(nw) || nw.startsWith(l));
  if (i < 0) i = tryEach((nw, l) => l.includes(nw) || nw.includes(l));
  if (i < 0) {
    // token overlap: all wanted tokens present in label
    i = tryEach((nw, l) => {
      const toks = nw.split(" ").filter((t) => t.length > 2);
      return toks.length > 0 && toks.every((t) => l.includes(t));
    });
  }
  return i;
};

// Shared yes/no vocabulary used by selects, radios and heuristics.
AB.YES = ["yes", "y", "true", "i am", "i do", "authorized", "eligible", "agree", "accept"];
AB.NO = ["no", "n", "false", "i am not", "i do not", "not authorized", "decline", "do not"];
AB.boolToYesNo = (v) => (v === true || v === "true" || v === "yes" ? "Yes" : v === false || v === "false" || v === "no" ? "No" : v);
// A question answered yes or no opens with an auxiliary verb and its subject ("Are you currently enrolled ...?", "Do you
// have ...?", "Will you require ...?"). Questions that ask for a name open otherwise ("Which school ...?", "School").
AB.isYesNoQuestion = (label) => /^(?:\d+ )?(?:are|is|am|was|were|do|does|did|have|has|had|will|would|can|could|should|may) (?:you|your|we|it|this|that|there|the|any|a|an|i)\b/.test(AB.norm(label));
