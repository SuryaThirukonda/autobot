// Exercise the real user path (toolbar popup → background → content script) without the test hook.
// Usage: AUTOBOT_CHROME=/path/to/chrome node tests/popup-path.mjs <url>
import { chromium } from "playwright-core"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(here, ".."); const ext = path.join(root, "autobot");
const url = process.argv[2]; const headed = process.argv.includes("--headed");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-popup-"));
const ctx = await chromium.launchPersistentContext(dir, { headless: false, executablePath: process.env.AUTOBOT_CHROME, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run"] });
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host; console.log("extension:", id);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || /autobot/i.test(m.text())) console.log("  page console:", m.type(), m.text().slice(0, 200)); });
  page.on("pageerror", (e) => console.log("  page error:", String(e).slice(0, 200)));
  sw.on("console", (m) => console.log("  sw console:", m.type(), m.text().slice(0, 200)));
  await page.goto(url, { waitUntil: "load" });
  const booted = await page.waitForFunction(() => document.documentElement.dataset.autobotDetected !== undefined, null, { timeout: 20000 }).then(() => true).catch(() => false);
  console.log("content script booted:", booted, "detected:", await page.evaluate(() => document.documentElement.dataset.autobotDetected ?? "(none)"));
  const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await popup.waitForTimeout(1000);
  console.log("popup status text:", await popup.evaluate(() => document.getElementById("status").textContent));
  // The popup resolves the active tab itself; here we target the job tab explicitly through the same background message.
  // Resolve the job tab by URL pattern (host permission <all_urls> makes url filters usable without the tabs permission).
  const pattern = new URL(url).origin + "/*";
  const job = (await popup.evaluate(async (pat) => (await chrome.tabs.query({ url: pat })).map((t) => ({ id: t.id })), pattern))[0];
  if (!job) throw new Error("job tab not found via chrome.tabs.query");
  await page.bringToFront();
  const detect = await popup.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:detect", tabId: tid }), job.id); console.log("bg:detect →", JSON.stringify(detect));
  const fill = await popup.evaluate((tid) => chrome.runtime.sendMessage({ type: "bg:fill", tabId: tid }), job.id); console.log("bg:fill →", JSON.stringify({ ok: fill?.ok, filled: fill?.filled, ats: fill?.ats, reason: fill?.reason, error: fill?.error, statuses: (fill?.statuses || []).filter((s) => s[1] !== "absent").map((s) => `${s[0]}:${s[1]}`) }));
  const shot = path.join(root, "tests", "out-popup-path.png"); await page.screenshot({ path: shot }); console.log("screenshot:", shot);
} finally { await ctx.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
