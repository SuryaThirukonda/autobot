// Autobot engine: writers. Isolated-world DOM writes plus a bridge to page.js for framework-aware writes.
var AB = globalThis.AB || (globalThis.AB = {});

// ---------- page-world bridge ----------
AB._pageReady = null;
AB.ensurePageScript = () => {
  if (AB._pageReady) return AB._pageReady;
  AB._pageReady = new Promise((resolve) => {
    if (document.documentElement.dataset.autobotPage === "1") return resolve(true);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page.js");
    s.async = false;
    s.onload = () => { s.remove(); resolve(true); };
    s.onerror = () => resolve(false);
    (document.head || document.documentElement).appendChild(s);
  });
  return AB._pageReady;
};

let _rpcId = 0;
AB.pageCall = async (method, params, timeout = 8000) => {
  await AB.ensurePageScript();
  const id = `ab_${++_rpcId}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.__autobot !== "res" || ev.data.id !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(t);
      resolve(ev.data);
    };
    const t = setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "page timeout" }); }, timeout);
    window.addEventListener("message", onMsg);
    window.postMessage({ __autobot: "req", id, method, params }, "*");
  });
};

// ---------- isolated-world primitives ----------
AB.nativeSet = (el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, "value");
  try { d?.set?.call(el, value); } catch {}
  if (el.value !== value) el.value = value;
};
AB.fire = (el, names, init = {}) => {
  for (const n of AB.arr(names)) {
    const opts = { bubbles: true, cancelable: true, composed: true, ...init };
    let ev;
    if (/^key/.test(n)) ev = new KeyboardEvent(n, opts);
    else if (n === "input") ev = new InputEvent(n, { ...opts, inputType: "insertText", data: init.data ?? null });
    else if (/^(focus|blur|focusin|focusout)$/.test(n)) ev = new FocusEvent(n, opts);
    else if (/^(click|mousedown|mouseup|mouseover)$/.test(n)) ev = new MouseEvent(n, opts);
    else ev = new Event(n, opts);
    el.dispatchEvent(ev);
  }
};

// Default text writer: focus, clear, set via native setter, fire the event sequence most frameworks listen to.
AB.writeText = async (el, value, { blur = true, skipFocusClick = false } = {}) => {
  value = value === undefined || value === null ? "" : String(value);
  el.focus();
  if (!skipFocusClick) AB.fire(el, "click");
  if (el.isContentEditable) {
    el.textContent = "";
    document.execCommand("selectAll", false, null);
    const ok = document.execCommand("insertText", false, value);
    if (!ok) el.textContent = value;
    AB.fire(el, ["input", "change"]);
    if (blur) el.blur();
    return true;
  }
  AB.fire(el, ["keydown", "keypress"]);
  AB.nativeSet(el, value);
  AB.fire(el, "input", { data: value });
  AB.fire(el, ["keyup", "change"]);
  if (blur) { AB.fire(el, "focusout"); el.blur(); }
  return (el.value ?? "") === value;
};

AB.setChecked = (el, checked) => {
  checked = Boolean(checked);
  if (el.checked === checked) return true;
  el.focus();
  el.click();
  if (el.checked !== checked) {
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
    try { d?.set?.call(el, checked); } catch { el.checked = checked; }
    AB.fire(el, ["input", "change"]);
  }
  return el.checked === checked;
};

// Native <select>: choose by option text/value using deterministic matching.
AB.writeSelect = (el, value, synonyms) => {
  const opts = Array.from(el.options).filter((o) => !o.disabled);
  const labels = opts.map((o) => o.label || o.textContent || o.value);
  let i = AB.bestOption(value, labels, synonyms);
  if (i < 0) i = AB.bestOption(value, opts.map((o) => o.value), synonyms);
  if (i < 0) return false;
  const opt = opts[i];
  el.focus();
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  try { d?.set?.call(el, opt.value); } catch { el.value = opt.value; }
  if (el.value !== opt.value) { opt.selected = true; }
  AB.fire(el, ["input", "change"]);
  el.blur();
  return el.value === opt.value;
};

// Radio group: pick the input whose label matches.
AB.writeRadio = (anyRadio, value, synonyms) => {
  const root = anyRadio.getRootNode();
  const group = anyRadio.name ? Array.from(root.querySelectorAll(`input[type=radio][name="${CSS.escape(anyRadio.name)}"]`)) : [anyRadio];
  const labels = group.map((r) => AB.labelFor(r, { group: false })[0] || r.value);
  let i = AB.bestOption(value, labels, synonyms);
  if (i < 0) i = AB.bestOption(value, group.map((r) => r.value), synonyms);
  if (i < 0) return false;
  return AB.setChecked(group[i], true);
};

// Upload when the page only exposes a button (hidden/absent <input type=file>): intercept the picker in the page world.
AB.uploadViaPicker = async (el, file) => {
  if (!file?.dataBase64) return false;
  const r = await AB.pageCall("fill", { path: AB.pathTo(el), method: "interceptFilePicker", value: file }, 9000);
  if (!r.ok) AB.log("picker interception failed", r.error);
  return Boolean(r.ok);
};

// File upload from a stored { name, type, dataBase64 }.
AB.writeFile = (input, file) => {
  if (!file?.dataBase64) return false;
  if (!(input instanceof HTMLInputElement && input.type === "file")) {
    // Prefer a nearby hidden file input; otherwise go through the button.
    const near = input.querySelector?.("input[type=file]") || input.closest?.("label, [class*='upload'], [class*='file'], fieldset, div")?.querySelector("input[type=file]");
    if (near) input = near; else return AB.uploadViaPicker(input, file);
  }
  const bin = atob(file.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], file.name || "resume.pdf", { type: file.type || "application/pdf" });
  const dt = new DataTransfer();
  dt.items.add(f);
  input.files = dt.files;
  AB.fire(input, "input", { composed: true });
  AB.fire(input, "change", { composed: false });
  return input.files.length === 1;
};

// Combobox / react-select style widget: open, type, pick the best visible option.
// Re-resolve an element that a framework re-render may have replaced.
AB.refresh = (el) => {
  if (!el || el.isConnected) return el;
  if (el.id) { const byId = document.getElementById(el.id); if (byId) return byId; }
  if (el.name) { const byName = document.querySelector(`[name="${CSS.escape(el.name)}"]`); if (byName) return byName; }
  return el;
};

AB.collectOptions = (optSel) => AB.queryAny(optSel, document, true).filter((o) => AB.isVisible(o) && AB.textOf(o));

AB.writeCombobox = async (el, value, { optionsPath, synonyms, typeToSearch = true } = {}) => {
  const want = AB.arr(value).map(String).filter(Boolean);
  if (!want.length) return false;
  el = AB.refresh(el);
  let input = el.matches("input, textarea") ? el : el.querySelector("input") || el;
  const optSel = optionsPath || [
    "css:[role=listbox] [role=option]:not([aria-disabled=true])",
    "css:[role=option]:not([aria-disabled=true])",
    "css:[class*='menu'] [class*='option']:not([class*='disabled'])",
    "css:[class*='select__option']:not([class*='disabled'])",
    "css:[class*='dropdown'] li, css:[class*='suggestion'], css:[class*='autocomplete'] li",
  ];
  // Anything already visible before we interact is not a menu option (e.g. radio labels with "option" in their class).
  const before = new Set(AB.collectOptions(optSel));
  input.focus();
  AB.fire(el, ["mousedown", "mouseup", "click"]);
  if (typeToSearch && input.matches("input, textarea")) {
    // React-controlled search inputs (react-select, Ashby, Greenhouse) only filter when React's own onChange runs.
    const isReact = Object.keys(input).some((k) => /^__react(Props|Fiber|EventHandlers|InternalInstance)\$/.test(k));
    if (isReact) { const r = await AB.pageCall("fill", { path: AB.pathTo(input), method: "react", value: want[0], eventOptions: { skipBlur: true } }); if (!r.ok) await AB.writeText(input, want[0], { blur: false }); }
    else await AB.writeText(input, want[0], { blur: false });
  }
  input = AB.refresh(input);
  const waitOptions = async (ms) => { const deadline = Date.now() + ms; let options = []; while (Date.now() < deadline) { options = AB.collectOptions(optSel).filter((o) => !before.has(o)); if (options.length) break; await AB.sleep(100); } return options; };
  let options = await waitOptions(2000);
  if (!options.length) {
    // Menu may not have opened: ArrowDown opens react-select/ARIA listboxes.
    AB.fire(input, "keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    options = await waitOptions(1200);
  }
  if (!options.length) {
    AB.log("combobox: no options rendered for", want[0], "on", input.id || input.className);
    AB.fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13 }); // some widgets commit typed text on Enter
    await AB.sleep(150);
    input = AB.refresh(input);
    const got = AB.norm(input.value), head = AB.norm(String(want[0]).split(",")[0]);
    return Boolean(got) && (got === AB.norm(want[0]) || (head.length >= 3 && got.includes(head)));
  }
  const labels = options.map((o) => o.innerText || o.textContent);
  let i = AB.bestOption(want, labels, synonyms);
  if (i < 0 && typeToSearch) {
    // The typed search narrowed the list: accept the first option only if it shares a meaningful token with the value.
    const toks = AB.norm(want[0]).split(" ").filter((t) => t.length >= 3);
    if (toks.some((t) => AB.norm(labels[0]).includes(t))) i = 0;
  }
  AB.log("combobox options", labels.slice(0, 8), "chose", i);
  if (i < 0) { AB.fire(input, "keydown", { key: "Escape", code: "Escape", keyCode: 27 }); return false; }
  const opt = options[i];
  const menuOpen = () => AB.collectOptions(optSel).filter((o) => !before.has(o)).length > 0;
  if (i === 0 && typeToSearch) {
    // The typed search left our match as the focused first option: Enter commits exactly that one.
    AB.fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13 });
    await AB.sleep(150);
    if (!menuOpen()) return true;
  }
  opt.scrollIntoView({ block: "nearest" });
  AB.fire(opt, ["mousemove", "mouseover", "mousedown", "mouseup", "click"]);
  await AB.sleep(150);
  if (menuOpen()) {
    // Never blind-commit: a stray Enter here would pick whatever is focused (observed: "+93" instead of "+1").
    AB.fire(input, "keydown", { key: "Escape", code: "Escape", keyCode: 27 });
    AB.log("combobox: option click did not commit", labels[i]);
    return false;
  }
  return true;
};

// ---------- dispatcher ----------
// method: default | defaultWithoutBlur | react | click | select | checkbox | radio | combobox | upload | jquery | setValueOnly | clear | keypress(Enter)
// Multi-round search (engine/search.js + search-widgets.js). Returns true/false when search decided the field,
// or null only when search never really started (no adapter, or the widget never showed a list) so the v1 writer
// may try. Once real candidates were seen, a commit was attempted, the user interacted or Stop was pressed, the
// result is final: the v1 prefix matcher must not get a second, less careful guess.
AB.SEARCH_FIELD_TYPES = new Set(["school", "major", "location", "company"]);
AB.trySearch = async (el, value, ctx = {}, { selectOnly = false } = {}) => {
  if (!AB.search?.fill || ctx.settings?.search === false) { AB.log("search skipped: disabled", ctx.key); return null; }
  if (ctx.signal?.aborted) return false;
  const fieldType = ctx.fieldType || AB.search.fieldTypeFor(ctx.key, ctx.label);
  // Only the four search field types run search unless a config field asks for it explicitly (searchType).
  if (!ctx.fieldType && !AB.SEARCH_FIELD_TYPES.has(fieldType)) return null;
  if (selectOnly && !AB.SEARCH_FIELD_TYPES.has(fieldType) && !ctx.fieldType) return null;
  const orig = el;
  el = AB.search.resolveControl ? AB.search.resolveControl(el) : el;
  if (!AB.search.adapterFor(el)) { AB.log("search skipped: no adapter for", ctx.key, el?.tagName, el?.id || el?.className); return null; }
  // User-defined aliases (options page): { "Texas A&M University": "Texas A&M University - College Station" }.
  const base = AB.arr(ctx.candidates?.length ? ctx.candidates : value).map(String);
  const aliasMap = ctx.settings?.searchAliases || {};
  const aliasFor = (v) => AB.arr(aliasMap[v] ?? Object.entries(aliasMap).find(([k]) => AB.norm(k) === AB.norm(v))?.[1]);
  const aliases = base.flatMap(aliasFor).map(String).filter(Boolean);
  // Per-ATS canonical name on the profile entry (imported from Simplify): the exact text this ATS's list uses.
  const atsAlts = AB.search.atsAlternates ? AB.search.atsAlternates(ctx.profile, ctx.key, ctx.ats) : [];
  // City pickers often list "City, ST, Country": add the profile's city/state forms as alternates.
  const extra = [];
  if (fieldType === "location" && ctx.profile && AB.getProfileValue) {
    const p = ctx.profile, cs = AB.getProfileValue(p, "city_state");
    if (cs) extra.push(cs);
    if (p.city && p.state && p.country) extra.push(`${p.city}, ${p.state}, ${p.country}`);
  }
  // Order: the user's alias (their exact wording for this list), the per-ATS name, then the profile value and forms.
  const values = Array.from(new Set([...aliases, ...atsAlts, ...base, ...extra]));
  const res = await AB.search.fill(el, values, { fieldType, key: ctx.key, label: ctx.label, signal: ctx.signal, optionsPath: ctx.optionsPath, otherFallback: ctx.settings?.searchOtherFallback, fallbackAnswer: base[0],
    onTrace: AB.debug ? (m, d) => AB.log("search", m, JSON.stringify(d)?.slice(0, 400)) : undefined });
  if (AB.debug) AB.log("search result", ctx.key || ctx.label, AB.search.describe(res));
  const decide = (v) => { if (v !== null) { res.decided = true; AB.searchResults.set(el, res); if (orig !== el) AB.searchResults.set(orig, res); } return v; };
  if (res.success) return decide(true);
  // Final without a commit: Stop, the user's own input, a list that changed but never settled (a real search widget
  // whose results never came; the v1 prefix matcher could commit a look-alike such as "… - Commerce"), or a
  // multi-choice widget that already holds someone else's choice.
  if (ctx.signal?.aborted || ["aborted", "trusted-invalidation", "candidate-capture-timeout", "other-selection-present"].includes(res.failureReason)) return decide(false);
  // Free-text box with datalist suggestions: typing the profile value is still a valid answer.
  if (res.datalist) return null;
  if (res.actions?.includes("SELECT_OPTIONS")) return decide(false);
  if (res.rounds?.length) return decide(false);
  return null;   // the widget never produced a list: not a search widget after all
};
AB.searchResults = new WeakMap();

// Rerun safety on the v1 dropdown path (Workday prompt buttons and pills, react-select single values, used when
// search does not handle the field): when the control already shows one of the candidate labels, leave it alone.
// A trailing note without letters, like Workday's "(+1)", is ignored; a lettered one like "(College Station)" is not.
AB.shownChoices = (el) => {
  if (!el) return [];
  if (el.matches?.("button, [role=button]")) {
    const text = (n) => String(n?.innerText || n?.textContent || "").replace(/\s+/g, " ").trim();
    let t = text(el);
    // An empty listbox button may show its choice beside it (Duolingo's month picker: <span>May</span><button>).
    if (!t && el.getAttribute("aria-haspopup") === "listbox" && el.parentElement?.querySelectorAll("button, [role=button], input, select, textarea").length === 1) t = text(el.parentElement);
    return t && !AB.search?.isPlaceholder?.(t) ? [t] : [];
  }
  return AB.search?.selectedTexts ? AB.search.selectedTexts(el) : [];
};
AB.alreadyShows = (el, value, synonyms) => {
  const shown = AB.shownChoices(el);
  if (!shown.length) return null;
  const strip = (s) => AB.norm(String(s).replace(/\s*\([^)a-z]*\)\s*$/i, ""));
  const wants = AB.arr(value).map(String).filter(Boolean);
  const all = [...wants, ...wants.flatMap((w) => AB.arr(synonyms?.[AB.norm(w)]))];
  return shown.find((t) => all.some((w) => AB.norm(w) === AB.norm(t) || (strip(w) && strip(w) === strip(t)))) || null;
};
AB.keepChoice = (el, text) => {
  AB.searchResults.set(el, { decided: true, success: true, alreadySelected: true, selected: { text }, adapter: "dropdown", rounds: [], actions: [] });
  return true;
};

AB.write = async (el, method, value, ctx = {}) => {
  method = method || "default";
  if (!el) return false;
  if (ctx.signal?.aborted) return false;
  const synonyms = ctx.synonyms;
  if (el instanceof HTMLSelectElement && !["click", "jquery", "react"].includes(method)) {
    // Long institution/location lists: the token scorer avoids prefix traps like "X University - Commerce".
    const r = await AB.trySearch(el, value, ctx, { selectOnly: true });
    if (r !== null) return r;
    if (ctx.signal?.aborted) return false;
    return AB.writeSelect(el, value, synonyms);
  }
  if (el instanceof HTMLInputElement && el.type === "radio" && method !== "click") return AB.writeRadio(el, AB.boolToYesNo(value), synonyms);
  if (el instanceof HTMLInputElement && el.type === "checkbox" && method !== "click") {
    const v = Array.isArray(value) ? value[0] : value;
    const want = v === undefined || v === null ? true : !(v === false || /^(no|false|n|0|off|unchecked)$/i.test(String(v).trim()));
    return AB.setChecked(el, want);
  }
  if (el instanceof HTMLInputElement && el.type === "file") return AB.writeFile(el, ctx.file);
  const isCombo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox" || el.matches("[class*='select__input'], [class*='select__control'], [class*='select__container']");
  switch (method) {
    case "click": el.scrollIntoView({ block: "center" }); AB.fire(el, ["mousedown", "mouseup", "click"]); return true;
    case "clear": return AB.writeText(el, "");
    case "setValueOnly": AB.nativeSet(el, value); return true;
    case "keypress": AB.fire(el, "keydown", { key: value || "Enter", code: value || "Enter", keyCode: 13 }); return true;
    case "combobox": {
      { const r = await AB.trySearch(el, value, ctx); if (r !== null) return r; }
      if (ctx.signal?.aborted) return false;
      { const kept = AB.alreadyShows(el, ctx.candidates?.length ? ctx.candidates : value, synonyms); if (kept) return AB.keepChoice(el, kept); }
      return AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms });
    }
    case "react": case "jquery": case "reactClick": {
      const r = await AB.pageCall("fill", { path: AB.pathTo(el), method, value, eventOptions: ctx.eventOptions || {} });
      if (r.ok) return true;
      AB.log("page method failed, falling back", method, r.error);
      return isCombo ? AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms }) : AB.writeText(el, value);
    }
    case "defaultWithoutBlur": return AB.writeText(el, value, { blur: false });
    case "default": default: {
      if (isCombo || (AB.SEARCH_FIELD_TYPES.has(ctx.fieldType || AB.search?.fieldTypeFor?.(ctx.key, ctx.label)) && AB.search?.isSearchable?.(el))) {
        const r = await AB.trySearch(el, value, ctx);
        if (r !== null) return r;
        if (ctx.signal?.aborted) return false;
        if (isCombo) {
          const kept = AB.alreadyShows(el, ctx.candidates?.length ? ctx.candidates : value, synonyms);
          if (kept) return AB.keepChoice(el, kept);
          return AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms });
        }
      }
      // React-controlled inputs reject plain writes unless the native setter + handlers are used; detect and route.
      const react = Object.keys(el).some((k) => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$") || k.startsWith("__reactEventHandlers$"));
      if (react) {
        const r = await AB.pageCall("fill", { path: AB.pathTo(el), method: "react", value, eventOptions: {} });
        if (r.ok) return true;
      }
      return AB.writeText(el, value);
    }
  }
};

// Read back what a control currently holds (for status reporting).
AB.readBack = (el) => {
  if (!el) return "";
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked ? "checked" : "";
  if (el instanceof HTMLInputElement && el.type === "file") return el.files?.[0]?.name || "";
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.text?.trim() || el.value || "";
  if ("value" in el) return el.value ?? "";
  return el.textContent?.trim() || "";
};
