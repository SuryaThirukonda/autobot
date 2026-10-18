# Simplify Copilot 3.1.9 — Autofill reverse-engineering notes

Target: `simplify-3.1.9/` (copied from Brave's snap profile, extension id `pbanhockgagggenencehbnadejlgchfc`).
Prettified sources: `analysis/pretty/`. REA static graph: `analysis/rea-javascript-application.json` (171 MB) and the trimmed `rea-app-graph.slim.json`.

Evidence authority: shipped artifact, static reading only. Nothing here was executed. REA's own result is marked `partial` (its worker exhausted a 1 GB heap on `contentScriptMain.js`), so the detailed autofill trace below comes from reading the prettified bundles, not from the REA graph.

---

## 1. Architecture at a glance

Built with the **WXT** extension framework (markers: `wxt:content-script-started`, `wxt:locationchange`, "unlisted script" wording). React UI, Zustand-style store, axios, pdf.js worker bundled.

| File | Role | Size |
|---|---|---|
| `background.js` | MV3 service worker. Auth, API client, remote-config fetch, AI answer proxy, LinkedIn/Handshake scraping, analytics | 2.9 MB |
| `content-scripts/content.js` | Tiny loader injected on `*://*/*` at `document_end`, all frames. Decides whether to load the main bundle | 21 KB |
| `contentScriptMain.js` | The real content script. ATS detection, field discovery, fill engine, side-panel UI | 2.2 MB |
| `pageScript.js` | Injected into the page's **main world** via `<script src=getURL("pageScript.js")>`. Does the actual DOM writes that need framework internals (React props, jQuery, dijit, UI5, TinyMCE) | 76 KB |
| `content-scripts/panel-restore.js` | `document_start` script that redraws a placeholder side panel from `sessionStorage` across page navigations so the UI doesn't flicker | 6 KB |
| `remoteConfig.json` | **24 MB** bundled fallback of the server-driven selector database. 56 ATS entries | 24 MB |
| `chunks/offscreen-*.js`, `offscreen.html` | Offscreen document (likely PDF/resume parsing with pdf.js) | |

Permissions worth noting: `*://*/*` host permission, `cookies`, `webRequest`, `webNavigation`, `tabs`, `unlimitedStorage`. `externally_connectable` to `*.simplify.jobs`, `*.village.do`, `*.village.ai`.

---

## 2. The autofill trigger path

1. **Hotkey** `Alt+Shift+F` is the manifest command `trigger-autofill`.
2. `background.js` ~L136000: `commands.onCommand` → `tabs.sendMessage(tabId, {action:"triggerFill"}, {frameId:0})`. If the content script answers falsy, it falls back to opening the panel (`Nc`).
3. `contentScriptMain.js:101000`:
   ```js
   if ("triggerFill" === e?.action) {
     const { fill, fillStatus, settings } = store.getState();
     if (fillStatus === "filling") return true;
     return fill ? (fill({ keyPaths: null, showProgress: true, continuous: settings?.defaultContinuous ?? true }), true) : false;
   }
   ```
   `keyPaths: null` = fill every field. `continuous` = keep clicking continue/next and re-filling across multi-page forms.
4. Toolbar click / panel "Apply with Autofill" button reach the same `fill` store action.

### How the content script gets loaded (frame gate)

`content.js` does **not** load the 2.2 MB bundle everywhere. It asks background for `fetchFrameGateConfig`, which flattens every `urls` and `embeddedPaths` from `remoteConfig.ATS`, `.Boards`, `.ResumeScores`, `.jobListTables` into one gate object `{urlPatterns, xpathGroups, selectorOnlyProbes, minWidth, minHeight, urlsExcluded}`. The loader then:
- matches `location.href` against the glob patterns (Chrome match-pattern syntax, `*://host/*`), or a `trackedObj=` query param;
- else, if the frame is big enough, runs the XPath probe groups against `document.documentElement` (with a custom `/shadow-root/` XPath extension that descends into open shadow roots);
- on a hit, `import(runtime.getURL("contentScriptMain.js"))`. A MutationObserver with exponential backoff (300 ms → 5 s) re-probes SPAs.
- iframes that match send `{method:"wakeTopFrame"}` so the top frame also loads (the panel lives in frame 0).

---

## 3. Remote config: the selector database

Loaded in background by `$l` (~L9032):
- Fetches `https://sabre.simplify.jobs/?v=3.1.9` (3 retries, 30-min in-memory cache, `last-modified` header used as a version string).
- Falls back to the bundled `remoteConfig.json` (which may be sharded via `__atsShards` / `__atsSerializedChunks` keys — not used in this build).
- "Sabre" is the internal codename (API `clientName: "Sabre"`, tracker endpoints `/tracker/sabre/*`).

Top-level sections: `ATS` (56 vendors), `Boards` (job-board scraping), `ResumeScores`, `resumeScoreKeywords` (1 481 keywords), `fieldCategories`, `fieldNameAliases`, `fieldDependencies`, `conditionalTrackedInputExclusions` (419), country/state code tables, feature flags (`fullAIAutofillEnabled`, `savedAnswersEnabled`, `copilotAnswerUnifiedEnabled`, `bestEffortAnswersEnabled`, `optionsCatalogPrefetchEnabled`), `render` (panel sizing / `urlsExcluded`), `changelogMessages`.

### ATS entry schema (per vendor)

| Key | Meaning |
|---|---|
| `urls`, `urlsExcluded` | Match patterns for URL-based detection |
| `embeddedPaths`, `pathsExcluded` | XPath groups for DOM-probe detection (e.g. Greenhouse iframe embedded on a company site) |
| `selectorOnlyMatching` | Only detect by DOM probe (vendor has no stable host) |
| `containerPath`, `containerRequired` | XPath to the form root; all field XPaths are relative to it |
| `defaultMethod` | Default write strategy (`react`, `default`, `jQuery`, …) |
| `trackedObjExtractors` | URL-pattern / XPath + regex + template rules that derive a canonical job id, e.g. `greenhouse:{board}/jobs/{id}` |
| `sourceKeys` | Query params to strip or preserve (`utm_source`, `gh_src`) |
| `applyButtonPaths`, `continueButtonPaths`, `submitButtonPaths`, `submittedSuccessPaths` | Multi-page navigation + success detection |
| `proxySubmitButtons` | Replace the site's submit with Simplify's own so submission can be tracked |
| `inputSelectors` | **The fill plan.** Ordered list of `[keyPath, steps[]]` |
| `trackedInputSelectors` | Discovery rules for *unknown* questions (custom screener questions) that go to the AI |
| `fillInputGroupInterval`, `fillInputInterval` | Pacing |

### `inputSelectors` step grammar

Each entry is `[keyPath, steps]`. `keyPath` is a path into the normalized candidate profile (`first_name`, `education[0].major.name`, …). Each step is either a bare XPath string or an object:

```
{ path | [path,...]      // XPath(s) relative to containerPath; %INPUTPATH%, %VALUE%, %UPPERVALUE%, %UNMAPPEDVALUE% templating
  method                 // write strategy; default from ATS.defaultMethod
  event, eventOptions    // raw DOM event to dispatch instead of a method; {bubbles, cancelable, noBlur, skipBlur, repeat, page:true}
  value, valueKey, valuePath, valuePathMap, values   // override/transform the profile value, or map to option labels
  valueRequired          // false = run even when profile has no value (used for clicks)
  hidden, name           // hidden = control step, not a user-visible field; name = label shown in panel
  time, delay, removed, removedTime   // wait for element to appear (default 4 s) / to disappear
  allowFailure           // continue plan on failure
  condition              // XPath boolean guard
  actions: [...]         // sub-steps executed sequentially against the found element
  inputSelectors, array, limit, reverse   // nested section (education/experience arrays), recursed by xE()
  optionsSource          // remote option catalog: {urlTemplate, extractors, responseItemsPath, responseTextPath, fallbackTerms}
  wordLimit, characterLimit, skipFocusClick
}
```

Observed `method` vocabulary with counts across all 56 ATS configs:
`click` 1138 · `defaultWithoutBlur` 222 · `default` 84 · `selectCheckboxOrRadio` 82 · `react` 82 · `uploadResume` 72 · `clearValue` 33 · `uploadCoverLetter` 30 · `reactClick` 14 · `jQuery` 12 · `writeCoverLetter` 11 · `blur` 8 · `setValueOnly` 8 · `scrollListboxToOption` 7 · `ui5` 4 · `reactDatePickerMonth` 4 · `dijit` 3 · `vanillaWithBlur` 3 · `tptEnableResume` 2 · `tinyMCE` 2 · `setValue` 1. Plus `interceptFilePicker` handled specially.

Example (Greenhouse): `["begin", [{path:"//a[@id='apply_button']", method:"click", valueRequired:false, hidden:true}]]` then `["first_name", [{path:[".//input[@id='first_name']", ".//input[contains(@name,'first_name')]", <label-text XPath>], method:"react"}]]`.

---

## 4. Fill engine (contentScriptMain.js)

1. **ATS detection** `UA` (~L38128): iterate `remoteConfig.ATS` in key order; first entry whose `urls` match (and `urlsExcluded` don't) wins with `matchedBy:"url"`, else first whose `embeddedPaths` XPath group all evaluate true wins with `matchedBy:"dom-probe"`. Selector-only vendors are tried last.
2. **Profile → keyPath expansion** `xE` (~L33865): walks `inputSelectors`, pushes keyPaths in order; for nested `inputSelectors` with `array:true` it expands to `education[0]`, `education[1]` … up to `limit`, honouring `reverse`.
3. **Value resolution** `mv` (L26738): `step.value` ?? `profile[step.valueKey]` ?? `profile[keyPath]`. Then `values` maps profile values to option labels (e.g. ethnicity enums → each vendor's wording), via `zb`.
4. **Per-field plan execution** `kv` (L26826): for each step: resolve the XPath (with `%VALUE%` substitution), wait for it with a MutationObserver + adaptive timer (`xv`), handle `removed`, then dispatch `method`/`event` through `fillInput`. Tracks `allowFailure`, caches unresolved paths per page in `unresolvedActionPaths`, aborts via `AbortSignal`.
5. **Alternative values** `vv`: tries each candidate value in turn until one is accepted, within a `fillDeadline`.
6. **Writes** go one of two ways:
   - Isolated-world DOM helpers (`Tn`, `F`) for simple inputs.
   - **Main-world** bridge `Sv` (L27150): `window.postMessage({action:"__simplify__fillInput", foundInput, method, value, …})` and await `__simplify__updateFilledInput` with matching `keyPath`. Used for `react`, `jQuery`, `dijit`, `ui5`, `tinyMCE`, uploads and any step with `eventOptions.page:true`.
7. **Status / verification**: `vx`/`wx`/`Sx` decide if a field is still empty, `aria-invalid`, or required-and-empty, driving retries and the panel's per-field status (`filled`, `skipped`, `error`, "The site rejected this value").
8. **Continuous mode**: after the plan, click `continueButtonPaths`, wait, re-run; `runAutoAdvanceInFrames` (background) asks every frame `hasAutoAdvanceTarget` then `runAutoAdvanceInFrame`. `submittedSuccessPaths` marks the application as applied and reports to `/v2/candidate/me/tracker/job-posting/applied`.

### pageScript.js — the React trick

`react` method (L2759): find the `__reactProps$…` / `__reactEventHandlers$…` key on the element, then synthesize `focus → click → keydown → keypress → (set value via native setter `q`) → input → keyup → change → blur`, calling both `element.dispatchEvent(ev)` and the React prop handler directly with `ev.nativeEvent = ev`. Selects set `.value` then fire `input`+`change`. Checkboxes use `.click()` and fall back to forcing `.checked`. Other handlers: `jQuery(el).val().trigger()`, `dijit.getEnclosingWidget(el).set("value")`, UI5, TinyMCE, `reactDatePickerMonth`, `scrollListboxToOption`. It also hosts `__simplify__waitFor` (wait for a React re-render) and `__simplify__interceptFilePickerFile` (patch `showOpenFilePicker`/`<input type=file>` to inject the resume `File`).

---

## 5. Unknown questions → AI ("Copilot")

- `trackedInputSelectors` describe how to *discover* question blocks: `fieldPath`, `labelPath`, `sectionPath`, `inputPath`, `inputTextPath`, `optionsPath`, `optionsSelectedPath`, `fillActions` (same step grammar with `%INPUTPATH%`), optional `optionsSource` for remote typeahead catalogs (e.g. Greenhouse's `/v1/boards/{boardToken}/education/schools?term=`).
- Content script sends `requestCopilotAnswerForTrackedInputs` with `{trackedInputs, jobInfo, answerPolicy}`.
- Background `b9` builds one request per question: `{mode:"select"|"text"|…, question: labelText, options:[…], context:{form_context, section, label}, profile_hint, job_info:{ats_key, tracked_obj, title, description, location, company_name, job_type, salary_*}, answer_policy}`.
- `f9` batches 20 at a time to **`POST https://api.simplify.jobs/v2/candidate/me/copilot/answer/batch`**, retries once, re-requests "unanswerable/transient" slots, and emits `ai_answer_partial_batch` telemetry. Older paths still present: `/v2/candidate/me/copilot/question`, `/copilot/tracked-inputs/v3`, `/v3/copilot/answers`, `requestGPTValue(s)`, `requestGPTCoverLetter`.
- Answers are cached per label (`trackedInputAnswers[labelText]`) and the user can store them (`savedAnswersEnabled`, `/copilot/questions`), give feedback (`/copilot/autofill/feedback`), and the extension reports fills (`/copilot/tracked-inputs/report`).

---

## 6. Data sources and auth

- API client `z({ baseUrl:"https://api.simplify.jobs", clientName:"Sabre" })` (background ~L135871). Tokens come from **cookies on simplify.jobs**: `authorization` (access, 15-min expiry, httpOnly, re-set by the extension via `cookies.set` after refresh) and a CSRF cookie; `refresh` cookie for renewal. Sent as `Authorization: Bearer`.
- Profile: `/v2/candidate/me/`, `/education/`, `/experience/`, `/skill/`, `/resume/paginate`, `/cover-letter/`, `/preferences`, `/subscription`. Normalized client-side into the keyPath schema below.
- Side features found in the same bundle: LinkedIn Voyager scraping (`/voyager/api/me`, `/relationships/dash/connections`, uses `li_at` + `JSESSIONID` cookies), Handshake profile import, "Village" networking widget (`api.village.ai`, `k.village.ai`), resume scoring, analytics to `boar.simplify.jobs/capture/` and Axiom.

### Profile keyPath schema (derived from all 56 configs)

161 distinct top-level keys. Core: `first_name last_name full_name legal_name preferred_name middle_name pronouns email phone phone_stripped phone_country phone_type phone_extension address address_2 city state postal_code country location city_state linkedin github portfolio twitter behance dribbble website websites[].url additional_url resume coverLetter cover_letter current_company_name current_job_title currently_working highestDegree most_recent_school most_recent_major most_recent_gpa work_auth work_auth_us work_auth_ca work_auth_uk sponsorship gender gender_identity transgender ethnicity hispanic multiple_ethnicities veteran_v2 armed_forces disability_v2 lgbt_v2 over18 over21 birthday_{M,MM,D,DD,YYYY,…} current_date_{…} source referred_by salary_requirements has_drivers_license language languages skill skills`.
Array sections: `education[]{education.name, degree, major.name, gpa, start_*, grad_*, graduated, city, state, country}`, `experience[]{company.name, title, description, location, city, state, country, currently_working, start_*, end_*}`, `language[]{language.name, speaking, reading, writing, fluent, native}`, `skill[]/skills[]{skill.name}`.
Suffixes `_2`, `_3` are the same value aimed at a second/third occurrence of the field; `_checkable`, `_text`, `_stripped`, `_slashes_MMDDYYYY` etc. are formatting variants. Keys like `begin`, `save_*`, `expand_*`, `clear_profile`, `wait_for_location_loaded` are hidden control steps, not profile data.

---

## 7. Where to look next

- `analysis/pretty/contentScriptMain.js` L26738–27160 (value resolution + step executor), L33865 (keyPath expansion), L38128 (ATS detection), L101000 (message handler).
- `analysis/pretty/pageScript.js` L2759+ (React writer), L2641/3174 (dijit), L2700–2760 (jQuery).
- `analysis/pretty/background.js` L9032 (remote config fetch), L134877 (AI batch), L135871 (API/auth), L136052–137140 (message dispatcher, 150 handlers).
- Dump any vendor's full plan: `python3 -I -c "import json;d=json.load(open('simplify-3.1.9/remoteConfig.json'));print(json.dumps(d['ATS']['Workday'],indent=1))"`.

## 8. Limits of this analysis

- Static only. No runtime capture; the live `sabre.simplify.jobs` config may differ from the bundled copy.
- REA's graph is partial for `contentScriptMain.js` (heap limit). Its endpoint/module/storage inventory is still in `rea-app-graph.slim.json`.
- Variable names are minified; function names above are the minified identifiers at those lines in *this* prettified copy.
