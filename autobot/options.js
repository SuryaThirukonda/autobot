const FIELDS = {
  identity: [
    ["first_name", "First name"], ["last_name", "Last name"], ["preferred_name", "Preferred name"], ["pronouns", "Pronouns"],
    ["email", "Email"], ["phone", "Phone"], ["phone_country", "Phone country (ISO, e.g. US)"],
    ["address", "Street address"], ["address_2", "Address line 2"], ["city", "City"], ["state", "State / province"], ["postal_code", "Postal code"], ["country", "Country"],
    ["current_company", "Current company"], ["current_title", "Current title"], ["years_experience", "Years of experience"],
    ["salary", "Salary expectation"], ["start_date", "Available start date"], ["notice_period", "Notice period"], ["how_heard", "How did you hear about us"], ["referred_by", "Referred by"],
  ],
  links: [["linkedin", "LinkedIn URL"], ["github", "GitHub URL"], ["portfolio", "Portfolio URL"], ["website", "Website URL"], ["twitter", "Twitter / X URL"]],
  eeo: [
    ["work_auth_us", "Authorized to work in the US?", ["true", "false"]],
    ["sponsorship", "Will need visa sponsorship?", ["false", "true"]],
    ["over18", "Over 18?", ["true", "false"]],
    ["gender", "Gender", ["Decline to self-identify", "Male", "Female", "Non-binary"]],
    ["hispanic", "Hispanic or Latino?", ["Decline to self-identify", "yes", "no"]],
    ["ethnicity", "Race / ethnicity", ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races"]],
    ["veteran", "Veteran status", ["I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran", "I don't wish to answer"]],
    ["disability", "Disability status", ["I do not want to answer", "Yes, I have a disability, or have had one in the past", "No, I do not have a disability and have not had one in the past"]],
  ],
};
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, children = []) => { const n = document.createElement(tag); Object.assign(n, attrs); for (const c of children) n.append(c); return n; };

function render(profile) {
  for (const [section, defs] of Object.entries(FIELDS)) {
    const box = $(`#${section}`); box.innerHTML = "";
    for (const [key, label, options] of defs) {
      let input;
      if (options) { input = el("select", { id: `f_${key}` }); for (const o of options) input.append(el("option", { value: o, textContent: o })); input.value = String(profile[key] ?? options[0]); }
      else input = el("input", { id: `f_${key}`, value: profile[key] ?? "", type: key === "email" ? "email" : "text" });
      box.append(el("label", { textContent: label }, [input]));
    }
  }
  $("#education").value = JSON.stringify(profile.education || [], null, 2);
  $("#experience").value = JSON.stringify(profile.experience || [], null, 2);
  const t = $("#answers"); t.innerHTML = "";
  for (const [q, a] of Object.entries(profile.answers || {})) addAnswerRow(q, a);
}
function addAnswerRow(q = "", a = "") {
  const tr = el("tr", {}, [el("td", {}, [el("input", { value: q, placeholder: "Question label as shown on forms", className: "q" })]), el("td", {}, [el("input", { value: a, placeholder: "Answer", className: "a" })]), el("td", {}, [el("button", { textContent: "✕", onclick: () => tr.remove() })])]);
  $("#answers").append(tr);
}
function collect(existing) {
  const profile = { ...existing };
  for (const defs of Object.values(FIELDS)) for (const [key, , options] of defs) {
    let v = $(`#f_${key}`).value;
    if (options && (v === "true" || v === "false")) v = v === "true";
    profile[key] = v;
  }
  try { profile.education = JSON.parse($("#education").value || "[]"); } catch { alert("education is not valid JSON"); throw new Error("bad json"); }
  try { profile.experience = JSON.parse($("#experience").value || "[]"); } catch { alert("experience is not valid JSON"); throw new Error("bad json"); }
  profile.answers = {};
  $("#answers").querySelectorAll("tr").forEach((tr) => { const q = tr.querySelector(".q").value.trim(), a = tr.querySelector(".a").value; if (q) profile.answers[q] = a; });
  return profile;
}

(async () => {
  const { profile = {}, resume = null, settings = {} } = await chrome.storage.local.get(["profile", "resume", "settings"]);
  render(profile);
  if (resume) $("#resumeInfo").textContent = `${resume.name} (${Math.round((resume.dataBase64.length * 3) / 4 / 1024)} KB)`;
  $("#showPanel").checked = settings.showPanel !== false;
  $("#autoFill").checked = Boolean(settings.autoFill);
  $("#heuristics").checked = settings.heuristics !== false;
  $("#debug").checked = Boolean(settings.debug);
  $("#testHooks").checked = Boolean(settings.testHooks);
  $("#configOverrides").value = JSON.stringify(settings.configOverrides || {}, null, 2);

  $("#save").onclick = async () => {
    let newProfile; try { newProfile = collect(profile); } catch { return; }
    let configOverrides; try { configOverrides = JSON.parse($("#configOverrides").value || "{}"); } catch { return alert("Config overrides is not valid JSON"); }
    const newSettings = { ...settings, showPanel: $("#showPanel").checked, autoFill: $("#autoFill").checked, heuristics: $("#heuristics").checked, debug: $("#debug").checked, testHooks: $("#testHooks").checked, configOverrides };
    await chrome.storage.local.set({ profile: newProfile, settings: newSettings });
    $("#saved").textContent = "Saved."; setTimeout(() => ($("#saved").textContent = ""), 1500);
  };
  $("#addAnswer").onclick = () => addAnswerRow();
  $("#resume").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    await chrome.storage.local.set({ resume: { name: f.name, type: f.type || "application/pdf", dataBase64: btoa(bin) } });
    $("#resumeInfo").textContent = `${f.name} (${Math.round(f.size / 1024)} KB) stored.`;
  };
  $("#clearResume").onclick = async () => { await chrome.storage.local.remove("resume"); $("#resumeInfo").textContent = "No resume stored."; };
  $("#export").onclick = async () => {
    const data = await chrome.storage.local.get(["profile", "settings"]);
    const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: "autobot-profile.json" }); a.click();
  };
  $("#importBtn").onclick = () => $("#import").click();
  $("#import").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const data = JSON.parse(await f.text());
    await chrome.storage.local.set({ profile: data.profile || data, ...(data.settings ? { settings: data.settings } : {}) });
    location.reload();
  };
})();
