// Autobot engine: shadow-DOM status panel.
var AB = globalThis.AB || (globalThis.AB = {});

AB.panel = (() => {
  let host, root, list, title, btnFill, btnStop, btnNext, onFill, onStop, onNext;
  const css = `
    :host { all: initial; }
    .box { position: fixed; right: 12px; bottom: 12px; width: 320px; max-height: 60vh; z-index: 2147483647;
      background: #111827; color: #e5e7eb; font: 13px/1.4 system-ui, sans-serif; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); display: flex; flex-direction: column; overflow: hidden; }
    .hdr { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #0b1220; }
    .hdr b { flex: 1; font-weight: 600; }
    button { border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; font: inherit; }
    .fill { background: #22c55e; color: #052e16; font-weight: 600; } .stop { background: #ef4444; color: #fff; } .next { background: #3b82f6; color: #fff; } .x { background: transparent; color: #9ca3af; }
    ul { list-style: none; margin: 0; padding: 6px 12px 10px; overflow: auto; }
    li { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #1f2937; }
    li span.k { flex: 1; color: #d1d5db; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li span.d { color: #9ca3af; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .filled { color: #4ade80; } .skipped, .absent { color: #6b7280; } .error, .not-found { color: #f87171; } .unknown { color: #fbbf24; } .filling { color: #60a5fa; }
    .sub { padding: 0 12px 8px; color: #9ca3af; font-size: 12px; }
  `;
  const ensure = () => {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-autobot-panel", "1");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}</style>
      <div class="box">
        <div class="hdr"><b>Autobot</b><button class="fill">Fill</button><button class="next" title="Click continue/next">Next</button><button class="stop">Stop</button><button class="x" title="Hide">✕</button></div>
        <div class="sub"></div>
        <ul></ul>
      </div>`;
    list = root.querySelector("ul"); title = root.querySelector(".sub");
    btnFill = root.querySelector(".fill"); btnStop = root.querySelector(".stop"); btnNext = root.querySelector(".next");
    btnFill.onclick = () => onFill?.(); btnStop.onclick = () => onStop?.(); btnNext.onclick = () => onNext?.();
    root.querySelector(".x").onclick = () => host.remove();
    document.documentElement.appendChild(host);
  };
  return {
    show({ subtitle, fill, stop, next }) { ensure(); onFill = fill; onStop = stop; onNext = next; if (subtitle) title.textContent = subtitle; },
    subtitle(t) { ensure(); title.textContent = t; },
    clear() { ensure(); list.innerHTML = ""; },
    status(key, status, detail) {
      ensure();
      let li = list.querySelector(`li[data-k="${CSS.escape(key)}"]`);
      if (!li) { li = document.createElement("li"); li.dataset.k = key; li.innerHTML = `<span class="k"></span><span class="s"></span><span class="d"></span>`; list.appendChild(li); }
      li.querySelector(".k").textContent = key;
      const s = li.querySelector(".s"); s.textContent = status; s.className = `s ${status}`;
      li.querySelector(".d").textContent = detail || "";
      li.scrollIntoView({ block: "nearest" });
    },
    remove() { host?.remove(); },
  };
})();
