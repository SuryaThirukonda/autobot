#!/usr/bin/env node
// Use Autobot's fill engine from Playwright WITHOUT the extension.
//
//   import { autobotFill } from "./tools/playwright-fill.mjs";
//   const result = await autobotFill(page, { profile, resume });   // page: a Playwright Page already on the form
//
//   CLI demo:  node tools/playwright-fill.mjs <job url> [--headed]
//
// The engine (autobot/engine/*.js + page.js) is injected with page.evaluate, which is not subject to the site's CSP,
// so it works on pages that block <script> tags. Everything runs in the page's main world, so the React bridge in
// page.js is called in-process. Nothing here clicks submit.
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "autobot");
const ENGINE = ["engine/util.js", "engine/xpath.js", "engine/profile.js", "engine/detect.js", "engine/heuristics.js", "engine/writer.js", "engine/plan.js", "engine/panel.js"];

export const loadConfigs = () => fs.readdirSync(path.join(ext, "configs")).filter((f) => f.endsWith(".json") && !f.startsWith("profile.")).map((f) => ({ id: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(ext, "configs", f), "utf8")) }));

/**
 * Fill the form on `page` with Autobot's engine.
 * @param page Playwright Page (or Frame) already navigated to the application form.
 * @param opts { profile, resume?: {name,type,dataBase64}, settings?: {heuristics?: boolean, debug?: boolean}, configs?: [...], panel?: boolean }
 * @returns { ats, matchedBy, filled, statuses: [[key, status, detail], ...] }
 */
export async function autobotFill(page, { profile, resume = null, settings = {}, configs = loadConfigs(), panel = false } = {}) {
  if (!profile) throw new Error("autobotFill: profile is required");
  const sources = [...ENGINE.map((f) => fs.readFileSync(path.join(ext, f), "utf8")), fs.readFileSync(path.join(ext, "page.js"), "utf8")];
  for (const src of sources) await page.evaluate((code) => { (0, eval)(code); }, src); // eval in main world; CSP does not apply to CDP evaluation
  return page.evaluate(async ({ profile, resume, settings, configs, panel }) => {
    const AB = globalThis.AB;
    AB._standalone = { profile, resume, settings };
    AB._configs = configs;
    AB.debug = Boolean(settings.debug);
    const d = AB.detectATS(configs) || (AB.looksLikeForm() ? { config: configs.find((c) => c.id === "generic"), matchedBy: "heuristic" } : null);
    if (!d) return { ats: null, matchedBy: null, filled: 0, statuses: [], reason: "no-form" };
    const statuses = [];
    const onStatus = (k, s, det) => { statuses.push([k, s, String(det ?? "").slice(0, 80)]); if (panel) AB.panel.status(k, s, det); };
    if (panel) AB.panel.show({ subtitle: `Filling ${d.config.name} (Playwright host)`, ats: d.config.name, matchedBy: d.matchedBy, profile, resume });
    const loaded = await AB.loadProfile();
    const res = await AB.fill({ config: d.config, profile: loaded.profile, resume: loaded.resume, settings: loaded.settings, onStatus });
    return { ats: d.config.id, matchedBy: d.matchedBy, filled: res.filled, statuses: statuses.filter((s) => s[1] !== "filling") };
  }, { profile, resume, settings, configs, panel });
}

// ---- CLI demo ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) { console.error("usage: node tools/playwright-fill.mjs <job url> [--headed]"); process.exit(2); }
  const headed = process.argv.includes("--headed");
  const profileFile = ["tests/profile.local.json", "tests/profile.sample.json"].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
  const resume = { name: "autobot-test-resume.pdf", type: "application/pdf", dataBase64: Buffer.from("%PDF-1.4\n% autobot test resume (not a real document)\n").toString("base64") };
  const findChrome = () => { if (process.env.AUTOBOT_CHROME) return process.env.AUTOBOT_CHROME; const pw = path.join(os.homedir(), ".cache", "ms-playwright"); if (!fs.existsSync(pw)) return undefined; for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const p = path.join(pw, d, "chrome-linux64/chrome"); if (fs.existsSync(p)) return p; } };
  const browser = await chromium.launch({ headless: !headed, executablePath: findChrome() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const t0 = Date.now();
    const result = await autobotFill(page, { profile, resume, settings: { debug: true }, panel: headed });
    console.log(`profile: ${path.basename(profileFile)} | ats=${result.ats} (${result.matchedBy}) filled=${result.filled} in ${Date.now() - t0} ms`);
    for (const [k, s, d] of result.statuses) if (s !== "absent") console.log(`  ${s.padEnd(10)} ${k.padEnd(36)} ${d}`);
    if (headed) { await page.screenshot({ path: path.join(root, "tests", "out-playwright-fill.png") }); await page.waitForTimeout(4000); }
  } finally { await browser.close(); }
}
