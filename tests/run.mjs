// autobot end-to-end test: load the unpacked extension into Chrome for Testing, seed a profile,
// open each fixture, trigger a fill through the test hook, and assert the resulting values.
// The browser loads a temporary copy of the extension without configs/profile.default.json, so a personal profile
// is never seeded into a test run.
// Usage: node tests/run.mjs [--headed] [--ext=legacy/autobot-v1]   (AUTOBOT_CHROME=/path/to/chrome overrides the
// binary; --ext or AUTOBOT_EXT picks the extension folder, default autobot/)
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { stageExtension } from "./stage-ext.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extArg = process.argv.find((a) => a.startsWith("--ext="));
const extDir = path.resolve(root, extArg ? extArg.slice(6) : process.env.AUTOBOT_EXT || "autobot");
const hasSearch = fs.existsSync(path.join(extDir, "engine", "search.js"));
// Per-ATS names and the rerun checks arrived in 0.2.0; older folders (legacy/) skip those blocks.
const has020 = hasSearch && /S\.atsAlternates\s*=/.test(fs.readFileSync(path.join(extDir, "engine", "search.js"), "utf8"));
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
// Status lines for one key, without the transient "filling" entries.
const statusOf = (summary, key) => JSON.stringify((summary.statuses || []).filter((s) => s[0] === key && s[1] !== "filling"));
const readCampus = (page) => page.evaluate(() => ({ hidden: document.getElementById("school-hidden").value, shown: document.querySelector(".select__single-value").textContent,
  box: document.getElementById("school-input").value, q: window.__queries.slice(), first: document.getElementById("first_name").value }));
const readWebui = (page) => page.evaluate(() => { const g = (id) => document.getElementById(id); return {
  schoolId: g("educations[0].school_name_id").value, degreeId: g("educations[0].degree_id").value, disciplineId: g("educations[0].discipline_id").value,
  school: g("web-ui28").value, degree: g("web-ui31").value, discipline: g("web-ui34").value, month: document.querySelector("[id='educations[0].end_date.month'] .GfJwj").textContent,
  year: g("educations[0].end_date.year").value, q: window.__queries, clicks: { ...window.__clicks }, submits: window.__submits, first: g("first_name").value }; });
const readJobboards = (page) => page.evaluate(() => { const sv = (id) => document.getElementById(id).closest(".select__control").querySelector(".select__single-value")?.textContent || ""; const g = (id) => document.getElementById(id).value; return {
  school: sv("school--0"), degree: sv("degree--0"), discipline: sv("discipline--0"), startMonth: sv("start-month--0"), startYear: g("start-year--0"), endMonth: sv("end-month--0"), endYear: g("end-year--0"),
  q: window.__queries["school--0"].slice(), submits: window.__submits, first: g("first_name") }; });
// Statuses that report a choice the control already showed, as "key" strings.
const keptKeys = (summary) => JSON.stringify((summary.statuses || []).filter((s) => s[1] === "filled" && /already selected/.test(s[2])).map((s) => s[0]));

(async () => {
  const { srv, base } = await serve();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "autobot-test-"));
  const staged = stageExtension(extDir, { tag: "test-ext" });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // extensions need a headful (or --headless=new) browser
    executablePath: findChrome(),
    args: [`--disable-extensions-except=${staged.dir}`, `--load-extension=${staged.dir}`, ...(headed ? [] : ["--headless=new"]), "--no-first-run", "--window-size=1200,900"],
    viewport: { width: 1200, height: 900 },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log("extension id:", extId);

    // Storage writes go through an extension page. onInstalled opens options.html too; that navigation can
    // interrupt ours, so retry once.
    const setStorage = async (items) => {
      const opt = await ctx.newPage();
      try {
        try { await opt.goto(`chrome-extension://${extId}/options.html`); } catch { await new Promise((r) => setTimeout(r, 500)); await opt.goto(`chrome-extension://${extId}/options.html`); }
        await opt.evaluate((o) => chrome.storage.local.set(o), items);
      } finally { await opt.close(); }
    };
    // Seed profile + resume + test hooks.
    await setStorage({ profile: PROFILE, resume: RESUME, settings: { testHooks: true, showPanel: true, heuristics: true, debug: true } });

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
    // ---- Search widgets (multi-round option search) ----
    if (hasSearch) {
      const page = await ctx.newPage();
      page.on("console", (m) => { if (/\[autobot\] search (result|search)/.test(m.text())) console.log("  ", m.text()); });
      await page.goto(`${base}/search.html`);
      const summary = await fillAndWait(page);
      console.log("search summary:", summary.statuses?.filter((s) => /school|major|location|company|\?/.test(s[0])));
      const v = await page.evaluate(() => { const g = (id) => document.getElementById(id); return {
        loc: g("loc").value, locId: g("loc-id").value, locQueries: window.__queries.loc.slice(), school: g("school").selectedOptions[0]?.text, schoolVal: g("school").value,
        schoolQueries: window.__queries.school.slice(), rendered: document.querySelector(".select2-selection__rendered").textContent, other: g("other").value, otherQueries: window.__queries.other.slice(),
        major: g("major").selectedOptions[0]?.text, employer: g("employer").value, city: g("city").value, name: g("fullname").value,
        eduSchool: g("edu-school").selectedOptions[0]?.text, eduOther: g("edu-school-other").value }; });
      check("search: location committed", v.loc, "Austin, Texas, United States");
      check("search: location id (option value)", v.locId, "L1");
      check("search: location needed a 2nd round", JSON.stringify(v.locQueries), (q) => { const a = JSON.parse(q); return a[0] === "Austin, Texas" && a.includes("Austin, TX"); });
      check("search: select2 ajax school", v.school, "Texas A&M University");
      check("search: select2 native value", v.schoolVal, "1002");
      check("search: select2 rendered label", v.rendered, "Texas A&M University");
      check("search: near-miss school left empty", v.other, "");
      check("search: near-miss school was searched", v.otherQueries.length, (n) => Number(n) >= 1);
      check("search: native select major (trap-free)", v.major, "Computer Science");
      check("search: datalist canonical employer", v.employer, "Babbage and Co.");
      check("search: school 'Other' fallback select", v.eduSchool, "Other");
      check("search: school 'Other' companion text", v.eduOther, "Texas A&M University");
      check("search: plain city not searched", v.city, "Austin");
      check("search: plain name still filled", v.name, "Ada Lovelace");
      check("search: status shows rounds", JSON.stringify(summary.statuses), (t) => /searched \\"Austin, Texas\\"/.test(t) || /searched "Austin, Texas"/.test(t) || /Austin, Texas, United States/.test(t));
      if (headed) await page.screenshot({ path: path.join(root, "tests", "out-search.png") });
      await page.close();
    }
    // ---- Workday-like (button prompts, multiselect search, split dates) ----
    {
      const page = await ctx.newPage();
      await page.goto(`${base}/workday.html`);
      const t0 = Date.now();
      const summary = await fillAndWait(page);
      const elapsed = Date.now() - t0;
      console.log("workday summary:", { ...summary, statuses: summary.statuses?.filter((s) => s[1] !== "absent") }, `${elapsed} ms`);
      const v = await page.evaluate(() => { const q = (s) => document.querySelector(s); return {
        detected: document.documentElement.dataset.autobotDetected, prev: document.querySelector('input[name=prev]:checked')?.value, fn: q("#fn").value, ln: q("#ln").value, a1: q("#a1").value, city: q("#city").value, zip: q("#zip").value,
        state: q("[data-automation-id='addressSection_countryRegion']").dataset.value, device: q("[data-automation-id='phone-device-type']").dataset.value, cc: q("[data-automation-id='formField-countryPhoneCode'] .chips").dataset.value,
        phone: q("#ph").value, src: q("[data-automation-id='sourceSection'] .chips").dataset.value, title: q("[data-automation-id='jobTitle']").value, company: q("[data-automation-id='company']").value,
        current: q("[data-automation-id='currentlyWorkHere']").checked, mm: q("[data-automation-id='dateSectionMonth-input']").value, yyyy: q("[data-automation-id='dateSectionYear-input']").value, desc: q("[data-automation-id='description']").value }; });
      check("wd detected", v.detected, "workday"); check("wd previously worked = No", v.prev, "false"); check("wd first", v.fn, "Ada"); check("wd last", v.ln, "Lovelace");
      check("wd address", v.a1, PROFILE.address); check("wd city", v.city, "Austin"); check("wd zip", v.zip, "78701"); check("wd state prompt", v.state, "Texas");
      check("wd phone device prompt", v.device, "Mobile"); check("wd country code multiselect", v.cc, "United States of America (+1)"); check("wd phone digits", v.phone, "5125550100");
      check("wd source multiselect", v.src, "LinkedIn"); check("wd job title", v.title, PROFILE.experience[0].title); check("wd company", v.company, PROFILE.experience[0].company); check("wd currently work here", v.current, true);
      check("wd start month", v.mm, "06"); check("wd start year", v.yyyy, "2025"); check("wd description", v.desc, PROFILE.experience[0].description);
      check("wd finished in under 25 s", elapsed, (ms) => ms < 25000);
      // Rerun on the filled form: the prompt buttons and pills already show the answers, so autobot must not open,
      // click or type into them again (a second click on a multi-select option toggles or duplicates it).
      if (has020) {
        const widgets = () => page.evaluate(() => { const q = (s) => document.querySelector(s); return { state: q("[data-automation-id='addressSection_countryRegion']").dataset.value,
          device: q("[data-automation-id='phone-device-type']").dataset.value, cc: q("[data-automation-id='formField-countryPhoneCode'] .chips").innerHTML, src: q("[data-automation-id='sourceSection'] .chips").innerHTML }; });
        const before = await widgets();
        await page.evaluate(() => {
          const W = "[data-automation-id='addressSection_countryRegion'], [data-automation-id='phone-device-type'], [data-automation-id='formField-countryPhoneCode'], [data-automation-id='sourceSection'], .popup";
          window.__widgetEvents = []; window.__popups = 0;
          for (const t of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "input", "change", "focusin"]) document.addEventListener(t, (e) => { const w = e.target?.closest?.(W); if (w) window.__widgetEvents.push(`${t}@${w.getAttribute("data-automation-id") || w.className}`); }, true);
          new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("popup")) window.__popups++; }).observe(document.body, { childList: true });
        });
        const again = await fillAndWait(page);
        const after = await widgets();
        const r = await page.evaluate(() => ({ events: window.__widgetEvents.slice(0, 8), popups: window.__popups, first: document.getElementById("fn").value }));
        const kept = (again.statuses || []).filter((s) => /already selected/.test(s[2])).map((s) => s[0]);
        check("wd rerun: no events on selection widgets", JSON.stringify(r.events), "[]");
        check("wd rerun: no popup opened", r.popups, 0);
        check("wd rerun: choices unchanged", JSON.stringify(after), JSON.stringify(before));
        check("wd rerun: prompts report already selected", JSON.stringify(kept), (t) => ["state", "phone_device", "phone_country_code", "how_heard"].every((k) => t.includes(`"${k}"`)));
        check("wd rerun: text fields still filled", r.first, "Ada");
      }
      await page.close();
    }
    // ---- Workday-style prompt (type, Enter, promptOption, selectedItem pill) ----
    if (hasSearch) {
      const page = await ctx.newPage();
      await page.goto(`${base}/search-workday.html`);
      await fillAndWait(page);
      const v = await page.evaluate(() => ({ hidden: document.getElementById("school-value").value, pill: document.querySelector("[data-automation-id=selectedItem]")?.title,
        box: document.getElementById("school-search").value, q: window.__wdQueries.slice(), first: document.getElementById("legal-first").value }));
      check("workday: prompt option committed", v.hidden, "Texas A&M University");
      check("workday: selectedItem pill", v.pill, "Texas A&M University");
      check("workday: search box cleared (no retype)", v.box, "");
      check("workday: searched once via Enter", JSON.stringify(v.q), JSON.stringify(["Texas A&M University"]));
      if (has020) {
        // Rerun: the pill already shows the school. The fixture's option click toggles, so a second commit would
        // remove the pill, and a second search would add a query.
        const again = await fillAndWait(page);
        const r = await page.evaluate(() => ({ pills: Array.from(document.querySelectorAll("[data-automation-id=selectedItem]")).map((p) => p.title), q: window.__wdQueries.slice() }));
        check("workday rerun: no new search", JSON.stringify(r.q), JSON.stringify(["Texas A&M University"]));
        check("workday rerun: pill kept, once", JSON.stringify(r.pills), JSON.stringify(["Texas A&M University"]));
        check("workday rerun: status says already selected", JSON.stringify(again.statuses), (t) => /already selected/.test(t));
      }
      await page.close();
    }
    // A different school already chosen by the user: leave the multi-select alone and add no second pill.
    if (has020) {
      const page = await ctx.newPage();
      await page.goto(`${base}/search-workday.html`);
      await page.evaluate(() => { const p = document.createElement("div"); p.setAttribute("data-automation-id", "selectedItem"); p.title = p.textContent = "Texas Tech University"; document.getElementById("school-pills").appendChild(p); document.getElementById("school-value").value = "Texas Tech University"; });
      const res = await fillAndWait(page);
      const r = await page.evaluate(() => ({ pills: Array.from(document.querySelectorAll("[data-automation-id=selectedItem]")).map((p) => p.title), q: window.__wdQueries.slice() }));
      check("workday: user's other pill kept", JSON.stringify(r.pills), JSON.stringify(["Texas Tech University"]));
      check("workday: no search over the user's pill", JSON.stringify(r.q), "[]");
      check("workday: status says kept existing choice", JSON.stringify(res.statuses), (t) => /kept the existing choice/.test(t));
      await page.close();
    }
    // ---- Greenhouse school list with campus-suffixed names only ----
    if (hasSearch) {
      const page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-campus.html`);
      const summary = await fillAndWait(page);
      const v = await readCampus(page);
      check("campus: detected as greenhouse", summary.ats, "greenhouse");
      check("campus: plain name commits no campus", v.hidden, "");
      check("campus: nothing shown as chosen", v.shown, "");
      check("campus: search box restored", v.box, "");
      check("campus: searched the plan, then stopped", JSON.stringify(v.q), JSON.stringify(["Texas A&M University", "Texas A&M"]));
      check("campus: status says return-empty", statusOf(summary, "education[0].school"), (t) => /return-empty/.test(t));
      check("campus: other fields still filled", v.first, "Ada");
      await page.close();
    }
    // Same form with the per-ATS name a Simplify import stores (education[0].school_greenhouse).
    if (has020) {
      const CS = "Texas A&M University - College Station";
      await setStorage({ profile: { ...PROFILE, education: [{ ...PROFILE.education[0], school_greenhouse: CS }] } });
      const page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-campus.html`);
      const summary = await fillAndWait(page);
      const v = await readCampus(page);
      check("campus+ats: College Station committed", v.hidden, "11785542002");
      check("campus+ats: shown as chosen", v.shown, CS);
      check("campus+ats: one search, per-ATS name first", JSON.stringify(v.q), JSON.stringify([CS]));
      check("campus+ats: status names the campus", statusOf(summary, "education[0].school"), (t) => t.includes(CS));
      const again = await fillAndWait(page);
      const r = await readCampus(page);
      check("campus+ats rerun: no new search", JSON.stringify(r.q), JSON.stringify([CS]));
      check("campus+ats rerun: choice kept", r.hidden, "11785542002");
      check("campus+ats rerun: status says already selected", statusOf(again, "education[0].school"), (t) => /already selected/.test(t));
      await page.close();
      // A board whose list has only the plain name and whose menu closes when nothing matches: the per-ATS name finds
      // nothing, then the profile value is searched and committed.
      const plain = await ctx.newPage();
      await plain.goto(`${base}/greenhouse.html`);
      const s2 = await fillAndWait(plain);
      check("campus+ats: plain list falls back to profile name", await plain.evaluate(() => document.getElementById("school-hidden").value), "Texas A&M University");
      check("campus+ats: status shows the per-ATS search first", statusOf(s2, "education[0].school"), (t) => t.includes("College Station") && t.includes("filled"));
      await plain.close();
      await setStorage({ profile: PROFILE });
    }
    // ---- Greenhouse education: Duolingo's own form with Greenhouse ids (web-ui pickers) ----
    if (has020) {
      const CS = "Texas A&M University - College Station";
      await setStorage({ profile: { ...PROFILE, education: [{ ...PROFILE.education[0], school_greenhouse: CS }] } });
      const page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-webui.html?gh_jid=8888721002`);
      const summary = await fillAndWait(page);
      const v = await readWebui(page);
      check("webui: detected as greenhouse by gh_jid", summary.ats, "greenhouse");
      check("webui: school id (College Station)", v.schoolId, "11785542002");
      check("webui: degree id", v.degreeId, "11786718002");
      check("webui: degree shown", v.degree, "Bachelor's Degree");
      check("webui: degree went through search", statusOf(summary, "education[0].degree"), (t) => /"filled","Bachelor's Degree +\(searched/.test(t));
      check("webui: discipline id", v.disciplineId, "11786740002");
      check("webui: discipline shown", v.discipline, "Computer Science");
      check("webui: discipline went through search", statusOf(summary, "education[0].major"), (t) => /"filled","Computer Science +\(searched/.test(t));
      // The three pickers share one <fieldset>: each search must type into its own box, never into the school's.
      check("webui: each search typed into its own box", JSON.stringify(v.q), JSON.stringify({ school: [CS], degree: ["Bachelor's Degree"], discipline: ["Computer Science"] }));
      check("webui: end month picked", v.month, "May");
      check("webui: end year", v.year, "2028");
      check("webui: start date reported absent", statusOf(summary, "education[0].start_month") + statusOf(summary, "education[0].start_year"), (t) => (t.match(/"absent"/g) || []).length === 2);
      check("webui: no unknown end-date question left", JSON.stringify(summary.statuses), (t) => !/\? [^"]*end date/.test(t));
      check("webui: other fields still filled", v.first, "Ada");
      check("webui: Add another (a submit button) and submit untouched", JSON.stringify([v.clicks.addAnother, v.clicks.submit, v.submits]), "[0,0,0]");
      // Rerun: the pickers show their choice in the proxy box (id stored), the month in its span. Nothing is retyped,
      // reopened or picked again.
      const again = await fillAndWait(page);
      const r = await readWebui(page);
      check("webui rerun: no new searches", JSON.stringify(r.q), JSON.stringify(v.q));
      check("webui rerun: month list not reopened", r.clicks.monthOpens, 1);
      check("webui rerun: values unchanged", JSON.stringify([r.schoolId, r.degreeId, r.disciplineId, r.month, r.year]), JSON.stringify([v.schoolId, v.degreeId, v.disciplineId, v.month, v.year]));
      check("webui rerun: choices report already selected", keptKeys(again), JSON.stringify(["education[0].school", "education[0].degree", "education[0].major", "education[0].end_month"]));
      check("webui rerun: still nothing submitted", JSON.stringify([r.clicks.addAnother, r.clicks.submit, r.submits]), "[0,0,0]");
      await page.close();
      await setStorage({ profile: PROFILE });
    }
    // ---- Greenhouse job-boards education: react-select 5 with no "field" wrapper, start and end dates ----
    if (has020) {
      const CS = "Texas A&M University - College Station";
      await setStorage({ profile: { ...PROFILE, education: [{ ...PROFILE.education[0], school_greenhouse: CS }] } });
      const page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-jobboards.html`);
      const summary = await fillAndWait(page);
      const v = await readJobboards(page);
      check("jobboards: detected as greenhouse", summary.ats, "greenhouse");
      check("jobboards: school committed", v.school, CS);
      check("jobboards: school status filled", statusOf(summary, "education[0].school"), (t) => /"filled"/.test(t));
      check("jobboards: degree (list has Bachelors too)", v.degree, "Bachelor's Degree");
      check("jobboards: degree went through search", statusOf(summary, "education[0].degree"), (t) => /"filled","Bachelor's Degree +\(searched/.test(t));
      check("jobboards: discipline", v.discipline, "Computer Science");
      check("jobboards: start month", v.startMonth, "August");
      check("jobboards: start year", v.startYear, "2024");
      check("jobboards: end month", v.endMonth, "May");
      check("jobboards: end year", v.endYear, "2028");
      check("jobboards: MM text fields leave the month selects alone", statusOf(summary, "education[0].start_month|MM") + statusOf(summary, "education[0].end_month|MM"), (t) => (t.match(/"absent"/g) || []).length === 2);
      check("jobboards: school searched once", JSON.stringify(v.q), JSON.stringify([CS]));
      const again = await fillAndWait(page);
      const r = await readJobboards(page);
      check("jobboards rerun: no new search", JSON.stringify(r.q), JSON.stringify([CS]));
      check("jobboards rerun: values unchanged", JSON.stringify(r), JSON.stringify(v));
      check("jobboards rerun: selects report already selected", keptKeys(again), JSON.stringify(["education[0].school", "education[0].degree", "education[0].major", "education[0].start_month", "education[0].end_month"]));
      check("jobboards: never submitted", r.submits, 0);
      await page.close();
      await setStorage({ profile: PROFILE });
    }
  } finally {
    await ctx.close().catch(() => {});
    srv.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    staged.cleanup();
  }
  const pad = (s, n) => String(s).padEnd(n);
  let fails = 0;
  for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 44)} got=${pad(JSON.stringify(r.actual), 44)} want=${r.expected}`); }
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
