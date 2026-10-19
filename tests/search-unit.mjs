// autobot unit test for the pure-logic search engine (engine/search.js): scorer, ranking, query plans,
// step-contract validation, the local resolver, the AB.search.run driver against a fake in-memory adapter,
// per-ATS names and the rerun checks. No browser, no dependencies: util.js, profile.js, heuristics.js, search.js and
// search-widgets.js are classic scripts evaluated into this Node context (their DOM code only runs when called).
// Usage: node tests/search-unit.mjs [--ext=legacy/autobot-v2]   (--ext picks the extension folder relative to the
// repo root, default autobot/)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extArg = process.argv.find((a) => a.startsWith("--ext="));
const extDir = path.resolve(root, extArg ? extArg.slice(6) : process.env.AUTOBOT_EXT || "autobot");
const searchFile = path.join(extDir, "engine", "search.js");
if (!fs.existsSync(searchFile)) { console.error(`no engine/search.js under ${extDir}`); process.exit(2); }

globalThis.AB = {};
for (const f of ["util.js", "profile.js", "heuristics.js", "search.js", "search-widgets.js"]) {
  const filename = path.join(extDir, "engine", f);
  if (!fs.existsSync(filename)) continue;
  vm.runInThisContext(fs.readFileSync(filename, "utf8"), { filename });
}
const AB = globalThis.AB;
const S = AB.search;
console.log("ext:", path.relative(root, extDir) || ".");

// ---------- tiny runner (same PASS/FAIL + "N/M checks passed" output as tests/run.mjs) ----------
const results = [];
const show = (v) => { let s; try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); } return String(s ?? v).slice(0, 70); };
// expected: a value (deep-equal) or a predicate; `want` labels a predicate in the output.
const check = (name, actual, expected, want) => {
  let ok;
  if (typeof expected === "function") { try { ok = Boolean(expected(actual)); } catch { ok = false; } }
  else { try { assert.deepStrictEqual(actual, expected); ok = true; } catch { ok = false; } }
  results.push({ name, ok, actual: show(actual), expected: typeof expected === "function" ? want || "(predicate)" : show(expected) });
};
const throws = (name, fn, re) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  check(name, err ? err.message.replace(/^Invalid autobot search payload: /, "") : "(no throw)", () => Boolean(err) && re.test(err.message), `throws ${re}`);
};
const accepts = (name, fn) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  check(name, err ? `threw: ${err.message}` : "ok", "ok");
};
// Run one async case; an unexpected exception becomes a FAIL line instead of aborting the suite.
const tcase = async (name, fn) => {
  try { await fn(); } catch (e) { results.push({ name: `${name} (threw)`, ok: false, actual: show(e?.message ?? e), expected: "no exception" }); }
};

// search.js exports its STOP / GENERIC word sets, so the "no all-generic query" invariant uses the real lists.
const STOP = S.STOP;
const GENERIC = S.GENERIC;

// ---------- fake adapter + stub resolvers for the driver ----------
// table: query -> candidate list ({value, text}) or a status string ("timeout", "invalidated", ...). Unknown query -> no-results.
const fakeAdapter = (table, { commitResult = true } = {}) => {
  const calls = { capture: [], commit: [], restore: [] };
  return {
    calls,
    async capture(el, query) {
      calls.capture.push(query);
      const row = table[query];
      if (row === undefined) return { status: "no-results", generation: { id: calls.capture.length, query, candidates: [], invalidated: false } };
      if (typeof row === "string") return { status: row };
      return { status: "ready", generation: { id: calls.capture.length, query, candidates: row.map((c) => ({ ...c })), invalidated: false } };
    },
    async commit(gen, cand) { calls.commit.push({ genId: gen.id, value: cand.value, text: cand.text }); return commitResult; },
    snapshot: (el) => ({ snap: el?.id ?? null }),
    restore(el, snap) { calls.restore.push(snap); },
  };
};
// responses: array of response objects, or a function (callIndex, request) -> response.
const stubResolver = (responses) => {
  const seen = [];
  return { seen, step: (req) => { seen.push(req); const i = seen.length - 1; return typeof responses === "function" ? responses(i, req) : responses[i]; } };
};
const spyResolver = () => {
  const inner = S.createResolver();
  const seen = [];
  return { seen, inner, step: (req) => { seen.push(req); return inner.step(req); } };
};
const RS = (round, query, session = "s1") => ({ action: "REQUEST_SEARCH", resolve_session_id: session, round_id: round, search_input: query });

const TAMU = { value: "tamu", text: "Texas A&M University" };
const COMMERCE = { value: "tamu-commerce", text: "Texas A&M University - Commerce" };
const KINGSVILLE = { value: "tamu-kingsville", text: "Texas A&M University - Kingsville" };
const TECH = { value: "ttu", text: "Texas Tech University" };
const T = S.THRESHOLDS;

(async () => {
  // =====================================================================================
  // 1. Scorer
  // =====================================================================================
  check("score: exact text = 1", S.score("school", "Texas A&M University", "Texas A&M University"), 1);
  check("score: exact after exactNorm (case/space) = 1", S.score("school", "Texas A&M University", "  texas a&m   UNIVERSITY "), 1);
  check("score: empty candidate = 0", S.score("school", "Texas A&M University", "   "), 0);
  check("score: TAMU vs 'Texas A & M University' >= 0.95", S.score("school", "Texas A&M University", "Texas A & M University"), (s) => s >= 0.95, ">= 0.95");
  check("score: TAMU vs '... - Commerce' < school threshold", S.score("school", "Texas A&M University", "Texas A&M University - Commerce"), (s) => s < T.school, `< ${T.school}`);
  check("score: TAMU vs 'Texas Tech University' < school threshold", S.score("school", "Texas A&M University", "Texas Tech University"), (s) => s < T.school, `< ${T.school}`);
  check("score: MIT vs Massachusetts Inst. of Tech >= threshold", S.score("school", "MIT", "Massachusetts Institute of Technology"), (s) => s >= T.school, `>= ${T.school}`);
  check("score: 'Austin, TX' vs 'Austin, Texas, US' >= location thr", S.score("location", "Austin, TX", "Austin, Texas, United States"), (s) => s >= T.location, `>= ${T.location}`);
  check("score: 'Austin, TX' vs 'Austin, Minnesota, US' < 0.5", S.score("location", "Austin, TX", "Austin, Minnesota, United States"), (s) => s < 0.5, "< 0.5");
  check("score: Bachelor's vs 'Bachelor of Science (BS)' high", S.score("degree", "Bachelor's", "Bachelor of Science (BS)"), (s) => s >= 0.9 && s >= T.degree, ">= 0.9");
  check("score: Bachelor's vs 'Master of Science (MS)' very low", S.score("degree", "Bachelor's", "Master of Science (MS)"), (s) => s <= 0.1, "<= 0.1");
  check("score: 'Computer Science' vs 'Computer and Info Sci' < major", S.score("major", "Computer Science", "Computer and Information Sciences"), (s) => s < T.major, `< ${T.major}`);
  check("score: 'Babbage & Co' vs 'Babbage and Co.' high", S.score("company", "Babbage & Co", "Babbage and Co."), (s) => s >= 0.95 && s >= T.company, ">= 0.95");
  check("score: always within [0, 1]", ["Texas", "MIT", "Austin, TX", "Bachelor's", "x"].flatMap((a) => ["Texas A&M University - Commerce", "Massachusetts Institute of Technology", "Master of Science (MS)", "y"].map((c) => S.score("school", a, c))), (xs) => xs.every((s) => s >= 0 && s <= 1), "all in [0, 1]");

  // =====================================================================================
  // 2. rank: higher score first, then shorter text, then original order
  // =====================================================================================
  {
    const opts = ["Banana split", "Kiwi", "Apple  ", "apple", "Pear", "APPLE"].map((text, i) => ({ value: `v${i}`, text }));
    const r = S.rank("generic", "Apple", opts);
    check("rank: score desc, then shorter text, then index", r.map((x) => x.i), [3, 5, 2, 1, 4, 0]);
    check("rank: scores carried on each entry", r.map((x) => x.score), [1, 1, 1, 0, 0, 0]);
    check("rank: entry.o is the original option object", r[0].o, opts[3]);
    const r2 = S.rank("school", "Texas A&M University", [TECH, COMMERCE, TAMU]);
    check("rank: TAMU ranks over Commerce over Tech", r2.map((x) => x.o.value), ["tamu", "tamu-commerce", "ttu"]);
    const r3 = S.rank("generic", ["zzz", "Kiwi"], opts);
    check("rank: score is the max over all answers", r3[0].o.text, "Kiwi");
    const r4 = S.rank("generic", "nothing matches", [{ text: "ccc" }, { text: "bb" }, { text: "aa" }, { text: "d" }]);
    check("rank: all-zero ties fall back to length then order", r4.map((x) => x.o.text), ["d", "bb", "aa", "ccc"]);
  }

  // =====================================================================================
  // 3. queryPlan
  // =====================================================================================
  check("plan: school 'Texas A&M University'", S.queryPlan("school", "Texas A&M University"), ["Texas A&M University", "Texas A&M"]);
  {
    const p = S.queryPlan("location", "Austin, TX");
    check("plan: location 'Austin, TX' starts with the answer", p[0], "Austin, TX");
    check("plan: location 'Austin, TX' includes 'Austin, Texas'", p, (x) => x.includes("Austin, Texas"), "includes 'Austin, Texas'");
    check("plan: location 'Austin, TX' includes 'Austin'", p, (x) => x.includes("Austin"), "includes 'Austin'");
    check("plan: location 'Austin, Texas' includes 'Austin, TX'", S.queryPlan("location", "Austin, Texas"), (x) => x.includes("Austin, TX"), "includes 'Austin, TX'");
  }
  {
    const p = S.queryPlan("school", "University of Texas at Austin");
    check("plan: UT Austin has no 'University of' query", p, (x) => !x.some((q) => S.fold(q) === "university of"), "no 'University of'");
    check("plan: UT Austin full plan", p, ["University of Texas at Austin", "Texas at Austin", "Texas"]);
  }
  {
    const p = S.queryPlan("company", "Babbage & Co");
    check("plan: company 'Babbage & Co' has no trailing '&'", p, (x) => x.every((q) => !/[&\s]$/.test(q)), "no query ends in '&'");
    check("plan: company 'Babbage & Co' full plan", p, ["Babbage & Co", "Babbage"]);
  }
  check("plan: empty answer -> []", S.queryPlan("school", "   "), []);
  check("plan: generic-only answer 'University of' -> []", S.queryPlan("school", "University of"), []);
  check("plan: 'Remote' is a real location answer", S.queryPlan("location", "Remote"), ["Remote"]);
  check("plan: generic-only location 'United States' -> []", S.queryPlan("location", "United States"), []);
  // "The St. Mary's College, Notre Dame" yields six distinct candidate queries; the plan is capped at maxSearches.
  check("plan: cap reached for a 6-variant school answer", S.queryPlan("school", "The St. Mary's College, Notre Dame").length, S.LIMITS.maxSearches);
  {
    const battery = {
      school: ["Texas A&M University", "University of Texas at Austin", "The University of Texas at Austin - Main Campus", "The St. Mary's College, Notre Dame", "University of St. Thomas - Houston", "University of California, Los Angeles (UCLA)", "MIT", "Univ. of Michigan", "University of", "College"],
      major: ["Computer Science", "B.S. Computer Science and Engineering", "Bachelor of Science in Mechanical Engineering", "Science", "Computer & Information Sciences"],
      degree: ["Bachelor's", "Master of Science", "PhD", "High School Diploma", "Degree"],
      location: ["Austin, TX", "Austin, Texas", "New York, NY, USA", "Remote", "United States", "San Francisco, CA"],
      company: ["Babbage & Co", "Acme Holdings, Inc.", "Inc", "AT&T", "Foo, LLC"],
      generic: ["Option 40", "Prefer not to say", Array(80).fill("word").join(" ")],
    };
    const bad = { cap: [], dup: [], generic: [], length: [] };
    let plans = 0;
    for (const [ft, answers] of Object.entries(battery)) for (const a of answers) {
      const p = S.queryPlan(ft, a);
      plans++;
      if (p.length > S.LIMITS.maxSearches) bad.cap.push(`${ft}:${a}`);
      if (new Set(p.map(S.fold)).size !== p.length) bad.dup.push(`${ft}:${a}`);
      for (const q of p) {
        if (!S.fold(q).split(" ").some((t) => t && !STOP.has(t) && !GENERIC[ft].has(t))) bad.generic.push(`${ft}:${q}`);
        if (q.length < 2 || q.length > S.LIMITS.queryMax) bad.length.push(`${ft}:${q.length}`);
      }
    }
    check(`plan: ${plans} plans never exceed maxSearches`, bad.cap, []);
    check(`plan: ${plans} plans have no fold-duplicates`, bad.dup, []);
    check(`plan: ${plans} plans have no all-stop/generic query`, bad.generic, []);
    check(`plan: ${plans} plans keep 2 <= query.length <= queryMax`, bad.length, []);
  }

  // =====================================================================================
  // 4. Contract validation
  // =====================================================================================
  {
    const opt = (i, extra = {}) => ({ candidate_key: `candidate-${i}`, value: `v${i}`, text: `Option ${i}`, ...extra });
    const cont = (options, extra = {}) => ({ resolve_session_id: "s1", round_id: "r1", options, ...extra });
    const start = (extra = {}) => ({ field_type: "school", question: "What school did you attend?", original_answer: "Texas A&M University", ...extra });

    accepts("contract: 25 options accepted", () => assert.equal(S.normalizeRequest(cont(Array.from({ length: 25 }, (_, i) => opt(i + 1)))).options.length, 25));
    accepts("contract: empty options array accepted", () => S.normalizeRequest(cont([])));
    throws("contract: 26 options rejected", () => S.normalizeRequest(cont(Array.from({ length: 26 }, (_, i) => opt(i + 1)))), /cannot exceed 25/);
    throws("contract: duplicate candidate_key rejected", () => S.normalizeRequest(cont([opt(1), opt(2, { candidate_key: "candidate-1" })])), /duplicate candidate_key/);
    throws("contract: unknown field_type rejected", () => S.normalizeRequest(start({ field_type: "city" })), /field_type must be one of/);
    throws("contract: empty question rejected", () => S.normalizeRequest(start({ question: "" })), /request\.question must be a non-empty string/);
    throws("contract: whitespace-only original_answer rejected", () => S.normalizeRequest(start({ original_answer: "   " })), /request\.original_answer/);
    throws("contract: empty option.text rejected", () => S.normalizeRequest(cont([opt(1, { text: "" })])), /option\.text/);
    throws("contract: empty option.value rejected", () => S.normalizeRequest(cont([opt(1, { value: "" })])), /option\.value/);
    throws("contract: empty resolve_session_id rejected", () => S.normalizeRequest(cont([opt(1)], { resolve_session_id: "" })), /resolve_session_id/);
    throws("contract: missing round_id rejected", () => S.normalizeRequest(cont([opt(1)], { round_id: undefined })), /round_id/);
    accepts("contract: 512-char original_answer accepted", () => S.normalizeRequest(start({ original_answer: "x".repeat(512) })));
    throws("contract: 513-char original_answer rejected", () => S.normalizeRequest(start({ original_answer: "x".repeat(513) })), /original_answer must be .* no longer than 512/);
    throws("contract: 513-char option.text rejected", () => S.normalizeRequest(cont([opt(1, { text: "x".repeat(513) })])), /option\.text .* 512/);
    throws("contract: 257-char option.value rejected", () => S.normalizeRequest(cont([opt(1, { value: "x".repeat(257) })])), /option\.value .* 256/);
    throws("contract: 129-char candidate_key rejected", () => S.normalizeRequest(cont([opt(1, { candidate_key: "k".repeat(129) })])), /candidate_key .* 128/);
    throws("contract: 129-char round_id rejected", () => S.normalizeRequest(cont([opt(1)], { round_id: "r".repeat(129) })), /round_id .* 128/);
    throws("contract: non-object request rejected", () => S.normalizeRequest([]), /request must be an object/);
    throws("contract: continuation without options rejected", () => S.normalizeRequest({ resolve_session_id: "s1", round_id: "r1" }), /options must be an array/);
    check("contract: alternates filtered to non-blank strings, max 8", S.normalizeRequest(start({ alternates: ["A", "", 3, "  ", null, "B", "C", "D", "E", "F", "G", "H", "I"] })).alternates, ["A", "B", "C", "D", "E", "F", "G", "H"]);

    const req = S.normalizeRequest({ resolve_session_id: "s1", round_id: "r2", options: [
      { candidate_key: "candidate-1", value: "austin-tx", text: "Austin" },
      { candidate_key: "candidate-2", value: "austin-mn", text: "Austin" },
      { candidate_key: "candidate-3", value: "austin-tx-us", text: "Austin, TX" },
    ] });
    const startReq = S.normalizeRequest({ field_type: "location", question: "What city do you live in?", original_answer: "Austin, TX" });
    const SO = (extra) => ({ action: "SELECT_OPTIONS", round_id: "r2", ...extra });

    throws("validate: REQUEST_SEARCH reusing request round_id", () => S.validateResponse(RS("r2", "Austin"), req), /fresh round_id/);
    accepts("validate: REQUEST_SEARCH with fresh round_id ok", () => S.validateResponse(RS("r3", "Austin"), req));
    accepts("validate: REQUEST_SEARCH on a start request ok", () => S.validateResponse(RS("r1", "Austin, TX"), startReq));
    throws("validate: REQUEST_SEARCH empty search_input", () => S.validateResponse(RS("r3", ""), req), /search_input/);
    throws("validate: REQUEST_SEARCH 257-char search_input", () => S.validateResponse(RS("r3", "q".repeat(257)), req), /search_input .* 256/);
    throws("validate: REQUEST_SEARCH without session id", () => S.validateResponse({ ...RS("r3", "Austin"), resolve_session_id: undefined }, req), /resolve_session_id/);
    throws("validate: SELECT_OPTIONS on a start request", () => S.validateResponse(SO({ selected_values: ["Austin, TX"] }), startReq), /not allowed on a start request/);
    throws("validate: SELECT_OPTIONS with 0 selected values", () => S.validateResponse(SO({ selected_values: [] }), req), /exactly one item/);
    throws("validate: SELECT_OPTIONS with 2 selected values", () => S.validateResponse(SO({ selected_values: ["Austin, TX", "Austin"] }), req), /exactly one item/);
    throws("validate: SELECT_OPTIONS text maps to 2 values", () => S.validateResponse(SO({ selected_values: ["Austin"] }), req), /one canonical native value/);
    accepts("validate: SELECT_OPTIONS unique text ok", () => S.validateResponse(SO({ selected_values: ["Austin, TX"] }), req));
    throws("validate: SELECT_OPTIONS text not in current options", () => S.validateResponse(SO({ selected_values: ["Dallas"] }), req), /exact text from current options/);
    throws("validate: SELECT_OPTIONS key from another round", () => S.validateResponse(SO({ round_id: "r1", selected_candidate_key: "candidate-3", selected_values: ["Austin, TX"] }), req), /current round and candidate identity/);
    throws("validate: SELECT_OPTIONS key not in current round", () => S.validateResponse(SO({ selected_candidate_key: "candidate-9", selected_values: ["Austin, TX"] }), req), /current round and candidate identity/);
    throws("validate: SELECT_OPTIONS key/text mismatch", () => S.validateResponse(SO({ selected_candidate_key: "candidate-1", selected_values: ["Austin, TX"] }), req), /current round and candidate identity/);
    accepts("validate: SELECT_OPTIONS current key + text ok", () => S.validateResponse(SO({ selected_candidate_key: "candidate-3", selected_values: ["Austin, TX"] }), req));
    accepts("validate: key disambiguates duplicate text", () => S.validateResponse(SO({ selected_candidate_key: "candidate-2", selected_values: ["Austin"] }), req));
    accepts("validate: RETURN_EMPTY ok", () => S.validateResponse({ action: "RETURN_EMPTY" }, req));
    throws("validate: unknown action rejected", () => S.validateResponse({ action: "GUESS" }, req), /unsupported/);
  }

  // =====================================================================================
  // 5. Resolver
  // =====================================================================================
  {
    const startReq = { field_type: "school", question: S.QUESTIONS.school, original_answer: "Texas A&M University" };
    const keyed = (cands) => cands.map((c, i) => ({ candidate_key: `candidate-${i + 1}`, value: c.value, text: c.text }));

    const r = S.createResolver();
    const a = r.step(startReq);
    check("resolver: start -> REQUEST_SEARCH", a.action, "REQUEST_SEARCH");
    check("resolver: start has a local session id", a.resolve_session_id, (s) => /^local-\d+$/.test(s), "/^local-\\d+$/");
    check("resolver: start round id", a.round_id, "r1");
    check("resolver: start queries the answer first", a.search_input, "Texas A&M University");
    const b = r.step({ resolve_session_id: a.resolve_session_id, round_id: a.round_id, options: keyed([COMMERCE, TAMU]) });
    check("resolver: good option -> SELECT_OPTIONS", b.action, "SELECT_OPTIONS");
    check("resolver: selects that candidate key", b.selected_candidate_key, "candidate-2");
    check("resolver: selected text + current round", [b.selected_values, b.round_id], [["Texas A&M University"], "r1"]);
    check("resolver: selection score", b.score, 1);

    const other = S.createResolver().step(startReq);
    check("resolver: each resolver gets a distinct session", other.resolve_session_id, (s) => s !== a.resolve_session_id, `!= ${a.resolve_session_id}`);

    const w = S.createResolver();
    const w1 = w.step(startReq);
    const w2 = w.step({ resolve_session_id: w1.resolve_session_id, round_id: w1.round_id, options: keyed([COMMERCE, TECH]) });
    check("resolver: weak options -> REQUEST_SEARCH", w2.action, "REQUEST_SEARCH");
    check("resolver: next query from the plan", w2.search_input, "Texas A&M");
    check("resolver: fresh round id, same session", [w2.round_id !== w1.round_id, w2.resolve_session_id], [true, w1.resolve_session_id]);
    const w3 = w.step({ resolve_session_id: w1.resolve_session_id, round_id: w2.round_id, options: keyed([TECH]) });
    check("resolver: plan exhausted -> RETURN_EMPTY", w3.action, "RETURN_EMPTY");
    check("resolver: RETURN_EMPTY carries best-so-far", w3.best, { text: COMMERCE.text, score: S.score("school", "Texas A&M University", COMMERCE.text) });

    const x = S.createResolver();
    const x1 = x.step(startReq);
    check("resolver: wrong session id -> RETRYABLE_FAILURE", x.step({ resolve_session_id: "local-nope", round_id: x1.round_id, options: keyed([TAMU]) }).action, "RETRYABLE_FAILURE");

    const amb = S.createResolver();
    const amb1 = amb.step(startReq);
    const amb2 = amb.step({ resolve_session_id: amb1.resolve_session_id, round_id: amb1.round_id, options: keyed([TAMU, { value: "tamu-other", text: TAMU.text }]) });
    check("resolver: ambiguous top text -> searches again", amb2.action, "REQUEST_SEARCH");

    const lo = S.createResolver({ threshold: 0.75 });
    const lo1 = lo.step(startReq);
    check("resolver: threshold override accepts Commerce", lo.step({ resolve_session_id: lo1.resolve_session_id, round_id: lo1.round_id, options: keyed([COMMERCE]) }).action, "SELECT_OPTIONS");

    const cap = S.createResolver();
    cap.step({ field_type: "school", question: S.QUESTIONS.school, original_answer: "University of St. Thomas - Houston", alternates: ["The St. Mary's College, Notre Dame"] });
    check("resolver: merged plan with alternates capped", cap.state.plan.length, S.LIMITS.maxSearches);
    check("resolver: merged plan has no fold-duplicates", new Set(cap.state.plan.map(S.fold)).size, cap.state.plan.length);
    check("resolver: empty plan -> RETURN_EMPTY at start", S.createResolver().step({ ...startReq, original_answer: "A" }).action, "RETURN_EMPTY");
  }

  // =====================================================================================
  // 6. Driver (AB.search.run) with a fake adapter
  // =====================================================================================
  const run = (opts) => S.run({ el: { id: "field" }, fieldType: "school", answer: "Texas A&M University", ...opts });

  await tcase("run: success round 1", async () => {
    const ad = fakeAdapter({ "Texas A&M University": [COMMERCE, TAMU] });
    const events = [];
    const res = await run({ adapter: ad, onTrace: (m) => events.push(m) });
    check("run: round 1 success", [res.success, res.failureReason], [true, null]);
    check("run: round 1 actions", res.actions, ["REQUEST_SEARCH", "SELECT_OPTIONS"]);
    check("run: round 1 selected", res.selected, { text: TAMU.text, value: "tamu", score: 1, round: "r1", query: "Texas A&M University" });
    check("run: round 1 single capture, no recapture", ad.calls.capture, ["Texas A&M University"]);
    check("run: round 1 commit on that generation", ad.calls.commit, [{ genId: 1, value: "tamu", text: TAMU.text }]);
    check("run: trace events", events, ["search", "candidates", "selected", "done"]);
  });

  await tcase("run: success round 2", async () => {
    const ad = fakeAdapter({ "Texas A&M University": [COMMERCE, KINGSVILLE], "Texas A&M": [COMMERCE, TAMU] });
    const res = await run({ adapter: ad });
    check("run: round 2 success", [res.success, res.failureReason], [true, null]);
    check("run: round 2 actions", res.actions, ["REQUEST_SEARCH", "REQUEST_SEARCH", "SELECT_OPTIONS"]);
    check("run: round 2 capture order", ad.calls.capture, ["Texas A&M University", "Texas A&M"]);
    check("run: round 2 selected round/query", [res.selected?.round, res.selected?.query, res.selected?.value], ["r2", "Texas A&M", "tamu"]);
    check("run: round 2 rounds summary", res.rounds, [
      { searchInput: "Texas A&M University", candidateCount: 2, status: "ready" },
      { searchInput: "Texas A&M", candidateCount: 2, status: "ready" },
    ]);
    check("run: round 2 commit on round-2 generation", ad.calls.commit.map((c) => c.genId), [2]);
  });

  await tcase("run: earlier-round pick recaptures", async () => {
    const table = { "Texas A&M University": [COMMERCE, TAMU], "Texas A&M": [KINGSVILLE] };
    const pick = { action: "SELECT_OPTIONS", round_id: "r1", selected_candidate_key: "candidate-2", selected_values: [TAMU.text], score: 1 };
    const ad = fakeAdapter(table);
    const res = await run({ adapter: ad, resolver: stubResolver([RS("r1", "Texas A&M University"), RS("r2", "Texas A&M"), pick]) });
    check("run: recapture success", [res.success, res.failureReason], [true, null]);
    check("run: recapture capture order", ad.calls.capture, ["Texas A&M University", "Texas A&M", "Texas A&M University"]);
    check("run: recapture commits on the fresh generation", ad.calls.commit, [{ genId: 3, value: "tamu", text: TAMU.text }]);
    check("run: recapture selected round/query", [res.selected?.round, res.selected?.query], ["r1", "Texas A&M University"]);

    // Same, but the resolver names only the text (no round id / key): the driver finds the latest round holding it.
    const ad2 = fakeAdapter(table);
    const res2 = await run({ adapter: ad2, resolver: stubResolver([RS("r1", "Texas A&M University"), RS("r2", "Texas A&M"), { action: "SELECT_OPTIONS", selected_values: [TAMU.text] }]) });
    check("run: text-only pick recaptures round 1", [res2.success, ad2.calls.capture], [true, ["Texas A&M University", "Texas A&M", "Texas A&M University"]]);

    // Recapture that times out is reported as such and never commits.
    const ad3 = fakeAdapter(table);
    const cap3 = ad3.capture.bind(ad3);
    ad3.capture = async (el, q) => (ad3.calls.capture.length >= 2 ? (ad3.calls.capture.push(q), { status: "timeout" }) : cap3(el, q));
    const res3 = await run({ adapter: ad3, resolver: stubResolver([RS("r1", "Texas A&M University"), RS("r2", "Texas A&M"), pick]) });
    check("run: recapture timeout", [res3.failureReason, ad3.calls.commit.length], ["selected-candidate-recapture-timeout", 0]);
  });

  await tcase("run: capture timeout", async () => {
    const ad = fakeAdapter({ "Texas A&M University": "timeout" });
    const res = await run({ adapter: ad });
    check("run: capture timeout", [res.success, res.failureReason, ad.calls.commit.length], [false, "candidate-capture-timeout", 0]);
  });

  await tcase("run: capture invalidated", async () => {
    const ad = fakeAdapter({ "Texas A&M University": "invalidated" });
    const res = await run({ adapter: ad });
    check("run: capture invalidated", [res.success, res.failureReason], [false, "trusted-invalidation"]);
  });

  await tcase("run: commit false", async () => {
    const ad = fakeAdapter({ "Texas A&M University": [TAMU] }, { commitResult: false });
    const res = await run({ adapter: ad });
    check("run: commit returns false", [res.success, res.failureReason, ad.calls.commit.length], [false, "candidate-commit-failed", 1]);
  });

  await tcase("run: no answer", async () => {
    for (const answer of ["", "   ", undefined, null]) {
      const ad = fakeAdapter({});
      const res = await run({ adapter: ad, answer });
      check(`run: no answer (${JSON.stringify(answer) ?? "undefined"})`, [res.attempted, res.success, res.failureReason, ad.calls.capture.length], [false, false, "no-answer", 0]);
    }
  });

  await tcase("run: aborted", async () => {
    const ad = fakeAdapter({ "Texas A&M University": [TAMU] });
    const res = await run({ adapter: ad, signal: AbortSignal.abort() });
    check("run: pre-aborted signal", [res.failureReason, ad.calls.capture.length, ad.calls.commit.length], ["aborted", 0, 0]);
    const ac = new AbortController();
    const ad2 = fakeAdapter({});
    ad2.capture = async () => { ac.abort(); throw new Error("aborted"); };
    const res2 = await run({ adapter: ad2, signal: ac.signal });
    check("run: abort during capture", res2.failureReason, "aborted");
  });

  await tcase("run: 40 candidates truncated", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => ({ value: `o${i + 1}`, text: `Option ${i + 1}` }));
    const ad = fakeAdapter({ "Option 40": forty, Option: forty });
    const spy = spyResolver();
    const res = await run({ adapter: ad, fieldType: "generic", answer: "Option 40", resolver: spy });
    const conts = spy.seen.filter((q) => "options" in q);
    check("run: 40 candidates -> 25 options per round", conts.map((q) => q.options.length), [25, 25]);
    check("run: truncation keeps the first 25", [conts[0]?.options[24]?.candidate_key, conts[0]?.options[24]?.text], ["candidate-25", "Option 25"]);
    check("run: rounds report 25 candidates", res.rounds.map((x) => x.candidateCount), [25, 25]);
    check("run: exact match at #40 never offered", [res.success, res.failureReason, ad.calls.commit.length], [false, "return-empty", 0]);
  });

  await tcase("run: repeated search", async () => {
    const ad = fakeAdapter({});
    const res = await run({ adapter: ad, resolver: stubResolver([RS("r1", "Texas"), RS("r2", " TEXAS ")]) });
    check("run: repeated search_input", [res.failureReason, ad.calls.capture], ["repeated-search", ["Texas"]]);
  });

  await tcase("run: session id changed", async () => {
    const ad = fakeAdapter({});
    const res = await run({ adapter: ad, resolver: stubResolver([RS("r1", "Texas A&M University", "s1"), RS("r2", "Texas A&M", "s2")]) });
    check("run: session id changed", [res.failureReason, ad.calls.capture.length], ["session-id-changed", 1]);
  });

  await tcase("run: search limit", async () => {
    const ad = fakeAdapter({});
    const res = await run({ adapter: ad, resolver: stubResolver((i) => RS(`r${i + 1}`, `query ${i + 1}`)) });
    check("run: search limit exceeded after 5", [res.failureReason, ad.calls.capture.length, res.actions.length], ["search-limit-exceeded", S.LIMITS.maxSearches, S.LIMITS.maxSearches + 1]);
  });

  await tcase("run: misc failure paths", async () => {
    const ad = fakeAdapter({ "Texas A&M University": [COMMERCE], "Texas A&M": [KINGSVILLE] });
    const res = await run({ adapter: ad });
    check("run: weak rounds -> return-empty with best", [res.failureReason, res.best?.text], ["return-empty", COMMERCE.text]);
    check("run: failure restores the snapshot once", ad.calls.restore, [{ snap: "field" }]);
    const ok = fakeAdapter({ "Texas A&M University": [TAMU] });
    await run({ adapter: ok });
    check("run: success does not restore", ok.calls.restore, []);
    const res2 = await run({ adapter: fakeAdapter({}), resolver: { step: () => { throw new Error("boom"); } } });
    check("run: resolver throws -> transport-error", res2.failureReason, "transport-error");
    const res3 = await run({ adapter: fakeAdapter({}), resolver: stubResolver([{ action: "REQUEST_SEARCH", round_id: "r1", search_input: "Texas" }]) });
    check("run: REQUEST_SEARCH without session", res3.failureReason, "missing-session-id");
    const res4 = await run({ adapter: fakeAdapter({}), resolver: stubResolver([{ action: "RETRYABLE_FAILURE" }]) });
    check("run: RETRYABLE_FAILURE passthrough", res4.failureReason, "retryable-failure");
    const ad5 = fakeAdapter({});
    ad5.capture = async () => { throw new Error("dom gone"); };
    check("run: capture throws -> capture-error", (await run({ adapter: ad5 })).failureReason, "candidate-capture-error");
  });

  // =====================================================================================
  // 7. fieldTypeFor
  // =====================================================================================
  check("fieldType: education[0].school", S.fieldTypeFor("education[0].school"), "school");
  check("fieldType: most_recent_major", S.fieldTypeFor("most_recent_major"), "major");
  check("fieldType: city", S.fieldTypeFor("city"), "location");
  check("fieldType: experience[0].company", S.fieldTypeFor("experience[0].company"), "company");
  check("fieldType: email", S.fieldTypeFor("email"), "generic");
  check("fieldType: education[0].degree", S.fieldTypeFor("education[0].degree"), "degree");
  check("fieldType: label 'What university...?'", S.fieldTypeFor("q7", "What university did you attend?*"), "school");
  check("fieldType: label 'Current City (required)'", S.fieldTypeFor("q4", "Current City (required)"), "location");

  // 7b. A profile key decides over label words. Airbnb's job-boards embed (2026-10-19) asks both questions below as
  // react-selects; the labels' "located" made them location searches that typed the profile city into Yes/No lists.
  const AUTH = "Are you legally authorized to work in the country where the job is located?";
  const SPONSOR = "Will you now or in the future require company sponsorship to retain or extend your work authorization in the country where the job is located?";
  if (!(S.PROFILE_KEYS instanceof Set)) console.log("section 7b skipped: label words still override profile keys in this extension");
  else {
    check("keyType: work_auth_us + 'job is located' label", S.fieldTypeFor("work_auth_us", AUTH), "generic");
    check("keyType: sponsorship + 'job is located' label", S.fieldTypeFor("sponsorship", SPONSOR), "generic");
    for (const [k, l] of [["over18", "Are you at least 18 years old in the city where you live?"], ["gender", "Gender (for roles located in the US)"],
      ["ethnicity", "Race or ethnicity, as reported to your school"], ["veteran", "Veteran status (US company policy)"], ["disability", "Disability status at your current location"],
      ["hispanic", "Hispanic or Latino (where do you live?)"], ["how_heard", "How did you hear about our company?"], ["current_title", "Your title at your current employer"],
      ["referred_by", "Who at the company referred you?"], ["state", "State where you are located"], ["country", "Country where you live"]])
      check(`keyType: ${k} ignores the label's search words`, S.fieldTypeFor(k, l), "generic");
    // Search-type keys decide too, even when the label names another type (key and label used to be checked per type).
    check("keyType: most_recent_school + 'city' label", S.fieldTypeFor("most_recent_school", "University in the city where you live"), "school");
    check("keyType: city + 'university' label", S.fieldTypeFor("city", "City of your university"), "location");
    check("keyType: current_company + 'school' label", S.fieldTypeFor("current_company", "Company or school"), "company");
    check("keyType: education[0].major|upper", S.fieldTypeFor("education[0].major|upper", "Major"), "major");
    check("keyType: education[0].end_month|MM + 'university' label", S.fieldTypeFor("education[0].end_month|MM", "Graduation month at your university"), "generic");
    // Without a profile key the label still classifies (saved-answer questions, question ids).
    check("keyType: no key, 'Current City' label", S.fieldTypeFor(null, "Current City (required)"), "location");
    check("keyType: no key, 'Which university' label", S.fieldTypeFor("", "Which university do you attend?"), "school");
    check("keyType: question id, 'employer' label", S.fieldTypeFor("question_123", "Name of your employer"), "company");
    // Every heuristic rule key, profile key, derived key and entry field classifies the same whatever its label says.
    // A failure names a key to add to S.PROFILE_KEYS (or to a search type) in engine/search.js.
    const loud = ["What university did you attend?", "Major / field of study", "Highest degree", "Where are you located?", "Current company"];
    const derived = ["full_name", "phone_digits", "location", "city_state", "start_date", "end_date", "grad_date", "current_company", "current_title", "most_recent_school", "most_recent_degree", "most_recent_major", "most_recent_gpa", "skills_text", "today"];
    const entry = ["school", "degree", "major", "gpa", "start_month", "start_year", "end_month", "end_year", "graduated"].map((f) => `education[0].${f}`)
      .concat(["company", "title", "location", "start_month", "start_year", "end_month", "end_year", "current", "description"].map((f) => `experience[0].${f}`));
    const known = [...new Set([...AB.arr(AB.RULES).map((r) => r[0]), ...Object.keys(AB.PROFILE_DEFAULT || {}).filter((k) => typeof AB.PROFILE_DEFAULT[k] !== "object"), ...derived, ...entry])];
    check("keyType: heuristics.js and profile.js loaded", [AB.arr(AB.RULES).length > 30, typeof AB.PROFILE_DEFAULT], [true, "object"]);
    check("keyType: no rule or profile key follows label words", known.filter((k) => loud.some((l) => S.fieldTypeFor(k, l) !== S.fieldTypeFor(k, ""))), []);
  }
  // The rule that names each question (engine/heuristics.js). A sponsorship question that mentions work authorization
  // used to get work_auth_us, so its Yes/No answer came from the wrong profile fact.
  if (typeof AB.keyForLabel === "function") {
    const key = (l) => AB.keyForLabel(AB.norm(l));
    check("rules: Airbnb work authorization", key(AUTH), "work_auth_us");
    check("rules: Airbnb sponsorship names work authorization", key(SPONSOR), "sponsorship");
    check("rules: sponsorship to obtain or maintain work authorization", key("Do you now, or will you in the future, require visa sponsorship to obtain or maintain work authorization?"), "sponsorship");
    check("rules: plain sponsorship question", key("Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?"), "sponsorship");
    check("rules: plain work authorization question", key("Are you legally authorized to work in the United States?"), "work_auth_us");
    check("rules: authorized without sponsorship", key("Are you authorized to work in the US without sponsorship?"), "work_auth_us");
    check("rules: eligible and will not require sponsorship", key("Are you legally eligible to work in the U.S. and will not require sponsorship?"), "work_auth_us");
    check("rules: work authorization that does not require sponsorship", key("Do you have work authorization that does not require sponsorship?"), "work_auth_us");
    check("rules: note about candidates who require sponsorship", key("Do you have US work authorization? Candidates who require sponsorship cannot be considered."), "work_auth_us");
  }

  // =====================================================================================
  // 8. Review regressions (wrong-fill safety findings, 2026-10-18 review)
  // =====================================================================================
  {
    const decide = (ft, ans, opts) => {
      const r = S.createResolver();
      const s0 = r.step({ field_type: ft, question: "q", original_answer: ans });
      const res = r.step({ resolve_session_id: s0.resolve_session_id, round_id: s0.round_id, options: opts.map((t, i) => ({ candidate_key: `c${i}`, value: t, text: t })) });
      return res.action === "SELECT_OPTIONS" ? `SELECT ${res.selected_values[0]}` : res.action;
    };
    const notSelect = (x) => !String(x).startsWith("SELECT");
    check("review: 'University of Michigan' !-> Michigan State", decide("school", "University of Michigan", ["Michigan State University"]), notSelect);
    check("review: 'University of Miami' !-> Miami University", decide("school", "University of Miami", ["Miami University"]), notSelect);
    check("review: parenthetical campuses are not ignored", decide("school", "Texas A&M University", ["Texas A&M University (College Station)", "Texas A&M University (Commerce)", "Texas A&M University (Kingsville)"]), notSelect);
    check("review: parenthetical acronym alias still matches", decide("school", "University of California Los Angeles", ["University of California Los Angeles (UCLA)", "University of California Berkeley"]), "SELECT University of California Los Angeles (UCLA)");
    check("review: Portland ME/OR tie refused", decide("location", "Portland", ["Portland, ME", "Portland, OR"]), notSelect);
    check("review: 'Business' !-> Business Analytics", decide("major", "Business", ["Business Analytics", "Business Administration", "Business Economics"]), notSelect);
    check("review: BS answer picks BS, not BA", decide("degree", "Bachelor of Science in Computer Science", ["Bachelor of Arts (BA)", "Bachelor of Science (BS)", "Bachelor of Fine Arts (BFA)"]), "SELECT Bachelor of Science (BS)");
    check("review: BS vs BA scores below degree threshold", S.score("degree", "Bachelor of Science", "Bachelor of Arts (BA)") < S.THRESHOLDS.degree, true);
    check("review: Master's !-> Graduate Certificate", S.score("degree", "Master's", "Graduate Certificate") < S.THRESHOLDS.degree, true);
    check("review: two acronym matches are ambiguous", decide("school", "USC", ["University of Southern California", "University of South Carolina"]), notSelect);
    check("review: 2-letter acronym gets no bonus", S.score("school", "UT", "University of Texas") < S.THRESHOLDS.school, true);
    check("review: 'State' is distinctive for schools", S.score("school", "Texas University", "Texas State University") < S.THRESHOLDS.school, true);
    check("review: 'Group' is distinctive for companies", S.score("company", "Acme", "Acme Group") < S.THRESHOLDS.company, true);
    check("review: major/location thresholds above one-extra-token score", S.THRESHOLDS.major > 0.8 && S.THRESHOLDS.location > 0.8, true);
    check("review: exact still wins over near duplicates", decide("school", "Texas A&M University", ["Texas A&M University - Commerce", "Texas A&M University", "Texas A & M University"]), "SELECT Texas A&M University");
  }

  // =====================================================================================
  // 9. Per-ATS canonical names (Simplify's per-ATS school/major) and rerun safety
  // =====================================================================================
  // Added in 0.2.0; skipped for older folders (--ext=legacy/autobot-v2) so their own checks still run.
  const has020 = typeof S.atsAlternates === "function" && typeof S.selectedMatch === "function";
  if (!has020) console.log("section 9 skipped: no per-ATS names or rerun checks in this extension (before 0.2.0)");
  if (has020) {
    const CS = "Texas A&M University - College Station";
    const CM = "Texas A&M University - Commerce";
    const P = { education: [
      { school: "Texas A&M University", major: "Computer Science", degree: "Bachelor's", school_greenhouse: CS, major_greenhouse: "Computer Science (BS)", school_lever: "Texas A&M University (College Station)" },
      { school: "Blinn College", school_greenhouse: "Blinn College - Bryan" },
    ] };
    check("ats: greenhouse school", S.atsAlternates(P, "education[0].school", "greenhouse"), [CS]);
    check("ats: greenhouse major", S.atsAlternates(P, "education[0].major", "greenhouse"), ["Computer Science (BS)"]);
    check("ats: lever school", S.atsAlternates(P, "education[0].school", "lever"), ["Texas A&M University (College Station)"]);
    check("ats: education.0 form with |fmt suffix", S.atsAlternates(P, "education.0.school|upper", "greenhouse"), [CS]);
    check("ats: second entry", S.atsAlternates(P, "education[1].school", "greenhouse"), ["Blinn College - Bryan"]);
    check("ats: missing entry", S.atsAlternates(P, "education[2].school", "greenhouse"), []);
    check("ats: most_recent_school reads entry 0", S.atsAlternates(P, "most_recent_school", "greenhouse"), [CS]);
    check("ats: most_recent_major reads entry 0", S.atsAlternates(P, "most_recent_major", "greenhouse"), ["Computer Science (BS)"]);
    check("ats: ATS id is case-insensitive", S.atsAlternates(P, "education[0].school", "Greenhouse"), [CS]);
    check("ats: generic config gets none", S.atsAlternates(P, "education[0].school", "generic"), []);
    check("ats: no ATS gets none", S.atsAlternates(P, "education[0].school", undefined), []);
    check("ats: Lever name unused on Greenhouse", S.atsAlternates({ education: [{ school: "X", school_lever: "Y" }] }, "education[0].school", "greenhouse"), []);
    check("ats: no name stored for this ATS", S.atsAlternates(P, "education[0].major", "lever"), []);
    check("ats: blank per-ATS value ignored", S.atsAlternates({ education: [{ school: "X", school_greenhouse: "  " }] }, "education[0].school", "greenhouse"), []);
    check("ats: degree has no per-ATS name", S.atsAlternates(P, "education[0].degree", "greenhouse"), []);
    check("ats: experience key ignored", S.atsAlternates(P, "experience[0].company", "greenhouse"), []);
    check("ats: bare 'school' key ignored", S.atsAlternates(P, "school", "greenhouse"), []);
    check("ats: no profile", S.atsAlternates(null, "education[0].school", "greenhouse"), []);

    // Greenhouse lists only campus-suffixed Texas A&M names. AB.trySearch orders the values as
    // [aliases, per-ATS name, profile value, ...], so the per-ATS name becomes the resolver's original_answer.
    const campusList = [{ candidate_key: "c1", value: "11785542002", text: CS }, { candidate_key: "c2", value: "11785542003", text: CM }, { candidate_key: "c3", value: "2001", text: TECH.text }];
    const withName = S.createResolver();
    const w1 = withName.step({ field_type: "school", question: S.QUESTIONS.school, original_answer: CS, alternates: ["Texas A&M University"] });
    check("ats resolver: round 1 searches the per-ATS name", w1.search_input, CS);
    const w2 = withName.step({ resolve_session_id: w1.resolve_session_id, round_id: w1.round_id, options: campusList });
    check("ats resolver: selects College Station in round 1", [w2.action, w2.selected_values?.[0]], ["SELECT_OPTIONS", CS]);
    const without = S.createResolver();
    const n1 = without.step({ field_type: "school", question: S.QUESTIONS.school, original_answer: "Texas A&M University" });
    const n2 = without.step({ resolve_session_id: n1.resolve_session_id, round_id: n1.round_id, options: campusList });
    check("ats resolver: without it, campuses tie and it searches again", [n2.action, n2.search_input], ["REQUEST_SEARCH", "Texas A&M"]);
    const n3 = without.step({ resolve_session_id: n1.resolve_session_id, round_id: n2.round_id, options: campusList });
    check("ats resolver: without it, RETURN_EMPTY (no campus guess)", n3.action, "RETURN_EMPTY");

    // selectedMatch: does the control already show one of the values autobot would write?
    check("selected: exact text", S.selectedMatch("school", [CS], [CS]), CS);
    check("selected: case and spacing", S.selectedMatch("school", ["texas a&m university - college   station"], [CS]), CS);
    check("selected: any value, any shown text", S.selectedMatch("school", ["Texas A&M University", CS], ["Baylor University", CS]), CS);
    check("selected: location by score", S.selectedMatch("location", ["Austin, TX"], ["Austin, Texas, United States"]), "Austin, Texas, United States");
    check("selected: another campus is not a match", S.selectedMatch("school", ["Texas A&M University"], [CS]), null);
    check("selected: different school", S.selectedMatch("school", ["Texas A&M University"], [TECH.text]), null);
    check("selected: nothing shown", S.selectedMatch("school", ["Texas A&M University"], []), null);
    check("selected: no values", S.selectedMatch("school", [], [CS]), null);
    check("selected: unknown field type falls back to generic", S.selectedMatch("bogus", ["LinkedIn"], ["LinkedIn"]), "LinkedIn");
    for (const t of ["Select One", "Select…", "Select...", "-- Select --", "Please select", "Please choose an option", "Make a selection", "None"]) check(`placeholder: "${t}"`, S.isPlaceholder(t), true);
    for (const t of ["Texas", "Selective Service", "Select Medical", "None of the above", "Other"]) check(`not a placeholder: "${t}"`, S.isPlaceholder(t), false);

    // Panel wording for the rerun outcomes.
    check("describe: already selected", S.describe({ success: true, alreadySelected: true, selected: { text: CS }, adapter: "enhanced-select" }), `${CS} (already selected; enhanced-select)`);
    check("describe: multi-select keeps another choice", S.describe({ success: false, failureReason: "other-selection-present", existing: "Indeed" }), 'kept the existing choice "Indeed" (multi-select; not adding another)');
  }
  if (has020) await tcase("ats run: per-ATS name commits College Station", async () => {
    const CS = "Texas A&M University - College Station";
    const rows = [{ value: "11785542002", text: CS }, { value: "11785542003", text: "Texas A&M University - Commerce" }];
    const ad = fakeAdapter({ [CS]: [rows[0]], "Texas A&M University": rows, "Texas A&M": rows });
    const res = await S.run({ el: { id: "school" }, fieldType: "school", answer: CS, alternates: ["Texas A&M University"], adapter: ad });
    check("ats run: success after one search", [res.success, ad.calls.capture], [true, [CS]]);
    check("ats run: commits the College Station id", ad.calls.commit.map((c) => c.value), ["11785542002"]);
    const plain = fakeAdapter({ "Texas A&M University": rows, "Texas A&M": rows });
    const res2 = await S.run({ el: { id: "school" }, fieldType: "school", answer: "Texas A&M University", adapter: plain });
    check("ats run: without it, nothing committed", [res2.success, res2.failureReason, plain.calls.commit.length, plain.calls.capture], [false, "return-empty", 0, ["Texas A&M University", "Texas A&M"]]);
  });

  // ---------- report ----------
  const pad = (s, n) => String(s).padEnd(n);
  let fails = 0;
  for (const r of results) { if (!r.ok) fails++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 56)} got=${pad(JSON.stringify(r.actual), 44)} want=${r.expected}`); }
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
