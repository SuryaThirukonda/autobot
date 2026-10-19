// The real user path without any test hook: the service worker seeds the profile from configs/profile.default.json,
// then the toolbar popup's messages (bg:detect, bg:fill) go through the service worker to the content script.
// Also checks that the page cannot read that profile file while it can still read the ATS configs. Never submits.
// Usage: node tests/popup-path.mjs <url> [--headed] [--ext=legacy/autobot-v1]   (AUTOBOT_CHROME overrides the binary)
// The seeded file is tests/profile.local.json when present, else tests/profile.sample.json, written into a temporary
// copy of the extension; your own configs/profile.default.json is never loaded.
import { chromium } from "playwright-core"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { stageExtension } from "./stage-ext.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(here, "..");
const extArg = process.argv.find((a) => a.startsWith("--ext=")); const extDir = path.resolve(root, extArg ? extArg.slice(6) : process.env.AUTOBOT_EXT || "autobot");
const url = process.argv[2]; if (!url || url.startsWith("--")) { console.error("usage: node tests/popup-path.mjs <url> [--headed] [--ext=<folder>]"); process.exit(2); }
const headed = process.argv.includes("--headed");
const profileFile = fs.existsSync(path.join(here, "profile.local.json")) ? "profile.local.json" : "profile.sample.json";
const staged = stageExtension(extDir, { tag: "popup-ext", profile: JSON.parse(fs.readFileSync(path.join(here, profileFile), "utf8")) });
console.log("seed file:", profileFile);
const findChrome = () => { if (process.env.AUTOBOT_CHROME) return process.env.AUTOBOT_CHROME; const pw = path.join(os.homedir(), ".cache", "ms-playwright"); if (!fs.existsSync(pw)) return undefined; for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const p = path.join(pw, d, "chrome-linux64/chrome"); if (fs.existsSync(p)) return p; } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-popup-"));
const ctx = await chromium.launchPersistentContext(dir, { headless: false, executablePath: findChrome(), args: [`--disable-extensions-except=${staged.dir}`, `--load-extension=${staged.dir}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run"] });
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host; console.log("extension:", id);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || /autobot/i.test(m.text())) console.log("  page console:", m.type(), m.text().slice(0, 200)); });
  page.on("pageerror", (e) => console.log("  page error:", String(e).slice(0, 200)));
  sw.on("console", (m) => console.log("  sw console:", m.type(), m.text().slice(0, 200)));
  await page.goto(url, { waitUntil: "load" });
  // Single-page ATSs (Ashby, Workday) fetch the form after load: give them until the network goes quiet.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await popup.waitForTimeout(1000);
  // Opened as a tab, the popup's "active tab" is itself, so its own status line is informational only.
  console.log("popup status text:", await popup.evaluate(() => document.getElementById("status").textContent));
  // The popup resolves the active tab itself; here the job tab is found by URL (host permission <all_urls> makes url
  // filters usable without the tabs permission) and targeted through the same background messages.
  const pattern = new URL(page.url()).origin + "/*";
  const job = (await popup.evaluate(async (pat) => (await chrome.tabs.query({ url: pat })).map((t) => ({ id: t.id })), pattern))[0];
  if (!job) throw new Error("job tab not found via chrome.tabs.query");
  const booted = await popup.evaluate(async (tid) => {
    for (let i = 0; i < 80; i++) {
      try { const r = await chrome.tabs.sendMessage(tid, { type: "autobot:status" }, { frameId: 0 }); if (r?.booted) return r; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }, job.id);
  console.log("content script booted:", JSON.stringify(booted));
  await page.bringToFront();
  const detect = await popup.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:detect", tabId: tid }), job.id); console.log("bg:detect →", JSON.stringify(detect));
  const fill = await popup.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:fill", tabId: tid }), job.id); console.log("bg:fill →", JSON.stringify({ ok: fill?.ok, filled: fill?.filled, ats: fill?.ats, reason: fill?.reason, error: fill?.error, statuses: (fill?.statuses || []).filter((s) => s[1] !== "absent" && s[1] !== "filling").map((s) => `${s[0]}:${s[1]}`) }));
  const seeded = await popup.evaluate(async () => { const r = await chrome.storage.local.get(["profileSeededFrom", "profile"]); return { from: r.profileSeededFrom || null, hasProfile: Boolean(r.profile?.first_name || r.profile?.email) }; });
  console.log("profile seeded by the service worker:", JSON.stringify(seeded));
  // web_accessible_resources: the page may fetch the ATS configs and page.js, never the profile or extension pages.
  const access = await page.evaluate(async (extId) => {
    const get = async (p) => { try { const r = await fetch(`chrome-extension://${extId}/${p}`); return r.ok ? `readable (${r.status})` : `http ${r.status}`; } catch (e) { return `blocked (${e.name})`; } };
    return { "configs/greenhouse.json": await get("configs/greenhouse.json"), "page.js": await get("page.js"), "configs/profile.default.json": await get("configs/profile.default.json"), "options.html": await get("options.html") };
  }, id);
  console.log("fetch from the web page:", JSON.stringify(access));
  const shot = path.join(root, "tests", "out-popup-path.png"); await page.screenshot({ path: shot }); console.log("screenshot:", shot);
} finally { await ctx.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); staged.cleanup(); }
