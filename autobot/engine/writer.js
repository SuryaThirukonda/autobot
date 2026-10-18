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

// File upload from a stored { name, type, dataBase64 }.
AB.writeFile = (input, file) => {
  if (!file?.dataBase64) return false;
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
  if (typeToSearch && input.matches("input, textarea")) await AB.writeText(input, want[0], { blur: false });
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
  opt.scrollIntoView({ block: "nearest" });
  AB.fire(opt, ["mousemove", "mouseover", "mousedown", "mouseup", "click"]);
  await AB.sleep(150);
  // Verify the menu closed (commit). If it is still open, commit the focused option with Enter.
  if (AB.collectOptions(optSel).filter((o) => !before.has(o)).length) {
    AB.fire(input, "keydown", { key: "Enter", code: "Enter", keyCode: 13 });
    await AB.sleep(120);
  }
  return true;
};

// ---------- dispatcher ----------
// method: default | defaultWithoutBlur | react | click | select | checkbox | radio | combobox | upload | jquery | setValueOnly | clear | keypress(Enter)
AB.write = async (el, method, value, ctx = {}) => {
  method = method || "default";
  if (!el) return false;
  const synonyms = ctx.synonyms;
  if (el instanceof HTMLSelectElement && !["click", "jquery", "react"].includes(method)) return AB.writeSelect(el, value, synonyms);
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
    case "combobox": return AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms });
    case "react": case "jquery": case "reactClick": {
      const r = await AB.pageCall("fill", { path: AB.pathTo(el), method, value, eventOptions: ctx.eventOptions || {} });
      if (r.ok) return true;
      AB.log("page method failed, falling back", method, r.error);
      return isCombo ? AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms }) : AB.writeText(el, value);
    }
    case "defaultWithoutBlur": return AB.writeText(el, value, { blur: false });
    case "default": default: {
      if (isCombo) return AB.writeCombobox(el, value, { optionsPath: ctx.optionsPath, synonyms });
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
  if ("value" in el) return el.value ?? "";
  return el.textContent?.trim() || "";
};
