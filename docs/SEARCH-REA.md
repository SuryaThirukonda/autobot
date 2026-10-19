# How search works in Jobright Autofill, and how autobot v2 rebuilds it

> **Since 0.2.0:** the `v2/` folder described here was merged into [`autobot/`](../autobot), which is now the only extension. A frozen copy is in [`legacy/autobot-v2/`](../legacy/autobot-v2). Paths below that start with `v2/` now live under `autobot/`.

Date: 2026-10-18. Target: **Jobright Autofill – Instant Job Applications, Job Match, AI Tailor Resume 1.24.1**, extension id `odcnpipkhjegpefkfplmedhmkmmhmoko`, installed in Brave (snap) at `~/snap/brave/692/.config/BraveSoftware/Brave-Browser/Default/Extensions/odcnpipkhjegpefkfplmedhmkmmhmoko/1.24.1_0`. REA records the installed directory as SHA-256 `680795cdfbfb456ef5dd7517dc4e632f67c9b526174506040d58e4078d937b1d`, and `diff -r` shows it is byte-identical to `targets/jobright-1.24.1`.

Full claim ledger, with verdicts and line references: [`SEARCH-REA-claims.md`](SEARCH-REA-claims.md).

## 0. What "the Notes app" turned out to be

Jobright 1.24.1 has no Notes feature. A whole-word search for `note`/`notes` across all 13 JavaScript bundles finds three hits, all in `helper-app`. Two are references to `note.svg`, the icon of the "autofill again?" confirmation modal (`~components/Popups/DoubleConfirmPopup`, prettified `helper-app.js` 143300–143390). The third is a library re-export named `note` (line 2031). A broader substring search adds only `notepad`, `noteOnce` and `notEqual`, none of which is a notes feature. The search feature that does exist is Jobright's **option search for typeahead and dropdown fields** ("client search"), so that is what this report covers and what autobot v2 rebuilds.

## 1. Method and evidence

| Step | What | Evidence |
|---|---|---|
| 1 | REA `analyze_javascript_application` on the installed directory (manifest, `helper-app`, `contents`, `background`), 6 GB analyzer heap | `ev_136e60682c6df9cd7c0d153f157fc418bee52706ac86da011c7550e95996d489`. `contents` and `background` parsed; the 7.5 MB `helper-app.41ea2652.js` **exhausted the heap**, so REA has no graph for it (this coverage gap is recorded in the Evidence) |
| 2 | Prettified `helper-app` (`analysis/jobright/pretty/helper-app.js`), then split the Parcel bundle into one CommonJS file per app module, rewriting `require("~x")` to relative paths (`tools/carve-parcel.mjs`): 2 140 modules parsed, 785 app modules emitted, no path collisions | `analysis/jobright/carved/helper-app/carve-index.json` maps every carved file to its Parcel id and prettified line range |
| 3 | REA on the carved search slice (31 files) | `ev_9b7f5e1a8ee22699350334e3a5c8303a8d02fa13ac3ec599fe0aed4f1d3f155b`: 31/31 parsed, 57 379 AST nodes, 343 findings |
| 4 | REA `trace_application_feature`, incoming to `api/autofill-client-search.js` | `ev_96020524104577412edb2feccbd1434429c04779dc16e9c7adef5e4887cadefc`: iCIMS, Kula, RippleHire, Phenom and Avature drivers import it (static import edges, inferred/high) |
| 5 | Six reader agents, one per subsystem, then six independent skeptics who re-read every cited line and tried to refute each claim | 242 claims: **148 confirmed, 94 corrected, 0 refuted**; 101 additional behaviours found by the skeptics. See the ledger |
| 6 | Complete REA session exported | `analysis/jobright/rea3/search-evidence-bundle.json` (git-ignored, 141 MB, 6 records) |

Everything here is **static**: REA parsed the code as inert text and never executed it. Runtime claims about Jobright are inferences from code. The Jobright server's behaviour is **unknown** except where the client contract constrains it.

## 2. How Jobright's search works

### 2.1 The loop

```
site driver (content script)                 background service worker                 Jobright "Swan" API
──────────────────────────────               ──────────────────────────               ───────────────────
start {source, field_type, question,  ──►  resolveAutofillClientSearchStep  ──►  POST https://api.jobright.ai
       original_answer}                     normalize · cookie warm-up · fetch        /swan/autofill/autofill-option-resolve
                                            validate twice                              /client-search-step  (credentials:include)
      ◄── REQUEST_SEARCH {resolve_session_id, round_id, search_input}
type search_input into the site's own widget, capture ≤25 {value,text}
continuation {resolve_session_id, round_id, options[]}  ──►  … ──►
      ◄── SELECT_OPTIONS {selected_values:[text]}  → re-find the option, click it, verify readback
      ◄── RETURN_EMPTY / RETRYABLE_FAILURE         → field fallback (e.g. school → "Other" + companion box)
```

- **Message hop.** Site drivers call `deps.requestStep(req)`, which is `sendToBackground({ name: "resolveAutofillClientSearchStep", body })`. Example: the iCIMS wiring at carved `contents/sites/icims/index.js:60-62`, prettified `helper-app.js` 237847–237849. The background router dispatches it at `background.js:573`, the handler is module `gQ638` at `background.js:29546-29590`, and the fetch is at `background.js:29815`. `API_DOMAIN` resolves to `https://api.jobright.ai` (`background.js:1144`).
- **Contract** (`api/autofill-client-search`, prettified 200469–200716):
  - **Start request:** `{source, field_type, question, original_answer}`. Source must be one of icims, phenom, smartrecruiters, avature, oraclecloud, jacobs, ripplehire or kula. Field type must be school, major, degree, location or company; company is allowed only for kula. Text fields are capped at 512 characters.
  - **Continuation:** `{resolve_session_id, round_id, options}`. There are at most 25 options; `candidate_key` is capped at 128 characters, `value` at 256 and `text` at 512, and keys must be unique.
  - **Responses:**
    - `REQUEST_SEARCH` must use a fresh `round_id` and a non-empty `search_input` of at most 256 characters.
    - `SELECT_OPTIONS` must name exactly one value whose text exists in the current options and maps to one native value.
    - `RETURN_EMPTY` is allowed on a start request only for school.
    - `RETRYABLE_FAILURE` may carry one of 8 codes, such as `MODEL_CALL_FAILED` or `SESSION_CONFLICT`, plus a UUID and `retry_after_ms` of at most 60 000.
  - The question strings come from a frozen map, for example school → "What school did you attend?".
- **Server-side state (inferred).** A continuation carries only ids and options. The server must therefore keep the original question and answer per `resolve_session_id`. The failure codes (`MODEL_*`) suggest a model picks both the next query and the option, but that part is unknown from the client.
- **Error handling.** The background turns every validation, HTTP, parse or network error into a bare `{action:"RETRYABLE_FAILURE"}`. No driver reads `retry_after_ms`, so a retryable failure is treated as final. The skeptics found one bug: request normalization runs *outside* the handler's try block, so a malformed request never gets a reply.

### 2.2 The drivers (8 sites, all server-resolved)

| Site | Fields | How candidates are read | Notable timing / rule | Evidence (prettified `helper-app.js`) |
|---|---|---|---|---|
| iCIMS | school, major | Main-world same-origin `GET /jobs/profileoptions?q=…&size=25` with a 3 s abort, no typing. A DOM-typing capture (`captureFreshIcimsSearchCandidates`) and its commit ship but **nothing imports them** | Max 5 searches. No repeated normalized query. Session id must not change. Commit retypes the query, waits ≤5 s for exactly one matching `li`, then polls readback for 500 ms | driver 239124–239436, widget 239449–239913 |
| Kula | degree/discipline, location, company | Chakra popovers. Company is resolved locally with no server, by reading React-fiber option props in the main world | 600 ms wait, then up to 20 polls of 200 ms until 2 identical snapshots. "Add and select" rows excluded | 252929–253418 |
| RippleHire | location | Bootstrap typeahead or Google Places | Up to 3 000 ms for the menu, 100 ms stable, 10 ms polls; ArrowDown+Enter fallback for Places. **Restores the pre-search value** on failure | 284309–285102 |
| Jacobs | school/major (select2) | `select2-<id>-results`, value = `data-select2-id` | 1 100 ms debounce, 40×100 ms polls. School falls back to "Other" plus a companion field | 245567–245692 |
| Oracle Cloud | school/major LOV | Main-world fetch/XHR interception of LOV data, plus the DOM | 14×250 ms settle | 268591–268680 and `operations.js` |
| Phenom | school | rbt typeahead `[role=option]` | Stage timeouts (prepare 5 s, probe 12 s, resolve 60 s) whose abort signal is never passed into the work, so a timeout only abandons the promise | 276185–276562 |
| Avature | institution/major | select2 | 5 000 ms windows | 200302–200459 |
| SmartRecruiters | institution | `spl-autocomplete` | 30×100 ms | 291848–292026 |

### 2.3 Capture and commit mechanics (shared ideas)

- **Generations** (`client-search-widget`, 239449–239913). Each control has a token counter in a WeakMap, and each capture makes a generation object `{token, candidates, invalidated}`. Capture-phase listeners invalidate the generation on any `isTrusted` keydown, input, change, click, pointerdown or pointerup on the select, trigger, container or search box. The field then ends as `trusted-invalidation`, so autofill never fights a user who starts typing. Script-dispatched events are untrusted and do not invalidate.
- **Settle rule.** Results count only after the container changed from its open-state baseline, is no longer loading, shows options or a "no results" row, and keeps the same signature for N polls. N is 3×20 ms in iCIMS's shipped DOM capture, 2×200 ms in Kula, and a 100 ms hold in RippleHire.
- **Commit.** The selection is re-checked against the current generation, exactly one option with the same text must exist, the option is clicked, and then the native and visible selection are polled. If the chosen option came from an earlier round, the driver retypes that round's query first.
- **Fallbacks.** iCIMS/Jacobs school: select the single exact "Other" option, then type the school into the unique companion "other school" input. iCIMS major: reset to the placeholder and verify it is blank.

### 2.4 Matching that never reaches the server

`~contents/methods/choice-match` (prettified 131362–131389) is Jobright's shared local matcher, used by about 45 site modules. It normalizes with NFKC, curly quotes, collapsed whitespace and lowercase, and accepts an option only if **exactly one** option equals the answer. Fuzzy matching is rare:

- **Workday** (`crawler/utils/select`, 214620–214660) uses a Levenshtein similarity with threshold 0.7 strict or 0.5 loose. A tie returns null, and fuzzy matching is disabled for school, skills and field of study.
- **Ashby** uses Fuse.js at 0.35 and its own GraphQL school search.
- **Greenhouse react-select** tries exact, then startsWith, then includes, but uses only exact matching for school and discipline.

The fuzzy decisions for the 8 client-search sites are made on the server.

### 2.5 Cancellation and telemetry

- **Cancellation** (`~contents/methods/cancellation`, 90081–90203) is cooperative. `checkpoint()` throws when the user cancels or skips, `cancellableDelay()` rejects on abort, and `withSkip()` gives each field its own skip controller.
- **In-flight steps are not aborted.** The background fetch has no signal or timeout. Drivers call `checkpoint()` around every await and throw away late replies.
- **Telemetry.** A per-field resolve trace `{actions, rounds:[{searchInput, candidateCount}], selected, failureReason}` is kept, and answer-pair and submit tracking events go to Jobright's event endpoints.

## 3. autobot v2: what was kept, replaced and dropped

The new code lives in `v2/engine/search.js` (pure logic, unit-tested in Node) and `v2/engine/search-widgets.js` (DOM adapters). Integration is in `v2/engine/writer.js` (`AB.trySearch`) and `v2/engine/plan.js`.

| Jobright | autobot v2 |
|---|---|
| Step contract: start/continuation shapes, four actions, ≤25 options, length caps, fresh round id, exactly-one selection, text → one value | **Kept.** `normalizeRequest` / `validateResponse` |
| Driver guards: ≤5 searches, no repeated normalized query, stable session id, recapture before committing an earlier round's pick, `failureReason` strings | **Kept.** `AB.search.run`, using the same reason strings (`search-limit-exceeded`, `repeated-search`, `trusted-invalidation`, `candidate-commit-failed`, `return-empty` …) |
| Server/model chooses the query and the option | **Replaced** by a deterministic local resolver. `queryPlan` produces per-field-type query variants. `score` is a token scorer:<br>• It knows state codes, degree families with subject qualifiers (BS ≠ BA), acronyms of 3 or more letters, `&`/`and`, and parenthetical aliases ("(UCLA)" but not "(Commerce)").<br>• It penalizes each distinct extra token by 0.2.<br>• It treats "University of X" and "X University" as different.<br>Per-field thresholds sit above the one-extra-token score: school 0.86, major 0.85, degree 0.78, location 0.85, company 0.84. A runner-up within 0.05 makes the round ambiguous, so nothing is selected |
| Generation tokens and trusted-event invalidation | **Kept** (`search-widgets.js`) |
| Settle rule (changed from the open-state baseline, not loading, N stable polls) | **Kept**, with generic timings (25 ms polls, 6 stable, 4.5 s window). Added: an unchanged or irrelevant list is accepted only after a grace period, so a default list shown on focus is never taken for results |
| Exactly-one exact-text commit plus readback | **Kept**, with a stricter stable readback (60 ms within 900 ms). One of these must hold:<br>• a selected-value element (single-value, pill, rendered label) shows exactly the option;<br>• the menu closed and a text box *changed* to exactly the option;<br>• the menu closed, the text matches exactly, and the field's hidden id changed.<br>Exact text that was already there with nothing else changing is reported as unverified |
| Restore the pre-search value on failure (RippleHire) | **Kept** for every adapter |
| School "Other" + companion input (iCIMS/Jacobs) | **Kept**, guarded. It runs only when all of these hold:<br>• the field is a school field by config or by a strict institution label;<br>• the list contains no education-level entries;<br>• nothing in the list shares a distinctive word with the school or scores at least 0.25.<br>The companion box is looked up after the commit and must be unique and sit in the school's own field (or be labeled as a school box). Otherwise the choice is reverted |
| Per-site DOM recipes (Chakra, select2, rbt, LOV …) | **Generalized** into adapters: native `<select>`, enhanced select (select2/chosen/iCIMS-style ajax), ARIA combobox/react-select (including pickers that hide the real input until a proxy is clicked or that move focus to a popup search box), `<datalist>`, Workday prompt |
| Background POST to `api.jobright.ai`, cookie session, iCIMS `/jobs/profileoptions` fetch, Oracle fetch/XHR interception, telemetry upload | **Dropped.** autobot sends nothing; the trace is shown in the panel only |
| `RETURN_EMPTY` leaves the field to the user | **Kept.** autobot never guesses below the threshold |
| — | **Added:** user-defined *search aliases* (options page), e.g. `"Texas A&M University" → "Texas A&M University - College Station"`, for lists whose canonical name differs from the profile |

## 4. Verification

| Check | Result |
|---|---|
| `npm run test:search`: Node unit tests for the scorer, query plan, contract, resolver and driver (fake adapter), plus 15 regressions from the code review | 161/161 |
| `npm run test:v2`: e2e in Chrome for Testing with v2 loaded. It runs the v1 fixtures, including the Workday fixture added upstream; 15 search-widget checks (async ARIA combobox needing a second round, select2 ajax, near miss left empty, 150-option native select with prefix traps, datalist, "Other" + companion, plain text not searched); and 4 Workday prompt checks | 86/86 |
| `npm test`: v1 regression with the original `autobot/` | 67/67 |
| Live: `node tests/live.mjs https://job-boards.greenhouse.io/duolingo/jobs/8888721002 --ext=v2` (throwaway browser, never submits) | Search ran on Greenhouse's remote school picker. "Texas A&M University" returned 7 candidates, all campus-suffixed ("… - College Station", "… - Commerce", …). The best scored 0.80, below 0.86, so the field was left empty and restored. With the alias set, round 1 selected "Texas A&M University - College Station", and the hidden `educations[0].school_name_id` was set to `11785542002` |

Problems the live run exposed, now fixed in v2:

- **Default list taken for results.** The baseline was taken before the dropdown opened, so the default A–Z list counted as search results.
- **Typing into the wrong input.** The picker's `aria-controls` input is a hidden trigger. The real search box is a separate unlabeled input inside the popup.
- **Hidden config target.** The config path landed on the hidden id input.

### Code review

Four independent reviewers covered loop correctness, wrong-fill safety, integration regressions and performance. A skeptic then re-checked each reviewer's findings: 34 reported, 32 confirmed, 2 rejected as designed behavior or not reproducible. All 32 confirmed findings are fixed. The main ones:

- **Stop, user input or a later-round failure fell back to the v1 prefix matcher.** The matcher could then commit, for example, "Texas A&M University - Commerce". Search results are now final once real candidates were seen.
- **Ties and one-extra-word matches were accepted.** Examples: "Business" → "Business Analytics", "Portland" → "Portland, ME".
- **"State" was treated as filler.** "University of Michigan" matched "Michigan State University" at 0.98.
- **Parenthetical campuses were ignored.**
- **The "Other" fallback could type into another field's box.**
- **The readback trusted the typed query.**
- **Enhanced-select rounds 2+ closed their own dropdown.**
- **Page-wide scans ran every poll.**

v2 was also missing four commits that another session made to `autobot/` during this work: the instant-absent plan executor, the Workday config, the `today` profile key and panel coexistence. Those were three-way merged into v2 (base `ff91b02`) with no conflicts.

## 5. Limits and open items

- The scorer cannot tell which suffixed campus is the flagship, for example "X - College Station" versus "X - Commerce". It leaves such fields empty unless a search alias says which one. Jobright delegates this choice to its server.
- Abbreviations that are not acronyms of the full name ("UT Austin") are not expanded; add an alias.
- The Workday prompt adapter is tested on a Workday-style fixture (`tests/fixtures/search-workday.html`), not on a live Workday tenant: real applications sit behind sign-in.
- Trusted-event invalidation cannot be exercised by the automated tests, because Playwright's synthetic page events are untrusted. It was reviewed but not run.
- Server behaviour (query choice, selection policy, model) is unknown. Only the client contract is evidenced.
