# How job-application autofill works — Simplify Copilot vs Jobright, and what Autobot keeps

Sources: static analysis of Simplify Copilot 3.1.9 (`targets/simplify-3.1.9`, prettified in `analysis/pretty`) and Jobright Autofill 1.24.1 (`targets/jobright-1.24.1`, prettified in `analysis/jobright/pretty`), REA application graphs for both (`analysis/*.json`, both `partial` because the main bundles exhaust REA's analysis heap), and a live capture of Simplify's traffic and remote config (`analysis/live/CAPTURE.md`). Line references below point at the prettified copies.

## 1. The pipeline both extensions implement

Every autofill extension has to solve the same six problems. The table shows how each one does it and what Autobot does.

| Stage | Simplify Copilot | Jobright | Autobot |
|---|---|---|---|
| **Gate**: should the heavy code run on this page? | Tiny loader `content-scripts/content.js` asks the worker for a "frame gate" built from every ATS `urls` glob + `embeddedPaths` XPath in the remote config; only then `import()`s the 2.2 MB bundle | Plasmo content script `contents.js` injects `helper-app.js` (7.5 MB) through the worker (`injectHelperAppBundle`) on `<all_urls>`, with an exclude list | Content script is small enough to run everywhere; URL globs + XPath probes (`configs/*.json`) decide which plan to use; a 3-control minimum decides whether to show anything |
| **ATS detection** | Iterate `ATS` in config order: URL glob match (`urls` minus `urlsExcluded`), else DOM probe (`embeddedPaths` groups all true, `pathsExcluded` none true). `contentScriptMain.js:38128` | Hostname table (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `myworkdayjobs.com`, `icims.com`, `apply.workable.com`…) plus query-param hints (`gh_jid`, `ashby_jid`). `helper-app.js:86253` | Same two-tier scheme as Simplify (`engine/detect.js`), falling back to a `generic` heuristic plan |
| **Field discovery** | Config-driven: `inputSelectors = [[keyPath, steps[]]]`, XPaths relative to `containerPath`; array sections (`education`, `experience`) expand per profile entry (`xE`, `:33865`). Unknown questions: `trackedInputSelectors` with `fieldPath/labelPath/sectionPath/inputPath/optionsPath` | Per-ATS "plan" modules with embedded `selectorTables` (XPath/CSS), `labelPatterns`, `answerMaps`, `params` (e.g. Greenhouse plan at `:92057`); generic pass enumerates controls and derives labels (`aria-labelledby`, `labels`, data-test-id, name, id) | Config plans with the same `[key → steps]` idea (`engine/plan.js`), then a heuristic pass that enumerates controls, extracts labels and classifies them with ordered word-boundary keyword rules (`engine/heuristics.js`) |
| **Value resolution** | `mv()` (`:26738`): step `value` → `valueKey` → profile[keyPath]; `zb()` maps profile enums to per-vendor option labels via `values` maps; `%VALUE%` templating in XPaths; option catalogs fetched from vendor APIs (`optionsSource`) | `answerMaps` (degree/discipline/race fallbacks), country alias groups, month tables; everything else from the server (`resolveAutofillOperation`, `regenerateAnswer` → AI) | `getProfileValue()` with formatters (`start_date|MM/YYYY`), `VALUE_MAPS` for yes/no, EEO, degree, month; deterministic saved answers keyed by normalized question text. No network |
| **Writing values** | Isolated world: `Tn()` focus → `execCommand("insertText")` or native setter + keydown/keypress/input/keyup/change (`:4147`). Main world (`pageScript.js`): `react` finds `__reactProps$…`, dispatches events **and** calls the React handler with `nativeEvent` (`:2759`); `jQuery`, `dijit`, `ui5`, `tinyMCE`, `selectCheckboxOrRadio`, `scrollListboxToOption`, `interceptFilePicker` (patches `HTMLInputElement.prototype.click`/`showOpenFilePicker`), `uploadResume` via `DataTransfer` | Native setter through `HTMLInputElement.prototype` descriptor, clear-then-set, `input`/`change`/`keydown` events (`:140313`); React fiber walks (`memoizedProps`/`pendingProps`) injected with `chrome.scripting.executeScript({world:"MAIN"})` for react-select, Workday, Recruitee, Workable; pointer-event sequences for custom dropdowns | `engine/writer.js`: native setter + full event sequence in the isolated world; `page.js` main-world bridge for `react`/`jquery` (same React-props handler trick); `writeSelect`/`writeRadio`/`setChecked` with deterministic option matching; `writeCombobox` opens, types, waits for `[role=option]`, picks best match; `writeFile` via `DataTransfer` |
| **Multi-page / submit** | `continueButtonPaths`, `submitButtonPaths`, `submittedSuccessPaths`, `proxySubmitButtons`; `runAutoAdvanceInFrames` asks every frame for a next button; success → tracker API | Per-ATS "submission-network" scripts hook `fetch`/`XMLHttpRequest` to detect the application POST (Workday, Oracle, SuccessFactors, BrassRing, ClearCompany) and report "applied" | `continue` paths with a bounded loop (6 pages); `submit` paths are only used to *stop* advancing. Autobot never clicks submit |

## 2. Simplify's configuration grammar (the part worth keeping)

The live config (`https://sabre.simplify.jobs/?v=3.1.9`, 31.8 MB, 56 ATS entries) is the product. Per vendor:

```
urls, urlsExcluded, embeddedPaths, pathsExcluded, selectorOnlyMatching     # detection
containerPath, containerRequired, defaultMethod                           # scope + default writer
trackedObjExtractors, sourceKeys                                          # canonical job id, tracking params
applyButtonPaths, continueButtonPaths, submitButtonPaths, submittedSuccessPaths, proxySubmitButtons
inputSelectors: [[keyPath, [ step | xpath-string ]...]]                   # the fill plan
trackedInputSelectors: [{fieldPath, labelPath, sectionPath, inputPath, inputTextPath, optionsPath, optionsSelectedPath, optionsSource, fillActions}]
```

Step object keys observed (counts across all vendors): `path` 3491, `time` 1827, `method` 1822, `values` 896, `actions` 696, `allowFailure` 634, `eventOptions` 482, `condition` 480, `valueRequired` 385, `valuePath` 367, `event` 362, `delay` 342, `valueKey` 295, nested `inputSelectors` 276, `template` 225, `array`/`limit`/`reverse`, `hidden`, `name`, `removed`, `skipFocusClick`, `wordLimit`, `characterLimit`, `optionsSource`.

Methods and frequency: `click` 1138, `defaultWithoutBlur` 222, `default` 84, `selectCheckboxOrRadio` 82, `react` 82, `uploadResume` 72, `clearValue` 33, `uploadCoverLetter` 30, `reactClick` 14, `jQuery` 12, `writeCoverLetter` 11, `blur` 8, `setValueOnly` 8, `scrollListboxToOption` 7, `ui5` 4, `reactDatePickerMonth` 4, `dijit` 3, `vanillaWithBlur` 3, `tptEnableResume` 2, `tinyMCE` 2, `setValue` 1.

Profile keyPaths referenced: 161 top-level (`first_name`, `email`, `work_auth_us`, `ethnicity`, `veteran_v2`, …) plus array sections `education[]`, `experience[]`, `language[]`, `skill[]`; `_2`/`_3` suffixes target repeated fields; `_MM`, `_YYYY`, `_slashes_MMDDYYYY` suffixes are formatting variants.

Autobot's `configs/*.json` keep the useful subset: `urls`, `urlsExcluded`, `probes`, `container`, `defaultMethod`, `pre`, `fields[]` with `key`, `path`, `method`, `value`, `valueKey`, `values`, `required`, `allowFailure`, `condition`, `time`, `actions[]`, `array`/`limit`/`add`/`item`/`fields`, `optionsPath`, plus `continue`/`submit`/`success`. The selectors were written from scratch against the public ATS DOMs; nothing was copied from the proprietary config.

## 3. Where the "AI" actually sits

- **Simplify**: only for questions its config cannot map. The content script discovers them with `trackedInputSelectors`, the worker batches them to `POST /v2/candidate/me/copilot/answer/batch` (20 per request, `background.js:134877`) with `{mode: select|text, question, options, context:{form_context, section, label}, profile_hint, job_info:{ats_key, tracked_obj, title, description, company_name, salary…}, answer_policy}`. Answers are cached per label and can be saved. Everything else (names, links, EEO, education, resume) is deterministic config.
- **Jobright**: `resolveAutofillOperation` / `regenerateAnswer` / `resolveAutofillClientSearchStep` go to `api.jobright.ai`; also server-side "site rules" with an A/B flag (`getSiteRules`, `refreshSiteRules`). Option catalogs for Greenhouse schools/disciplines are fetched from Greenhouse's own `/v1/boards/{token}/education/{type}`.
- **Autobot**: none. Unknown questions are answered only from the saved-answers table (normalized exact match, then containment) and otherwise reported as `unknown` in the panel so you fill them by hand.

## 4. Runtime behaviour observed (Simplify, unauthenticated, `analysis/live`)

- Config fetched once at install (`sabre.simplify.jobs`, 959 KB gzipped), cached 30 min in memory and persisted in `chrome.storage.local`.
- Install tutorial is a fake application form that the extension autofills as a demo (statuses for `first_name`, `email`, `phone_stripped`, `linkedin`, and a tracked question appear in storage).
- Job info (title, company, pay, "confirmed live") is extracted locally from the page via `trackedObjExtractors`; authenticated endpoints 401 when logged out; analytics gated behind the privacy consent card.
- REA note: `capture_browser_scenario` crashes on `chrome-extension://<GUID>/…` responses (status 0 from Chrome's `use_dynamic_url` internal redirect). Autobot deliberately does not use `use_dynamic_url` so it stays analyzable. Repro in `analysis/live/repro-ext/`, draft report in `analysis/live/rea-issue-draft.md` (not filed).

## 5. Autobot validation (2026-10-18)

- `npm test`: 48/48 checks on three fixtures (Greenhouse-like with a react-select clone, Lever-like with custom radio/EEO selects, unknown ATS with label-only heuristics). Verifies values, event sequences (`input`+`change`), resume `File` attachment, yes/no mapping, EEO synonym mapping, saved answers, and that consent/marketing checkboxes stay untouched.
- `node tests/live.mjs https://job-boards.greenhouse.io/anthropic/jobs/5183044008` (owned Chrome for Testing, never submits): detected `greenhouse` by URL; wrote first/last name, email, phone, resume on the real React form; chose `United States +1` in the react-select phone-country widget and `I understand that I do not need to complete this…` in the posting's custom react-select question from a saved answer (label-matched). Fields the posting does not have are reported `absent`. Two writes initially failed because Greenhouse re-rendered the inputs after the first writes; the writer now re-resolves detached elements by id/name and falls back to ArrowDown/Enter for listboxes.

## 6. REA on Jobright

`analyze_javascript_application` (MCP, 4 GB heap, 10 min): 16 relevant files, 12 parsed, 77 findings, 36 285 semantic unknowns, coverage `partial` because `helper-app.41ea2652.js` (7.5 MB) exhausted the worker heap, same as Simplify's `contentScriptMain.js`. The graph still gave the file inventory, sender-validation observations (18) and endpoint candidates; the detailed engine trace came from the prettified bundles. Jobright's architecture: Plasmo MV3; worker with ~150 message handlers (`static/background/index.js`); per-ATS MAIN-world fiber injections via `chrome.scripting`; `declarativeNetRequest` permission; "submission-network" content scripts that monkey-patch `fetch`/XHR on Workday, Oracle, SuccessFactors, BrassRing and ClearCompany to confirm submissions.
