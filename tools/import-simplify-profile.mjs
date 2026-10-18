#!/usr/bin/env node
// Convert a Simplify candidate record (GET https://api.simplify.jobs/v2/candidate/me/ as JSON) into Autobot's
// profile schema and write the two git-ignored profile files.
//
//   node tools/import-simplify-profile.mjs simplify-me.json
//
// To get simplify-me.json: open https://simplify.jobs/profile while signed in, open DevTools → Network, reload,
// pick the request to /v2/candidate/me/, right-click → Copy → Copy response, paste into a file.
// (The web app sends the `csrf` cookie as an `x-csrf-token` header; the API is cookie-authenticated.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) { console.error("usage: node tools/import-simplify-profile.mjs <simplify-candidate.json>"); process.exit(2); }
const me = JSON.parse(fs.readFileSync(src, "utf8"));

// Simplify's own code→label maps (from its remote config `values` tables).
const GENDER = { 1: "Male", 2: "Female", 3: "Non-binary", 4: "Decline to self-identify" };
const VETERAN = { 1: "I identify as one or more of the classifications of a protected veteran", 2: "I am not a protected veteran", 3: "I don't wish to answer" };
const DISABILITY = { 1: "Yes, I have a disability, or have had one in the past", 2: "No, I do not have a disability and have not had one in the past", 3: "I do not want to answer" };
const LGBT = { 1: "Yes", 2: "No", 3: "Decline to self-identify" };
const DEGREE = { 1: "Bachelor's", 2: "Master's", 3: "MBA", 4: "JD", 5: "PhD", 6: "Associate's", 7: "High School", 8: "MD", 9: "Other", 10: "Certification", 11: "Some College", 12: "Bachelor's", 13: "Bachelor's", 14: "Bachelor's", 15: "Bachelor's", 16: "Master's", 17: "Master's", 18: "Master's", 19: "Master's", 20: "Master's" };
const DEGREE_FULL = { 12: "Bachelor of Arts", 13: "Bachelor of Science", 14: "Bachelor of Fine Arts", 15: "Bachelor of Business Administration", 16: "Master of Arts", 17: "Master of Science" };
const ETHNICITY = { "Decline to State": "Decline to self-identify", "African American": "Black or African American", "East Asian": "Asian", "South Asian": "Asian", "Southeast Asian": "Asian", "Hispanic/Latinx": "Hispanic or Latino", "Multiple": "Two or More Races", "Native American/Alaskan": "American Indian or Alaska Native", "Native Hawaiian/Pacific Islander": "Native Hawaiian or Other Pacific Islander", "White": "White", "Middle Eastern": "White" };

const s = (v) => (v === null || v === undefined ? "" : String(v));
const phone = (() => { const d = s(me.phone_raw_number || me.phone).replace(/\D/g, ""); const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d; return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : s(me.phone); })();
const loc = s(me.location); const [city = "", stateAbbr = ""] = loc.split(",").map((x) => x.trim());
const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };
const ethnicity = Array.isArray(me.ethnicity) ? me.ethnicity.map((e) => ETHNICITY[e] || e) : [ETHNICITY[me.ethnicity] || s(me.ethnicity)];
const over18 = me.birthday ? (Date.now() - new Date(me.birthday).getTime()) / (365.25 * 864e5) >= 18 : true;

const profile = {
  _source: `Imported from Simplify candidate record on ${new Date().toISOString().slice(0, 10)} by tools/import-simplify-profile.mjs`,
  first_name: s(me.first_name), last_name: s(me.last_name), preferred_name: s(me.preferred_name), pronouns: "",
  email: s(me.email), phone, phone_country: s(me.phone_country_code || "US").replace(/^\+?1$/, "US"),
  address: s(me.address), address_2: s(me.address_2), city, state: STATES[stateAbbr] || stateAbbr, postal_code: s(me.postal_code), country: /USA|United States/i.test(loc) || !loc ? "United States" : loc.split(",").pop().trim(),
  linkedin: s(me.linkedin), github: s(me.github), portfolio: s(me.portfolio), website: s(me.portfolio || me.additional_url), twitter: "",
  current_company: s((me.experience || []).find((e) => e.currently_working)?.company?.name || me.experience?.[0]?.company?.name),
  current_title: s((me.experience || []).find((e) => e.currently_working)?.title || me.experience?.[0]?.title),
  years_experience: "",
  work_auth_us: Boolean(me.work_auth_us), sponsorship: Boolean(me.sponsorship), over18,
  gender: GENDER[me.gender] || "Decline to self-identify", ethnicity: ethnicity[0] || "Decline to self-identify", hispanic: ethnicity.includes("Hispanic or Latino") ? "yes" : ethnicity[0] === "Decline to self-identify" ? "Decline to self-identify" : "no",
  veteran: VETERAN[me.veteran_v2] || "I don't wish to answer", disability: DISABILITY[me.disability_v2] || "I do not want to answer", lgbt: LGBT[me.lgbt_v2] || "Decline to self-identify",
  salary: "", start_date: "", notice_period: "", how_heard: "LinkedIn", referred_by: "",
  education: (me.education || []).map((e) => ({
    school: s(e.education?.lever || e.education?.name || e.education_custom_name), school_greenhouse: s(e.education?.greenhouse || e.education?.name),
    degree: DEGREE[e.degree] || "Bachelor's", degree_full: DEGREE_FULL[e.degree] || "", major: s(e.major?.name || e.major_custom_name), gpa: e.gpa ? Number(e.gpa).toFixed(1) : "",
    start_month: s(e.start_month), start_year: s(e.start_year), end_month: s(e.grad_month), end_year: s(e.grad_year), graduated: e.grad_year ? e.grad_year < new Date().getFullYear() : false,
  })),
  experience: (me.experience || []).map((e) => ({
    company: s(e.company?.name), title: s(e.title), location: s(e.location), start_month: s(e.start_month), start_year: s(e.start_year), end_month: s(e.end_month), end_year: s(e.end_year), current: Boolean(e.currently_working), description: s(e.description),
  })),
  projects: (me.project || []).map((p) => ({ name: s(p.name), title: s(p.title), location: s(p.location), start_month: s(p.start_month), start_year: s(p.start_year), end_month: s(p.end_month), end_year: s(p.end_year), current: Boolean(p.currently_working), description: s(p.description), link: s(p.link) })),
  skills: [...(me.skill || []).filter((k) => k.preferred), ...(me.skill || []).filter((k) => !k.preferred)].map((k) => s(k.skill?.name)).filter(Boolean),
  languages: (me.language || []).map((l) => s(l.language?.name || l.name)).filter(Boolean),
  answers: {},
  cover_letter_text: "",
};

for (const out of ["tests/profile.local.json", "autobot/configs/profile.default.json"]) {
  fs.writeFileSync(path.join(root, out), JSON.stringify(profile, null, 2) + "\n");
  console.log("wrote", out);
}
console.log(`profile: ${profile.first_name} ${profile.last_name}, ${profile.education.length} education, ${profile.experience.length} experience, ${profile.skills.length} skills (both files are git-ignored)`);
