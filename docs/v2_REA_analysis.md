# v2 REA analysis: Jobright's option search, rebuilt in autobot v2

> **Since 0.2.0:** the `v2/` folder described here was merged into [`autobot/`](../autobot), which is now the only extension. A frozen copy is in [`legacy/autobot-v2/`](../legacy/autobot-v2). Paths below that start with `v2/` now live under `autobot/`.

Session date: 2026-10-18. This file summarizes the whole piece of work: how the target was found, every REA step and what it produced, what was learned about Jobright's search, what was built in `v2/`, how it was tested and reviewed, and what is still open. The detailed evidence report is [`SEARCH-REA.md`](SEARCH-REA.md). The 242-claim ledger is [`SEARCH-REA-claims.md`](SEARCH-REA-claims.md).

## Outcome in brief

- **The "Notes app" does not exist in Jobright 1.24.1.** The search feature that does exist is option search for typeahead and dropdown fields. Jobright calls it "client search", and it was analyzed in full.
- **Jobright resolves those searches on its server.** A site driver types each query the server proposes into the site's own widget and sends back up to 25 candidates. The server then picks one, asks for another query, or gives up.
- **autobot v2 keeps that loop and all its client-side guards.** It replaces the server with a local, deterministic resolver and sends nothing anywhere.
- **Every test suite passes:**

  | Suite | Result |
  |---|---|
  | v2 end-to-end | 86/86 |
  | v1 end-to-end | 67/67 |
  | Search unit tests | 161/161 |
  | Live Greenhouse posting | Search ran correctly, both with and without an alias |

- **Nothing is committed.** `v2/` is listed in `.gitignore` by another session (see section 8).

## 1. Request and interpretation

The request was to reverse engineer the Jobright AI extension installed in Brave, understand how search works in "the Notes app", show the evidence, and build a similar feature named autobot, with default fields for loading as an extension.

A whole-word search for `note` across all 13 JavaScript bundles found three hits, all in `helper-app`. Two are the `note.svg` icon of the "autofill again?" confirmation modal (`~components/Popups/DoubleConfirmPopup`, prettified `helper-app.js` around 143300–143390). The third is a library re-export named `note` (line 2031). No notes feature exists, so the work targeted the search feature that does exist. Section 0 of `SEARCH-REA.md` records that call.

"Default fields" was taken to mean: name the extension `autobot` and keep every other manifest field as in v1. `v2/manifest.json` changes only `name`, `short_name`, `action.default_title`, and the content-script list, which gains the two search files.

## 2. Finding the target

| Item | Value |
|---|---|
| Browser | Brave installed as a snap. The standard `~/.config/BraveSoftware/Brave-Browser` has no profile; the real one is `~/snap/brave/692/.config/BraveSoftware/Brave-Browser/Default` |
| Extensions in that profile | BetterCampus, BlockSite, Claude, Bitwarden, **Jobright Autofill 1.24.1**, Simplify Copilot 3.1.9 |
| Jobright id / path | `odcnpipkhjegpefkfplmedhmkmmhmoko` / `…/Extensions/odcnpipkhjegpefkfplmedhmkmmhmoko/1.24.1_0` |
| Identity | REA directory digest `680795cdfbfb456ef5dd7517dc4e632f67c9b526174506040d58e4078d937b1d`. `diff -r` against `targets/jobright-1.24.1` shows the copies are identical |
| Structure | Plasmo/Parcel MV3 build. `helper-app.41ea2652.js` is 7.5 MB (the in-page app), `contents.d42e7fcf.js` is the content script, `static/background/index.js` is the service worker, plus 10 smaller ATS- and page-specific scripts |

Source-module names survive in Parcel's dependency maps (`"~api/autofill-client-search": "3KzDR"`). Listing all 416 `~…` names located the search code: `~api/autofill-client-search`, `~contents/methods/choice-match`, `~contents/methods/autocomplete-listbox`, `~contents/sites/*/…client-search`, `~contents/sites/ashby/canonical-search`, and others.

## 3. The REA process, step by step

### 3.1 Tooling

The `reverse-engineer-anything` skill was loaded and the `rea` MCP server was connected. The tools used were:

- `analyze_javascript_application`
- `trace_application_feature`
- `inspect_analysis_view` (summary mode)
- `export_evidence_bundle`

No setup or repair was needed. REA treats target code as data; no target code was executed during the analysis.

### 3.2 First pass on the installed extension: heap exhaustion

`analyze_javascript_application` ran with these parameters:

| Parameter | Value |
|---|---|
| `input_path` | The installed `1.24.1_0` directory |
| `format` | `directory` |
| `detail` | `summary` |
| `source_paths` | `manifest.json`, `helper-app.41ea2652.js`, `contents.d42e7fcf.js`, `static/background/index.js` |
| `max_heap_mb` | 6144 |
| `integrity_policy` | `record-and-continue` |

| Result | Value |
|---|---|
| Parent Evidence | `ev_136e60682c6df9cd7c0d153f157fc418bee52706ac86da011c7550e95996d489` (summary view `ev_0da51881cf4a8518df2d5d875577d471c20e5f653f454d0202d7f73d1e773a7a`) |
| Parsed | `contents` and `background` (2 files; 184 667 AST nodes, 51 findings) |
| Skipped | `helper-app.41ea2652.js`: "Owned JavaScript worker exhausted its heap" at a 6 467 616 768-byte limit |
| Coverage | Application and semantic graphs partial; 23 658 semantic unknowns retained |

An earlier session had also failed to parse `helper-app` with REA (`docs/AUTOFILL-PROCESS.md` §5b). The search code lives in that bundle, so REA could not see it directly.

### 3.3 Workaround: carving the Parcel bundle

`tools/carve-parcel.mjs` was written for this, and the work is reproducible with it. It takes the prettified bundle (`analysis/jobright/pretty/helper-app.js`) and does four things:

- **Split:** it splits the module table into one CommonJS file per app module. Each file starts with a 3-line header: Parcel id, prettified line range and source name.
- **Name:** it derives each file's path from `~alias` names in the dependency maps. Relative imports are resolved from the importer's directory.
- **Rewrite:** it rewrites `e("dep")` calls to `require("./relative/path.js")`, so REA can rebuild the import graph.
- **Index:** it writes `carve-index.json` listing file, Parcel id, source name, prettified line range, SHA-256 and deps.

Two resolution problems were found and fixed during carving:

1. **Directory indexes.** Site modules such as `~contents/sites/icims` are directory indexes: they import `../base-filler` and `./education-client-search`. The carver votes "file versus index" using relative targets whose names are already known.
2. **Collisions.** 20 output paths first collided, for example several `contents/sites/rules.js`. Any importer that produced a collision and had 3 or more `./` dependencies is flipped to an index. Residual collisions get a Parcel-id suffix. Final collisions: 0.

| Carve statistic | Value |
|---|---|
| Parcel modules parsed | 2 140 |
| Modules with a resolved name | 1 144 |
| App modules emitted | 785 (7.9 MB) |
| Line mapping | carved line N ↔ prettified line `pretty_start + N − 4` |

### 3.4 REA on the carved search slice

`analyze_javascript_application` ran on `analysis/jobright/carved/helper-app` with 31 `source_paths`:

- the client-search API module;
- the iCIMS, Jacobs, Kula, RippleHire, Oracle Cloud, Phenom, Avature and SmartRecruiters drivers, with their site indexes and DOM helpers;
- `choice-match`, `autocomplete-listbox`, Ashby `canonical-search`, Greenhouse `react-select-search`, `crawler/utils/select` and `cancellation`.

| Result | Value |
|---|---|
| Parent Evidence | `ev_9b7f5e1a8ee22699350334e3a5c8303a8d02fa13ac3ec599fe0aed4f1d3f155b` (summary view `ev_b29b07e109d35d4a27de627a77cdd428a4cfccb0a75c3db76ae34bb6b2b037d0`) |
| Artifact digest | `61fe584d55abcaf4122fa7522636508f0e5f69d41b42c5fae998c8f35cb1b10c` |
| Parsed | 31/31 files, 435 182 bytes, 57 379 AST nodes, 343 findings, 0 parse failures |
| Semantic relations retained | 25 008 data-flow, 4 446 call-flow, 3 876 object-flow, 2 749 closure, 490 promise-ownership, 12 request |
| Coverage | Partial by design: 756 files outside the selected slice; 22 019 semantic unknowns |

### 3.5 Feature traces

| Trace | Evidence | Result |
|---|---|---|
| String seed `client-search-step` (contains) against the original-artifact graph | `ev_2e650b1b4252fe3f2f05f3578603c4a85e46b2898b5fce4957774edfbda9b262` | No match. REA notes this does not prove absence. My unverified explanation: the endpoint is built inside a template literal, which this seed kind may not index, and `helper-app` is missing from that graph |
| Module seed `api/autofill-client-search.js`, incoming, against the carved graph | `ev_96020524104577412edb2feccbd1434429c04779dc16e9c7adef5e4887cadefc` | 2 seed matches, 23 nodes, 42 edges, 45 observed and 20 inferred facts. Import edges (inferred, high confidence) come from the iCIMS, Kula, RippleHire, Phenom and Avature drivers |

The background side was traced by direct reading of prettified `background.js`, which REA had parsed in step 3.2:

- the Plasmo router `case "resolveAutofillClientSearchStep"` at line 573;
- handler module `gQ638` at 29546–29590;
- the `fetch` to `${API_DOMAIN}/swan/autofill/autofill-option-resolve/client-search-step` at 29815;
- `apiDomain: "https://api.jobright.ai"` at 1144.

### 3.6 Targeted manual reading

Key modules were read directly to pin down the design before building:

| Module | Prettified lines |
|---|---|
| `api/autofill-client-search` | 200469–200716 |
| iCIMS driver | 239124–239436 |
| iCIMS widget | 239449–239913 |
| iCIMS wiring | `contents/sites/icims/index.js` 60–62 (prettified 237847–237849) |
| `choice-match` | 131362–131389 |
| `autocomplete-listbox` | 140636–140654 |
| Greenhouse `react-select-search` | 229771–229790 |

### 3.7 Parallel deep read with adversarial verification

A workflow covered six subsystems. Each subsystem got one reader, and then an independent skeptic who re-opened every cited line and tried to refute each claim.

| Subsystem | Claims | Confirmed | Corrected | Refuted | Missed behaviour added |
|---|---|---|---|---|---|
| Protocol and background transport | 38 | 27 | 11 | 0 | 18 |
| iCIMS driver and widget | 40 | 27 | 13 | 0 | 14 |
| Kula, RippleHire, Jacobs | 43 | 27 | 16 | 0 | 17 |
| Oracle Cloud, Phenom, Avature, SmartRecruiters | 40 | 19 | 21 | 0 | 17 |
| Local (non-server) matching | 40 | 24 | 16 | 0 | 19 |
| Cancellation, stability, tracking | 41 | 24 | 17 | 0 | 16 |
| **Total** | **242** | **148** | **94** | **0** | **101** |

Run cost: 12 agents, about 2.4 M subagent tokens, 579 tool calls, about 27 minutes. Every claim carries a carved path, carved lines, prettified lines and a kind (observed, inferred or unknown). Corrections were mostly precision fixes such as exact selectors, poll counts and key precedence. One correction changed the design story: iCIMS's DOM-typing capture (`captureFreshIcimsSearchCandidates`) and its commit ship in 1.24.1, but nothing imports them. The live iCIMS path fetches the site's `/jobs/profileoptions` endpoint from the main world instead. The typing, settle and stability mechanics autobot copies are live in the Kula, RippleHire, Jacobs, Phenom, Avature and SmartRecruiters drivers, and the source comments say so.

### 3.8 Evidence retained

| File | Tracked? | Content |
|---|---|---|
| `analysis/jobright/rea3/search-evidence-bundle.json` | no (git-ignored) | `export_evidence_bundle`: 6 records, 141 317 125 bytes, 0 unknowns |
| `analysis/jobright/rea3/search-readers.json`, `search-verification.json` | no | Full reader and verifier output, including short code excerpts |
| `analysis/jobright/carved/helper-app/` | no | Carved modules and `carve-index.json` |
| `docs/SEARCH-REA.md`, `docs/SEARCH-REA-claims.md` | yes (untracked so far) | Report and claim ledger. Claims and line references only; no third-party code |

### 3.9 What REA established and what it did not

- **Established statically:**
  - the module graph around the client-search API;
  - the message hop and endpoint;
  - the request and response contract, with all validation rules;
  - each driver's guards, timings, selectors and failure reasons.
- **Not established:** how the server chooses queries and options. The failure codes (`MODEL_CALL_FAILED`, `SESSION_*`) suggest a stateful model-backed resolver, but that is inference. REA never executed Jobright, and no Jobright traffic was captured.
- **Coverage limits that remain:** `helper-app` as a whole was never parsed as one file. Only the 31-file carved slice has REA semantic graphs; the remaining carved modules were read by text.

## 4. Findings: how Jobright's search works

Full detail with line references is in `SEARCH-REA.md` §2. In short:

1. **Start.** A site driver checks that the field qualifies, then sends `{source, field_type, question, original_answer}` through `sendToBackground({name: "resolveAutofillClientSearchStep"})`. Field types are school, major, degree, location or company. Sources are 8 ATS sites.
2. **Server call.** The background normalizes the request, warms cookies, and POSTs to `https://api.jobright.ai/swan/autofill/autofill-option-resolve/client-search-step` with `credentials: "include"`. It validates the reply twice. Any error becomes a bare `RETRYABLE_FAILURE`.
3. **`REQUEST_SEARCH`.** The driver types `search_input` into the site's widget and captures at most 25 `{value, text}` candidates. It returns them with `candidate_key`s.
4. **Driver guards.** At most 5 searches. No repeated normalized query. The session id must not change. Each round id must be fresh.
5. **Commit.** On `SELECT_OPTIONS`, the driver finds exactly one option with that text, retyping an earlier round's query if needed. It clicks it and polls a readback.
6. **Give up.** `RETURN_EMPTY` or `RETRYABLE_FAILURE` ends the attempt. iCIMS and Jacobs schools fall back to "Other" plus a companion box; iCIMS majors reset to the placeholder.
7. **Capture mechanics.**
   - **Generations:** each control has a WeakMap token, and a trusted user event invalidates a capture.
   - **Settling:** results count only after the list changes from its open-state baseline, stops loading and holds steady for N polls.
   - **Restore:** RippleHire puts the input's pre-search value back on failure.
8. **Local matching.** Matching that never reaches the server is exact and unique (`choice-match`). Only Workday (Levenshtein), Ashby (Fuse.js) and Greenhouse (prefix and contains) do fuzzy matching locally.
9. **Cancellation is cooperative.** `checkpoint()` and `cancellableDelay()` stop a field, but in-flight server steps are not aborted. Resolve traces and answer-pair events are sent to Jobright.

## 5. What was built: autobot v2

`v2/` is a copy of `autobot/`, taken at commit `ff91b02`, plus the search feature. Against the current `autobot/` it has 2 new files and 10 modified files, about 200 changed lines in the modified ones.

| File | Role |
|---|---|
| `v2/engine/search.js` (488 lines, new) | Pure logic, unit-testable in Node: query plan per field type, token scorer, contract validation ported from Jobright's validator, local resolver (`createResolver`), and the driver loop `AB.search.run` with Jobright's guards and failure-reason strings |
| `v2/engine/search-widgets.js` (658 lines, new) | DOM adapters: native `<select>`, enhanced select (select2/chosen/iCIMS-style ajax), ARIA combobox and react-select (including hidden-trigger pickers and popup search boxes), `<datalist>`, Workday prompt. Also capture, settle, commit and readback; generations with trusted-event invalidation; owned-value restore; `resolveControl`; the guarded "Other" fallback; `AB.search.fill` and `describe` |
| `v2/engine/writer.js` | `AB.trySearch`: decides when search runs and when its result is final. Also user aliases, extra city/state forms for location, Stop handling, and routing in `AB.write` |
| `v2/engine/plan.js` | Passes key, candidates, signal, settings and profile to writes. Shows the search trace in field status. Resets search results each run |
| `v2/engine/heuristics.js` | A `type=search` input that is itself a listbox combobox counts as a real field. Widget-internal search boxes are still skipped |
| `v2/options.html`, `options.js` | Settings: multi-round search on/off, the "Other" fallback on/off, search aliases (JSON) |
| `v2/manifest.json`, `background.js` | Name `autobot`; search files added to content scripts and to on-demand injection |
| `v2/engine/panel.js`, `popup.html`, `options.html` | Visible brand "autobot" |
| `v2/README.md` | "Option search (new in v2)" section, limits, test commands |

Design choices, as opposed to things copied from Jobright:

- **Local resolver.** Jobright's server is replaced by a deterministic query plan and a token scorer.
- **Thresholds and ties.** Each field type has a threshold (school 0.86, major 0.85, degree 0.78, location 0.85, company 0.84). A runner-up within 0.05 makes the round ambiguous.
- **No guessing.** When the resolver isn't sure, the field is left for the user.
- **User-defined search aliases.** A list's canonical name can differ from the profile, for example "Texas A&M University" → "Texas A&M University - College Station".
- **Nothing is sent.** No `api.jobright.ai` call, no cookies, no `/jobs/profileoptions` fetch, no fetch/XHR interception, no telemetry.

## 6. Iterations driven by tests

**Scorer sanity pass.**
- **Different campus accepted:** "Texas A&M University - Commerce" scored 0.88, above the school bar. The penalty for each distinct extra token went from 0.12 to 0.2.
- **Junk queries:** the plan produced queries made only of filler words ("University of", "Babbage &"). Those are now filtered.

**Fixture failures.**
- **`optionsPath` bypass:** configs that set `optionsPath` skipped search entirely. The adapters now use it as their option selector.
- **Leftover text on a near miss:** a near-miss field kept autobot's typed query. Adapters gained snapshot and restore.

**Live Greenhouse** (`job-boards.greenhouse.io/duolingo/jobs/8888721002`, throwaway browser, never submitted). Four real-world problems were found and fixed:
1. **Hidden target.** The config path landed on a hidden `educations[0].school_name_id`. `resolveControl` now finds the visible control in the same field.
2. **Hidden trigger.** The input with `aria-controls` is hidden until a visible proxy input is clicked. Typing has to go into the popup's own search box, which has no ARIA attributes. The adapter now clicks the proxy and types wherever focus lands, or into the visible input next to the listbox.
3. **Default list taken for results.** Alphabetical "Aalborg…" entries were captured as search results. The baseline is now taken after the dropdown opens. A list that shares no distinctive word with the query only counts after a grace period.
4. **React detection blind spot.** React's internal markers are invisible from the content script, so isolated-world typing can fail silently. A main-world retype through `page.js` kicks in when the list does not react.

Live result: the school list returned 7 campus-suffixed entries, so autobot correctly left the field empty. With the alias set, round 1 selected "Texas A&M University - College Station", and the hidden id read back as `11785542002`.

**Unit-test agent.** It wrote `tests/search-unit.mjs`, with 145 checks at that point, and reported four more issues, all fixed:
- reusing a resolver kept the previous field's state;
- `experience[0].location` mapped to generic;
- the driver had no guard for a capture without a generation or for blank candidates;
- two school-query variants were malformed.

**Workday-style fixture** (`tests/fixtures/search-workday.html`). The commit was mis-reported as failed because the readback did not recognize Workday's `selectedItem` pill. After that false failure, the legacy writer retyped the box. Both fixed.

## 7. Independent code review

Four reviewers covered loop correctness, wrong-fill safety, integration with v1, and performance. A skeptic checked each reviewer's findings. The first run stalled after a connection loss and was rerun from scratch on the current code (8 agents, about 1.6 M tokens, 236 tool calls, about 31 minutes).

| Lens | Found | Confirmed |
|---|---|---|
| Loop correctness | 9 | 9 |
| Wrong-fill safety | 9 | 9 |
| Integration | 8 | 7 |
| Performance | 8 | 7 |
| **Total** | **34** | **32** |

All 32 confirmed findings were fixed. The most important:

- **Final decisions.** Stop, user input or a later-round failure handed the field to v1's prefix matcher, which could then commit "… - Commerce". Search results are now final once candidates were seen.
- **Scorer false positives:**
  - ties and one-extra-word matches ("Business" → "Business Analytics", "Portland" → "Portland, ME");
  - "State" treated as filler ("University of Michigan" → "Michigan State University" at 0.98);
  - word order ignored ("University of Miami" versus "Miami University");
  - campuses in parentheses ignored;
  - BS and BA scored the same;
  - two-letter acronyms got a bonus.
- **"Other" fallback:**
  - it could type into another field's "please specify" box;
  - it ran on education-level selects;
  - it ran when the school was listed under another name.
- **Readback** trusted the typed query and accepted text that merely contained the candidate.
- **Enhanced select** closed its own dropdown on round 2 and later.
- **Invalidation** did not cover the listbox or the popup search box.
- **Restore** could overwrite the user's own typing.
- **Performance:**
  - page-wide `div` scans and a `document.body` MutationObserver ran on every poll;
  - abort listeners leaked from `sleep()`;
  - an O(n²) filter dropped group headers.
- **Integration:**
  - v2 lacked the upstream plan speedup;
  - search ran on every combobox, not just the four search field types;
  - datalist near misses were left empty;
  - city selects listing "City, ST, Country" were left empty.

The two rejected findings were "a school list with only suffixed campuses picks Other" (designed and documented) and "listeners stay attached after a non-commit run" (handled by the new generation discard).

A capture issue surfaced while verifying these fixes and was also fixed. The main-world retype wait ran before polling began, which hid loading-to-results transitions. Polling now runs alongside typing.

Regression checks for the safety findings were added to `tests/search-unit.mjs` (section 8), bringing it to 161 checks.

## 8. Interaction with the other session

Another session committed four times to `autobot/` and the shared tests during this work:

- `955d49b`: sidebar coexistence
- `ff91b02`: panel re-measure
- `2384088`: Workday config, instant-absent plan executor, `today` key
- `64139b8`: Playwright host `tools/playwright-fill.mjs`

v2 was copied around `ff91b02`. The later changes were three-way merged into v2 file by file (base `ff91b02:autobot/<file>`): `README.md`, `configs/workday.json`, `engine/plan.js`, `engine/profile.js`. All merges were clean. That session also added `v2/` to `.gitignore` with the note "Parallel work by another session; not published from here". The line was left as is, so `v2/` currently cannot be committed without removing it.

## 9. Verification summary

| Check | Command | Result |
|---|---|---|
| Search unit tests | `npm run test:search` | 161/161 |
| v2 end-to-end (Chrome for Testing, extension loaded) | `npm run test:v2` | 86/86: v1 fixtures, the upstream Workday fixture, 15 search-widget checks, 4 Workday prompt checks |
| v1 end-to-end | `npm test` | 67/67 |
| Live Greenhouse school picker | `node tests/live.mjs <url> --ext=v2` (alias via `AUTOBOT_SETTINGS`) | No alias: left empty, hidden id blank. With alias: committed, hidden id set |
| Playwright host, no extension (scratch copy pointed at v2) | `autobotFill(page, {profile})` on both search fixtures | Same results as the extension run. A second run on `search.html` wrote nothing |

Not exercised automatically: trusted-event invalidation (Playwright's synthetic page events are untrusted), and a live Workday tenant (applications sit behind sign-in).

## 10. Files added or changed

- **New, untracked:**
  - `docs/SEARCH-REA.md`, `docs/SEARCH-REA-claims.md`, `docs/v2_REA_analysis.md`
  - `tests/search-unit.mjs`, `tests/fixtures/search.html`, `tests/fixtures/search-workday.html`
  - `tools/carve-parcel.mjs`
- **Modified, uncommitted:**
  - `tests/run.mjs`: `--ext` option, options-page race retry, search and Workday-prompt blocks
  - `tests/live.mjs`: `--ext`, `AUTOBOT_SETTINGS`, hidden-input readback, race retry
  - `package.json`: `test:v2`, `test:search`, `pack:v2`
  - `README.md`: v2 and the docs listed
- **Git-ignored:** `v2/` (whole folder, see section 8), `analysis/jobright/carved/`, `analysis/jobright/rea3/`.

## 11. Open items

- **Playwright host for v2: not done.** The request was interrupted. Needed: an `ext` option (default `v2`) and `engine/search.js` plus `engine/search-widgets.js` in its file list. A scratch copy with exactly those changes was verified (section 9).
- **Reruns are not idempotent on Workday prompts.** A second run rewrites config text fields with the same values. It also searches the school again, because the prompt box is empty once the choice shows as a pill, which could add a duplicate on a real multi-select. Fix: treat a field that already shows a selected value as filled before searching.
- **Commit: not done.** It requires removing `v2/` from `.gitignore`.
- **Known scorer limits:**
  - a flagship campus listed only with a suffix needs a user alias;
  - abbreviations that are not acronyms ("UT Austin") are not expanded.

## 12. Reproducing the analysis

```bash
# 1. Copy the installed extension (identical to targets/jobright-1.24.1) and prettify the main bundle
npx prettier@3 --parser babel --print-width 120 targets/jobright-1.24.1/helper-app.41ea2652.js > analysis/jobright/pretty/helper-app.js
# 2. Carve it into per-module files REA can parse
node tools/carve-parcel.mjs analysis/jobright/pretty/helper-app.js analysis/jobright/carved/helper-app helper-app.41ea2652.js
# 3. Run REA (MCP analyze_javascript_application) on analysis/jobright/carved/helper-app with the 31 source_paths in §3.4,
#    then trace_application_feature with seed {kind: "module", value: "api/autofill-client-search.js"}, direction "incoming"
# 4. Tests
npm run test:all   # since 0.2.0; the old test:v2 run is part of npm test
```
