// Live smoke test: load autobot into an owned Chrome for Testing, open a real job posting, and fill it through the
// extension's own message path (extension page -> service worker -> content script, as the toolbar popup does).
// Prints every status, reads the values back and takes a screenshot. It NEVER clicks submit.
// Usage: node tests/live.mjs <url> [--headed] [--ext=legacy/autobot-v1]
// The browser loads a temporary copy of the extension without configs/profile.default.json. The profile comes from
// tests/profile.local.json (git-ignored, your real profile) when present, else tests/profile.sample.json.
// AUTOBOT_SETTINGS='{"searchAliases":{...}}' merges extra settings; AUTOBOT_EXTRA_EXT loads a second extension.
import { chromium } from "playwright-core";
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { fileURLToPath } from "node:url";
import { stageExtension } from "./stage-ext.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(here, ".."); const extArg = process.argv.find((x) => x.startsWith("--ext=")); const extDir = path.resolve(root, extArg ? extArg.slice(6) : process.env.AUTOBOT_EXT || "autobot");
const url = process.argv[2]; if (!url || url.startsWith("--")) { console.error("usage: node tests/live.mjs <url> [--headed] [--ext=<folder>]"); process.exit(2); }
const headed = process.argv.includes("--headed");
const profileFile = fs.existsSync(path.join(here, "profile.local.json")) ? "profile.local.json" : "profile.sample.json";
const PROFILE = JSON.parse(fs.readFileSync(path.join(here, profileFile), "utf8"));
console.log("profile:", profileFile);
const RESUME = { name: "autobot-test-resume.pdf", type: "application/pdf", dataBase64: Buffer.from("%PDF-1.4\n% autobot test resume (not a real document)\n").toString("base64") };
const findChrome = () => { if (process.env.AUTOBOT_CHROME) return process.env.AUTOBOT_CHROME; const pw = path.join(os.homedir(), ".cache", "ms-playwright"); if (!fs.existsSync(pw)) return undefined; for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const p = path.join(pw, d, "chrome-linux64/chrome"); if (fs.existsSync(p)) return p; } };
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-live-"));
const staged = stageExtension(extDir, { tag: "live-ext" });
// AUTOBOT_EXTRA_EXT=/path/to/another/unpacked/extension loads a second extension (e.g. Simplify) to test coexistence.
const extList = [staged.dir, ...(process.env.AUTOBOT_EXTRA_EXT ? [process.env.AUTOBOT_EXTRA_EXT] : [])].join(",");
const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, executablePath: findChrome(), args: [`--disable-extensions-except=${extList}`, `--load-extension=${extList}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run", "--window-size=1280,1000"], viewport: { width: 1280, height: 1000 } });
try {
  // Pick autobot's worker (another extension may also have one).
  const isOurs = (w) => w.url().endsWith("/background.js") && !/pbanhock|odcnpip/.test(w.url());
  let sw = ctx.serviceWorkers().find(isOurs);
  while (!sw) { const w = await ctx.waitForEvent("serviceworker", { timeout: 15000 }); if (isOurs(w) && !/_metadata/.test(w.url())) sw = w; }
  const extId = new URL(sw.url()).host;
  // An extension page drives the run: the storage write, then the same bg:detect / bg:fill messages the popup sends.
  // onInstalled opens options.html too; that navigation can interrupt ours, so retry once.
  const ext = await ctx.newPage(); try { await ext.goto(`chrome-extension://${extId}/options.html`); } catch { await new Promise((r) => setTimeout(r, 500)); await ext.goto(`chrome-extension://${extId}/options.html`); }
  await ext.evaluate(([profile, resume, extra]) => chrome.storage.local.set({ profile, resume, settings: { showPanel: true, heuristics: true, debug: true, ...extra } }), [PROFILE, RESUME, JSON.parse(process.env.AUTOBOT_SETTINGS || "{}")]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (/\[autobot\]/.test(m.text())) console.log("  ", m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: "load" });
  // Single-page ATSs (Ashby, Workday) fetch the form after load: give them until the network goes quiet.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // Find the job tab the way the extension does (host permission <all_urls> allows url filters), then wait until
  // its content script answers.
  const pattern = new URL(page.url()).origin + "/*";
  const tabId = await ext.evaluate(async (pat) => (await chrome.tabs.query({ url: pat }))[0]?.id, pattern);
  if (!tabId) throw new Error(`no tab matches ${pattern}`);
  const booted = await ext.evaluate(async (tid) => {
    for (let i = 0; i < 80; i++) {
      try { const r = await chrome.tabs.sendMessage(tid, { type: "autobot:status" }, { frameId: 0 }); if (r?.booted) return true; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }, tabId);
  console.log("content script:", booted ? "ready" : "not answering yet (bg:detect injects it)");
  console.log("detected:", JSON.stringify(await ext.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:detect", tabId: tid }), tabId)));
  await page.bringToFront(); // background tabs throttle timers, which would slow the search waits
  const summary = await ext.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:fill", tabId: tid }), tabId);
  if (!summary?.ok) console.log("fill did not run:", JSON.stringify(summary));
  console.log(`ats=${summary?.ats} filled=${summary?.filled}`);
  for (const [k, s, d] of summary?.statuses || []) if (s !== "filling") console.log(`  ${s.padEnd(10)} ${k.padEnd(36)} ${d}`);
  // Read back visible controls (no submit!).
  const values = await page.evaluate(() => Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]), textarea, select")).filter((e) => e.offsetParent !== null || e.type === "file").map((e) => ({ id: e.id || e.name || e.getAttribute("aria-label") || e.getAttribute("data-automation-id") || e.tagName, type: e.type, value: e.type === "file" ? (e.files[0]?.name || "") : e.type === "checkbox" || e.type === "radio" ? String(e.checked) : (e.value || "").slice(0, 60) })).filter((v) => v.value));
  const hiddenEdu = await page.evaluate(() => Array.from(document.querySelectorAll("input[type=hidden]")).filter((e) => /school|degree|discipline|location|latitude|longitude/i.test(e.id + " " + e.name)).map((e) => `${e.id || e.name}=${e.value}`));
  if (hiddenEdu.length) console.log("hidden education/location inputs:", hiddenEdu.join("  "));
  // Listbox buttons (Duolingo's month picker) show their choice beside the button, not as a control value.
  const picks = await page.evaluate(() => { const t = (n) => (n?.innerText || "").replace(/\s+/g, " ").trim(); return Array.from(document.querySelectorAll("button[aria-haspopup=listbox]")).map((b) => ({ id: b.closest("[id]")?.id || "", text: t(b) || t(b.parentElement) })).filter((x) => x.text && !/^select\b/i.test(x.text)); });
  if (picks.length) { console.log("listbox buttons showing a choice:"); for (const x of picks) console.log(`  ${x.id.slice(0, 40).padEnd(40)} = ${x.text.slice(0, 60)}`); }
  // react-selects (Greenhouse job-boards) show their choice beside the input; the input's own value stays empty.
  const rsel = await page.evaluate(() => { const t = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim(); return Array.from(document.querySelectorAll("[class*='select__control']")).map((c) => { const id = c.querySelector("input")?.id || ""; return { id, q: id ? t(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : "", text: Array.from(c.querySelectorAll("[class*='single-value'], [class*='multi-value__label']")).map(t).join(" | ") }; }).filter((x) => x.text); });
  if (rsel.length) { console.log("react-select choices:"); for (const x of rsel) console.log(`  ${(x.id + " " + x.q).slice(0, 56).padEnd(56)} = ${x.text.slice(0, 60)}`); }
  console.log("non-empty controls after fill:"); for (const v of values) if (v.type !== "radio" && v.type !== "checkbox") console.log(`  ${v.type.padEnd(9)} ${String(v.id).slice(0, 40).padEnd(40)} = ${v.value}`);
  // Radio/checkbox groups: question text + what is checked (so a wrong tick is visible).
  const groups = await page.evaluate(() => {
    const txt = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const byName = new Map();
    for (const r of document.querySelectorAll("input[type=radio], input[type=checkbox]")) { const k = r.name || r.id; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
    const out = [];
    for (const [name, inputs] of byName) {
      const first = inputs[0]; let q = ""; let box = first.closest("label")?.parentElement || first.parentElement;
      for (let i = 0; box && i < 6 && !q; i++, box = box.parentElement) { const c = Array.from(box.querySelectorAll("legend, [class*='label'], [class*='question'], h3, h4, p, span, div")).find((c) => !c.contains(first) && !c.querySelector("input") && txt(c).length > 3 && txt(c).length < 200); if (c) q = txt(c); }
      const checked = inputs.filter((i) => i.checked).map((i) => txt(i.closest("label")) || txt(document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) || i.value);
      out.push({ type: first.type, q: q.slice(0, 70), options: inputs.length, checked });
    }
    return out;
  });
  console.log("choice groups (question → checked):"); for (const g of groups) console.log(`  ${g.type.padEnd(8)} [${String(g.options).padStart(2)}] ${g.q.padEnd(72)} → ${g.checked.join(" | ") || "(none)"}`);
  const layout = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const fixed = Array.from(document.querySelectorAll("html > div, body > div")).filter((d) => getComputedStyle(d).position === "fixed" || d.shadowRoot).map((d) => { const inner = d.shadowRoot?.querySelector(".col, .column, [class*='panel']"); const r = (inner || d).getBoundingClientRect(); return { id: d.id || d.getAttribute("data-autobot-panel") && "autobot" || d.className?.toString().slice(0, 30) || d.tagName, left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }; }); return { htmlMarginRight: cs.marginRight, htmlMaxWidth: cs.maxWidth, bodyWidth: document.body.getBoundingClientRect().width, scrollY: window.scrollY, fixed: fixed.filter((f) => f.width > 100) }; });
  console.log("layout:", JSON.stringify(layout));
  const shot = path.join(root, "tests", "out-live.png"); await page.screenshot({ path: shot, fullPage: false }); console.log("screenshot:", shot);
} finally { await ctx.close().catch(() => {}); fs.rmSync(userDataDir, { recursive: true, force: true }); staged.cleanup(); }
