# autobot

A deterministic job-application autofill extension (Manifest V3). No AI, no server, no telemetry. Your profile lives in `chrome.storage.local` and never leaves the browser.

autobot is a clean-room reconstruction built from two reverse-engineering passes:

- **Simplify Copilot and Jobright (first pass, `../docs/AUTOFILL-PROCESS.md`).** Config-driven field plans per ATS, Simplify's value maps, writing through the page's own React handlers, file uploads, Workday automation ids, the sidebar panel, and a heuristic fallback for forms no config covers.
- **Jobright's "client search" loop (second pass, `../docs/v2_REA_analysis.md`).** A multi-round option search for school, major, location and company fields, resolved locally by a deterministic scorer instead of Jobright's server.

Version 0.2.0 merges both into this folder. The two earlier builds are frozen in `../legacy/`.

## Install (unpacked)

1. `chrome://extensions` (or `brave://extensions`) → enable *Developer mode* → *Load unpacked* → pick this `autobot/` folder. Works in Chrome, Brave, Edge and Chrome for Testing.
2. The options page opens on install. Fill in your profile, upload a resume (stored locally as base64), add saved answers for recurring free-text questions, then *Save*. If `configs/profile.default.json` exists, the profile is already filled in from it (see below).
3. On a job application page press **Alt+Shift+A**, click the toolbar icon → *Fill this page*, or use the panel's *Autofill* button. Review every field. **autobot never clicks submit.**

**Coming from the separate `v2/` copy:** remove that unpacked copy at `chrome://extensions`. Both bind Alt+Shift+A and would fill the same form twice. Search aliases or other settings saved in the v2 copy don't carry over, so enter them again on this options page.

## How a fill runs

1. `engine/detect.js` loads `configs/*.json` (plus any overrides from settings), matches the URL against each config's `urls` globs, then runs XPath `probes`. Otherwise the `generic` plan is used when the page has 3 or more controls.
2. `engine/plan.js` walks `fields[]`: resolve the profile value (`key`, `valueKey`, `value`, formatters like `start_date|MM/YYYY`), map it to vendor labels (`values`), find the element (`path`, with `%VALUE%` templating), and write with the chosen `method`. Array sections (`education`, `experience`) repeat per profile entry and can click an `add` button. Fields missing from the page are reported at once instead of waited for.
3. `engine/heuristics.js` then enumerates every remaining control outside the config's `containerExcluded` regions (such as Ashby's "Autofill from resume" box, which hands a file to the ATS's resume parser), derives its label (label[for], aria-labelledby, aria-label, wrapping label, fieldset legend, nearest preceding text, placeholder, name/id tokens, `autocomplete`) and classifies it with ordered word-boundary keyword rules → profile key. Unknown questions fall back to the saved-answers table. Consent and marketing checkboxes are never ticked.
4. `engine/writer.js` writes. School, major, location and company dropdowns go through the option search first (next section). Everything else uses the native value setter plus `keydown/keypress/input/keyup/change`, `<select>` option matching (exact → synonym → prefix → contains → token overlap), radio and checkbox groups, react-select style comboboxes (open, type, wait for `[role=option]`, pick), and file inputs via `DataTransfer`. React-controlled inputs are written from the main world (`page.js`) by calling the component's `onChange`/`onInput` props with the native event, the same trick Simplify uses.
5. The shadow-DOM panel lists every field with `filled / skipped / not-found / unknown / error`.

## Option search

School, major, location and company fields are often not plain text boxes. They are typeaheads that fetch matches as you type (react-select, ARIA comboboxes, select2/iCIMS ajax dropdowns, Workday prompts) or very long `<select>` lists. Instead of taking the first plausible option, autobot runs a search loop:

1. **Values to try**, in order: your search alias for the value (options page), the name this ATS uses for your school or major (next section), then the profile value. Location fields also try "City, State" and "City, State, Country".
2. **Plan queries** (`engine/search.js`, `queryPlan`): each value first, then deterministic variants. Schools drop "The", campus suffixes and the words University/College ("Texas A&M University" → "Texas A&M"). Locations swap state names and codes ("Austin, Texas" → "Austin, TX" → "Austin"). Companies drop legal suffixes. At most 5 queries, never a repeat, never a query of filler words only.
3. **Capture** (`engine/search-widgets.js`): type the query one character at a time, watch the widget's result list, and wait until it changed, stopped loading and held still. Then read up to 25 `{value, text}` candidates. "No results" rows, loading rows and "Add …"/"Create …" entries are ignored. A menu that closes or empties after typing and stays that way for 2 seconds also counts as "no results", so the next query still runs.
4. **Resolve** (`createResolver`): score every candidate against the values with a token scorer.
   - It knows state codes, degree families with qualifiers (BS ≠ BA), acronyms of 3 or more letters ("MIT"), "&" = "and", and parenthetical aliases ("(UCLA)").
   - Every distinct extra word costs 0.2, and "University of X" ≠ "X University".
   - An option is selected only if it clears the field's threshold (school 0.86, major 0.85, location 0.85, company 0.84) and no different option is within 0.05 of it.
   - Otherwise the next query runs. When the plan is exhausted the field is left alone (`return-empty`), so autobot never guesses.
   - Near misses like "Texas A&M University - Commerce" for "Texas A&M University" score below the bar on purpose.
5. **Commit**: click the single visible option whose text matches exactly, then confirm the widget really shows it (stable readback). If you touch the widget mid-search (any trusted key, click or pointer event), the search stops (`trusted-invalidation`). On any failure the control is restored to what it held before.
6. **School fallback**: on a school field with nothing in the list resembling the school, autobot picks the exact "Other" entry and types your plain profile school into the field's own "please specify" box. It also requires an institution list (no degree or education-level entries) and that box to be unique after the choice. Otherwise it reverts.

Once search has seen real candidates, its decision is final. The same holds when you pressed Stop, touched the widget, or the list changed but never settled. The older first-plausible-option writer never gets a second guess, because it could pick a look-alike campus.

The panel shows each search, for example `Austin, Texas, United States (searched "Austin, Texas"→0, "Austin, TX"→1; combobox)`, or the failure reason with the best near miss. The options page has the switches: *Multi-round search*, the *"Other"* fallback, and *Search aliases*.

Differences from Jobright, by design: Jobright sends each step to its server (`/swan/autofill/autofill-option-resolve/client-search-step`), where a model picks the next query and the option. autobot keeps the same step contract (`REQUEST_SEARCH` / `SELECT_OPTIONS` / `RETURN_EMPTY`, fresh round ids, ≤25 options, ≤5 searches, exact-text identity), but resolves it locally and deterministically. Nothing is sent anywhere, and there is no iCIMS `profileoptions` fetch or Oracle network interception.

### Per-ATS school and major names

Greenhouse and Lever keep their own school lists, and their names don't always match yours. Greenhouse, for example, lists Texas A&M only with a campus, as "Texas A&M University - College Station". Simplify stores the exact name for each site, and the profile importer copies it onto your education entry:

```json
{ "school": "Texas A&M University", "school_greenhouse": "Texas A&M University - College Station", "school_lever": "…", "major_greenhouse": "…", "major_lever": "…" }
```

On a form detected as that ATS, the stored name is searched first, then your plain value. Everywhere else, and for the "Other" box, the plain `school` and `major` are used. You can add or edit these keys in the options page's education JSON. A search alias does the same for every site at once.

## Running a fill twice

Pressing Autofill again on a form you already filled is safe:

- A dropdown, prompt or pill that already shows the answer is left alone: no click, no typing, no new search. A Workday multi-select would otherwise toggle the choice off or add a second pill. The panel says `(already selected)`.
- A multi-select that already holds a different choice, maybe one you picked, keeps it (`kept the existing choice`).
- Plain text boxes are written again on purpose. When the browser restores a form, the visible text can be out of step with the page's React state, and writing again fixes that.

## Privacy

- The profile, resume and settings stay in `chrome.storage.local`. autobot has no server and sends nothing.
- Web pages can load only `page.js` and the five ATS configs from the extension (`web_accessible_resources`). `configs/profile.default.json` is not on that list, so a site cannot read it. The service worker reads it to seed storage.
- Test hooks (`window.postMessage` commands and the `data-autobot-*` result attributes) work only on `localhost`, `127.0.0.1`, `[::1]` and `file://` pages, and only with the *test hooks* setting on. A job site can neither start a fill through them nor read a result.
- Search traces and the per-run history are recorded only with *Debug logging* on.
- `npm run pack` builds `dist/autobot-<version>.zip` without `configs/profile.default.json`.

## Config grammar (`configs/<ats>.json`)

```jsonc
{
  "id": "lever", "name": "Lever",
  "urls": ["*://jobs.lever.co/*/apply*"], "urlsExcluded": [],
  "probes": [["//form[@id='application-form'][.//input[@name='name']]"]],   // groups; all XPaths in a group must be true
  "container": ["//form[@id='application-form']"],                           // field XPaths are relative to this
  "containerExcluded": ["//*[contains(@class, 'autofill-uploader')]"],       // regions inside it that are never written
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

- `autobot/configs/profile.default.json`: when extension storage has no profile, the service worker copies this file into storage on install, on browser start and before a fill, so a fresh unpacked install is ready to go. It never overwrites a profile you saved.
- `tests/profile.local.json`: used by `tests/live.mjs` and `tests/popup-path.mjs` instead of the Ada Lovelace sample.

Create both from a Simplify export with `node tools/import-simplify-profile.mjs simplify-me.json` (the script header explains how to grab the JSON from simplify.jobs). It maps Simplify's numeric EEO and degree codes with Simplify's own value tables and copies the per-ATS school and major names. Edit the result in the options page afterwards. Saved answers are not part of the Simplify export.

## Using the engine from Playwright (no extension)

The fill engine is plain DOM JavaScript, and the extension is one host for it. `tools/playwright-fill.mjs` is another:

```js
import { autobotFill } from "./tools/playwright-fill.mjs";
const result = await autobotFill(page, { profile, resume, settings });   // page already on the application form
// result: { ats, matchedBy, filled, statuses: [[key, status, detail], ...] }
```

It injects the engine files listed in `manifest.json`, including the option search, plus `page.js` with `page.evaluate` (not blocked by site CSP). Then it passes the profile and configs in directly and runs `AB.fill` in the page's main world. `settings` takes the same switches as the options page (`search`, `searchAliases`, `searchOtherFallback`, `heuristics`, `debug`). A browser-use agent can call it as a tool step and read back `statuses` to decide what still needs a human. Demo: `node tools/playwright-fill.mjs <job url> [--headed]`.

## Tests

```bash
npm install
npm test                                     # browser fixtures: Greenhouse, Lever, Ashby, generic, search widgets, Workday, reruns, campus names
npm run test:search                          # search logic unit tests in Node: scorer, query plans, contract, resolver, driver, per-ATS names
npm run test:all                             # both
npm run test:headed                          # fixtures in a visible window, with screenshots
node tests/live.mjs <job posting url>        # fills a real page in a throwaway browser, prints statuses, screenshots; never submits
node tests/popup-path.mjs <job posting url>  # popup → service worker → content script path, profile seeding, what pages can fetch
```

The browser tests load a temporary copy of the extension without `configs/profile.default.json`, so a personal profile never reaches a test browser. `--ext=legacy/autobot-v1` runs a suite against another folder. `AUTOBOT_CHROME=/path/to/chrome` overrides the browser. Branded Google Chrome 137 and later ignores `--load-extension`, so use Chrome for Testing or Chromium.

## Live results

0.2.0 on 2026-10-18: throwaway browser, `tests/profile.local.json` (a Simplify import), no search aliases, nothing submitted. The Ashby row is a re-run on 2026-10-19 after OpenAI's form changed, with `tests/profile.sample.json`: Ashby saves every field to its server while you fill (`ApiSetFormValue`), before any submit, so the fake profile is the safer choice there.

| ATS | Posting | Written | Left alone, or not reached |
|---|---|---|---|
| Greenhouse (job-boards) | Duolingo | first/last name, email, phone, resume, LinkedIn, website, GPA, and the school as "Texas A&M University - College Station" from the stored Greenhouse name (the v2 build left it empty) | free-text questions, name pronunciation. Degree, discipline and dates are not reached: the config paths miss this form's education fields (v1 and v2 too) |
| Greenhouse (job-boards) | Anthropic | first/last name, email, phone, resume, country | free-text and custom questions with no rule or saved answer |
| Lever | Palantir | resume, full name, email, phone, location typeahead, company, LinkedIn/GitHub/portfolio, work authorization = Yes, sponsorship = No, "how did you hear" = LinkedIn | the school: Lever lists Texas A&M only with campus suffixes and the profile has no Lever name, so search returns empty instead of guessing. Consent and residency radios, essays |
| Ashby | OpenAI | legal name, email, phone, the resume in the form's own Resume field (uploaded first, then 2.5 s for Ashby's save to land), location typeahead "Austin, Texas, United States", work authorization = Yes, gender/race/veteran | the "Autofill from resume" box (excluded, so Ashby's parser never runs), preferred name, start date, sponsorship (profile says No: the hidden checkbox stays unticked, which leaves Ashby's Yes/No buttons unanswered), office days, additional information, arbitration and certification checkboxes |
| Workday | NVIDIA | earlier pass: detection only, the application form is behind sign-in | everything |

## Troubleshooting ("it does nothing")

- **Hotkey does nothing.** Browsers only auto-bind an extension's suggested shortcut if nothing else holds it. Brave did not bind Alt+Shift+A on a profile where Simplify already owns Alt+Shift+F/S. Open `brave://extensions/shortcuts` (or `chrome://extensions/shortcuts`), find autobot → *Autofill the current application page*, and set a key. The toolbar popup's **Fill this page** button and the sidebar's **Autofill** button do not depend on the shortcut.
- **No sidebar, or only Simplify's or Jobright's sidebar.** All three pin a column to the right edge. autobot shifts left when another sidebar already reserves that space, but running three autofillers on one form is still a bad idea: disable Simplify and Jobright at `brave://extensions` while testing autobot.
- **Popup says "Page not ready (reload the tab)".** The tab was opened before the extension was (re)loaded, so its content script is missing. autobot tries to inject it on demand. If that fails, for example on an extension or browser-internal page, reload the tab.
- **Sidebar appears only on known ATSs.** On Greenhouse, Lever, Ashby and Workday the panel opens by itself. On any other form it appears after you press the hotkey or the popup's Fill button, then runs heuristics.
- **After editing code**, click the reload arrow on the extension card at `brave://extensions`, then reload the job page.

## Limits

- Deterministic by design: questions without a rule or saved answer are left blank and listed as `unknown`.
- Configs cover Greenhouse, Lever, Ashby, Workday (first pass) and a generic plan. Other ATSs run on heuristics only.
- Custom dropdown widgets vary. The search adapters cover native selects, select2/chosen/iCIMS-style ajax selects, ARIA comboboxes/react-select, `<datalist>` inputs and Workday prompts. Add `optionsPath` in a config for others; the search uses it as the option selector.
- The scorer is conservative. A school listed only with a campus suffix ("Texas A&M University - College Station") scores like any other campus. It is left for you unless the plain name is also listed, your profile has that ATS's name, or you add a search alias. Abbreviations that are not acronyms of the name ("UT Austin") are not expanded.
- Dates in the profile are month/year only.
