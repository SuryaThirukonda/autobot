// Live smoke test: load Autobot into an owned Chrome for Testing, open a real job posting, fill it, screenshot,
// and read back the values. It NEVER clicks submit. Usage: node tests/live.mjs <url> [--headed]
import { chromium } from "playwright-core";
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(here, ".."); const extDir = path.join(root, "autobot");
const url = process.argv[2]; if (!url) { console.error("usage: node tests/live.mjs <url> [--headed]"); process.exit(2); }
const headed = process.argv.includes("--headed");
// tests/profile.local.json (git-ignored, your real profile) wins over the sample when present.
const profileFile = fs.existsSync(path.join(here, "profile.local.json")) ? "profile.local.json" : "profile.sample.json";
const PROFILE = JSON.parse(fs.readFileSync(path.join(here, profileFile), "utf8"));
console.log("profile:", profileFile);
const RESUME = { name: "autobot-test-resume.pdf", type: "application/pdf", dataBase64: Buffer.from("%PDF-1.4\n% autobot test resume (not a real document)\n").toString("base64") };
const findChrome = () => { if (process.env.AUTOBOT_CHROME) return process.env.AUTOBOT_CHROME; const pw = path.join(os.homedir(), ".cache", "ms-playwright"); for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const p = path.join(pw, d, "chrome-linux64/chrome"); if (fs.existsSync(p)) return p; } };
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-live-"));
// AUTOBOT_EXTRA_EXT=/path/to/another/unpacked/extension loads a second extension (e.g. Simplify) to test coexistence.
const extList = [extDir, ...(process.env.AUTOBOT_EXTRA_EXT ? [process.env.AUTOBOT_EXTRA_EXT] : [])].join(",");
const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false, executablePath: findChrome(), args: [`--disable-extensions-except=${extList}`, `--load-extension=${extList}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run", "--window-size=1280,1000"], viewport: { width: 1280, height: 1000 } });
try {
  // Pick Autobot's worker (another extension may also have one).
  const isOurs = (w) => w.url().endsWith("/background.js") && !/pbanhock|odcnpip/.test(w.url());
  let sw = ctx.serviceWorkers().find(isOurs);
  while (!sw) { const w = await ctx.waitForEvent("serviceworker", { timeout: 15000 }); if (isOurs(w) && !/_metadata/.test(w.url())) sw = w; }
  const extId = new URL(sw.url()).host;
  const opt = await ctx.newPage(); await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate(([profile, resume]) => chrome.storage.local.set({ profile, resume, settings: { testHooks: true, showPanel: true, heuristics: true, debug: true } }), [PROFILE, RESUME]); await opt.close();
  const page = await ctx.newPage();
  page.on("console", (m) => { if (/\[autobot\]/.test(m.text())) console.log("  ", m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.autobotReady === "1", null, { timeout: 20000 });
  console.log("detected:", await page.evaluate(() => document.documentElement.dataset.autobotDetected));
  await page.evaluate(() => window.postMessage({ __autobot: "cmd", type: "fill" }, "*"));
  await page.waitForFunction(() => document.documentElement.dataset.autobotDone, null, { timeout: 120000 });
  const summary = JSON.parse(await page.evaluate(() => document.documentElement.dataset.autobotDone));
  console.log(`ats=${summary.ats} filled=${summary.filled}`);
  for (const [k, s, d] of summary.statuses) console.log(`  ${s.padEnd(10)} ${k.padEnd(36)} ${d}`);
  // Read back visible controls (no submit!).
  const values = await page.evaluate(() => Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]), textarea, select")).filter((e) => e.offsetParent !== null || e.type === "file").map((e) => ({ id: e.id || e.name || e.getAttribute("aria-label") || e.getAttribute("data-automation-id") || e.tagName, type: e.type, value: e.type === "file" ? (e.files[0]?.name || "") : e.type === "checkbox" || e.type === "radio" ? String(e.checked) : (e.value || "").slice(0, 60) })).filter((v) => v.value));
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
  const shot = path.join(root, "tests", "out-live.png"); await page.screenshot({ path: shot, fullPage: false }); console.log("screenshot:", shot);
} finally { await ctx.close().catch(() => {}); fs.rmSync(userDataDir, { recursive: true, force: true }); }
