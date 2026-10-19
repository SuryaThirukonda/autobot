# autobot (v2)

v2 of Autobot: the same deterministic job-application autofill extension, plus **multi-round option search** for typeahead and searchable dropdown fields, reconstructed from Jobright Autofill 1.24.1's "client search" loop (evidence in `../docs/SEARCH-REA.md`). The extension name is `autobot`; every other manifest field keeps v1's defaults.

A deterministic job-application autofill extension (Manifest V3). No AI, no server, no telemetry. Your profile lives in `chrome.storage.local` and never leaves the browser.

It is a clean-room reconstruction of the autofill pipeline used by Simplify Copilot and Jobright (see `../docs/AUTOFILL-PROCESS.md`): config-driven field plans per ATS, framework-aware value writing, and a heuristic fallback for forms no config covers.

## Install (unpacked)

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick this `v2/` folder (disable v1 Autobot first; both bind the same shortcut). Works in Chrome, Brave, Edge, Chrome for Testing.
2. The options page opens on install. Fill in your profile, upload a resume (stored locally as base64), add saved answers for recurring free-text questions, *Save*.
3. On a job application page press **Alt+Shift+A**, click the toolbar icon → *Fill this page*, or use the panel's *Fill* button. Review every field. **Autobot never clicks submit.**

## How a fill runs

1. `engine/detect.js` loads `configs/*.json` (plus any overrides from settings), matches the URL against each config's `urls` globs, then runs XPath `probes`; otherwise the `generic` plan is used when the page has 3+ controls.
2. `engine/plan.js` walks `fields[]`: resolve the profile value (`key`, `valueKey`, `value`, formatters like `start_date|MM/YYYY`), map it to vendor labels (`values`), wait for the element (`path`, with `%VALUE%` templating), and write with the chosen `method`. Array sections (`education`, `experience`) repeat per profile entry and can click an `add` button.
3. `engine/heuristics.js` then enumerates every remaining control, derives its label (label[for], aria-labelledby, aria-label, wrapping label, fieldset legend, nearest preceding text, placeholder, name/id tokens, `autocomplete`) and classifies it with ordered word-boundary keyword rules → profile key. Unknown questions fall back to the saved-answers table; consent/marketing checkboxes are never ticked.
4. `engine/writer.js` writes: native value setter + `keydown/keypress/input/keyup/change`, `<select>` option matching (exact → synonym → prefix → contains → token overlap), radio/checkbox groups, react-select style comboboxes (open, type, wait for `[role=option]`, pick), file inputs via `DataTransfer`. React-controlled inputs are written from the main world (`page.js`) by calling the component's `onChange`/`onInput` props with the native event, the same trick Simplify uses.
5. The shadow-DOM panel lists every field with `filled / skipped / not-found / unknown / error`.

## Option search (new in v2)

School, major, location and company fields are often not plain text boxes: they are typeaheads that fetch matches as you type (react-select, ARIA comboboxes, select2/iCIMS ajax dropdowns, Workday prompts) or very long `<select>` lists. v1 typed the profile value once and took the first plausible option. v2 runs a search loop instead:

1. **Plan queries** (`engine/search.js`, `queryPlan`): the profile value first, then deterministic variants. Schools drop "The", campus suffixes and the words University/College ("Texas A&M University" → "Texas A&M"). Locations swap state names and codes ("Austin, Texas" → "Austin, TX" → "Austin"). Companies drop legal suffixes. At most 5 queries, never a repeat, never a query of filler words only.
2. **Capture** (`engine/search-widgets.js`): type the query one character at a time, watch the widget's result list, and wait until it changed, stopped loading and held still. Then read up to 25 `{value, text}` candidates. "No results" rows, loading rows and "Add …"/"Create …" entries are ignored.
3. **Resolve** (`createResolver`): score every candidate against the profile value with a token scorer.
   - It knows state codes, degree families with qualifiers (BS ≠ BA), acronyms of 3 or more letters ("MIT"), "&" = "and", and parenthetical aliases ("(UCLA)").
   - Every distinct extra word costs 0.2, and "University of X" ≠ "X University".
   - An option is selected only if it clears the field's threshold (school 0.86, major 0.85, location 0.85, company 0.84) and no different option is within 0.05 of it.
   - Otherwise the next query runs. When the plan is exhausted the field is left alone (`return-empty`), so autobot never guesses.
   - Near misses like "Texas A&M University - Commerce" for "Texas A&M University" score below the bar on purpose.
4. **Commit**: click the single visible option whose text matches exactly, then confirm the widget really shows it (stable readback). If the user touches the widget mid-search (any trusted key, click or pointer event), the search stops (`trusted-invalidation`). On any failure the control is restored to what it held before.
5. **School fallback**: on a school field with nothing in the list resembling the school, autobot picks the exact "Other" entry and types the school into the field's own "please specify" box. It also requires an institution list (no degree or education-level entries) and that box to be unique after the choice. Otherwise it reverts.

Once search has seen real candidates, its decision is final: Stop, user input or a failed round never hands the field to the older first-plausible-option writer.

The panel shows each search, for example `Austin, Texas, United States (searched "Austin, Texas"→0, "Austin, TX"→1; combobox)`, or the failure reason with the best near miss. Both settings are on the options page: *Multi-round search* and the *"Other"* fallback.

Differences from Jobright, by design: Jobright sends each step to its server (`/swan/autofill/autofill-option-resolve/client-search-step`), where a model picks the next query and the option. autobot keeps the same step contract (`REQUEST_SEARCH` / `SELECT_OPTIONS` / `RETURN_EMPTY`, fresh round ids, ≤25 options, ≤5 searches, exact-text identity), but resolves it locally and deterministically. Nothing is sent anywhere, and there is no iCIMS `profileoptions` fetch or Oracle network interception.

## Config grammar (`configs/<ats>.json`)

```jsonc
{
  "id": "lever", "name": "Lever",
  "urls": ["*://jobs.lever.co/*/apply*"], "urlsExcluded": [],
  "probes": [["//form[@id='application-form'][.//input[@name='name']]"]],   // groups; all XPaths in a group must be true
  "container": ["//form[@id='application-form']"],                           // field XPaths are relative to this
  "defaultMethod": "default",                                                // default | react | jquery
  "pre": [{ "path": ["//a[@id='apply_button']"], "time": 800, "delay": 900 }], // clicks before filling (reveal the form)
  "fields": [
    { "key": "full_name", "path": [".//input[@name='name']"] },
    { "key": "resume", "method": "upload", "path": [".//input[@type='file' and @name='resume']"], "allowFailure": true },
    { "key": "work_auth_us", "values": "workAuth", "method": "radio", "path": ["..."], "allowFailure": true },
    { "key": "education", "array": true, "limit": 2, "add": ["..."], "item": ["..."],
      "fields": [{ "key": "school", "method": "combobox", "path": ["..."], "optionsPath": ["css:[role=option]"] },
                 { "key": "start_month|MM", "valueKey": "start_month|MM", "path": ["..."] }] },
    { "key": "any", "actions": [{ "path": "...", "method": "click", "time": 1000 }, { "delay": 300 }, { "path": "...%VALUE%...", "method": "click", "allowFailure": true }] }
  ],
  "continue": ["..."], "submit": ["..."], "success": ["..."]
}
```

Field keys: `key` (profile keyPath; `a.b[0].c|fmt`), `valueKey`, `value` (literal), `values` (name of a map in `AB.VALUE_MAPS` or an inline `{profileValue: [labels]}` map), `method` (`default`, `defaultWithoutBlur`, `react`, `jquery`, `click`, `select`, `radio`, `checkbox`, `combobox`, `upload`, `setValueOnly`, `clear`, `keypress`), `path` (XPath or `css:` selector, string or array), `time` (wait ms), `required` (default true: skip when the profile has no value), `allowFailure`, `condition` (XPath boolean), `optionsPath`, `actions[]` (sub-steps: `path`, `method`, `event`, `eventOptions`, `time`, `delay`, `removed`, `allowFailure`, `condition`), `array`/`limit`/`add`/`item`/`fields`.

Profile keys: see `engine/profile.js` (`PROFILE_DEFAULT`). Derived keys: `full_name`, `phone_digits`, `location`, `city_state`, `current_company`, `current_title`, `most_recent_school|degree|major|gpa`, `skills_text`, `start_date`/`end_date` (from sibling month/year). Formatters: `upper lower digits yesno M MM MMM MMMM YY YYYY MM/YYYY MM/DD/YYYY YYYY-MM YYYY-MM-DD "MMMM YYYY"`.

Overrides: the options page has a *Config overrides* JSON box, `{ "greenhouse": { "fields": [...] } }` replaces that key of the bundled config.

## Your profile as the default (git-ignored)

Two optional files hold a real profile and are ignored by git:

- `autobot/configs/profile.default.json` — bundled into the extension; when extension storage has no profile yet, Autobot seeds itself from this file on first use, so a fresh unpacked install is ready to fill immediately.
- `tests/profile.local.json` — used by `node tests/live.mjs` instead of the Ada Lovelace sample.

Create both from a Simplify export with `node tools/import-simplify-profile.mjs simplify-me.json` (the script header explains how to grab the JSON from simplify.jobs). It maps Simplify's numeric EEO and degree codes with Simplify's own value tables. Edit the result in the options page afterwards; saved answers are not part of the Simplify export.

## Using the engine from Playwright (no extension)

The fill engine is plain DOM JavaScript; the extension is one host for it. `tools/playwright-fill.mjs` is another:

```js
import { autobotFill } from "./tools/playwright-fill.mjs";
const result = await autobotFill(page, { profile, resume });   // page already on the application form
// result: { ats, matchedBy, filled, statuses: [[key, status, detail], ...] }
```

It injects `engine/*.js` and `page.js` with `page.evaluate` (not blocked by site CSP), passes the profile and configs in directly, and runs `AB.fill` in the page's main world. A browser-use agent can call it as a tool step and read back `statuses` to decide what still needs a human. Demo: `node tools/playwright-fill.mjs <job url> [--headed]`.

## Tests

```bash
npm install
npm test                                   # v1: 48 checks on Greenhouse-like, Lever-like and unknown-ATS fixtures (headless, Chrome for Testing)
npm run test:v2                            # v2: the same fixtures + the search-widget fixture (tests/fixtures/search.html)
npm run test:search                        # v2 search logic unit tests in Node (scorer, query plan, contract, resolver, driver)
npm run test:headed                        # same with a visible window + screenshot
node tests/live.mjs <job posting url>      # fills a real page in a throwaway browser, prints statuses, screenshots; never submits
```

`AUTOBOT_CHROME=/path/to/chrome` overrides the browser (branded Google Chrome ≥137 ignores `--load-extension`; use Chrome for Testing or Chromium).

## Live results (2026-10-18, throwaway browser, nothing submitted)

| ATS | Posting | Written | Left alone (correctly) |
|---|---|---|---|
| Greenhouse (job-boards) | Anthropic | first/last/email/phone, resume, phone-country react-select, custom react-select question via saved answer | reCAPTCHA, country search box |
| Lever | Palantir | resume, full name, email, phone, location typeahead, company, LinkedIn/GitHub/Portfolio, work-auth radio = Yes, sponsorship radio = No, university select, "how did you hear" select = LinkedIn | consent radios, Singapore residency radios, 33 language checkboxes, free-text essays, preferred name / pronunciation (no profile value) |
| Ashby | OpenAI | name, email, phone, resume, location combobox, work-auth checkbox = on, gender/ethnicity/veteran radios = decline | sponsorship checkbox stays unchecked (profile says no), office-days, arbitration + acknowledgement checkboxes, start date, free text |
| Workday | NVIDIA | detection only: the application form is behind sign-in; the job page has no fillable fields | everything |

## Troubleshooting ("it does nothing")

- **Hotkey does nothing.** Browsers only auto-bind an extension's suggested shortcut if nothing else holds it; Brave did not bind Alt+Shift+A on a profile where Simplify already owns Alt+Shift+F/S. Open `brave://extensions/shortcuts` (or `chrome://extensions/shortcuts`), find Autobot → *Autofill the current job application page*, and set a key. The toolbar popup's **Fill this page** button and the sidebar's **Autofill** button do not depend on the shortcut.
- **No sidebar, or only Simplify's/Jobright's sidebar.** All three pin a column to the right edge. Autobot now shifts left when another sidebar already reserves that space, but running three autofillers on one form is still a bad idea: disable Simplify and Jobright at `brave://extensions` while testing Autobot.
- **Popup says "Page not ready (reload the tab)".** The tab was opened before the extension was (re)loaded, so its content script is missing. Autobot tries to inject it on demand; if that fails (e.g. on an extension or browser-internal page), reload the tab.
- **Sidebar appears only on known ATSs.** On Greenhouse, Lever, Ashby and Workday the panel opens by itself; on any other form it appears after you press the hotkey or the popup's Fill button, then runs heuristics.
- **After editing code**, click the reload arrow on the extension card at `brave://extensions`, then reload the job page.

## Limits

- Deterministic by design: questions without a rule or saved answer are left blank and listed as `unknown`.
- Configs cover Greenhouse, Lever, Ashby, Workday (first pass) and a generic plan. Other ATSs run on heuristics only.
- Custom dropdown widgets vary; the search adapters cover native selects, select2/chosen/iCIMS-style ajax selects, ARIA comboboxes/react-select, `<datalist>` inputs and Workday prompts. Add `optionsPath` in a config for others (the search uses it as the option selector).
- The scorer is conservative. A main campus listed only with a suffix ("Texas A&M University - College Station") scores like any other campus, so it is left for you unless the plain name is also listed. Abbreviations that are not acronyms of the name ("UT Austin") are not expanded.
- Dates in profile are month/year only.
