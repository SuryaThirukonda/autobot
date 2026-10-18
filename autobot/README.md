# Autobot

A deterministic job-application autofill extension (Manifest V3). No AI, no server, no telemetry. Your profile lives in `chrome.storage.local` and never leaves the browser.

It is a clean-room reconstruction of the autofill pipeline used by Simplify Copilot and Jobright (see `../docs/AUTOFILL-PROCESS.md`): config-driven field plans per ATS, framework-aware value writing, and a heuristic fallback for forms no config covers.

## Install (unpacked)

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick this `autobot/` folder. Works in Chrome, Brave, Edge, Chrome for Testing.
2. The options page opens on install. Fill in your profile, upload a resume (stored locally as base64), add saved answers for recurring free-text questions, *Save*.
3. On a job application page press **Alt+Shift+A**, click the toolbar icon → *Fill this page*, or use the panel's *Fill* button. Review every field. **Autobot never clicks submit.**

## How a fill runs

1. `engine/detect.js` loads `configs/*.json` (plus any overrides from settings), matches the URL against each config's `urls` globs, then runs XPath `probes`; otherwise the `generic` plan is used when the page has 3+ controls.
2. `engine/plan.js` walks `fields[]`: resolve the profile value (`key`, `valueKey`, `value`, formatters like `start_date|MM/YYYY`), map it to vendor labels (`values`), wait for the element (`path`, with `%VALUE%` templating), and write with the chosen `method`. Array sections (`education`, `experience`) repeat per profile entry and can click an `add` button.
3. `engine/heuristics.js` then enumerates every remaining control, derives its label (label[for], aria-labelledby, aria-label, wrapping label, fieldset legend, nearest preceding text, placeholder, name/id tokens, `autocomplete`) and classifies it with ordered word-boundary keyword rules → profile key. Unknown questions fall back to the saved-answers table; consent/marketing checkboxes are never ticked.
4. `engine/writer.js` writes: native value setter + `keydown/keypress/input/keyup/change`, `<select>` option matching (exact → synonym → prefix → contains → token overlap), radio/checkbox groups, react-select style comboboxes (open, type, wait for `[role=option]`, pick), file inputs via `DataTransfer`. React-controlled inputs are written from the main world (`page.js`) by calling the component's `onChange`/`onInput` props with the native event, the same trick Simplify uses.
5. The shadow-DOM panel lists every field with `filled / skipped / not-found / unknown / error`.

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

## Tests

```bash
npm install
npm test                                   # 48 checks on Greenhouse-like, Lever-like and unknown-ATS fixtures (headless, Chrome for Testing)
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
- Custom dropdown widgets vary; `combobox` handles react-select/ARIA listboxes. Add `optionsPath` for others.
- Dates in profile are month/year only.
