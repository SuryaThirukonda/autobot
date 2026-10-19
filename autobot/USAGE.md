# Using autobot

autobot fills in job applications for you from a profile you keep in your browser. It types your details, attaches your resume and picks dropdown answers. Then you review the form and submit it yourself. **autobot never clicks submit.**

It has built-in plans for Greenhouse, Lever, Ashby and Workday. On any other application form it makes a best-effort pass by reading each field's label.

How autobot works inside, and how to run its tests, is in [README.md](README.md).

## 1. Install

You need Chrome, Brave, Edge or another Chromium-based browser.

1. Get the extension folder. Either clone the repository with `git clone https://github.com/SuryaThirukonda/autobot.git`, or unzip a zip made with `npm run pack`.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the `autobot` folder, the one that contains `manifest.json`.
5. Optional: pin autobot from the extensions menu so its icon stays in the toolbar.

If an older copy is loaded, such as one from `legacy/` or a separate `v2` folder, remove it. Every copy uses the same shortcut, and two copies would fill the same form twice.

## 2. Set up your profile

The settings page opens by itself after you install. To open it later, click the autobot icon and choose **Profile & settings**, or click ⚙ in the autobot panel.

Fill in what you want autobot to type, and leave the rest blank. Blank fields are skipped, never guessed.

- **Identity, Links, Work authorization & voluntary disclosures:** your name, email, phone, address, LinkedIn, GitHub and website, your work authorization and sponsorship answers, and the optional demographic answers.
- **Resume:** choose a PDF, DOC, DOCX or TXT file. It is stored in the browser and attached wherever a form asks for a resume.
- **Education & experience:** two lists written as JSON, newest entry first. See the examples below.
- **Saved answers:** a question and your answer, for questions that come up again and again, such as "Why do you want to work here?". A form question uses a saved answer when, ignoring case and punctuation, one question contains the other.
- **Settings:** see [section 7](#7-settings).

Click **Save** when you are done.

An education list with one entry:

```json
[
  { "school": "Texas A&M University", "degree": "Bachelor's", "major": "Computer Science", "gpa": "3.9",
    "start_month": "8", "start_year": "2024", "end_month": "5", "end_year": "2028", "graduated": false }
]
```

An experience list with one entry:

```json
[
  { "company": "Babbage & Co", "title": "Software Engineer", "location": "Austin, TX",
    "start_month": "6", "start_year": "2025", "current": true, "description": "Built things." }
]
```

Months are numbers from 1 to 12 and years have four digits. autobot formats each date the way the form asks for it.

### Bring your profile over from Simplify

If you use Simplify, you can copy your Simplify profile instead of typing it in:

1. Sign in at simplify.jobs and open your profile page.
2. Open the browser's developer tools, go to **Network**, and reload the page.
3. Find the request to `/v2/candidate/me/`, right-click it, choose **Copy**, then **Copy response**, and paste it into a file such as `simplify-me.json`.
4. In the repository folder, run:

   ```bash
   node tools/import-simplify-profile.mjs simplify-me.json
   ```

   This writes `autobot/configs/profile.default.json`, plus a copy for the live tests. Git ignores both files, so your profile is never committed.
5. Reload autobot at `chrome://extensions`. When autobot has no profile yet, it loads this file by itself. It never overwrites a profile you already saved. To replace a saved profile with the imported one, use **Import profile JSON** on the settings page and pick `autobot/configs/profile.default.json`.

The import also keeps the school and major names Simplify stored for Greenhouse and Lever (see [section 5](#5-schools-majors-and-other-dropdowns)). Saved answers are not part of a Simplify export.

### Back up your profile

**Export profile JSON** saves your profile and settings to a file, and **Import profile JSON** loads one back. The export does not include your resume, so keep the resume file too.

Export before you remove autobot or load it from a different folder. The browser gives each unpacked folder its own storage, so a copy loaded from a new folder starts empty.

## 3. Fill an application

1. Open the application form itself. On many sites that means clicking **Apply** first.
2. On Greenhouse, Lever, Ashby and Workday forms, the autobot panel opens on the right and says the application was detected. On other sites the panel appears once you start a fill.
3. Start the fill in one of three ways:
   - press **Alt+Shift+A**;
   - click the autobot icon, then **Fill this page**;
   - click **Autofill this page** in the panel.
4. Wait for the panel to finish. Every field it handled gets a colored dot.
5. Go through the whole form. Fix anything that is wrong and answer what is left, then submit the form yourself.

Some sites, like Ashby and Workday, load the form after the page itself. Wait until the form is visible before you start: a field that is not on the page yet is reported as missing, not waited for.

**Stop**, in the panel or the popup, ends a fill that is running. Fields that were already written stay written.

### Reading the panel

| Dot | Panel label | What it means | What to do |
|---|---|---|---|
| Green | Filled | autobot wrote the field. | Check it. |
| Amber | Needs you | A question with no rule and no saved answer, or a dropdown where no option matched closely enough. | Answer it yourself. For a question that keeps coming up, add a saved answer. |
| Grey | Skipped | Nothing to write: your profile has no value for it, or this form has no such field. | Add the value to your profile if you want it filled next time. |
| Red | Errors | The field was not found, or the value did not stick. | Fill it in by hand. |

The panel has three tabs:

- **Autofill:** the fill button, **Next page**, **Stop**, your resume, and the first results.
- **Fields:** every field with its result. Filter by Filled, Needs you, Skipped or Errors.
- **Profile:** a summary of your profile and a link to edit it.

Click **›** at the top of the panel to tuck it away. A small **autobot** button stays on the page; click it to bring the panel back.

## 4. Multi-page applications (Workday)

Workday applications take several pages and need a Workday account, so sign in first. Then, on each page:

1. Fill the page.
2. Check it.
3. Click the form's **Save and Continue**, or the panel's **Next page**, and fill the next page.

To let autobot move through the pages itself, tick **Continue through multi-page forms (never submits)** in the toolbar popup before you fill. autobot then fills a page, clicks the form's continue button and fills the next page, for up to six more pages. It stops at the page with the Submit button, so the last check and the submit stay with you.

## 5. Schools, majors and other dropdowns

School, major, degree, location and company questions are often searchable dropdowns. autobot types your answer, reads the options the site offers, and picks one only when it clearly matches. If nothing is close enough, it leaves the question for you instead of guessing. For example, it never picks "Texas A&M University - Commerce" for "Texas A&M University".

When a site's list uses a different name than your profile, you can tell autobot the site's name in two ways:

- **Per-site names.** Add `school_greenhouse`, `school_lever`, `major_greenhouse` or `major_lever` to an education entry. autobot tries that name first on that site, and your plain `school` or `major` everywhere else. The Simplify import adds these for you.

  ```json
  { "school": "Texas A&M University", "school_greenhouse": "Texas A&M University - College Station" }
  ```

- **Search aliases.** In Settings, map your value to the name a list uses. An alias applies on every site.

  ```json
  { "Texas A&M University": "Texas A&M University - College Station" }
  ```

If your school is not in a list at all, autobot picks the list's **Other** entry and types your school into the "please specify" box next to it. You can turn this off in Settings.

## 6. Filling the same form again

You can press Autofill again at any time, for example after you fix something in your profile:

- A dropdown or selection that already shows the right answer is left alone. autobot does not reopen it, so a multi-select never loses or duplicates a choice.
- A multi-select that holds a different choice, maybe one you picked, keeps it.
- On Ashby, a Yes/No question that already has an answer keeps it.
- Text boxes are written again. This keeps the site's own copy of each value in step with what you see.

## 7. Settings

| Setting | Default | What it does |
|---|---|---|
| Show panel on detected ATS pages | On | Opens the panel by itself on Greenhouse, Lever, Ashby and Workday forms. |
| Fill automatically when a known ATS is detected | Off | Starts a fill as soon as one of those forms is detected. |
| Use heuristic matching for fields no config covers | On | Fills fields by reading their labels, on any form. |
| Multi-round search | On | Searches dropdowns as described in [section 5](#5-schools-majors-and-other-dropdowns). |
| "Other" fallback | On | Picks "Other" and types your school when the list does not have it. |
| Search aliases | Empty | Your value mapped to the exact text a site's list uses. |
| Debug logging | Off | Writes the details of each fill to the browser's developer console. |
| Enable test hooks | Off | Only for the automated tests. Leave it off. |
| Config overrides | Empty | For advanced use: replaces parts of the built-in site plans. |

Click **Save** after you change a setting.

## 8. Privacy

- Your profile, resume and settings stay in this browser's extension storage. autobot has no server and sends nothing anywhere.
- autobot never submits an application.
- What autobot types goes into the site's form just like your own typing, and some sites save it before you submit. Ashby saves each field to its server as it changes. Only fill in applications you mean to send, and keep **Fill automatically** off unless you want every detected form filled.
- Websites cannot read your profile or resume from the extension.

## 9. Updating

1. Get the new version: run `git pull` in the repository, or unzip a newer zip over the same folder.
2. At `chrome://extensions`, click the reload arrow on the autobot card.
3. Reload any job pages you have open.

Your profile stays, because the folder is the same.

## 10. Troubleshooting

- **The shortcut does nothing.** A browser only assigns Alt+Shift+A when no other extension holds it. Set a shortcut at `chrome://extensions/shortcuts` (Brave: `brave://extensions/shortcuts`) under autobot's "Autofill the current application page". The toolbar and panel buttons work without a shortcut.
- **The popup says "Page not ready (reload the tab)".** The tab was open before autobot was installed or reloaded. Reload the tab.
- **No panel appears.** The panel opens by itself only on Greenhouse, Lever, Ashby and Workday forms, and only with **Show panel on detected ATS pages** on. Elsewhere, press the shortcut or use the toolbar button.
- **The panel says your profile is empty.** Fill in the settings page and click **Save**, or import a profile.
- **Nothing was filled on Ashby or Workday.** The form was probably still loading. Wait until it is visible and press Autofill again.
- **Another autofill extension is open too.** Simplify and Jobright also put a sidebar on the right. autobot moves aside for them, but several autofillers on one form get in each other's way, so turn the others off while you use autobot.
- **A field came out wrong.** Correct it by hand. For a dropdown that picks the wrong option or none, add a search alias or a per-site name ([section 5](#5-schools-majors-and-other-dropdowns)). For a question, add a saved answer.

## 11. Removing autobot

Click **Remove** on the autobot card at `chrome://extensions`. This also deletes the profile and settings stored in the browser, so export them first if you want to keep them.
