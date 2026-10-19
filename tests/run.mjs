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
// Whole-word option matching and checked react-select picks came with the EEO fix; older folders skip that block.
const hasWholeWords = /AB\.hasWords\s*=/.test(fs.readFileSync(path.join(extDir, "engine", "util.js"), "utf8"));
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
const SETTINGS = { testHooks: true, showPanel: true, heuristics: true, debug: true };

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
// [filled lines, other lines] reported for a key.
const writesOf = (summary, key) => { const s = (summary.statuses || []).filter((x) => x[0] === key && x[1] !== "filling"); return [s.filter((x) => x[1] === "filled").length, s.filter((x) => x[1] !== "filled").length]; };
const readCampus = (page) => page.evaluate(() => ({ hidden: document.getElementById("school-hidden").value, shown: document.querySelector(".select__single-value").textContent,
  box: document.getElementById("school-input").value, q: window.__queries.slice(), first: document.getElementById("first_name").value }));
const readWebui = (page) => page.evaluate(() => { const g = (id) => document.getElementById(id); return {
  schoolId: g("educations[0].school_name_id").value, degreeId: g("educations[0].degree_id").value, disciplineId: g("educations[0].discipline_id").value,
  school: g("web-ui28").value, degree: g("web-ui31").value, discipline: g("web-ui34").value, month: document.querySelector("[id='educations[0].end_date.month'] .GfJwj").textContent,
  year: g("educations[0].end_date.year").value, q: window.__queries, clicks: { ...window.__clicks }, submits: window.__submits, first: g("first_name").value,
  location: g("location").value, locationBox: g("web-ui7").value, lat: g("latitude").value, lng: g("longitude").value,
  // What each listbox button shows, by group id ("Select..." when unanswered), and how often each list was opened.
  shown: Object.fromEntries(Array.from(document.querySelectorAll("[role=group][id^='question_'], [role=group][id^='demographic_answers']")).map((n) => [n.id, n.querySelector(".GfJwj").textContent])),
  opens: { ...window.__opens }, openLists: document.querySelectorAll("[role=group] [role=listbox]").length,
  gpa: g("question_38795090002").value, altEmail: g("question_38795096002").value, linkedin: g("question_38795097002").value, website: g("question_38795098002").value }; });
// Duolingo's question and demographic group ids in the webui fixture.
const DUO = { grad: "question_38795087002", office: "question_38795088002", officeLoc: "question_38795089002", heard: "question_38795094002", conferences: "question_38795095002",
  auth: "question_38795099002", sponsor: "question_38795100002", opt: "question_38795101002", optExt: "question_38795102002", gender: "demographic_answers.4028533002",
  race: "demographic_answers.4028534002", orientation: "demographic_answers.4028535002", trans: "demographic_answers.4028536002", disability: "demographic_answers.4028537002", veteran: "demographic_answers.4028538002" };
const readJobboards = (page) => page.evaluate(() => { const sv = (id) => document.getElementById(id).closest(".select__control").querySelector(".select__single-value")?.textContent || ""; const g = (id) => document.getElementById(id).value; return {
  school: sv("school--0"), degree: sv("degree--0"), discipline: sv("discipline--0"), startMonth: sv("start-month--0"), startYear: g("start-year--0"), endMonth: sv("end-month--0"), endYear: g("end-year--0"),
  q: window.__queries["school--0"].slice(), submits: window.__submits, first: g("first_name") }; });
// Airbnb's Yes/No react-selects in the job-boards fixture (MBA enrollment, work authorization, sponsorship): what each
// shows and every value typed into it.
const MBA_Q = "Are you currently enrolled in a full-time MBA program at an accredited U.S. business school, with an expected graduation date of Spring 2028?";
const AUTH_YES = "Yes, I am currently legally authorized to work in the country where the job is located.";
const SPONSOR_NO = "No, I do not and will not require immigration sponsorship to legally work in the country where the job is located.";
const readQuestions = (page) => page.evaluate(() => { const ids = { mba: "question_69899953", auth: "question_69899963", sponsor: "question_69899964" };
  const sv = (id) => document.getElementById(id).closest(".select__control").querySelector(".select__single-value")?.textContent || "";
  return { ...Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sv(id)])), typed: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, window.__typed[id] || []])) }; });
// Status lines whose key starts with some text: a question no rule names is listed as "? " plus its label.
const statusesStarting = (summary, prefix) => JSON.stringify((summary.statuses || []).filter((s) => s[0].startsWith(prefix) && s[1] !== "filling"));
// Statuses that report a choice the control already showed, as "key" strings.
const keptKeys = (summary) => JSON.stringify((summary.statuses || []).filter((s) => s[1] === "filled" && /already selected/.test(s[2])).map((s) => s[0]));
// greenhouse-eeo.html: what each react-select shows, every pick per control (sorted), the checkboxes, submits, the
// values of react-select's hidden "required" inputs (never written) and every text typed into each react-select.
const readEeo = (page) => page.evaluate(() => ({
  shown: Object.fromEntries(Array.from(document.querySelectorAll("input[role=combobox]")).map((i) => [i.id, i.closest(".select__control").querySelector(".select__single-value")?.textContent || ""])),
  picks: Object.keys(window.__picks).sort().map((k) => `${k}=${window.__picks[k].join("|")}`), boxes: Array.from(document.querySelectorAll("input[type=checkbox]")).map((c) => c.checked), submits: window.__submits,
  required: Array.from(document.querySelectorAll("input[aria-hidden=true][tabindex='-1']")).map((i) => i.value), typed: window.__typed }));
// Status lines made from react-select's hidden "required" input, whose label is the placeholder or the live region.
const hiddenInputKeys = (summary) => JSON.stringify((summary.statuses || []).map((s) => s[0]).filter((k) => /^\? (select\b|option\b.*\bselected|\d+ results? available)/.test(k)));

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
    await setStorage({ profile: PROFILE, resume: RESUME, settings: SETTINGS });

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
    // ---- Greenhouse: Duolingo's own form with Greenhouse ids (web-ui pickers and listbox buttons) ----
    if (has020) {
      const CS = "Texas A&M University - College Station";
      // The office questions have no profile key: a saved answer fills them.
      const OFFICE = { "Are you willing to work from the office location of the job?": "Yes", "Which office location are you most interested in?": "New York, NY" };
      const duoProfile = { ...PROFILE, gender: "Male", education: [{ ...PROFILE.education[0], school_greenhouse: CS }], answers: { ...PROFILE.answers, ...OFFICE } };
      await setStorage({ profile: duoProfile });
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
      // The three education pickers share one <fieldset>: each search must type into its own box, never into the school's.
      check("webui: each search typed into its own box", JSON.stringify(v.q), JSON.stringify({ location: ["Austin, Texas"], school: [CS], degree: ["Bachelor's Degree"], discipline: ["Computer Science"] }));
      check("webui: end month picked", v.month, "May");
      check("webui: end year", v.year, "2028");
      check("webui: start date reported absent", statusOf(summary, "education[0].start_month") + statusOf(summary, "education[0].start_year"), (t) => (t.match(/"absent"/g) || []).length === 2);
      check("webui: no unknown end-date question left", JSON.stringify(summary.statuses), (t) => !/\? [^"]*end date/.test(t));
      check("webui: other fields still filled", v.first, "Ada");
      // Location picker: a Google Places list behind the same overlay/proxy picker, resolved by the option search.
      check("webui: location stored", v.location, "Austin, TX, USA");
      check("webui: location shown", v.locationBox, "Austin, TX, USA");
      check("webui: location coordinates set", JSON.stringify([v.lat, v.lng]), JSON.stringify(["30.2672", "-97.7431"]));
      check("webui: location went through search", statusOf(summary, "location"), (t) => /"filled","Austin, TX, USA +\(searched/.test(t));
      // Question and demographic dropdowns (listbox buttons): config paths, the heuristic pass, value maps, saved answers.
      const s = v.shown;
      check("webui: graduation timeline from the end date", s[DUO.grad], "Spring/Summer 2028");
      check("webui: work authorization", s[DUO.auth], "Yes");
      check("webui: sponsorship", s[DUO.sponsor], "No");
      check("webui: OPT questions NA without sponsorship", JSON.stringify([s[DUO.opt], s[DUO.optExt]]), JSON.stringify(["NA", "NA"]));
      check("webui: where did you hear", s[DUO.heard], "LinkedIn");
      check("webui: office questions from saved answers", JSON.stringify([s[DUO.office], s[DUO.officeLoc]]), JSON.stringify(["Yes", "New York, NY"]));
      check("webui: gender identity (multi list)", s[DUO.gender], "Man");
      check("webui: race (multi list, decline)", s[DUO.race], "I don't wish to answer");
      check("webui: disability", s[DUO.disability], "I don't wish to answer");
      check("webui: veteran (value map)", s[DUO.veteran], "No, I am not a veteran or active member");
      check("webui: no answer, left alone", JSON.stringify([s[DUO.conferences], s[DUO.orientation], s[DUO.trans]]), JSON.stringify(["Select...", "Select...", "Select..."]));
      check("webui: unanswered lists never opened", JSON.stringify([DUO.conferences, DUO.orientation, DUO.trans].map((id) => v.opens[id] || 0)), "[0,0,0]");
      check("webui: every list closed again", v.openLists, 0);
      check("webui: config fields report the picks", [statusOf(summary, "graduation"), statusOf(summary, "opt"), statusOf(summary, "gender")].join(" "), (t) => /"filled","Spring\/Summer 2028"/.test(t) && /"filled","NA"/.test(t) && /"filled","Man"/.test(t));
      check("webui: heuristic picks report the option", statusOf(summary, "veteran"), (t) => /"filled","No, I am not a veteran or active member"/.test(t));
      check("webui: unanswered dropdowns listed as unknown", JSON.stringify((summary.statuses || []).filter((x) => x[1] === "unknown").map((x) => x[0])), (t) => [/sponsored conferences/, /sexual orien/, /transgender/].every((re) => re.test(t)));
      // "Alternate Email" is a second address, never the profile email.
      check("webui: Alternate Email left empty", v.altEmail, "");
      check("webui: Alternate Email listed as unknown", statusOf(summary, "? alternate email"), (t) => /"unknown"/.test(t));
      check("webui: GPA, LinkedIn and website", JSON.stringify([v.gpa, v.linkedin, v.website]), JSON.stringify([PROFILE.education[0].gpa, PROFILE.linkedin, PROFILE.portfolio]));
      check("webui: Add another (a submit button) and submit untouched", JSON.stringify([v.clicks.addAnother, v.clicks.submit, v.submits]), "[0,0,0]");
      // Rerun: the pickers show their choice in the proxy box (choice stored), the listbox buttons in their span.
      // Nothing is retyped, reopened or picked again; a second click in a multi list would remove the choice.
      const again = await fillAndWait(page);
      const r = await readWebui(page);
      check("webui rerun: no new searches", JSON.stringify(r.q), JSON.stringify(v.q));
      check("webui rerun: month list not reopened", r.clicks.monthOpens, 1);
      check("webui rerun: no list reopened", JSON.stringify(r.opens), JSON.stringify(v.opens));
      check("webui rerun: values unchanged", JSON.stringify([r.schoolId, r.degreeId, r.disciplineId, r.month, r.year, r.location, r.shown]), JSON.stringify([v.schoolId, v.degreeId, v.disciplineId, v.month, v.year, v.location, v.shown]));
      check("webui rerun: choices report already selected", keptKeys(again), JSON.stringify(["location", "education[0].school", "education[0].degree", "education[0].major", "education[0].end_month", "graduation", "opt", "opt_extension", "gender"]));
      check("webui rerun: still nothing submitted", JSON.stringify([r.clicks.addAnother, r.clicks.submit, r.submits]), "[0,0,0]");
      await page.close();
      // The user's own pick in a multi list stays the only one. With sponsorship needed, the OPT questions are the user's.
      await setStorage({ profile: { ...duoProfile, sponsorship: true } });
      const own = await ctx.newPage();
      await own.goto(`${base}/greenhouse-webui.html?gh_jid=8888721002`);
      await own.evaluate((id) => { const b = document.getElementById(id).querySelector("button"); b.click(); document.getElementById(id).querySelector("[role=option][title='Woman']").click(); b.click(); }, DUO.gender);
      // Two other listbox buttons the new writer must leave alone, on questions the heuristic pass would answer: one that
      // shows its choice as its own text (Workday style) and an icon toggle beside a typeahead input.
      await own.evaluate(() => {
        document.querySelector("form").insertAdjacentHTML("beforeend", `<div class="qwjgb"><label for="decoy-a">How did you hear about us?</label><div id="decoy-a" role="group"><button type="button" aria-haspopup="listbox" aria-controls="decoy-a-list">Select One</button></div></div>
          <div class="qwjgb"><label for="decoy-b">Where did you hear about us?</label><div><input id="decoy-b" type="text"><button type="button" aria-haspopup="listbox" aria-controls="decoy-b-list"></button></div></div>`);
        window.__decoyClicks = 0;
        for (const b of document.querySelectorAll("[aria-controls^=decoy]")) b.addEventListener("click", () => window.__decoyClicks++);
      });
      const s2 = await fillAndWait(own);
      const u = await readWebui(own);
      check("webui decoys: other listbox buttons never clicked", await own.evaluate(() => window.__decoyClicks), 0);
      check("webui user: own multi choice kept, nothing added", u.shown[DUO.gender], "Woman");
      check("webui user: status says kept the existing choice", statusOf(s2, "gender"), (t) => /kept the existing choice \\"Woman/.test(t));
      check("webui sponsorship: sponsorship = Yes", u.shown[DUO.sponsor], "Yes");
      check("webui sponsorship: OPT questions left alone", JSON.stringify([u.shown[DUO.opt], u.shown[DUO.optExt]]), JSON.stringify(["Select...", "Select..."]));
      check("webui sponsorship: OPT lists never opened", JSON.stringify([u.opens[DUO.opt] || 0, u.opens[DUO.optExt] || 0]), "[0,0]");
      check("webui sponsorship: OPT listed as unknown", statusOf(s2, "opt") + statusOf(s2, "opt_extension"), (t) => (t.match(/"unknown","no answer for sponsorship = true"/g) || []).length === 2);
      check("webui user: every list closed again", u.openLists, 0);
      await own.close();
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
      check("jobboards: no status from react-select's hidden required inputs", hiddenInputKeys(summary), "[]");
      // The config answers both questions. Its paths land on the input's wrapper (select__input-container), and the
      // heuristic pass used to take the input inside for a fresh question: work_auth_us both times, searched as a
      // location because the labels say "located", with the profile city typed into the Yes/No lists.
      const qs = await readQuestions(page);
      check("jobboards: work authorization answered", qs.auth, AUTH_YES);
      check("jobboards: sponsorship answered", qs.sponsor, SPONSOR_NO);
      check("jobboards: questions written once, by the config", JSON.stringify([writesOf(summary, "work_auth_us"), writesOf(summary, "sponsorship")]), "[[1,0],[1,0]]");
      check("jobboards: no city typed into the Yes/No lists", JSON.stringify([qs.typed.auth, qs.typed.sponsor]), (t) => !/Austin/.test(t));
      // The MBA question names a "business school" but is a Yes/No dropdown: no school key, nothing typed into it, and
      // with no saved answer it is left for you. react-select's hidden required inputs are no questions at all.
      check("jobboards: Yes/No question naming a school is no school field", statusOf(summary, "most_recent_school"), "[]");
      check("jobboards: MBA question left for you", statusesStarting(summary, "? are you currently enrolled"), (t) => /"unknown","no rule"/.test(t));
      check("jobboards: nothing typed into the MBA question", JSON.stringify(qs.typed.mba), "[]");
      check("jobboards: no rows for hidden required inputs", statusesStarting(summary, "? select"), "[]");
      const again = await fillAndWait(page);
      const r = await readJobboards(page);
      const rq = await readQuestions(page);
      check("jobboards rerun: questions unchanged", JSON.stringify([rq.auth, rq.sponsor]), JSON.stringify([AUTH_YES, SPONSOR_NO]));
      check("jobboards rerun: no new search", JSON.stringify(r.q), JSON.stringify([CS]));
      check("jobboards rerun: values unchanged", JSON.stringify(r), JSON.stringify(v));
      check("jobboards rerun: selects report already selected", keptKeys(again), JSON.stringify(["education[0].school", "education[0].degree", "education[0].major", "education[0].start_month", "education[0].end_month"]));
      check("jobboards: never submitted", r.submits, 0);
      await page.close();
      // The same questions when only the heuristic pass sees them (a board whose labels the config's paths miss): the
      // profile key, not the label's "located", decides the dropdown; the sponsorship question gets the sponsorship fact
      // although its label also says "work authorization"; a saved answer fills the MBA question, with no search.
      {
        const gh = JSON.parse(fs.readFileSync(path.join(extDir, "configs", "greenhouse.json"), "utf8"));
        const fields = gh.fields.filter((f) => !["work_auth_us", "sponsorship"].includes(f.key));
        await setStorage({ profile: { ...PROFILE, education: [{ ...PROFILE.education[0], school_greenhouse: CS }], answers: { ...PROFILE.answers, [MBA_Q]: "Yes" } }, settings: { ...SETTINGS, configOverrides: { greenhouse: { fields } } } });
        const page = await ctx.newPage();
        await page.goto(`${base}/greenhouse-jobboards.html`);
        const summary = await fillAndWait(page);
        const qs = await readQuestions(page);
        check("heuristic questions: work authorization", qs.auth, AUTH_YES);
        check("heuristic questions: sponsorship", qs.sponsor, SPONSOR_NO);
        check("heuristic questions: keyed work_auth_us and sponsorship", JSON.stringify([writesOf(summary, "work_auth_us"), writesOf(summary, "sponsorship")]), "[[1,0],[1,0]]");
        check("heuristic questions: no city typed into them", JSON.stringify([qs.typed.auth, qs.typed.sponsor]), (t) => !/Austin/.test(t));
        check("heuristic questions: saved answer fills the MBA question", qs.mba, "Yes");
        check("heuristic questions: MBA answer typed as is, no school search", JSON.stringify(qs.typed.mba), JSON.stringify(["Yes"]));
        await page.close();
        await setStorage({ settings: SETTINGS });
      }
      await setStorage({ profile: PROFILE });
    }
    // ---- Greenhouse job-boards EEO: the EEOC block, demographic surveys and a company's own questions ----
    // The EEO paths read only Greenhouse's EEOC questions. Everything else is left to the heuristic pass, which reads
    // each control by its own label and never answers "gender identity". A react-select pick counts only once shown.
    if (hasWholeWords) {
      const MALE = { ...PROFILE, gender: "Male" };
      // Robinhood (demographic survey only): the gender path used to land on "What is your gender identity?", type
      // "Man" and commit "Cisgender woman" while the status said "filled gender Man".
      await setStorage({ profile: MALE });
      let page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-eeo.html?form=robinhood`);
      let summary = await fillAndWait(page);
      let v = await readEeo(page);
      check("eeo robinhood: gender identity left alone", JSON.stringify([v.shown["1255"], v.picks.filter((p) => p.startsWith("1255="))]), JSON.stringify(["", []]));
      check("eeo robinhood: no gender status says filled", statusOf(summary, "gender"), (t) => t !== "[]" && !/"filled"/.test(t));
      check("eeo robinhood: gender identity needs you", statusOf(summary, "? what is your gender identity"), (t) => /"unknown"/.test(t));
      check("eeo robinhood: race picks the decline option", v.shown["1258"], "I don't wish to answer");
      check("eeo robinhood: status names the option shown", statusOf(summary, "ethnicity"), (t) => /"filled","I don't wish to answer"/.test(t));
      // "I am not a protected veteran" lists nothing; the full list is matched next (a "No options" row is no option).
      check("eeo robinhood: military status searched, then the full list", JSON.stringify(v.typed["1259"]), JSON.stringify(["I am not a protected veteran", ""]));
      check("eeo robinhood: military status not answered", JSON.stringify([v.shown["1259"], /"filled"/.test(statusOf(summary, "veteran"))]), JSON.stringify(["", false]));
      check("eeo robinhood: disability decline", v.shown["1261"], "I don't wish to answer");
      check("eeo robinhood: consent box untouched", JSON.stringify(v.boxes), "[false]");
      // Unanswered required questions keep react-select's hidden required input; it is no question of its own.
      check("eeo robinhood: no status from react-select's hidden inputs", hiddenInputKeys(summary), "[]");
      check("eeo robinhood: hidden required inputs left empty", JSON.stringify(v.required), JSON.stringify(["", ""]));
      await page.close();
      // Airbnb (its own Gender / Race / Veteran questions): "Man" was typed into Gender (Male / Female / Other /
      // Decline), nothing was chosen, and the status said filled.
      page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-eeo.html?form=airbnb`);
      summary = await fillAndWait(page);
      v = await readEeo(page);
      check("eeo airbnb: Gender shows Male", v.shown.question_69899960, "Male");
      check("eeo airbnb: gender status says Male", statusOf(summary, "gender"), (t) => /"filled","Male"/.test(t) && !/"Man"/.test(t));
      check("eeo airbnb: race and veteran", JSON.stringify([v.shown.question_69899961, v.shown.question_69899962]), JSON.stringify(["Decline to Self Identify", "I am not a protected veteran"]));
      check("eeo airbnb: decline-to-answer box untouched", JSON.stringify(v.boxes), "[false]");
      // The phone country lists "United States +1" and shows "+1": still a pick of that option.
      check("eeo airbnb: phone country shows its code", v.shown.country, "+1");
      check("eeo airbnb: phone country status filled", statusOf(summary, "country"), (t) => /"filled","\+1"/.test(t));
      await page.close();
      // A demographic survey ahead of the EEOC block (Discord): the config answers the EEOC questions, the heuristic
      // pass the survey's own Gender question. Hispanic "No" reveals the race question.
      await setStorage({ profile: { ...MALE, hispanic: "No", ethnicity: "Asian" } });
      page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-eeo.html`);
      summary = await fillAndWait(page);
      v = await readEeo(page);
      check("eeo both: EEOC answers", JSON.stringify([v.shown.gender, v.shown.hispanic_ethnicity, v.shown.race, v.shown.veteran_status]), JSON.stringify(["Male", "No", "Asian", "I am not a protected veteran"]));
      check("eeo both: survey Gender Male, gender identity alone", JSON.stringify([v.shown["4033064002"], v.shown["4033068002"]]), JSON.stringify(["Male", ""]));
      check("eeo both: one pick per answered control", JSON.stringify(v.picks), JSON.stringify(["4033064002=Male", "gender=Male", "hispanic_ethnicity=No", "race=Asian", "veteran_status=I am not a protected veteran"]));
      const again = await fillAndWait(page);
      const r = await readEeo(page);
      check("eeo both rerun: no new picks", JSON.stringify(r.picks), JSON.stringify(v.picks));
      check("eeo both rerun: EEOC choices already selected", keptKeys(again), (t) => ["gender", "hispanic", "ethnicity", "veteran"].every((k) => t.includes(`"${k}"`)));
      check("eeo both: never submitted", r.submits, 0);
      await page.close();
      // No option for the profile's value: nothing is chosen and no gender status says filled.
      await setStorage({ profile: { ...PROFILE, gender: "Non-binary" } });
      page = await ctx.newPage();
      await page.goto(`${base}/greenhouse-eeo.html`);
      summary = await fillAndWait(page);
      v = await readEeo(page);
      check("eeo no match: gender questions left empty", JSON.stringify([v.shown.gender, v.shown["4033064002"], v.picks.filter((p) => /^(gender|4033064002)=/.test(p))]), JSON.stringify(["", "", []]));
      check("eeo no match: no gender status says filled", statusOf(summary, "gender"), (t) => t !== "[]" && !/"filled"/.test(t));
      check("eeo no match: no status from react-select's hidden inputs", hiddenInputKeys(summary), "[]");
      check("eeo no match: hidden required inputs left empty", JSON.stringify(v.required), JSON.stringify(["", ""]));
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
