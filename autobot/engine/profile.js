// Autobot engine: profile schema, keyPath access, derived values and formatting.
var AB = globalThis.AB || (globalThis.AB = {});

AB.PROFILE_DEFAULT = {
  first_name: "", last_name: "", preferred_name: "", pronouns: "",
  email: "", phone: "", phone_country: "US",
  address: "", address_2: "", city: "", state: "", postal_code: "", country: "United States",
  linkedin: "", github: "", portfolio: "", website: "", twitter: "",
  current_company: "", current_title: "", years_experience: "",
  work_auth_us: true, sponsorship: false, over18: true,
  gender: "Decline to self-identify", ethnicity: "Decline to self-identify", hispanic: "Decline to self-identify",
  veteran: "I am not a protected veteran", disability: "I do not want to answer",
  salary: "", start_date: "", notice_period: "",
  how_heard: "LinkedIn", referred_by: "",
  education: [
    // { school, degree, major, gpa, start_month, start_year, end_month, end_year, graduated: true }
  ],
  experience: [
    // { company, title, location, start_month, start_year, end_month, end_year, current: false, description }
  ],
  skills: [], languages: [],
  // Deterministic saved answers: normalized question label -> answer text.
  answers: {},
  // resume: { name, type, dataBase64 } (stored separately in chrome.storage.local under "resume")
  cover_letter_text: ""
};

AB.MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
AB.MONTHS_SHORT = AB.MONTHS.map((m) => m.slice(0, 3));

// Formatters usable as "keyPath|fmt". Dates are built from *_month/*_year siblings.
AB.format = (value, fmt, ctx) => {
  if (!fmt) return value;
  const two = (n) => String(n).padStart(2, "0");
  const m = ctx?.month, y = ctx?.year;
  switch (fmt) {
    case "upper": return String(value ?? "").toUpperCase();
    case "lower": return String(value ?? "").toLowerCase();
    case "digits": return String(value ?? "").replace(/\D/g, "");
    case "yesno": return AB.boolToYesNo(value);
    case "MM": return m ? two(m) : "";
    case "M": return m ? String(Number(m)) : "";
    case "MMM": return m ? AB.MONTHS_SHORT[Number(m) - 1] : "";
    case "MMMM": return m ? AB.MONTHS[Number(m) - 1] : "";
    case "YYYY": return y ? String(y) : "";
    case "YY": return y ? String(y).slice(-2) : "";
    case "MM/YYYY": return m && y ? `${two(m)}/${y}` : "";
    case "MM/DD/YYYY": return m && y ? `${two(m)}/01/${y}` : "";
    case "YYYY-MM": return m && y ? `${y}-${two(m)}` : "";
    case "YYYY-MM-DD": return m && y ? `${y}-${two(m)}-01` : "";
    case "MMMM YYYY": return m && y ? `${AB.MONTHS[Number(m) - 1]} ${y}` : "";
    default: return value;
  }
};

// Resolve "a.b[0].c|fmt" against the profile. Returns undefined when missing/empty.
// Special derived keys: full_name, phone_digits, location, *_date (uses sibling month/year).
AB.getProfileValue = (profile, keyPath) => {
  if (!profile || !keyPath) return undefined;
  let [path, fmt] = String(keyPath).split("|");
  const segs = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = profile, parent = null, lastSeg = null;
  for (const s of segs) { parent = cur; lastSeg = s; if (cur == null) break; cur = cur[s]; }
  // derived
  if (cur === undefined || cur === null || cur === "") {
    const root = segs.length === 1 ? profile : parent;
    switch (lastSeg) {
      case "full_name": cur = [profile.first_name, profile.last_name].filter(Boolean).join(" "); break;
      case "phone_digits": cur = String(profile.phone || "").replace(/\D/g, ""); break;
      case "location": cur = [root?.city, root?.state].filter(Boolean).join(", ") || root?.country; break;
      case "city_state": cur = [root?.city, root?.state].filter(Boolean).join(", "); break;
      case "start_date": case "end_date": case "grad_date": {
        const pre = lastSeg === "start_date" ? "start" : "end";
        const month = root?.[`${pre}_month`], year = root?.[`${pre}_year`];
        if (!year) return undefined;
        return AB.format(undefined, fmt || "MM/YYYY", { month, year });
      }
      case "current_company": cur = profile.experience?.find((e) => e.current)?.company || profile.experience?.[0]?.company; break;
      case "current_title": cur = profile.experience?.find((e) => e.current)?.title || profile.experience?.[0]?.title; break;
      case "most_recent_school": cur = profile.education?.[0]?.school; break;
      case "most_recent_degree": cur = profile.education?.[0]?.degree; break;
      case "most_recent_major": cur = profile.education?.[0]?.major; break;
      case "most_recent_gpa": cur = profile.education?.[0]?.gpa; break;
      case "skills_text": cur = (profile.skills || []).join(", "); break;
    }
  }
  if (cur === undefined || cur === null || cur === "") return undefined;
  if (fmt && /^(MM|M|MMM|MMMM|YYYY|YY)$/.test(fmt) && (lastSeg?.endsWith("_month") || lastSeg?.endsWith("_year"))) {
    // formatting a month or year field directly
    const isMonth = lastSeg.endsWith("_month");
    return AB.format(cur, fmt, { month: isMonth ? cur : parent?.[lastSeg.replace("_year", "_month")], year: isMonth ? parent?.[lastSeg.replace("_month", "_year")] : cur });
  }
  return AB.format(cur, fmt);
};

// Saved-answer lookup by normalized label (exact, then contains either way).
AB.lookupAnswer = (profile, label) => {
  const answers = profile?.answers || {};
  const nl = AB.norm(label);
  if (!nl) return undefined;
  for (const [k, v] of Object.entries(answers)) if (AB.norm(k) === nl) return v;
  for (const [k, v] of Object.entries(answers)) { const nk = AB.norm(k); if (nk && (nl.includes(nk) || nk.includes(nl))) return v; }
  return undefined;
};

// Optional bundled default profile (configs/profile.default.json, git-ignored, personal). Seeds storage once when empty.
AB.seedDefaultProfile = async () => {
  try {
    const r = await fetch(chrome.runtime.getURL("configs/profile.default.json"));
    if (!r.ok) return null;
    const p = await r.json();
    if (!p || typeof p !== "object" || !(p.first_name || p.email)) return null;
    await new Promise((res) => chrome.storage.local.set({ profile: p, profileSeededFrom: "configs/profile.default.json" }, res));
    return p;
  } catch { return null; }
};

AB.loadProfile = () =>
  new Promise((resolve) =>
    chrome.storage.local.get(["profile", "resume", "settings"], async (r) => {
      let profile = r.profile;
      if (!profile || (!profile.first_name && !profile.email)) profile = (await AB.seedDefaultProfile()) || profile || {};
      resolve({ profile: { ...AB.PROFILE_DEFAULT, ...profile }, resume: r.resume || null, settings: r.settings || {} });
    })
  );
