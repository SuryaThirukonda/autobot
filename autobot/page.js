// Autobot page-world script. Framework-aware writers that need access to page JS objects
// (React props/fiber handlers, jQuery). Talks to the content script over window.postMessage.
(() => {
  if (document.documentElement.dataset.autobotPage === "1") return;
  document.documentElement.dataset.autobotPage = "1";

  const byPath = (path) => {
    try {
      if (!path) return null;
      if (path.startsWith("css:")) return document.querySelector(path.slice(4));
      return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch { return null; }
  };
  const nativeSet = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const own = Object.getOwnPropertyDescriptor(el, "value")?.set;
    const inherited = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    // React's value tracker shadows the instance setter: write through the prototype setter so React sees the change.
    if (own && inherited && own !== inherited) inherited.call(el, value); else if (inherited) inherited.call(el, value); else el.value = value;
    try { el.setAttribute("value", value); } catch {}
  };
  const reactKey = (el) => Object.keys(el).find((k) => /^(__reactProps|__reactEventHandlers)\$/.test(k));
  const reactProps = (el) => { const k = reactKey(el); return k ? el[k] : null; };

  // Dispatch a DOM event and, when React props exist, also call the matching React handler directly
  // with nativeEvent attached (this is what makes controlled React inputs accept the value).
  const fireReact = (el, Ctor, type, handlerName, init = {}) => {
    const ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init });
    Object.defineProperty(ev, "target", { writable: false, value: el });
    Object.defineProperty(ev, "currentTarget", { writable: false, value: el });
    el.dispatchEvent(ev);
    const props = reactProps(el);
    if (props && typeof props[handlerName] === "function") { try { ev.nativeEvent = ev; props[handlerName](ev); } catch {} }
  };

  const methods = {
    react: ({ el, value, eventOptions }) => {
      if (el instanceof HTMLSelectElement) {
        fireReact(el, FocusEvent, "focus", "onFocus");
        nativeSet(el, value);
        fireReact(el, Event, "input", "onInput");
        fireReact(el, Event, "change", "onChange");
        fireReact(el, FocusEvent, "blur", "onBlur");
        return true;
      }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const want = value === undefined ? true : !(value === false || value === "false" || value === "No" || value === "no");
        if (el.checked !== want) { fireReact(el, FocusEvent, "focus", "onFocus"); el.click(); if (el.checked !== want) { el.checked = want; fireReact(el, Event, "input", "onInput"); fireReact(el, Event, "change", "onChange"); } }
        return el.checked === want;
      }
      if (el instanceof HTMLButtonElement || el.getAttribute("role") === "button") {
        fireReact(el, MouseEvent, "mousedown", "onMouseDown"); fireReact(el, MouseEvent, "mouseup", "onMouseUp"); fireReact(el, MouseEvent, "click", "onClick");
        return true;
      }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("unsupported element for react");
      const v = value === undefined || value === null ? "" : String(value);
      fireReact(el, FocusEvent, "focus", "onFocus");
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      fireReact(el, MouseEvent, "click", "onClick");
      fireReact(el, KeyboardEvent, "keydown", "onKeyDown", { key: v[0] || "a" });
      fireReact(el, KeyboardEvent, "keypress", "onKeyPress", { key: v[0] || "a" });
      nativeSet(el, v);
      fireReact(el, InputEvent, "input", "onInput", { inputType: "insertText", data: v });
      fireReact(el, KeyboardEvent, "keyup", "onKeyUp", { key: v[0] || "a" });
      fireReact(el, Event, "change", "onChange");
      if (!eventOptions?.skipBlur) { fireReact(el, FocusEvent, "blur", "onBlur"); el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }
      return el.value === v;
    },
    reactClick: ({ el }) => {
      fireReact(el, FocusEvent, "focus", "onFocus"); fireReact(el, MouseEvent, "mousedown", "onMouseDown"); fireReact(el, MouseEvent, "mouseup", "onMouseUp"); fireReact(el, MouseEvent, "click", "onClick");
      return true;
    },
    jquery: ({ el, value }) => {
      const $ = window.jQuery || window.$;
      if (!$ || !$.fn) throw new Error("no jQuery");
      const $el = $(el);
      if (el instanceof HTMLSelectElement) { $el.trigger("focus").val(value).trigger("input").trigger("change"); return true; }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) { $el.prop("checked", Boolean(value)).trigger("input").trigger("change"); return true; }
      $el.trigger("focus").trigger("click").trigger("keydown").val(value).trigger("input").trigger("keyup").trigger("change");
      return $el.val() === value;
    },
    // Read React-select-like component options when not rendered (best effort): returns labels seen in props.options
    options: ({ el }) => {
      let n = el, depth = 0;
      while (n && depth < 6) {
        const props = reactProps(n);
        const opts = props?.options || props?.children?.props?.options;
        if (Array.isArray(opts)) return opts.map((o) => (typeof o === "string" ? o : o?.label ?? o?.value ?? "")).filter(Boolean);
        n = n.parentElement; depth++;
      }
      return [];
    },
    hasReact: ({ el }) => Boolean(reactKey(el)),
  };

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.__autobot !== "req") return;
    const { id, method, params } = ev.data;
    const reply = (payload) => window.postMessage({ __autobot: "res", id, ...payload }, "*");
    try {
      const el = byPath(params?.path);
      if (!el) return reply({ ok: false, error: "element not found" });
      const fn = method === "fill" ? methods[params.method] : methods[method];
      if (!fn) return reply({ ok: false, error: `unknown method ${params?.method || method}` });
      const result = fn({ el, value: params?.value, eventOptions: params?.eventOptions || {} });
      Promise.resolve(result).then((r) => reply({ ok: r !== false, result: r })).catch((e) => reply({ ok: false, error: String(e?.message || e) }));
    } catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
  });
})();
