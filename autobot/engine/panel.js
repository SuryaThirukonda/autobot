// Autobot engine: right-hand sidebar panel (shadow DOM), modelled on the Simplify / Jobright side columns:
// a fixed 384px white column that reserves page margin, header with logo + actions, tabs, job card, one big
// primary action, resume row, and a per-field status sheet.
var AB = globalThis.AB || (globalThis.AB = {});

AB.panel = (() => {
  const W = 384;
  let host, root, els = {}, handlers = {}, collapsed = false, counts = { filled: 0, skipped: 0, unknown: 0, error: 0, absent: 0 };
  let last = {}; // last show() args and status rows, re-applied when the page re-renders and drops our host
  const rows = new Map();
  let reserveStyle = null;
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .col { position: fixed; top: 0; right: 0; width: ${W}px; height: 100vh; z-index: 2147483647; background: #fff; border-left: 1px solid #eceff5;
      box-shadow: -4px 0 12px rgba(0,0,0,.03); font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #263137; display: flex; flex-direction: column; }
    .col.hidden { display: none; }
    .hdr { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 16px; flex: 0 0 auto; }
    .logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg,#22c55e,#0ea5e9); display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 15px; }
    .brand { font-size: 20px; font-weight: 700; flex: 1; letter-spacing: -.01em; }
    .ic { border: 1px solid #eceff5; background: #fff; border-radius: 8px; width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer; color: #5b6770; font-size: 15px; }
    .ic:hover { background: #f6f8fb; }
    .tabs { display: flex; margin: 0 16px; padding: 4px; background: #f3f5f9; border-radius: 10px; gap: 4px; flex: 0 0 auto; }
    .tab { flex: 1; text-align: center; padding: 7px 0; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; color: #5b6770; }
    .tab.on { background: #fff; color: #263137; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .sheet { margin: 14px 0 0; padding: 14px 16px 24px; flex: 1 1 auto; overflow: auto; border: 1px solid #eceff5; border-bottom: 0; border-radius: 14px 14px 0 0; box-shadow: 0 -2px 8px rgba(0,0,0,.06); }
    .card { border: 1px solid #eceff5; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; background: #fff; }
    .card.soft { background: #f8fafc; }
    .job { display: flex; gap: 12px; align-items: flex-start; }
    .job .mark { width: 44px; height: 44px; border-radius: 10px; background: #0f172a; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 18px; flex: 0 0 auto; }
    .job .t { font-weight: 700; font-size: 15px; line-height: 1.3; }
    .job .c { color: #6b7785; font-size: 13px; margin-top: 2px; }
    .badge { display: inline-block; margin-top: 8px; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: #e9fbff; color: #0b6b7d; border: 1px solid rgba(62,192,221,.25); }
    .badge.gray { background: #f3f5f9; color: #5b6770; border-color: #eceff5; }
    .primary { width: 100%; height: 48px; border: 0; border-radius: 12px; background: #3ec0dd; color: #052e3a; font-weight: 700; font-size: 16px; cursor: pointer; box-shadow: 0 6px 16px rgba(62,192,221,.35); }
    .primary:hover { background: #33b3d0; } .primary:disabled { background: #cfe9f0; color: #6b7785; box-shadow: none; cursor: default; }
    .row2 { display: flex; gap: 8px; margin-top: 8px; }
    .sec { flex: 1; height: 38px; border: 1px solid #eceff5; background: #fff; border-radius: 10px; font-weight: 600; cursor: pointer; color: #263137; font-size: 13px; }
    .sec:hover { background: #f6f8fb; } .sec.danger { color: #b42318; }
    .lbl { font-weight: 700; font-size: 13px; margin: 14px 0 8px; display: flex; align-items: center; justify-content: space-between; }
    .lbl .cnt { font-weight: 500; color: #6b7785; font-size: 12px; }
    .resume { display: flex; align-items: center; gap: 10px; border: 1px dashed #d7dde6; border-radius: 10px; padding: 10px 12px; color: #6b7785; font-size: 13px; }
    .resume b { color: #263137; font-weight: 600; }
    .sub { color: #6b7785; font-size: 12.5px; margin-top: 10px; min-height: 16px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid #f1f4f8; font-size: 13px; }
    li .k { color: #263137; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li .d { color: #8a95a3; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #cbd5e1; justify-self: center; }
    .filled .dot { background: #22c55e; } .skipped .dot, .absent .dot { background: #cbd5e1; } .error .dot, .not-found .dot { background: #ef4444; } .unknown .dot { background: #f59e0b; } .filling .dot { background: #3b82f6; }
    .empty { color: #8a95a3; font-size: 13px; padding: 8px 0; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 10px; font-size: 13px; } .kv div:nth-child(odd) { color: #6b7785; }
    .pill { position: fixed; top: 50%; right: 0; transform: translateY(-50%); z-index: 2147483647; background: #fff; border: 1px solid #eceff5; border-right: 0; border-radius: 10px 0 0 10px; box-shadow: -4px 0 12px rgba(0,0,0,.08); padding: 10px 8px; cursor: pointer; display: none; align-items: center; gap: 6px; font: 600 12px Inter, system-ui, sans-serif; color: #263137; writing-mode: vertical-rl; }
    .pill.show { display: flex; }
    .pill .logo { width: 20px; height: 20px; font-size: 12px; writing-mode: horizontal-tb; }
    .filters { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .f { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 999px; border: 1px solid #eceff5; background: #fff; cursor: pointer; color: #5b6770; }
    .f.on { background: #263137; color: #fff; border-color: #263137; }
  `;
  // Another autofill sidebar (Simplify, Jobright) may already own the right edge: it reserves html margin-right and
  // pins a fixed column there. Sit to its left instead of fighting for the same pixels.
  let offset = 0;
  const foreignOffset = () => {
    reserveStyle?.remove();
    const m = parseFloat(getComputedStyle(document.documentElement).marginRight) || 0;
    const foreign = Array.from(document.querySelectorAll("body > div, html > div")).filter((d) => d !== host && !d.hasAttribute("data-autobot-panel") && getComputedStyle(d).position === "fixed" && (d.id || "").match(/simplify|jobright|jr-|helper/i));
    const widest = foreign.reduce((w, d) => Math.max(w, d.getBoundingClientRect().width), 0);
    return Math.min(640, Math.max(m >= 240 ? m : 0, widest >= 240 ? widest : 0));
  };
  const reserve = (on) => {
    if (on) {
      offset = foreignOffset();
      if (!reserveStyle) { reserveStyle = document.createElement("style"); reserveStyle.setAttribute("data-autobot-reserve", "1"); }
      const total = W + offset;
      reserveStyle.textContent = `html { margin-right: ${total}px !important; width: auto !important; min-width: 0 !important; max-width: calc(100% - ${total}px) !important; }`;
      if (!reserveStyle.isConnected) document.documentElement.appendChild(reserveStyle);
      if (els.col) { els.col.style.right = `${offset}px`; els.pill.style.right = `${offset}px`; }
    } else reserveStyle?.remove();
  };
  const jobInfo = () => {
    const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content?.trim();
    let title = meta("og:title") || document.querySelector("h1")?.innerText?.trim() || document.title;
    let company = meta("og:site_name") || "";
    const m = title.match(/^(.*?)\s+(?:at|@|-|\|)\s+(.+)$/);
    if (!company && m && m[2].length < 40) company = m[2];
    if (!company) company = location.hostname.replace(/^(www|jobs|boards|job-boards|apply|careers)\./, "").split(".")[0];
    return { title: title.slice(0, 120), company: company.slice(0, 60) };
  };
  const ensure = () => {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-autobot-panel", "1");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}</style>
      <div class="pill" title="Open autobot"><span class="logo">A</span>autobot</div>
      <div class="col">
        <div class="hdr"><div class="logo">A</div><div class="brand">autobot</div>
          <button class="ic settings" title="Profile & settings">⚙</button><button class="ic collapse" title="Hide panel">›</button></div>
        <div class="tabs"><div class="tab on" data-t="autofill">⚡ Autofill</div><div class="tab" data-t="fields">☰ Fields</div><div class="tab" data-t="profile">◯ Profile</div></div>
        <div class="sheet">
          <div class="pane" data-p="autofill">
            <div class="card job"><div class="mark">·</div><div><div class="t">—</div><div class="c">—</div><span class="badge gray">No application form detected</span></div></div>
            <button class="primary fill">Autofill this page</button>
            <div class="row2"><button class="sec next" title="Click the form's Continue/Next button">Next page</button><button class="sec stop danger">Stop</button></div>
            <div class="sub"></div>
            <div class="lbl">Resume</div><div class="resume"><span>📄</span><span class="rtext">No resume uploaded</span></div>
            <div class="lbl">Fields <span class="cnt summary"></span></div><ul class="list short"></ul>
          </div>
          <div class="pane" data-p="fields" style="display:none">
            <div class="filters"><span class="f on" data-f="all">All</span><span class="f" data-f="filled">Filled</span><span class="f" data-f="unknown">Needs you</span><span class="f" data-f="skipped">Skipped</span><span class="f" data-f="error">Errors</span></div>
            <ul class="list full"></ul><div class="empty">Run Autofill to see per-field results.</div>
          </div>
          <div class="pane" data-p="profile" style="display:none">
            <div class="card soft kv"></div>
            <button class="sec edit" style="width:100%">Edit profile &amp; saved answers</button>
            <div class="sub">Your profile lives in this browser's extension storage. autobot never submits an application.</div>
          </div>
        </div>
      </div>`;
    els = {
      col: root.querySelector(".col"), pill: root.querySelector(".pill"), title: root.querySelector(".job .t"), company: root.querySelector(".job .c"), mark: root.querySelector(".job .mark"),
      badge: root.querySelector(".job .badge"), fill: root.querySelector(".fill"), next: root.querySelector(".next"), stop: root.querySelector(".stop"), sub: root.querySelector(".sub"),
      rtext: root.querySelector(".rtext"), summary: root.querySelector(".summary"), short: root.querySelector(".list.short"), full: root.querySelector(".list.full"), empty: root.querySelector(".empty"), kv: root.querySelector(".kv"),
    };
    els.fill.onclick = () => handlers.fill?.(); els.next.onclick = () => handlers.next?.(); els.stop.onclick = () => handlers.stop?.();
    root.querySelector(".settings").onclick = () => handlers.settings?.(); root.querySelector(".edit").onclick = () => handlers.settings?.();
    root.querySelector(".collapse").onclick = () => api.collapse(true); els.pill.onclick = () => api.collapse(false);
    root.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { root.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t)); root.querySelectorAll(".pane").forEach((p) => (p.style.display = p.dataset.p === t.dataset.t ? "" : "none")); }));
    root.querySelectorAll(".f").forEach((f) => (f.onclick = () => { root.querySelectorAll(".f").forEach((x) => x.classList.toggle("on", x === f)); const v = f.dataset.f; els.full.querySelectorAll("li").forEach((li) => (li.style.display = v === "all" || li.classList.contains(v) || (v === "error" && li.classList.contains("not-found")) ? "" : "none")); }));
    document.documentElement.appendChild(host);
    const ji = jobInfo(); els.title.textContent = ji.title || "—"; els.company.textContent = ji.company || location.hostname; els.mark.textContent = (ji.company || "A").slice(0, 1).toUpperCase();
    reserve(!collapsed);
    // Other sidebars (Simplify, Jobright) usually mount after us: keep re-measuring and slide left when one appears.
    if (!AB.panel._offsetTimer) {
      let ticks = 0;
      AB.panel._offsetTimer = setInterval(() => { ticks++; if (!host?.isConnected) return; const before = offset; reserve(!collapsed); if (offset !== before) AB.log("panel offset ->", offset); if (ticks > 60) { clearInterval(AB.panel._offsetTimer); AB.panel._offsetTimer = setInterval(() => host?.isConnected && reserve(!collapsed), 5000); } }, 1000);
    }
    // Re-apply state lost with the previous host.
    if (last.ats) { els.badge.textContent = `${last.ats} · ${last.matchedBy === "url" ? "detected by URL" : last.matchedBy === "dom-probe" ? "detected in page" : "heuristic form"}`; els.badge.classList.remove("gray"); }
    if (last.profile) api.setProfile(last.profile, last.resume);
    if (last.subtitle) els.sub.textContent = last.subtitle;
    if (last.busy) { els.fill.disabled = true; els.fill.textContent = "Autofilling…"; }
    for (const [key, [status, detail]] of rows) { for (const list of [els.short, els.full]) { if (list === els.short && status === "absent") continue; list.appendChild(li(key, status, detail)); } }
    if (rows.size) els.empty.style.display = "none";
  };
  const li = (key, status, detail) => { const n = document.createElement("li"); n.dataset.k = key; n.className = status; n.innerHTML = `<span class="dot"></span><span class="k"></span><span class="d"></span>`; n.querySelector(".k").textContent = key.replace(/^\? /, ""); n.querySelector(".d").textContent = detail || status; return n; };
  const api = {
    show({ subtitle, fill, stop, next, settings, ats, matchedBy, profile, resume } = {}) {
      ensure();
      Object.assign(handlers, { fill, stop, next, settings });
      Object.assign(last, { ats: ats ?? last.ats, matchedBy: matchedBy ?? last.matchedBy, profile: profile ?? last.profile, resume: resume ?? last.resume, subtitle: subtitle ?? last.subtitle });
      if (subtitle) els.sub.textContent = subtitle;
      if (ats) { els.badge.textContent = `${ats} · ${matchedBy === "url" ? "detected by URL" : matchedBy === "dom-probe" ? "detected in page" : "heuristic form"}`; els.badge.classList.remove("gray"); }
      if (profile) api.setProfile(profile, resume);
    },
    setProfile(profile, resume) {
      ensure();
      last.profile = profile; last.resume = resume;
      els.rtext.innerHTML = resume?.name ? `<b>${resume.name.replace(/[<>&]/g, "")}</b> ready to attach` : "No resume uploaded — add one in settings";
      const rows = [["Name", [profile.first_name, profile.last_name].filter(Boolean).join(" ")], ["Email", profile.email], ["Phone", profile.phone], ["Location", [profile.city, profile.state].filter(Boolean).join(", ")], ["Work auth (US)", profile.work_auth_us ? "Yes" : "No"], ["Sponsorship", profile.sponsorship ? "Yes" : "No"], ["Education", `${(profile.education || []).length} entr${(profile.education || []).length === 1 ? "y" : "ies"}`], ["Experience", `${(profile.experience || []).length} entr${(profile.experience || []).length === 1 ? "y" : "ies"}`], ["Saved answers", String(Object.keys(profile.answers || {}).length)]];
      els.kv.innerHTML = rows.map(([k, v]) => `<div>${k}</div><div>${String(v || "—").replace(/[<>&]/g, "")}</div>`).join("");
    },
    subtitle(t) { ensure(); last.subtitle = t; els.sub.textContent = t; },
    busy(on) { ensure(); last.busy = on; els.fill.disabled = on; els.fill.textContent = on ? "Autofilling…" : "Autofill this page"; },
    clear() { ensure(); rows.clear(); els.short.innerHTML = ""; els.full.innerHTML = ""; counts = { filled: 0, skipped: 0, unknown: 0, error: 0, absent: 0 }; els.summary.textContent = ""; els.empty.style.display = "none"; },
    status(key, status, detail) {
      ensure();
      rows.set(key, [status, detail]);
      for (const list of [els.short, els.full]) {
        let n = list.querySelector(`li[data-k="${CSS.escape(key)}"]`);
        if (!n) { n = li(key, status, detail); list.appendChild(n); } else { n.className = status; n.querySelector(".d").textContent = detail || status; }
        if (list === els.short && status === "absent") n.remove(); // the short list shows only what matters on this page
      }
      counts[status in counts ? status : status === "not-found" ? "error" : "skipped"]++;
      els.summary.textContent = `${counts.filled} filled · ${counts.unknown} need you · ${counts.skipped + counts.absent} skipped${counts.error ? ` · ${counts.error} errors` : ""}`;
      els.short.lastElementChild?.scrollIntoView({ block: "nearest" });
    },
    collapse(on) { ensure(); collapsed = on; els.col.classList.toggle("hidden", on); els.pill.classList.toggle("show", on); reserve(!on); },
    remove() { host?.remove(); reserveStyle?.remove(); },
  };
  return api;
})();
