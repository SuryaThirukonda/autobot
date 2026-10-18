// Autobot end-to-end test: load the unpacked extension into Chrome for Testing, seed a profile,
// open each fixture, trigger a fill through the test hook, and assert the resulting values.
// Usage: node tests/run.mjs [--headed]   (AUTOBOT_CHROME=/path/to/chrome to override the binary)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extDir = path.join(root, "autobot");
const headed = process.argv.includes("--headed");

const PROFILE = {
  first_name: "Ada", last_name: "Lovelace", email: "ada@example.test", phone: "(512) 555-0100", phone_country: "US",
  address: "1 Analytical Engine Way", city: "Austin", state: "Texas", postal_code: "78701", country: "United States",
  linkedin: "https://www.linkedin.com/in/ada-lovelace", github: "https://github.com/ada", portfolio: "https://ada.example.test", website: "https://ada.example.test", twitter: "",
  current_company: "Babbage & Co", current_title: "Software Engineer", years_experience: "3",
  work_auth_us: true, sponsorship: false, over18: true,
  gender: "Decline to self-identify", ethnicity: "Decline to self-identify", hispanic: "Decline to self-identify",
  veteran: "I am not a protected veteran", disability: "I do not want to answer",
  salary: "150000", how_heard: "LinkedIn",
  education: [{ school: "Texas A&M University", degree: "Bachelor's", major: "Computer Science", gpa: "3.9", start_month: "8", start_year: "2024", end_month: "5", end_year: "2028", graduated: false }],
  experience: [{ company: "Babbage & Co", title: "Software Engineer", location: "Austin, TX", start_month: "6", start_year: "2025", current: true, description: "Built things." }],
  skills: ["TypeScript", "Python"],
  answers: { "Why do you want to work here?": "Because the mission matches my experience building reliable systems." },
};
const RESUME = { name: "ada-resume.pdf", type: "application/pdf", dataBase64: Buffer.from("%PDF-1.4\n% autobot test resume\n").toString("base64") };

const serve = () => new Promise((resolve) => {
  const dir = path.join(here, "fixtures");
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, path.basename(new URL(req.url, "http://x").pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end("nope"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(f));
  });
  srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
});

const findChrome = () => {
  if (process.env.AUTOBOT_CHROME) return process.env.AUTOBOT_CHROME;
  const pw = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pw)) for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      const p = path.join(pw, d, rel); if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // let Playwright decide
};

const results = [];
const check = (name, actual, expected) => {
  const ok = typeof expected === "function" ? expected(actual) : String(actual ?? "") === String(expected);
  results.push({ name, ok, actual: String(actual ?? "").slice(0, 60), expected: typeof expected === "function" ? "(predicate)" : String(expected) });
};

const fillAndWait = async (page) => {
  await page.waitForFunction(() => document.documentElement.dataset.autobotReady === "1", null, { timeout: 15000 });
  await page.evaluate(() => { delete document.documentElement.dataset.autobotDone; window.postMessage({ __autobot: "cmd", type: "fill" }, "*"); });
  await page.waitForFunction(() => document.documentElement.dataset.autobotDone, null, { timeout: 60000 });
  return JSON.parse(await page.evaluate(() => document.documentElement.dataset.autobotDone));
};

(async () => {
  const { srv, base } = await serve();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-test-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // extensions need a headful (or --headless=new) browser
    executablePath: findChrome(),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run", "--window-size=1200,900"],
    viewport: { width: 1200, height: 900 },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log("extension id:", extId);

    // Seed profile + resume + test hooks via the options page.
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await opt.evaluate(([profile, resume]) => chrome.storage.local.set({ profile, resume, settings: { testHooks: true, showPanel: true, heuristics: true, debug: true } }), [PROFILE, RESUME]);
    await opt.close();

    // ---- Greenhouse-like ----
    {
      const page = await ctx.newPage();
      page.on("console", (m) => { if (/\[autobot\]/.test(m.text())) console.log("  ", m.text()); });
      await page.goto(`${base}/greenhouse.html`);
      const summary = await fillAndWait(page);
      console.log("greenhouse summary:", summary);
      const v = await page.evaluate(() => ({
        first: document.getElementById("first_name").value, last: document.getElementById("last_name").value, email: document.getElementById("email").value, phone: document.getElementById("phone").value,
        resume: document.getElementById("resume").files[0]?.name, school: document.getElementById("school-hidden").value, degree: document.getElementById("degree").selectedOptions[0]?.text,
        auth: document.getElementById("auth").selectedOptions[0]?.text, sponsor: document.getElementById("sponsor").selectedOptions[0]?.text, linkedin: document.getElementById("linkedin").value, website: document.getElementById("website").value,
        why: document.getElementById("why").value, gender: document.getElementById("gender").selectedOptions[0]?.text, veteran: document.getElementById("veteran").selectedOptions[0]?.text,
        events: document.getElementById("events").textContent, detected: document.documentElement.dataset.autobotDetected,
      }));
      check("gh detected", v.detected, "greenhouse");
      check("gh first_name", v.first, "Ada"); check("gh last_name", v.last, "Lovelace"); check("gh email", v.email, "ada@example.test"); check("gh phone", v.phone, "(512) 555-0100");
      check("gh resume", v.resume, "ada-resume.pdf"); check("gh school (combobox)", v.school, "Texas A&M University"); check("gh degree", v.degree, "Bachelor's Degree");
      check("gh work auth", v.auth, "Yes"); check("gh sponsorship", v.sponsor, "No"); check("gh linkedin", v.linkedin, PROFILE.linkedin); check("gh website", v.website, PROFILE.portfolio);
      check("gh saved answer", v.why, PROFILE.answers["Why do you want to work here?"]); check("gh gender", v.gender, "Decline To Self Identify"); check("gh veteran", v.veteran, "I am not a protected veteran");
      check("gh input+change events fired on first_name", v.events, (e) => /"first_name":\["input","change"/.test(e) || /"first_name":\[.*"input".*"change"/.test(e));
      if (headed) await page.screenshot({ path: path.join(root, "tests", "out-greenhouse.png") });
      await page.close();
    }
    // ---- Lever-like ----
    {
      const page = await ctx.newPage();
      await page.goto(`${base}/lever.html`);
      const summary = await fillAndWait(page);
      console.log("lever summary:", summary);
      const v = await page.evaluate(() => { const g = (n) => document.querySelector(`[name="${n}"]`); return {
        detected: document.documentElement.dataset.autobotDetected, name: g("name").value, email: g("email").value, phone: g("phone").value, org: g("org").value, li: g("urls[LinkedIn]").value, gh: g("urls[GitHub]").value, pf: g("urls[Portfolio]").value,
        resume: g("resume").files[0]?.name, auth: document.querySelector('input[name="cards[abc][field0]"]:checked')?.value, salary: g("cards[abc][field1]").value,
        gender: g("eeo[gender]").selectedOptions[0]?.text, race: g("eeo[race]").selectedOptions[0]?.text, vet: g("eeo[veteran]").selectedOptions[0]?.text, marketing: g("consent[marketing]").checked }; });
      check("lever detected", v.detected, "lever"); check("lever full name", v.name, "Ada Lovelace"); check("lever email", v.email, PROFILE.email); check("lever phone", v.phone, PROFILE.phone);
      check("lever org", v.org, PROFILE.current_company); check("lever linkedin", v.li, PROFILE.linkedin); check("lever github", v.gh, PROFILE.github); check("lever portfolio", v.pf, PROFILE.portfolio);
      check("lever resume", v.resume, "ada-resume.pdf"); check("lever custom radio (heuristic)", v.auth, "Yes"); check("lever salary (heuristic)", v.salary, PROFILE.salary);
      check("lever gender", v.gender, "Decline to self-identify"); check("lever race", v.race, "Decline to self-identify"); check("lever veteran", v.vet, "I am not a protected veteran");
      check("lever marketing checkbox untouched", v.marketing, false);
      await page.close();
    }
    // ---- Unknown ATS ----
    {
      const page = await ctx.newPage();
      await page.goto(`${base}/generic.html`);
      const summary = await fillAndWait(page);
      console.log("generic summary:", summary);
      const v = await page.evaluate(() => { const g = (id) => document.getElementById(id); return {
        detected: document.documentElement.dataset.autobotDetected, q1: g("q1").value, q2: g("q2").value, q3: g("q3").value, q4: g("q4").value, q5: g("q5").value, q6: g("q6").value, q7: g("q7").value, q8: g("q8").value,
        auth: document.querySelector('input[name=auth]:checked')?.value, q9: g("q9").value, q10: g("q10").value, q11: g("q11").value, q12: g("q12").value, q13: g("q13").files[0]?.name, q14: g("q14").value, q15: g("q15").checked }; });
      check("generic detected", v.detected, "generic"); check("generic full name", v.q1, "Ada Lovelace"); check("generic email", v.q2, PROFILE.email); check("generic phone", v.q3, PROFILE.phone);
      check("generic city", v.q4, "Austin"); check("generic state", v.q5, "Texas"); check("generic linkedin", v.q6, PROFILE.linkedin); check("generic company", v.q7, PROFILE.current_company); check("generic title", v.q8, PROFILE.current_title);
      check("generic auth radio", v.auth, "y"); check("generic sponsorship select", v.q9, "No"); check("generic how heard", v.q10, "LinkedIn"); check("generic saved answer", v.q11, PROFILE.answers["Why do you want to work here?"]);
      check("generic gender synonym", v.q12, "Prefer not to say"); check("generic resume", v.q13, "ada-resume.pdf"); check("generic degree synonym", v.q14, "Bachelors"); check("generic certify checkbox untouched", v.q15, false);
      await page.close();
    }
  } finally {
    await ctx.close().catch(() => {});
    srv.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  const pad = (s, n) => String(s).padEnd(n);
  let fails = 0;
  for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 44)} got=${pad(JSON.stringify(r.actual), 44)} want=${r.expected}`); }
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
