// Autobot engine: multi-round option search for typeahead / searchable dropdown fields.
//
// Modeled on Jobright Autofill 1.24.1's "client search" loop (evidence: docs/SEARCH-REA.md):
//   site driver -> requestStep(start | {session, round, options}) -> REQUEST_SEARCH | SELECT_OPTIONS | RETURN_EMPTY | RETRYABLE_FAILURE
//   REQUEST_SEARCH  -> type search_input into the widget, capture <= 25 {value, text} candidates, send them back
//   SELECT_OPTIONS  -> recapture if the chosen round is not the current one, commit exactly that candidate, verify readback
// Jobright resolves each step on its server (a model picks the query and the option). Autobot keeps the same
// action vocabulary and guards, but the resolver below is local and deterministic: a query plan per field type
// and a token scorer. Nothing leaves the browser.
//
// This file is pure logic (no DOM) so it can be unit-tested in Node; DOM adapters live in search-widgets.js.
var AB = globalThis.AB || (globalThis.AB = {});
AB.search = AB.search || {};
(() => {
  const S = AB.search;

  // ---------- contract constants (mirrors the Jobright client-search validator) ----------
  S.LIMITS = Object.freeze({
    maxOptions: 25,          // request.options cannot exceed 25
    maxSearches: 5,          // driver aborts with search-limit-exceeded after 5 REQUEST_SEARCH rounds
    textMax: 512,            // question / original_answer / option.text / selected value
    queryMax: 256,           // search_input
    valueMax: 256,           // option.value / option.domain
    keyMax: 128,             // candidate_key / round_id / resolve_session_id
  });
  S.FIELD_TYPES = Object.freeze(["school", "major", "degree", "location", "company", "generic"]);
  S.QUESTIONS = Object.freeze({
    school: "What school did you attend?",
    major: "What was your field of study?",
    degree: "What degree did you earn?",
    location: "What city do you live in?",
    company: "What company did you work for?",
    generic: "Which option matches?",
  });
  // Minimum score to accept a candidate without asking for another search round.
  // One distinctive extra token costs 0.2, so every threshold sits above 0.8: an option that merely contains the
  // answer plus another distinguishing word ("Business" vs "Business Analytics") is never accepted.
  S.THRESHOLDS = Object.freeze({ school: 0.86, major: 0.85, degree: 0.78, location: 0.85, company: 0.84, generic: 0.85 });
  // A runner-up with different text this close to the top means the round is ambiguous.
  S.TIE_MARGIN = 0.05;

  // ---------- normalization ----------
  // Jobright's own local matcher (contents/methods/choice-match) is NFKC + curly quotes + whitespace + lowercase,
  // exact equality only. Autobot adds diacritic folding, "&" -> "and" and punctuation stripping for the token scorer.
  S.exactNorm = (s) =>
    typeof s !== "string" && typeof s !== "number" ? "" :
      String(s).normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

  S.fold = (s) =>
    String(s ?? "")
      .normalize("NFKD").replace(/\p{M}+/gu, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/&/g, " and ")
      .replace(/'s\b/g, "s")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const STOP = new Set(["the", "of", "at", "and", "in", "for", "a", "an", "de", "la", "le", "el", "du", "des", "di", "da"]);
  // Words that add little when they are the only difference between the answer and an option.
  const GENERIC = {
    school: new Set(["university", "college", "institute", "school", "campus", "main", "univ", "uni", "u", "inc"]),
    major: new Set(["studies", "science", "sciences", "bachelor", "master", "degree", "in", "major", "program", "ba", "bs", "b", "s", "ms", "ma"]),
    degree: new Set(["degree", "of", "in", "diploma"]),
    location: new Set(["united", "states", "usa", "us", "america", "metro", "area", "greater"]),
    company: new Set(["inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "sa", "ag"]),
    generic: new Set(),
  };
  S.tokens = (s) => S.fold(s).split(" ").filter((t) => t && !STOP.has(t));
  S.GENERIC = GENERIC;
  S.STOP = STOP;

  // ---------- alias tables (deterministic, small) ----------
  S.US_STATES = Object.freeze({
    al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
    fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky",
    la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri",
    mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
    nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island",
    sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
    wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia", pr: "puerto rico",
  });
  const STATE_BY_NAME = Object.fromEntries(Object.entries(S.US_STATES).map(([k, v]) => [v, k]));
  S.COUNTRY_ALIASES = Object.freeze({
    "united states": ["usa", "us", "united states of america", "u s", "u s a", "america"],
    "united kingdom": ["uk", "u k", "great britain", "britain", "england"],
    "united arab emirates": ["uae"], "south korea": ["korea republic of", "republic of korea", "korea"],
  });
  S.DEGREE_FAMILIES = Object.freeze({
    bachelor: ["bachelor", "bachelors", "bachelor s", "bs", "ba", "bsc", "b s", "b a", "be", "btech", "b eng", "beng", "bfa", "bba", "bsn"],
    master: ["master", "masters", "master s", "ms", "ma", "msc", "m s", "m a", "meng", "m eng", "mtech", "mfa", "msn", "graduate degree"],
    mba: ["mba", "m b a", "master of business administration"],
    phd: ["phd", "ph d", "doctorate", "doctoral", "doctor of philosophy", "dphil"],
    associate: ["associate", "associates", "associate s", "aa", "as", "aas"],
    highschool: ["high school", "high school diploma", "ged", "secondary school", "high school or equivalent"],
    jd: ["jd", "j d", "juris doctor"], md: ["md", "m d", "doctor of medicine"],
  });
  S.degreeFamily = (s) => {
    const f = S.fold(s);
    if (!f) return null;
    // Longest alias first so "master of business administration" wins over "master".
    const pairs = [];
    for (const [fam, alts] of Object.entries(S.DEGREE_FAMILIES)) for (const a of alts) pairs.push([fam, a]);
    pairs.sort((a, b) => b[1].length - a[1].length);
    for (const [fam, a] of pairs) if (f === a || f.startsWith(a + " ") || f.includes(" " + a + " ") || f.endsWith(" " + a)) return fam;
    return null;
  };

  // Subject qualifier inside a degree family: "Bachelor of Science" (science) vs "Bachelor of Arts" (arts).
  const QUALIFIERS = [
    ["fine arts", /\b(fine arts|bfa|mfa)\b/], ["business", /\b(business administration|bba|mba)\b/], ["nursing", /\b(nursing|bsn|msn)\b/],
    ["applied science", /\b(applied science|bas|mas)\b/], ["engineering", /\b(engineering|beng|meng|b eng|m eng|btech|mtech|be)\b/],
    ["education", /\b(education|bed|med)\b/], ["law", /\b(laws|llb|llm)\b/], ["science", /\b(science|sciences|bs|bsc|b s|ms|msc|m s)\b/], ["arts", /\b(arts|ba|b a|ma|m a)\b/],
  ];
  S.degreeQualifier = (s) => { const f = ` ${S.fold(s)} `; for (const [q, re] of QUALIFIERS) if (re.test(f)) return q; return null; };

  // Expand a location string into a canonical token list: state codes -> names, country aliases -> canonical.
  S.locationTokens = (s) => {
    let f = " " + S.fold(s) + " ";
    for (const [canon, alts] of Object.entries(S.COUNTRY_ALIASES)) for (const a of alts.slice().sort((x, y) => y.length - x.length)) f = f.replace(new RegExp(` ${a} `, "g"), ` ${canon} `);
    const raw = f.trim().split(" ").filter(Boolean);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      // Only treat a 2-letter token as a state code when it follows something (city) or is alone: "austin tx", "tx".
      if (t.length === 2 && S.US_STATES[t] && (i > 0 || raw.length === 1)) { out.push(...S.US_STATES[t].split(" ")); continue; }
      out.push(t);
    }
    return out.filter((t) => !STOP.has(t));
  };

  // School abbreviations users commonly have in profiles vs what ATS lists show.
  S.schoolVariants = (s) => {
    const raw = String(s ?? "").trim();
    const out = [];
    const add = (v) => { v = String(v || "").replace(/\s+/g, " ").trim(); if (v && v.length >= 2) out.push(v); };
    const tidy = (v) => v.replace(/\s+([,.;])/g, "$1").replace(/^[\s,]+|[\s,]+$/g, "");
    const base = raw.replace(/^the\s+/i, "");
    const core = base.replace(/\s*[-–—,(].*$/, "");                          // drop campus suffix: "X - Main Campus", "X (Austin)"
    add(raw);
    add(base);
    add(core);
    add(core.replace(/\buniv\.?(?=\s|$)/gi, "University").replace(/\bst\.\s/gi, "Saint "));
    add(tidy(core.replace(/\b(university|college|institute of technology|institute)\b/gi, " ").replace(/\s+/g, " ").replace(/\s+(of|at)\s*$/i, "").replace(/^\s*(of|at)\s+/i, "")));
    const m = base.match(/^university of (.+?)(?:,|\s+at\s+|\s*[-–—]|$)/i);
    if (m) add(m[1]);                                                         // "University of Michigan" -> "Michigan"
    return out;
  };

  // ---------- query plan: the ordered search_input values the local resolver will request ----------
  S.queryPlan = (fieldType, answer) => {
    const a = String(answer ?? "").replace(/\s+/g, " ").trim();
    if (!a) return [];
    const toks = a.split(" ");
    const plan = [];
    const generic = GENERIC[fieldType] || GENERIC.generic;
    const push = (q) => {
      q = String(q || "").replace(/\s+/g, " ").replace(/[\s,&/+-]+$/g, "").replace(/^[\s,&/+-]+/g, "").trim().slice(0, S.LIMITS.queryMax);
      if (q.length < 2) return;
      // A query made only of stop words / generic words ("University of", "Inc") matches everything.
      const toks = S.fold(q).split(" ").filter(Boolean);
      if (!toks.some((t) => !STOP.has(t) && !generic.has(t))) return;
      if (!plan.some((p) => S.fold(p) === S.fold(q))) plan.push(q);
    };
    switch (fieldType) {
      case "school":
        S.schoolVariants(a).forEach(push);
        push(toks.slice(0, 2).join(" "));
        break;
      case "location": {
        const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
        push(a);
        if (parts.length >= 2) {
          const st = S.US_STATES[S.fold(parts[1])];
          if (st) push(`${parts[0]}, ${st.replace(/\b\w/g, (c) => c.toUpperCase())}`);
          const code = STATE_BY_NAME[S.fold(parts[1])];
          if (code) push(`${parts[0]}, ${code.toUpperCase()}`);
        }
        push(parts[0]);
        break;
      }
      case "company":
        push(a);
        push(a.replace(/[,.]?\s+(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh)\.?$/i, ""));
        push(toks[0]);
        break;
      case "major":
        push(a);
        push(a.replace(/^(b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|bachelor('?s)?|master('?s)?)(\s+of\s+\w+)?\s+(in\s+)?/i, ""));
        push(a.replace(/\s+(and|&)\s+.*$/i, ""));
        push(toks.slice(0, 2).join(" "));
        push(toks[0]);
        break;
      case "degree": {
        push(a);
        const fam = S.degreeFamily(a);
        if (fam) for (const alt of [{ bachelor: "Bachelor", master: "Master", mba: "MBA", phd: "Doctor", associate: "Associate", highschool: "High School", jd: "Juris", md: "Doctor of Medicine" }[fam]]) push(alt);
        push(toks[0]);
        break;
      }
      default:
        push(a);
        push(toks.slice(0, 3).join(" "));
        push(toks[0]);
    }
    return plan.slice(0, S.LIMITS.maxSearches);
  };

  // ---------- scorer ----------
  // Score in [0, 1]. Deterministic; documented weights. 1.0 = exact after exactNorm.
  S.score = (fieldType, answer, candidateText) => {
    const A = String(answer ?? ""), C = String(candidateText ?? "");
    if (!S.exactNorm(A) || !S.exactNorm(C)) return 0;
    if (S.exactNorm(A) === S.exactNorm(C)) return 1;
    if (S.fold(A) === S.fold(C)) return 0.99;
    if (fieldType === "degree") {
      const fa = S.degreeFamily(A), fc = S.degreeFamily(C);
      if (fa && fc) {
        if (fa !== fc) return 0.05;
        const qa = S.degreeQualifier(A), qc = S.degreeQualifier(C);
        if (qa && qc && qa !== qc) return 0.5;          // BS vs BA, MS vs MA, MFA vs MA
        return qa && qc ? 0.96 : 0.92;                   // same family; same qualifier ranks above a bare family match
      }
    }
    // A parenthetical is ignored only when it is an alias: its letters are the initials of the rest ("(UCLA)") or all
    // of its words are already in the answer. "(Commerce)" / "(Austin)" name a different campus and are scored.
    const initials = (s) => S.fold(s).split(" ").filter((t) => t && !STOP.has(t)).map((t) => t[0]).join("");
    let Cs = C, parenCost = 0;
    if (fieldType !== "degree") {
      const main = C.replace(/\([^)]*\)/g, " ");
      for (const m of C.match(/\(([^)]*)\)/g) || []) {
        const inner = m.slice(1, -1), it = S.tokens(inner), at0 = S.tokens(A);
        const isAlias = it.length > 0 && ((S.fold(inner).replace(/ /g, "").length >= 2 && initials(main).startsWith(S.fold(inner).replace(/ /g, ""))) || it.every((t) => at0.includes(t)));
        if (isAlias) { Cs = Cs.replace(m, " "); parenCost += 0.02 * it.filter((t) => !at0.includes(t)).length; }
      }
      parenCost = Math.min(0.06, parenCost);
    }
    const at = fieldType === "location" ? S.locationTokens(A) : S.tokens(A);
    const ct = fieldType === "location" ? S.locationTokens(Cs) : S.tokens(Cs);
    if (!at.length || !ct.length) return 0;
    const generic = GENERIC[fieldType] || GENERIC.generic;
    const used = new Set();
    let hit = 0;
    for (const t of at) {
      let best = 0, bj = -1;
      for (let j = 0; j < ct.length; j++) {
        if (used.has(j)) continue;
        const c = ct[j];
        const v = c === t ? 1 : (t.length >= 4 && c.startsWith(t)) || (c.length >= 4 && t.startsWith(c)) ? 0.8 : 0;
        if (v > best) { best = v; bj = j; }
      }
      if (bj >= 0) used.add(bj);
      hit += best * (generic.has(t) ? 0.5 : 1);
    }
    const aWeight = at.reduce((s, t) => s + (generic.has(t) ? 0.5 : 1), 0);
    const recall = aWeight ? hit / aWeight : 0;
    // Extra candidate tokens that are not generic make it a different entity ("Texas A&M University - Commerce").
    const extra = ct.filter((t, j) => !used.has(j));
    const extraDistinct = extra.filter((t) => !generic.has(t)).length;
    const extraGeneric = extra.length - extraDistinct;
    const precisionPenalty = Math.min(0.6, extraDistinct * 0.2 + extraGeneric * 0.02);
    // Acronym bonus: "MIT" vs "Massachusetts Institute of Technology", "UCLA" vs "University of California Los Angeles".
    const acr = (toks) => toks.filter((t) => !STOP.has(t)).map((t) => t[0]).join("");
    const fa = S.fold(A).replace(/ /g, ""), fc = S.fold(C).replace(/ /g, "");
    // Two-letter acronyms are too ambiguous to count; ties between several acronym matches are refused by the resolver.
    const acronym = (fa.length >= 3 && fa.length <= 6 && acr(S.fold(C).split(" ")) === fa) || (fc.length >= 3 && fc.length <= 6 && acr(S.fold(A).split(" ")) === fc);
    let s = recall - precisionPenalty - parenCost;
    if (acronym) s = Math.max(s, 0.88);
    if (recall === 1 && extraDistinct === 0) s = Math.max(s, 0.93 - extraGeneric * 0.01 - parenCost);
    // Word order matters for schools: "University of Miami" and "Miami University" are different institutions.
    if (fieldType === "school") {
      const uo = (x) => / university of /.test(` ${S.fold(x)} `), u = (x) => / university /.test(` ${S.fold(x)} `);
      if (u(A) && u(C) && uo(A) !== uo(C)) s = Math.min(s, 0.8);
    }
    return Math.max(0, Math.min(0.98, Number(s.toFixed(4))));
  };

  // Rank candidates; ties broken by shorter text, then original order (stable, deterministic).
  S.rank = (fieldType, answers, options) => {
    const ans = AB.arr(answers).map(String).filter((s) => s.trim());
    return options
      .map((o, i) => ({ o, i, score: Math.max(0, ...ans.map((a) => S.score(fieldType, a, o.text))) }))
      .sort((x, y) => y.score - x.score || x.o.text.length - y.o.text.length || x.i - y.i);
  };

  // ---------- step contract validation (port of Jobright's normalize/validate pair) ----------
  const fail = (m) => { throw new Error(`Invalid autobot search payload: ${m}`); };
  const str = (v, max, name) => { if (typeof v !== "string" || !v.trim() || v.length > max) fail(`${name} must be a non-empty string no longer than ${max}`); return v; };
  S.normalizeRequest = (req) => {
    if (!req || typeof req !== "object" || Array.isArray(req)) fail("request must be an object");
    if ("field_type" in req) {
      if (!S.FIELD_TYPES.includes(req.field_type)) fail(`request.field_type must be one of ${S.FIELD_TYPES.join(", ")}`);
      return { field_type: req.field_type, question: str(req.question, S.LIMITS.textMax, "request.question"), original_answer: str(req.original_answer, S.LIMITS.textMax, "request.original_answer"), alternates: AB.arr(req.alternates).filter((x) => typeof x === "string" && x.trim()).slice(0, 8) };
    }
    if (!Array.isArray(req.options)) fail("request.options must be an array");
    if (req.options.length > S.LIMITS.maxOptions) fail(`request.options cannot exceed ${S.LIMITS.maxOptions}`);
    const keys = new Set();
    const options = req.options.map((o) => {
      const opt = { candidate_key: str(o?.candidate_key, S.LIMITS.keyMax, "option.candidate_key"), value: str(o.value, S.LIMITS.valueMax, "option.value"), text: str(o.text, S.LIMITS.textMax, "option.text") };
      if (keys.has(opt.candidate_key)) fail("request.options contains a duplicate candidate_key");
      keys.add(opt.candidate_key);
      return opt;
    });
    return { resolve_session_id: str(req.resolve_session_id, S.LIMITS.keyMax, "request.resolve_session_id"), round_id: str(req.round_id, S.LIMITS.keyMax, "request.round_id"), options };
  };
  S.validateResponse = (res, req) => {
    if (!res || typeof res !== "object") fail("response must be an object");
    switch (res.action) {
      case "REQUEST_SEARCH":
        str(res.resolve_session_id, S.LIMITS.keyMax, "response.resolve_session_id");
        str(res.round_id, S.LIMITS.keyMax, "response.round_id");
        if ("round_id" in req && req.round_id === res.round_id) fail("REQUEST_SEARCH must use a fresh round_id");
        str(res.search_input, S.LIMITS.queryMax, "response.search_input");
        return res;
      case "SELECT_OPTIONS": {
        if (!("options" in req)) fail("SELECT_OPTIONS is not allowed on a start request");
        if (!Array.isArray(res.selected_values) || res.selected_values.length !== 1) fail("SELECT_OPTIONS response.selected_values must contain exactly one item");
        const text = str(res.selected_values[0], S.LIMITS.textMax, "response.selected_values[0]");
        if (res.selected_candidate_key !== undefined) {
          const m = req.options.filter((o) => o.candidate_key === res.selected_candidate_key && o.text === text);
          if (res.round_id !== req.round_id || m.length !== 1) fail("SELECT_OPTIONS must reference current round and candidate identity");
          return res;
        }
        const m = req.options.filter((o) => o.text === text);
        if (!m.length) fail("SELECT_OPTIONS must reference exact text from current options");
        if (new Set(m.map((o) => o.value)).size !== 1) fail("SELECT_OPTIONS text must identify one canonical native value");
        return res;
      }
      case "RETURN_EMPTY": return res;
      case "RETRYABLE_FAILURE": return res;
      default: fail("response.action is unsupported");
    }
  };

  // ---------- local resolver: the deterministic stand-in for Jobright's server step ----------
  // createResolver() returns step(request) -> response, keeping per-session state like the server does.
  let sessionSeq = 0;
  S.createResolver = ({ threshold } = {}) => {
    const st = { session: null, fieldType: null, answers: [], plan: [], next: 0, roundSeq: 0, best: null, rounds: [] };
    const newRound = () => `r${++st.roundSeq}`;
    const requestSearch = (reason) => {
      const q = st.plan[st.next++];
      if (!q) return null;
      return { action: "REQUEST_SEARCH", resolve_session_id: st.session, round_id: newRound(), search_input: q, reason };
    };
    const step = (raw) => {
      const req = S.normalizeRequest(raw);
      let res;
      if ("field_type" in req) {
        // A start request always begins a fresh session (a resolver may be reused across fields).
        Object.assign(st, { next: 0, roundSeq: 0, best: null, rounds: [] });
        st.session = `local-${++sessionSeq}`;
        st.fieldType = req.field_type;
        st.answers = [req.original_answer, ...req.alternates];
        st.plan = [];
        for (const a of st.answers) for (const q of S.queryPlan(req.field_type, a)) if (!st.plan.some((p) => S.fold(p) === S.fold(q))) st.plan.push(q);
        st.plan = st.plan.slice(0, S.LIMITS.maxSearches);
        st.threshold = threshold ?? S.THRESHOLDS[req.field_type] ?? S.THRESHOLDS.generic;
        res = requestSearch("initial query") || { action: "RETURN_EMPTY" };
      } else {
        if (req.resolve_session_id !== st.session) return { action: "RETRYABLE_FAILURE" };
        const ranked = S.rank(st.fieldType, st.answers, req.options);
        const top = ranked[0];
        st.rounds.push({ round_id: req.round_id, top: top ? { text: top.o.text, score: top.score } : null, count: req.options.length });
        if (top && (!st.best || top.score > st.best.score)) st.best = { round_id: req.round_id, option: top.o, score: top.score };
        // Ambiguity: the top text maps to two different values in this round -> refuse (Jobright: ambiguous-selected-text).
        const sameText = top ? req.options.filter((o) => o.text === top.o.text) : [];
        const runnerUp = top ? ranked.find((r) => r.o.text !== top.o.text) : null;
        const tie = Boolean(top && runnerUp && top.score < 0.99 && runnerUp.score >= top.score - S.TIE_MARGIN);
        const ambiguous = tie || (sameText.length > 1 && new Set(sameText.map((o) => o.value)).size > 1);
        if (tie) st.rounds[st.rounds.length - 1].tie = { a: top.o.text, b: runnerUp.o.text, score: top.score };
        if (top && top.score >= st.threshold && !ambiguous) {
          res = { action: "SELECT_OPTIONS", selected_values: [top.o.text], round_id: req.round_id, selected_candidate_key: top.o.candidate_key, score: top.score };
        } else {
          res = requestSearch(!top ? "no candidates" : tie ? `"${top.o.text}" and "${runnerUp.o.text}" are too close (${top.score.toFixed(2)})` : ambiguous ? `"${top.o.text}" maps to two values` : `best "${top.o.text}" scored ${top.score.toFixed(2)} < ${st.threshold}`);
          if (!res) {
            // Plan exhausted: give up (RETURN_EMPTY) rather than guess. `best` is reported for the panel only.
            res = { action: "RETURN_EMPTY", best: st.best ? { text: st.best.option.text, score: st.best.score } : null };
          }
        }
      }
      S.validateResponse(res, req);
      return res;
    };
    return { step, state: st };
  };

  // ---------- driver: runs the loop against a widget adapter (port of the iCIMS driver's control flow) ----------
  // adapter: { capture(el, query, signal) -> {status, generation}, commit(generation, candidate, signal) -> bool, clear?(el) -> bool }
  // generation: { id, query, candidates: [{value, text, ...}], invalidated: bool }
  S.run = async ({ el, fieldType = "generic", answer, alternates = [], adapter, signal, resolver, onTrace, adapterOptions = {} }) => {
    const answers = [answer, ...alternates].map((a) => (a === undefined || a === null ? "" : String(a).trim())).filter(Boolean);
    const result = { fieldType, attempted: true, success: false, actions: [], rounds: [], selected: null, failureReason: null, candidatesSeen: [] };
    const trace = (msg, data) => { try { onTrace?.(msg, data); } catch {} };
    let snapshot, restored = false;
    const done = (reason) => {
      result.failureReason = reason;
      try { if (current && S.discardGeneration) S.discardGeneration(current); } catch {}
      // Leave the control as we found it when the search gives up (Jobright clears the select / resets the widget),
      // except after the user started interacting with it: their input wins.
      if (reason && reason !== "no-answer" && reason !== "trusted-invalidation" && adapter?.restore && !restored) { restored = true; try { adapter.restore(el, snapshot); } catch {} }
      trace("done", result);
      return result;
    };
    if (!answers.length) { result.attempted = false; return done("no-answer"); }
    try { snapshot = adapter?.snapshot ? adapter.snapshot(el) : undefined; } catch { snapshot = undefined; }
    Object.defineProperty(result, "snapshot", { value: snapshot, enumerable: false });
    resolver = resolver || S.createResolver();
    const start = { field_type: S.FIELD_TYPES.includes(fieldType) ? fieldType : "generic", question: S.QUESTIONS[fieldType] || S.QUESTIONS.generic, original_answer: answers[0].slice(0, S.LIMITS.textMax), alternates: answers.slice(1) };
    const searches = [];          // [{round_id, search_input, options}]
    let session = null, round = null, options = null, current = null;
    for (let guard = 0; guard < 20; guard++) {
      if (signal?.aborted) return done("aborted");
      let r;
      try { r = await resolver.step(session && round ? { resolve_session_id: session, round_id: round, options } : start); }
      catch (e) { return done("transport-error"); }
      result.actions.push(r.action);
      if (r.action === "REQUEST_SEARCH") {
        if (!r.resolve_session_id) return done("missing-session-id");
        if (session !== null && r.resolve_session_id !== session) return done("session-id-changed");
        session = r.resolve_session_id;
        if (searches.length >= S.LIMITS.maxSearches) return done("search-limit-exceeded");
        if (searches.some((s) => S.exactNorm(s.search_input) === S.exactNorm(r.search_input))) return done("repeated-search");
        trace("search", { query: r.search_input, reason: r.reason });
        let cap;
        try { cap = await adapter.capture(el, r.search_input, signal, adapterOptions); } catch (e) { return done(signal?.aborted ? "aborted" : "candidate-capture-error"); }
        if (cap.status === "invalidated") return done("trusted-invalidation");
        if (cap.status !== "ready" && cap.status !== "no-results") return done(`candidate-capture-${cap.status}`);
        current = cap.generation || { candidates: [], invalidated: false };
        // Blank candidates would violate the step contract; drop them here rather than fail the whole field.
        const cands = AB.arr(current.candidates).filter((c) => c && String(c.text ?? "").trim()).slice(0, S.LIMITS.maxOptions);
        current.candidates = cands;
        round = r.round_id;
        options = cands.map((c, i) => ({ candidate_key: `candidate-${i + 1}`, value: String(c.value || c.text).slice(0, S.LIMITS.valueMax), text: String(c.text).slice(0, S.LIMITS.textMax) }));
        searches.push({ round_id: round, search_input: r.search_input, options, generation: current });
        for (const o of options) if (result.candidatesSeen.length < 60 && !result.candidatesSeen.includes(o.text)) result.candidatesSeen.push(o.text);
        result.rounds.push({ searchInput: r.search_input, candidateCount: options.length, status: cap.status });
        trace("candidates", { query: r.search_input, count: options.length, sample: options.slice(0, 5).map((o) => o.text) });
        continue;
      }
      if (r.action === "SELECT_OPTIONS") {
        const text = r.selected_values?.[0];
        const s = r.round_id ? searches.find((x) => x.round_id === r.round_id) : [...searches].reverse().find((x) => x.options.some((o) => o.text === text));
        const opt = s && (r.selected_candidate_key ? s.options.find((o) => o.candidate_key === r.selected_candidate_key) : s.options.find((o) => o.text === text));
        if (!s || !opt) return done("missing-current-candidate");
        let gen = s.generation;
        if (gen !== current || gen.invalidated) {
          // The chosen candidate came from an earlier round: type that round's query again and re-find it.
          let cap;
          try { cap = await adapter.capture(el, s.search_input, signal, adapterOptions); } catch { return done(signal?.aborted ? "aborted" : "selected-candidate-recapture-error"); }
          if (cap.status === "invalidated") return done("trusted-invalidation");
          if (cap.status !== "ready" || !cap.generation) return done(`selected-candidate-recapture-${cap.status}`);
          gen = current = cap.generation;
        }
        const cand = gen.candidates.find((c) => String(c.value || c.text).slice(0, S.LIMITS.valueMax) === opt.value && String(c.text).slice(0, S.LIMITS.textMax) === opt.text);
        if (!cand) return done("missing-current-candidate");
        let ok = false;
        try { ok = await adapter.commit(gen, cand, signal); } catch { ok = false; }
        if (!ok) return done(gen.invalidated ? "trusted-invalidation" : "candidate-commit-failed");
        result.success = true;
        if (gen.unverified) result.unverified = true;
        result.selected = { text: cand.text, value: cand.value, score: r.score ?? null, round: s.round_id, query: s.search_input };
        trace("selected", result.selected);
        return done(null);
      }
      if (r.action === "RETURN_EMPTY") {
        if (r.best) result.best = r.best;
        return done("return-empty");
      }
      return done("retryable-failure");
    }
    return done("step-limit");
  };

  // Map a profile key / label to a search field type.
  S.fieldTypeFor = (key = "", label = "") => {
    // Use the last key segment so nested keys ("experience[0].location") classify like top-level ones.
    const k = String(key || "").toLowerCase().split(".").pop().replace(/\[\d+\]$/, ""), l = AB.norm ? AB.norm(label) : String(label).toLowerCase();
    if (/school|university|college|institution/.test(k) || /\b(school|university|college|institution)\b/.test(l)) return "school";
    if (/major|field_of_study|discipline/.test(k) || /\b(major|field of study|discipline|area of study)\b/.test(l)) return "major";
    if (/degree/.test(k) || /\bdegree\b/.test(l)) return "degree";
    if (/^(location|city|city_state)$/.test(k) || /\b(location|city|where .* live|located)\b/.test(l)) return "location";
    if (/company|employer|organization/.test(k) || /\b(company|employer|organization)\b/.test(l)) return "company";
    return "generic";
  };

  // Per-ATS canonical names stored on a profile education entry. Simplify keeps one name per ATS for the same
  // school ({ school: "Texas A&M University", school_greenhouse: "Texas A&M University - College Station" }), which is
  // the exact text that ATS's list uses. key: the field's profile key ("education[0].school", "education.0.major|upper",
  // or the heuristic "most_recent_school"); ats: the detected config id. Returns [] when nothing applies.
  S.atsAlternates = (profile, key, ats) => {
    const id = String(ats ?? "").trim().toLowerCase();
    if (!profile || typeof profile !== "object" || !id || id === "generic") return [];
    const k = String(key ?? "").split("|")[0].trim().replace(/\[(\d+)\]/g, ".$1");
    let m = k.match(/^education\.(\d+)\.(school|major)$/);
    if (!m) { const r = k.match(/^most_recent_(school|major)$/); if (r) m = [k, "0", r[1]]; }
    if (!m) return [];
    const entry = AB.arr(profile.education)[Number(m[1])];
    const v = entry && typeof entry === "object" ? entry[`${m[2]}_${id}`] : undefined;
    return typeof v === "string" && v.trim() ? [v.trim()] : [];
  };

  // Rerun safety: does a choice the control already shows match one of the answers? Same bar search uses to commit
  // (exact after exactNorm, or a score at the field type's threshold), so "Texas A&M University" does not count as
  // matching an existing "Texas A&M University - College Station". Returns the matching shown text or null.
  S.selectedMatch = (fieldType, values, texts) => {
    const ft = S.FIELD_TYPES.includes(fieldType) ? fieldType : "generic";
    const th = S.THRESHOLDS[ft] ?? S.THRESHOLDS.generic;
    const vs = AB.arr(values).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!vs.length) return null;
    for (const t of AB.arr(texts).map((x) => String(x ?? "").trim()).filter(Boolean)) {
      if (vs.some((v) => S.exactNorm(v) === S.exactNorm(t) || S.score(ft, v, t) >= th)) return t;
    }
    return null;
  };
})();
