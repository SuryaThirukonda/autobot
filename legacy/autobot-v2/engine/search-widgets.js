// Autobot engine: DOM adapters for AB.search.run (capture candidates after typing a query, commit one, verify).
//
// Mechanics follow Jobright Autofill 1.24.1's client-search capture/commit code (evidence: docs/SEARCH-REA.md):
//  - a per-control generation token; a newer capture or a *trusted* user event (keydown/input/change/click/
//    pointerdown/pointerup on the control, trigger, container or search box) invalidates the older generation
//    (iCIMS client-search-widget; RippleHire/Kula use the same generation idea)
//  - type the query (one character at a time, as iCIMS' shipped-but-unreferenced DOM capture does; RippleHire and
//    Kula write it in one burst), then wait for the results container to change from its open-state baseline, stop
//    loading, show options or a "no results" row, and hold still (iCIMS: 3 equal polls; Kula: 2 equal 200 ms
//    snapshots; RippleHire: 100 ms stable)
//  - candidates are {value, text}, deduplicated by the pair, at most 25; creatable "Add …" rows are excluded (Kula)
//  - commit requires exactly one option whose text equals the candidate, clicks it, then polls a stable readback;
//    on failure the control is restored to its pre-search value (RippleHire clearTemporaryValue)
// In the shipped build iCIMS itself fetches candidates from the site's /jobs/profileoptions in the main world and
// never types; autobot does not copy that and reads only what the widget renders.
// Timings are longer than Jobright's iCIMS constants because generic typeaheads debounce and fetch remotely;
// they are listed in AB.search.TIMING.
var AB = globalThis.AB || (globalThis.AB = {});
AB.search = AB.search || {};
(() => {
  const S = AB.search;
  S.TIMING = Object.freeze({ poll: 25, stablePolls: 6, openWait: 800, captureWindow: 4500, commitVisibleWait: 2500, readbackWindow: 900, readbackStable: 60, unchangedGrace: 700, irrelevantGrace: 1500, bridgeRetypeAfter: 450 });

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    const t = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
  const visible = (el) => (AB.isVisible ? AB.isVisible(el) : !!el);
  const NO_RESULTS = /^(no (results?|options?|matches?|matching|items?|records?|data)( found)?|nothing found|0 results|no suggestions?|not found|no .* found|type to search)\.?$/i;
  const LOADING = /^(loading|searching|please wait)\b/i;
  // Creatable / free-text entries ("Add \"X\"", "Create X", "Use X", Kula's "Add and select") are never candidates.
  const CREATABLE = /^(?:add|create|use|enter)\b\s*(?:new\s+)?[:"“'‘«]|^(?:add|create)\s+".*"$|\badd and select\b|^\+\s*add\b/i;
  const PLACEHOLDER = /^(?:[-—–]\s*)?(?:make a selection|please select(?: an option)?|select(?: one| an option)?|choose(?: an option| one)?|--+|none)(?:\s*[-—–])?$/i;

  // ---------- generations ----------
  const tokens = new WeakMap();      // control -> counter
  const guards = new WeakMap();      // control -> { token, cleanup }
  const nextToken = (ctrl) => { guards.get(ctrl)?.cleanup(); guards.delete(ctrl); const t = (tokens.get(ctrl) ?? 0) + 1; tokens.set(ctrl, t); return t; };
  const isCurrent = (gen) => tokens.get(gen.control) === gen.token && !gen.invalidated;
  const release = (gen) => { const g = guards.get(gen.control); if (g?.token === gen.token) { g.cleanup(); guards.delete(gen.control); } };
  const armInvalidation = (gen, nodes) => {
    const onEv = (ev) => { if (ev.isTrusted) { gen.invalidated = true; release(gen); } };
    const types = ["keydown", "input", "change", "click", "pointerdown", "pointerup"];
    const list = new Set();
    // The guard can grow: the listbox, popup and popup search box are only known after the widget opens.
    gen.guard = (more) => { for (const n of more) if (n && !list.has(n)) { list.add(n); for (const t of types) n.addEventListener(t, onEv, true); } };
    gen.guard(nodes);
    guards.set(gen.control, { token: gen.token, cleanup: () => { for (const n of list) for (const t of types) n.removeEventListener(t, onEv, true); list.clear(); } });
  };
  const extendGuard = (gen, nodes) => { if (isCurrent(gen) && gen.guard) gen.guard(nodes.filter(Boolean)); };
  S.discardGeneration = (gen) => { if (gen) { gen.invalidated = true; release(gen); } };

  // ---------- typing ----------
  const protoSet = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d?.set) d.set.call(el, v); else el.value = v;
  };
  const kb = (el, type, key) => el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key }));
  // Per-run record of the text inputs autobot typed into: their value before the run and the value autobot left.
  // restore() only puts back a value that is still exactly what autobot typed (never the user's own edits).
  const runs = new WeakMap();   // control -> { pre: Map(input -> value), typed: Map(input -> value) }
  const beginRun = (control, inputs) => { const r = { pre: new Map(), typed: new Map() }; for (const n of inputs) if (n) r.pre.set(n, n.value); runs.set(control, r); return r; };
  const restoreOwned = (control) => {
    const r = runs.get(control);
    if (!r) return;
    for (const [n, typed] of r.typed) {
      if (!n.isConnected || n.value !== typed || !r.pre.has(n) || n.value === r.pre.get(n)) continue;
      protoSet(n, r.pre.get(n));
      n.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, inputType: "deleteContentBackward" }));
      n.dispatchEvent(new Event("change", { bubbles: true }));
    }
    runs.delete(control);
  };
  S.typeQuery = (input, text, control) => {
    const run = control ? runs.get(control) : null;
    if (run && !run.pre.has(input)) run.pre.set(input, input.value);
    input.focus();
    protoSet(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, inputType: "deleteContentBackward" }));
    let acc = "";
    for (const ch of String(text)) {
      kb(input, "keydown", ch);
      kb(input, "keypress", ch);
      protoSet(input, (acc += ch));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: ch }));
      kb(input, "keyup", ch);
    }
    input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    if (run) run.typed.set(input, input.value);
  };
  const isReact = (el) => Object.keys(el).some((k) => /^__react(Props|Fiber|EventHandlers)\$/.test(k));
  const mouse = (el, names = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) => {
    for (const n of names) {
      const Ctor = n.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(n, { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }));
    }
  };

  // ---------- generic capture loop ----------
  // readState() -> { loading: bool, noResults: bool, options: [{el, value, text}] }; signature over value/text.
  const sig = (state) => JSON.stringify({ n: state.noResults, o: state.options.map((o) => [o.value, o.text]) });
  const dedupe = (opts) => {
    const out = [], seen = new Set();
    for (const o of opts) {
      if (!o.text || NO_RESULTS.test(o.text) || LOADING.test(o.text) || CREATABLE.test(o.text)) continue;
      const k = JSON.stringify([o.value, o.text]);
      if (seen.has(k)) continue;
      seen.add(k); out.push(o);
      if (out.length >= S.LIMITS.maxOptions) break;
    }
    return out;
  };
  // Does any option share a distinctive (non-stop, >= 3 chars) token with the query?
  const relevant = (opts, query, fieldType) => {
    const generic = S.GENERIC?.[fieldType] || new Set();
    const all = AB.search.tokens(query).filter((t) => t.length >= 3);
    const q = all.filter((t) => !generic.has(t)).length ? all.filter((t) => !generic.has(t)) : all;
    if (!q.length) return true;
    return opts.some((o) => { const t = AB.search.tokens(o.text); return q.some((w) => t.some((x) => x.startsWith(w) || w.startsWith(x) && x.length >= 3)); });
  };
  const lastSig = new WeakMap();   // control -> signature of the last accepted capture
  const settle = async ({ gen, readState, open, act, signal, window: windowMs = S.TIMING.captureWindow }) => {
    // Open first and take the baseline from the open state, so a default list shown on open is not mistaken
    // for search results (Jobright's iCIMS capture opens the dropdown before snapshotting it).
    if (open) {
      await open();
      let last = null, same = 0;
      const until = Date.now() + 600;
      while (Date.now() <= until && same < 3) { const g = sig(readState()); same = g === last ? same + 1 : 0; last = g; await sleep(S.TIMING.poll, signal); }
    }
    const baseline = sig(readState());
    // The previous round's list still showing is never "results" for the new query.
    const baselineIsPrevious = lastSig.get(gen.control) === baseline;
    let changed = false, sawLoading = false;
    {
      // Poll while act() runs (it may wait before a main-world retype): loading or list transitions that happen
      // during that wait still count as "changed". Results are accepted only once act() has finished.
      const actAt = Date.now();
      let actDone = false, actErr = null;
      const actP = Promise.resolve().then(act).catch((e) => { actErr = e; }).finally(() => { actDone = true; });
      const deadline = actAt + windowMs;
      let last = "", stable = 0;
      while (Date.now() <= deadline) {
        if (actDone && actErr) throw actErr;
        if (!isCurrent(gen)) { await actP; return { status: "invalidated" }; }
        const st = readState();
        const s = sig(st);
        if (s !== baseline) changed = true;
        if (st.loading) sawLoading = true;
        if (!actDone || st.loading) { stable = 0; await sleep(S.TIMING.poll, signal); continue; }
        // Jobright only accepts a container that changed after typing. Autobot also accepts an unchanged, non-empty
        // list after a grace period, for widgets whose list already matched the query before typing.
        const unchangedOk = !changed && !baselineIsPrevious && st.options.length > 0 && Date.now() - actAt >= S.TIMING.unchangedGrace && relevant(st.options, gen.query, gen.fieldType);
        if (!st.options.length && !(changed && st.noResults)) { stable = 0; await sleep(S.TIMING.poll, signal); continue; }
        if (!changed && !unchangedOk) { stable = 0; await sleep(S.TIMING.poll, signal); continue; }
        // A list that shares no distinctive word with the query is usually the widget's default list shown on
        // focus while the real search is still in flight: give the search time before accepting it.
        if (st.options.length && !relevant(st.options, gen.query, gen.fieldType) && Date.now() - actAt < S.TIMING.irrelevantGrace) { stable = 0; await sleep(S.TIMING.poll, signal); continue; }
        if (s === last) stable++; else { last = s; stable = 1; }
        if (stable >= S.TIMING.stablePolls) {
          lastSig.set(gen.control, s);
          gen.candidates = dedupe(st.options);
          return { status: gen.candidates.length ? "ready" : "no-results", generation: gen };
        }
        await sleep(S.TIMING.poll, signal);
      }
      await actP;
      return { status: changed || sawLoading ? "timeout" : "stale" };
    }
  };

  // Readback with a stability window (Jobright: value must stay equal for >= 50 ms within 500 ms).
  const stableTrue = async (pred, signal, windowMs = S.TIMING.readbackWindow) => {
    const deadline = Date.now() + windowMs;
    let since = null;
    while (Date.now() <= deadline) {
      let ok = false;
      try { ok = Boolean(pred()); } catch { ok = false; }
      if (ok) { since ??= Date.now(); if (Date.now() - since >= S.TIMING.readbackStable) return true; } else since = null;
      await sleep(10, signal);
    }
    return false;
  };

  // ---------- option discovery (ARIA + common libraries) ----------
  const OPTION_SEL = [
    "[role=option]",
    "[class*='select__option']", "[class*='-option']:not([class*='-options'])",
    ".select2-results__option", ".chosen-results li", ".selectize-dropdown .option", ".ts-dropdown .option",
    "[data-automation-id='promptOption']", "[data-automation-id='menuItem']",
    ".pac-item", ".autocomplete-suggestion", ".ui-menu-item", ".tt-suggestion", ".typeahead li", ".suggestions li",
  ].join(", ");
  const LIST_SEL = "[role=listbox], [class*='select__menu'], [class*='-menu'], .select2-results, .chosen-results, .selectize-dropdown, .ts-dropdown, .pac-container, .autocomplete-suggestions, .ui-autocomplete, .tt-menu, [class*='suggest'], [class*='autocomplete'], [class*='dropdown-menu'], [class*='results']";
  const optionValue = (el) => {
    for (const a of ["data-value", "data-selected-value", "data-id", "value", "aria-value", "data-option-value", "dropdown-value"]) { const v = clean(el.getAttribute?.(a)); if (v) return v; }
    return clean(el.innerText || el.textContent);
  };
  const optionText = (el) => clean(el.getAttribute?.("aria-label") && !clean(el.innerText || el.textContent) ? el.getAttribute("aria-label") : el.innerText || el.textContent);

  S.findListbox = (input) => {
    const doc = input.ownerDocument || document;
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of clean(input.getAttribute(attr)).split(" ").filter(Boolean)) { const n = doc.getElementById(id); if (n?.isConnected) return n; }
    }
    const act = input.getAttribute("aria-activedescendant");
    if (act) { const n = doc.getElementById(act); const lb = n?.closest("[role=listbox]"); if (lb) return lb; }
    // Jobright's autocomplete-listbox fallback: a unique listbox whose aria-label equals the input's aria-label.
    const al = clean(input.getAttribute("aria-label")).toLowerCase();
    if (al) { const m = Array.from(doc.querySelectorAll("[role=listbox]")).filter((l) => clean(l.getAttribute("aria-label")).toLowerCase() === al); if (m.length === 1) return m[0]; }
    return null;
  };
  // Options near the control: its listbox when known, else option-like nodes in the nearest field wrapper, else
  // visible floating menus (react-select portals, select2 dropdowns appended to body). Also returns the zones that
  // were searched, so "no results" / loading detection stays inside the widget instead of scanning the page.
  const FIELD_SEL = "[class*='field'], [class*='form-group'], [class*='question'], [class*='select'], [class*='combobox'], [class*='autocomplete'], [class*='typeahead'], li, fieldset";
  const MAX_NODES = 500;
  const discover = (input, scope, optionsPath) => {
    const doc = input.ownerDocument || document;
    let nodes = [], zones = [];
    if (optionsPath && AB.queryAny) { nodes = AB.queryAny(optionsPath, doc, true); zones = Array.from(new Set(nodes.map((n) => n.closest(LIST_SEL) || n.parentElement).filter(Boolean))); }
    const lb = scope || S.findListbox(input);
    if (!nodes.length && lb) { nodes = Array.from(lb.querySelectorAll(OPTION_SEL)); if (lb.matches?.("[role=option]")) nodes.push(lb); zones = [lb]; }
    const wrap = input.closest(FIELD_SEL) || input.parentElement;
    if (!nodes.length && !lb && wrap) { nodes = Array.from(wrap.querySelectorAll(OPTION_SEL)); if (nodes.length) zones = [wrap]; }
    if (!nodes.length && !lb) {
      const lists = Array.from(doc.querySelectorAll(LIST_SEL)).filter((l) => !l.closest("[data-autobot-panel]") && visible(l)).slice(0, 12);
      for (const l of lists) for (const o of l.querySelectorAll(OPTION_SEL)) { nodes.push(o); if (nodes.length > MAX_NODES) break; }
      zones = lists;
    }
    if (wrap && !zones.includes(wrap)) zones.push(wrap);
    nodes = Array.from(new Set(nodes)).slice(0, MAX_NODES).filter((n) => visible(n) && !n.closest("[data-autobot-panel]") && n.getAttribute("aria-disabled") !== "true" && !/\bdisabled\b/.test(n.className || ""));
    // Drop group headers that contain other options (one pass over ancestors).
    const set = new Set(nodes), parents = new Set();
    for (const n of nodes) for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) parents.add(p);
    nodes = nodes.filter((n) => !parents.has(n));
    return { options: nodes.map((el) => ({ el, value: optionValue(el), text: optionText(el) })), zones };
  };
  const readOptions = (input, scope, optionsPath) => discover(input, scope, optionsPath).options;
  const LOADING_SEL = "[aria-busy=true], [class*='loading']:not([class*='hide']), [class*='spinner'], .select2-results__option.loading-results";
  // Short leaf texts inside the zones only (no page-wide div scan).
  const zoneFlags = (zones) => {
    let noResults = false, loading = false, seen = 0;
    for (const z of zones) {
      const w = (z.ownerDocument || document).createTreeWalker(z, NodeFilter.SHOW_ELEMENT);
      for (let n = z; n && seen < 1500; n = w.nextNode(), seen++) {
        if (n.childElementCount > 1) continue;
        const t = clean(n.textContent);
        if (!t || t.length >= 60) continue;
        const nr = NO_RESULTS.test(t), ld = !nr && LOADING.test(t);
        if ((nr || ld) && visible(n)) { if (nr) noResults = true; else loading = true; }
      }
      if (!loading) loading = Array.from(z.querySelectorAll(LOADING_SEL)).some((n) => visible(n)) || (z.matches?.(LOADING_SEL) && visible(z));
    }
    return { noResults, loading };
  };
  const containerState = (input, scope, optionsPath) => {
    const { options, zones } = discover(input, scope, optionsPath);
    const opts = options.filter((o) => !NO_RESULTS.test(o.text) && !LOADING.test(o.text));
    const f = zoneFlags(zones);
    const noResults = f.noResults && !opts.length;
    // A visible "no results" row wins over a stale spinner elsewhere in the widget.
    return { loading: f.loading && !opts.length && !noResults, noResults, options: opts };
  };
  const ownerControl = (el) => el.closest("[role=combobox], [class*='select__control'], [class*='select__container']") || el;

  // ---------- adapters ----------
  const adapters = {};

  // Native <select>: the "search" filters option labels locally; no typing needed.
  adapters.nativeSelect = {
    name: "native-select",
    match: (el) => el instanceof HTMLSelectElement && !el.multiple,
    capture: async (el, query) => {
      const gen = { control: el, token: nextToken(el), query, candidates: [], invalidated: false, kind: "native-select" };
      armInvalidation(gen, [el]);
      const q = AB.search.tokens(query);
      const opts = Array.from(el.options).filter((o) => !o.disabled && !PLACEHOLDER.test(clean(o.text)) && clean(o.text));
      const hit = (o) => { const t = AB.search.tokens(o.text); return q.length && q.every((w) => t.some((x) => x === w || (w.length >= 3 && x.startsWith(w)))); };
      gen.candidates = dedupe(opts.filter(hit).map((o) => ({ el: o, value: clean(o.value) || clean(o.text), text: clean(o.text) })));
      return { status: gen.candidates.length ? "ready" : "no-results", generation: gen };
    },
    commit: async (gen, cand, signal) => { try { return await nativeCommit(gen, cand, signal); } finally { release(gen); } },
    snapshot: (el) => ({ index: el.selectedIndex, value: el.value }),
    restore: (el, snap) => {
      if (!snap || el.selectedIndex === snap.index) return;
      el.selectedIndex = snap.index;
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    },
  };
  const nativeCommit = async (gen, cand, signal) => {
      const el = gen.control;
      if (!isCurrent(gen)) return false;
      const opt = Array.from(el.options).filter((o) => (clean(o.value) || clean(o.text)) === cand.value && clean(o.text) === cand.text);
      if (opt.length !== 1) return false;
      el.focus();
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      try { d?.set?.call(el, opt[0].value); } catch { el.value = opt[0].value; }
      if (el.value !== opt[0].value) opt[0].selected = true;
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      // select2 / chosen / iCIMS mirror the native select through jQuery change handlers.
      if (el.nextElementSibling && /select2|chosen|dropdown|selectize|ts-wrapper/i.test(el.nextElementSibling.className + " " + el.nextElementSibling.id) && AB.pageCall) {
        await AB.pageCall("fill", { path: AB.pathTo(el), method: "jquery", value: opt[0].value }, 2000).catch(() => {});
      }
      el.blur();
      return stableTrue(() => el.selectedOptions.length === 1 && clean(el.selectedOptions[0].text) === cand.text, signal);
  };

  // Enhanced select whose options are fetched on search (select2 ajax, iCIMS icimsdropdown-ajax, chosen with remote).
  // The native <select> is hidden; a sibling widget has a trigger and a dropdown with its own search box.
  const enhancedParts = (sel) => {
    const doc = sel.ownerDocument || document;
    const sib = sel.nextElementSibling;
    const trigger = sib?.querySelector?.(".select2-selection, .chosen-single, .chosen-choices, [role=combobox], a, button, [tabindex]") || (sib?.id ? sib : null);
    let owned = null;
    for (const a of ["aria-controls", "aria-owns"]) { const id = clean(trigger?.getAttribute?.(a)).split(" ")[0]; const n = id && doc.getElementById(id); if (n) { owned = n.closest(".select2-dropdown, .chosen-drop, .dropdown-container, [role=dialog]") || n; break; } }
    const openDrops = Array.from(doc.querySelectorAll(".select2-container--open .select2-dropdown"));
    const container = owned || (sib?.id && doc.getElementById(`${sib.id}_ctnr`)) || sib?.querySelector?.(".chosen-drop, .dropdown-container") || (openDrops.length === 1 ? openDrops[0] : null);
    const input = container?.querySelector("input:not([type=hidden])") || null;
    return { sib, trigger, container, input };
  };
  adapters.enhancedSelect = {
    name: "enhanced-select",
    match: (el) => el instanceof HTMLSelectElement && !el.multiple && Boolean(el.nextElementSibling) &&
      (/select2|chosen|selectize|ts-wrapper/i.test(el.nextElementSibling.className) || el.getAttribute("icimsdropdown-search") === "1" || el.getAttribute("data-ajax--url") !== null) &&
      Array.from(el.options).filter((o) => clean(o.text) && !PLACEHOLDER.test(clean(o.text))).length <= 1,
    capture: async (el, query, signal, opts = {}) => {
      const gen = { control: el, token: nextToken(el), query, candidates: [], invalidated: false, kind: "enhanced-select" };
      gen.fieldType = opts.fieldType;
      let parts = enhancedParts(el);
      if (!parts.trigger) return { status: "unavailable" };
      const isOpen = (p) => Boolean(p.container?.isConnected && p.input && visible(p.input) && p.trigger?.getAttribute?.("aria-expanded") !== "false");
      // Rounds 2+ find the dropdown still open from round 1: clicking the trigger again would close it.
      if (!isOpen(parts)) {
        mouse(parts.trigger, ["mousedown", "mouseup", "click"]);
        const deadline = Date.now() + S.TIMING.openWait;
        do { await sleep(S.TIMING.poll, signal); parts = enhancedParts(el); } while (Date.now() <= deadline && !isOpen(parts));
      }
      if (!isOpen(parts)) return { status: "unavailable" };
      gen.container = parts.container; gen.input = parts.input; gen.trigger = parts.trigger;
      armInvalidation(gen, [el, parts.trigger, parts.container, parts.input]);
      return settle({ gen, readState: () => containerState(parts.input, parts.container), act: () => S.typeQuery(parts.input, query, el), signal });
    },
    commit: async (gen, cand, signal) => {
      try {
        if (!isCurrent(gen)) return false;
        const m = readOptions(gen.input, gen.container).filter((o) => o.text === cand.text && o.value === cand.value);
        const byText = m.length ? m : readOptions(gen.input, gen.container).filter((o) => o.text === cand.text);
        if (byText.length !== 1) return false;
        mouse(byText[0].el, ["mouseover", "mousedown", "mouseup", "click"]);
        const el = gen.control;
        const rendered = () => AB.search.exactNorm(el.nextElementSibling?.querySelector?.(".select2-selection__rendered, .chosen-single span, [class*='rendered'], [class*='selected']")?.textContent);
        return await stableTrue(() => (el.selectedOptions.length === 1 && clean(el.selectedOptions[0].text) === cand.text) || rendered() === AB.search.exactNorm(cand.text), signal);
      } finally { release(gen); }
    },
  };

  // Close an open enhanced-select dropdown without changing the native selection.
  adapters.enhancedSelect.snapshot = (el) => { beginRun(el, []); return { index: el.selectedIndex }; };
  adapters.enhancedSelect.restore = (el) => {
    const p = enhancedParts(el);
    if (p.input) kb(p.input, "keydown", "Escape");
    runs.delete(el);
    const still = enhancedParts(el);
    if (still.input && visible(still.input) && still.trigger) mouse(still.trigger, ["mousedown", "mouseup", "click"]);
  };

  // Workday prompt fields: type, press Enter to search, pick a promptOption.
  adapters.workdayPrompt = {
    name: "workday-prompt",
    match: (el) => Boolean(el.closest?.("[data-automation-id='multiSelectContainer'], [data-automation-id*='formField']") && (el.matches?.("[data-automation-id='searchBox'] input, input[data-automation-id='searchBox']") || el.closest("[data-uxi-widget-type='selectinput']"))),
    capture: async (el, query, signal, opts = {}) => {
      const input = el.matches("input") ? el : el.querySelector("input");
      if (!input) return { status: "unavailable" };
      const gen = { control: input, token: nextToken(input), query, candidates: [], invalidated: false, kind: "workday-prompt", input, optionsPath: opts.optionsPath, fieldType: opts.fieldType };
      armInvalidation(gen, [input]);
      const scope = () => (input.ownerDocument || document).querySelector("[data-automation-id='activeListContainer'], [data-automation-id='promptOptionsList'], [role=listbox]");
      const read = () => { const sc = scope(); extendGuard(gen, [sc]); return containerState(input, sc, gen.optionsPath); };
      return settle({ gen, readState: read, signal,
        act: () => { S.typeQuery(input, query, input); kb(input, "keydown", "Enter"); kb(input, "keyup", "Enter"); } });
    },
    commit: (gen, cand, signal) => adapters.ariaCombobox.commit(gen, cand, signal),
    snapshot: (el) => adapters.ariaCombobox.snapshot(el),
    restore: (el, snap) => adapters.ariaCombobox.restore(el, snap),
  };

  // ARIA combobox / react-select / generic typeahead text input.
  adapters.ariaCombobox = {
    name: "combobox",
    match: (el) => {
      const input = el.matches?.("input, textarea") ? el : el.querySelector?.("input:not([type=hidden])");
      if (!input) return false;
      const own = ownerControl(input);
      return input.getAttribute("role") === "combobox" || own.getAttribute?.("role") === "combobox" || input.hasAttribute("aria-autocomplete") || input.getAttribute("aria-haspopup") === "listbox" ||
        /select__input|typeahead|autocomplete|autosuggest|combobox/i.test(`${input.className} ${input.parentElement?.className || ""} ${input.closest("[class*='select__control']") ? "select__input" : ""}`) ||
        Boolean(input.getAttribute("list")) || input.closest("[class*='select__control']") !== null;
    },
    capture: async (el, query, signal, opts = {}) => {
      let input = el.matches?.("input, textarea") ? el : el.querySelector("input:not([type=hidden])");
      if (!input) return { status: "unavailable" };
      const gen = { control: input, token: nextToken(input), query, candidates: [], invalidated: false, kind: "combobox", input, optionsPath: opts.optionsPath, fieldType: opts.fieldType };
      armInvalidation(gen, [input, ownerControl(input)]);
      // <input list="datalist">: options are static in the DOM.
      const dlId = input.getAttribute("list");
      if (dlId) {
        const dl = (input.ownerDocument || document).getElementById(dlId);
        const q = AB.search.tokens(query);
        gen.candidates = dedupe(Array.from(dl?.options || []).map((o) => ({ el: o, value: clean(o.value), text: clean(o.label || o.value) })).filter((o) => { const t = AB.search.tokens(o.text); return q.every((w) => t.some((x) => x.startsWith(w))); }));
        gen.datalist = true;
        return { status: gen.candidates.length ? "ready" : "no-results", generation: gen };
      }
      const open = async () => {
        if (!visible(input)) {
          // Open the overlay through the visible proxy control in the same field, then wait for the real input.
          const field = input.closest("fieldset, [class*='field'], [class*='question']") || input.parentElement?.parentElement?.parentElement || input.parentElement;
          const opener = Array.from(field?.querySelectorAll("input:not([type=hidden]), [role=button], button") || []).find((n) => n !== input && visible(n) && !(n.tagName === "BUTTON" && /clear|remove/i.test(n.getAttribute("aria-label") || "")));
          if (opener) { mouse(opener, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]); opener.focus?.(); }
          const until = Date.now() + S.TIMING.openWait;
          while (Date.now() <= until && !visible(input)) await sleep(S.TIMING.poll, signal);
        }
        mouse(ownerControl(input), ["mousedown", "mouseup", "click"]);
        input.focus();
        // Some pickers move focus to a separate search box inside the opened popup (the controlled listbox's
        // container). Type where the focus went, else into a visible text input next to the listbox.
        await sleep(S.TIMING.poll, signal);
        const doc = input.ownerDocument || document;
        const lb = S.findListbox(input);
        const act0 = doc.activeElement;
        const isText = (n) => n && n.matches?.("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea") && visible(n) && !n.disabled;
        let target = null;
        if (act0 && act0 !== input && isText(act0) && (lb?.parentElement?.contains(act0) || input.closest("fieldset, [class*='field']")?.contains(act0))) target = act0;
        if (!target && !visible(input) && lb) target = Array.from(lb.parentElement?.querySelectorAll("input, textarea") || []).find(isText) || null;
        gen.typeTarget = target || input;
        // User input on the listbox, popup or popup search box also cancels this search.
        extendGuard(gen, [lb, lb?.parentElement, gen.typeTarget]);
      };
      const act = async () => {
        const typeInto = gen.typeTarget || input;
        if (typeInto !== input) typeInto.focus();
        S.typeQuery(typeInto, query, input);
        // React's expando props live on the page's JS wrappers, invisible to this isolated world, so React cannot be
        // detected here. If the list has not reacted to the query shortly after typing, retype from the main world
        // (page.js calls the component's own onChange with the native event).
        if (!AB.pageCall || !AB.pathTo) return;
        await sleep(S.TIMING.bridgeRetypeAfter, signal);
        const st = containerState(input, null, gen.optionsPath);
        if (st.loading || st.noResults || (st.options.length && relevant(st.options, query, gen.fieldType))) return;
        gen.bridged = true;
        await AB.pageCall("fill", { path: AB.pathTo(typeInto), method: "react", value: query, eventOptions: { skipBlur: true } }, 3000).catch(() => {});
      };
      const read = () => containerState(input, null, gen.optionsPath);
      let res = await settle({ gen, readState: read, open, act, signal });
      if (res.status === "stale" && isCurrent(gen)) {
        // Menu never opened: ArrowDown opens ARIA / react-select listboxes.
        res = await settle({ gen, readState: read, act: () => kb(input, "keydown", "ArrowDown"), signal, window: 1500 });
      }
      return res;
    },
    commit: async (gen, cand, signal) => {
      const input = gen.input;
      try {
        if (!isCurrent(gen)) return false;
        if (gen.datalist) {
          protoSet(input, cand.value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: cand.value }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return await stableTrue(() => clean(input.value) === cand.value, signal);
        }
        // Exactly one visible option with this text (Jobright: ambiguous-visible-options / missing-visible-option).
        let match = [];
        const deadline = Date.now() + S.TIMING.commitVisibleWait;
        while (Date.now() <= deadline) {
          if (!isCurrent(gen)) return false;
          const opts = readOptions(input, null, gen.optionsPath).filter((o) => o.text === cand.text);
          const exact = opts.filter((o) => o.value === cand.value);
          match = exact.length ? exact : opts;
          if (match.length >= 1) break;
          await sleep(S.TIMING.poll, signal);
        }
        if (match.length !== 1) return false;
        const optEl = match[0].el;
        const own = ownerControl(input);
        const want = AB.search.exactNorm(cand.text);
        const fieldBox = input.closest("[data-automation-id='multiSelectContainer'], [data-automation-id*='formField'], [class*='field'], fieldset, [class*='question'], [class*='form-group']") || input.parentElement;
        const SELECTED_SEL = "[class*='singleValue'], [class*='single-value'], [class*='multi-value__label'], [data-automation-id='selectedItem'], .select2-selection__rendered";
        const selectedTexts = () => Array.from(new Set([...(own.querySelectorAll?.(SELECTED_SEL) || []), ...(fieldBox?.querySelectorAll(SELECTED_SEL) || [])])).map((n) => AB.search.exactNorm(n.getAttribute("title") || n.textContent));
        const hidden = () => Array.from(fieldBox?.querySelectorAll("input[type=hidden]") || []).map((n) => n.value).join("\u0001");
        const texts = Array.from(new Set([input, gen.typeTarget].filter(Boolean)));
        const before = { hidden: hidden(), values: texts.map((n) => n.value) };
        optEl.scrollIntoView?.({ block: "nearest" });
        mouse(optEl, ["mouseover", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
        // Committed when: a dedicated selected-value element shows exactly the candidate (menu state irrelevant), or
        // the menu closed and a text box now holds exactly the candidate after changing, or holds it and the field's
        // hidden id changed. Text the box already held (the typed query) proves nothing on its own.
        let weak = false;
        const committed = () => {
          if (selectedTexts().includes(want)) return true;
          const menuGone = readOptions(input, null, gen.optionsPath).length === 0;
          if (!menuGone) return false;
          const exactNow = texts.map((n) => AB.search.exactNorm((AB.refresh ? AB.refresh(n) : n).value) === want);
          if (texts.some((n, k) => exactNow[k] && n.value !== before.values[k])) return true;
          if (exactNow.some(Boolean) && hidden() !== before.hidden) return true;
          weak = exactNow.some(Boolean);
          return false;
        };
        if (await stableTrue(committed, signal)) return true;
        // Exact text is shown and the menu closed, but nothing else changed: report success as unverified.
        if (weak && committed() === false && texts.some((n) => AB.search.exactNorm(n.value) === want) && readOptions(input, null, gen.optionsPath).length === 0) { gen.unverified = true; return true; }
        return false;
      } finally { release(gen); }
    },
    snapshot: (el) => { const input = el.matches?.("input, textarea") ? el : el.querySelector?.("input:not([type=hidden])"); if (input) beginRun(input, [input]); return input ? { value: input.value } : null; },
    restore: (el) => {
      const input = el.matches?.("input, textarea") ? el : el.querySelector?.("input:not([type=hidden])");
      if (!input) return;
      kb(input, "keydown", "Escape");
      restoreOwned(input);
      kb(input, "keydown", "Escape");
      input.blur();
    },
  };

  // School fallback (Jobright iCIMS/Jacobs pattern): pick the list's exact "Other" entry, then type the real school
  // into the companion "other / please specify" box. Guarded so it only runs on institution lists that show nothing
  // resembling the school, and so it can only write into the school's own box.
  const OTHER_RE = /^(other|others|other school|other institution|other university|other college|other \(please specify\)|not listed|my school is not listed|school not listed|institution not listed)$/i;
  const COMPANION_RE = /\b(other|specify|not listed|school name|name of (your )?(school|institution|university|college)|institution name|university name|college name)\b/i;
  const SCHOOLISH_RE = /\b(school|university|college|institution)\b/i;
  const INSTITUTION_LABEL = /^(school|university|college|institution|school name|university name|college name|institution name|name of (your )?(school|university|college|institution)|college university|university college|school or university|school university|university or college|college or university|educational institution|school attended|university attended)$/;
  const EDU_LEVEL = /\b(high school|some college|bachelor|master|doctor|doctorate|phd|associate|degree|ged|diploma|certificate|elementary|middle school|secondary)\b/i;
  const hasBox = (n) => n.offsetWidth > 0 && n.offsetHeight > 0;
  S.otherFallbackAllowed = ({ el, key, label, res, answer }) => {
    const k = String(key || "");
    const byConfig = /school/i.test(k) && !/^most_recent_/.test(k);
    const byLabel = INSTITUTION_LABEL.test(AB.norm ? AB.norm(label || "") : String(label || "").toLowerCase());
    if (!byConfig && !byLabel) return { ok: false, reason: "other-not-institution-field" };
    const texts = el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => clean(o.text)) : AB.arr(res.candidatesSeen);
    if (texts.some((t) => EDU_LEVEL.test(t))) return { ok: false, reason: "other-not-institution-list" };
    // Anything that shares a distinctive word with the school, or scores above a low floor, may be the school under
    // another name: leave the field for the user instead of declaring it "not listed".
    const generic = S.GENERIC?.school || new Set();
    const want = AB.search.tokens(answer).filter((t) => !generic.has(t));
    const near = texts.filter((t) => !OTHER_RE.test(AB.search.exactNorm(t))).some((t) => AB.search.tokens(t).some((x) => !generic.has(x) && want.includes(x)) || AB.search.score("school", answer, t) >= 0.25);
    if (near) return { ok: false, reason: "other-near-match-present" };
    return { ok: true };
  };
  S.findCompanionInput = (el, { exclude = new Set() } = {}) => {
    const doc = el.ownerDocument || document;
    const fieldOf = (n) => n.closest("[class*='field'], [class*='form-group'], [class*='question'], .q, li, tr, fieldset") || n.parentElement;
    const start = fieldOf(el);
    const inputs = Array.from(doc.querySelectorAll("input[type=text], input:not([type]), textarea")).filter((i) => hasBox(i) && visible(i) && !i.closest("[data-autobot-panel]") && i !== el && !i.value && !exclude.has(i));
    const after = inputs.filter((i) => el.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
    const near = [];
    let box = start;
    for (let hop = 0; box && hop < 3; hop++, box = box.nextElementSibling || box.parentElement?.nextElementSibling) {
      for (const i of after) if ((box.contains(i) || box === i) && !near.includes(i)) near.push(i);
    }
    // A bare "other"/"specify" label is only trusted inside the school's own field; elsewhere it must name a school.
    const ok = near.filter((i) => { const l = (AB.labelFor ? AB.labelFor(i) : [i.placeholder || ""]).join(" "); return COMPANION_RE.test(l) && (start?.contains(i) || SCHOOLISH_RE.test(l)); });
    return ok.length === 1 ? ok[0] : null;
  };
  S.otherFallback = async ({ el, adapter, answer, signal, adapterOptions, snapshot }) => {
    // The main search already restored the field and closed its record; track the "Other" probe as a new run.
    try { if (adapter.snapshot && !(el instanceof HTMLSelectElement)) adapter.snapshot(el); } catch {}
    const cap = await adapter.capture(el, "Other", signal, adapterOptions);
    if (cap.status !== "ready") return { ok: false, reason: `other-capture-${cap.status}` };
    const others = cap.generation.candidates.filter((c) => OTHER_RE.test(AB.search.exactNorm(c.text)));
    if (others.length !== 1) { S.discardGeneration(cap.generation); return { ok: false, reason: others.length ? "other-ambiguous" : "other-missing" }; }
    // Non-native widgets cannot always be un-selected: require a plausible box before committing there.
    const reversible = el instanceof HTMLSelectElement;
    if (!reversible && !S.findCompanionInput(el)) { S.discardGeneration(cap.generation); return { ok: false, reason: "companion-missing" }; }
    const boxesBefore = new Set(Array.from((el.ownerDocument || document).querySelectorAll("input, textarea")).filter((i) => hasBox(i)));
    if (!(await adapter.commit(cap.generation, others[0], signal))) return { ok: false, reason: "other-commit-failed" };
    // The school's own box often appears only after "Other" is chosen: look up after the commit, prefer new boxes.
    let box = null;
    for (let i = 0; i < 12 && !box; i++) {
      await sleep(50, signal);
      const fresh = S.findCompanionInput(el, { exclude: boxesBefore });
      box = fresh || (i >= 4 ? S.findCompanionInput(el) : null);
    }
    if (!box) {
      if (reversible) { try { adapter.restore(el, snapshot); } catch {} return { ok: false, reason: "companion-ambiguous" }; }
      return { ok: false, reason: "other-committed-companion-missing", other: others[0].text };
    }
    if (AB.writeText) await AB.writeText(box, answer); else { protoSet(box, answer); box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new Event("change", { bubbles: true })); }
    const ok = await stableTrue(() => box.isConnected && AB.search.exactNorm(box.value) === AB.search.exactNorm(answer), signal, 500);
    if (!ok && reversible) { try { adapter.restore(el, snapshot); } catch {} }
    return { ok, reason: ok ? null : "companion-not-committed", other: others[0].text };
  };

  S.ADAPTER_ORDER = ["workdayPrompt", "enhancedSelect", "nativeSelect", "ariaCombobox"];
  S.adapters = adapters;
  S.adapterFor = (el) => {
    if (!el) return null;
    for (const k of S.ADAPTER_ORDER) { try { if (adapters[k].match(el)) return adapters[k]; } catch {} }
    return null;
  };

  // Config paths and labels often point at a hidden input that only stores the chosen id (Greenhouse
  // "educations[0].school_name_id"). Resolve the visible searchable control in the same field.
  S.resolveControl = (el) => {
    if (!el) return el;
    const comboAttr = (n) => n.getAttribute?.("aria-haspopup") === "listbox" || n.getAttribute?.("role") === "combobox" || n.hasAttribute?.("aria-controls");
    // A combobox input may be visibility:hidden until a visible proxy input in the same field is clicked
    // (Duolingo/Greenhouse "web-ui" pickers): accept it when it is laid out (non-zero box).
    const laidOut = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).display !== "none"; };
    const usable = (n) => n && n.isConnected && !(n instanceof HTMLInputElement && n.type === "hidden") && !n.disabled && (visible(n) || (comboAttr(n) && laidOut(n)));
    if (usable(el) && S.adapterFor(el)) return el;
    const doc = el.ownerDocument || document;
    let lab = null;
    try { lab = el.id ? doc.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null; } catch {}
    const roots = [lab?.parentElement, el.parentElement, el.closest?.("fieldset, [class*='field'], [class*='question'], [class*='form-group']")].filter(Boolean);
    for (const r of roots) {
      const c = Array.from(r.querySelectorAll("input:not([type=hidden]), select, textarea")).filter((n) => n !== el && usable(n) && !n.closest("[data-autobot-panel]") && S.adapterFor(n));
      if (c.length) return c[0];
    }
    return el;
  };

  // Is this control a search-style widget (as opposed to a plain text box)?
  S.isSearchable = (el) => Boolean(S.adapterFor(el)) && !(el instanceof HTMLSelectElement && el.options.length < 2);

  // High-level entry used by writer/plan/heuristics.
  // values: answer candidates (first is the profile value, rest are synonyms from value maps).
  S.fill = async (el, values, { fieldType, label, key, signal, onTrace, optionsPath, otherFallback } = {}) => {
    const adapter = S.adapterFor(el);
    const vals = AB.arr(values).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!adapter || !vals.length) return { success: false, failureReason: adapter ? "no-answer" : "no-adapter", rounds: [], actions: [] };
    const ft = fieldType || S.fieldTypeFor(key, label);
    const adapterOptions = { optionsPath, fieldType: ft };
    const res = await S.run({ el, fieldType: ft, answer: vals[0], alternates: vals.slice(1), adapter, signal, onTrace, adapterOptions });
    res.adapter = adapter.name;
    res.datalist = Boolean(el.getAttribute?.("list"));
    if (res.success && res.unverified) res.selected.verified = false;
    if (!res.success && ft === "school" && res.failureReason === "return-empty" && otherFallback !== false && !signal?.aborted) {
      const gate = S.otherFallbackAllowed({ el, key, label, res, answer: vals[0] });
      let fb = gate;
      if (gate.ok) { try { fb = await S.otherFallback({ el, adapter, answer: vals[0], signal, adapterOptions, snapshot: res.snapshot }); } catch (e) { fb = { ok: false, reason: "other-error" }; } }
      res.otherFallback = fb;
      if (fb.ok) { res.success = true; res.selected = { text: `${fb.other} + "${vals[0]}"`, value: fb.other, score: null, round: null, query: "Other" }; res.failureReason = null; }
      else if (gate.ok && adapter.restore && fb.reason !== "other-committed-companion-missing") { try { adapter.restore(el, res.snapshot); } catch {} }
      else if (fb.reason === "other-committed-companion-missing") res.failureReason = fb.reason;
    }
    S.lastRuns = (S.lastRuns || []).slice(-19).concat([{ key, label, fieldType: ft, adapter: adapter.name, ...res }]);
    return res;
  };

  // One-line human summary of a run for the panel.
  S.describe = (res) => {
    if (!res) return "";
    const rounds = (res.rounds || []).map((r) => `"${r.searchInput}"→${r.candidateCount}`).join(", ");
    if (res.success) return `${res.selected.text}${res.selected.verified === false ? " (unverified)" : ""}  (searched ${rounds}${res.otherFallback?.ok ? ', then "Other" + companion' : ""}; ${res.adapter || ""})`;
    return `${res.failureReason}${rounds ? ` after ${rounds}` : ""}${res.best ? `; best "${res.best.text}" ${res.best.score.toFixed(2)}` : ""}`;
  };
})();
