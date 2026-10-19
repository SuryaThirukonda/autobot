// Autobot engine: XPath/CSS resolution with shadow-root descent and %VALUE% templating.
var AB = globalThis.AB || (globalThis.AB = {});

// Evaluate one XPath (or CSS when prefixed "css:") against a context node.
// Supports "/shadow-root/" segments: "//x-host/shadow-root/.//input" descends into open shadow roots.
AB.query = (expr, ctx = document, all = false) => {
  ctx = ctx || document;
  if (typeof expr !== "string" || !expr.trim()) return all ? [] : null;
  if (expr.startsWith("css:")) {
    const sel = expr.slice(4);
    try {
      const root = ctx instanceof Document || ctx instanceof ShadowRoot || ctx instanceof Element ? ctx : document;
      return all ? Array.from(root.querySelectorAll(sel)) : root.querySelector(sel);
    } catch (e) { return all ? [] : null; }
  }
  const idx = expr.indexOf("/shadow-root/");
  if (idx !== -1) {
    const head = expr.slice(0, idx);
    const tail = expr.slice(idx + "/shadow-root/".length);
    const hosts = AB.query(head, ctx, true);
    const out = [];
    for (const h of hosts) {
      if (h.shadowRoot) {
        const t = tail.startsWith(".") ? tail : "." + tail;
        for (const child of h.shadowRoot.children) {
          const found = AB.query(t, child, true);
          out.push(...found);
          if (!all && out.length) return out[0];
        }
      }
    }
    return all ? out : out[0] || null;
  }
  try {
    const doc = ctx.ownerDocument || ctx;
    const it = doc.evaluate(expr, ctx, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const out = [];
    let n;
    while ((n = it.iterateNext())) { out.push(n); if (!all) break; }
    return all ? out : out[0] || null;
  } catch (e) {
    AB.log("bad xpath", expr, e.message);
    return all ? [] : null;
  }
};

AB.queryAny = (exprs, ctx, all = false) => {
  for (const e of AB.arr(exprs)) {
    const r = AB.query(e, ctx, all);
    if (all ? r.length : r) return r;
  }
  return all ? [] : null;
};

AB.xpathBool = (expr, ctx = document) => {
  try { return document.evaluate(expr, ctx, null, XPathResult.BOOLEAN_TYPE, null).booleanValue; } catch { return false; }
};

// XPath string literal (handles quotes safely).
AB.xq = (s) => {
  s = String(s);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return "concat(" + s.split('"').map((p) => `"${p}"`).join(", '\"', ") + ")";
};

// Replace %VALUE%, %UPPERVALUE%, %LOWERVALUE%, %INPUTPATH% placeholders.
AB.template = (expr, value, inputPath) => {
  if (typeof expr !== "string") return expr;
  const v = value === undefined || value === null ? "" : String(value);
  return expr
    .replace(/%UPPERVALUE%/g, v.toUpperCase())
    .replace(/%LOWERVALUE%/g, v.toLowerCase())
    .replace(/%VALUE%/g, v)
    .replace(/%INPUTPATH%/g, inputPath || "");
};
AB.hasValueTemplate = (expr) => AB.arr(expr).some((e) => typeof e === "string" && /%(UPPER|LOWER)?VALUE%/.test(e));

// Wait for an element matching any expr to appear (MutationObserver + timeout).
AB.waitFor = (exprs, { ctx = document, timeout = 4000, signal } = {}) =>
  new Promise((resolve) => {
    let done = false;
    const check = () => {
      const el = AB.queryAny(exprs, ctx);
      if (el) { finish(el); return true; }
      return false;
    };
    const finish = (v) => { if (done) return; done = true; obs.disconnect(); clearTimeout(t); resolve(v); };
    const obs = new MutationObserver(() => { check(); });
    const t = setTimeout(() => finish(null), timeout);
    if (signal) signal.addEventListener("abort", () => finish(null), { once: true });
    if (!check()) obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  });

AB.waitGone = (el, timeout = 4000) =>
  new Promise((resolve) => {
    if (!el || !el.isConnected) return resolve(true);
    const obs = new MutationObserver(() => { if (!el.isConnected) { obs.disconnect(); clearTimeout(t); resolve(true); } });
    const t = setTimeout(() => { obs.disconnect(); resolve(!el.isConnected); }, timeout);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });

// Absolute XPath of an element (for passing to the page world).
AB.pathTo = (el) => {
  if (!(el instanceof Element)) return null;
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `//*[@id=${AB.xq(el.id)}]`;
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && n !== document.documentElement) {
    let i = 1, s = n.previousElementSibling;
    while (s) { if (s.tagName === n.tagName) i++; s = s.previousElementSibling; }
    parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
    n = n.parentElement;
  }
  return "/html/" + parts.join("/");
};
