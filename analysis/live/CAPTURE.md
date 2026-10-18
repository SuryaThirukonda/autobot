# Live capture: Simplify 3.1.9 remote config + runtime traffic

Date: 2026-10-18. Companion to `../FINDINGS.md` (static analysis).

## What was captured and how

| Artifact | How obtained | Notes |
|---|---|---|
| `sabre-live.json` (31.8 MB) + `headers.txt` | Direct GET of `https://sabre.simplify.jobs/?v=3.1.9`, the URL background.js fetches | `last-modified: Fri, 16 Oct 2026 21:33:37 GMT`, `etag W/"e66ba1f4…"`, `cache-control: public, max-age=10800`, Cloudflare, CORS `*` |
| `config-diff.json` | Structural diff vs bundled `remoteConfig.json` | see below |
| `rea-scenario-greenhouse.json` | **REA `capture-browser-scenario`, connect mode**, against an owned Chrome for Testing 151 instance with the extension loaded unpacked | console / page-error / frame / worker events, final URL, screenshot, hashed storage |
| `rea-final-screenshot.png` | REA end-of-scenario artifact | shows Simplify panel rendered on the Greenhouse posting |
| `sw-network.jsonl` | My CDP logger attached to the extension's background service worker (REA only attaches to page targets) | credential headers redacted at capture |
| `page-network.jsonl` | Same logger attached to the Greenhouse page target | |
| `netlog.json` → `netlog-requests.json`, `live-simplify-calls.txt` | Chrome `--log-net-log` (Default capture mode: no cookies/credentials) for the whole browser lifetime | the only source that covers install-time traffic before loggers attached |

The owned browser used a throwaway profile and was **not signed in**. No cookies or tokens were copied from your Brave profile, so all authenticated endpoints returned 401. Nothing was changed in Brave.

## Live vs bundled remote config

Same shape: 36 top-level keys, 56 ATS entries, no vendors added or removed, no new fill `method` names. Changes:

- `savedAnswersEnabled`: `false` → **`true`** (the only flag flip).
- `conditionalTrackedInputExclusions`: 419 → 420 entries.
- `ATS`: 22 of 56 vendors changed. Largest growth is **Greenhouse** (5.9 MB → 12.9 MB): `containerPath` 14→15, `pathsExcluded` 1→3, `submittedSuccessPaths` 6→7, `trackedInputSelectors` 9→11, new key `staleInvalidFlags`, `inputSelectors` same count (60) but rewritten. Then ICIMS (+0.8 MB, `inputSelectors` 35→39, `urls` 14→16), Avature, SmartRecruiters, Lever, Workday, OracleCloud (`continueButtonPaths` 1→2, `submitButtonPaths` 2→3), Rippling, PhenomPeople, AshbyHQ, Workable, JazzHR, SuccessFactors, Google (`submitButtonPaths` 4→6), Jobvite, FreshTeam, Waymo, Dover, Recruitee, BambooHR, BreezyHR, PinpointHQ.
- One new profile keyPath: `most_recent_graduation_mmyyyy`.
- Flags unchanged: `fullAIAutofillEnabled=true`, `copilotAnswerUnifiedEnabled=true`, `bestEffortAnswersEnabled=true`, `optionsCatalogPrefetchEnabled=false`, `profileCorrectionPromptEnabled=false`.

Takeaway: the bundled file is a two-day-stale fallback; the live file is the real selector database and is re-fetched at most every 30 min in memory (`Zl` cache) and persisted in `chrome.storage.local` under key `[["key","remoteConfigValues"]]` with an `expireAt`.

## Runtime traffic observed (unauthenticated)

From `live-simplify-calls.txt` (NetLog, times relative to browser start):

1. **Install**: extension opens `assets/tutorial/tutorial.html`. The tutorial is a fake application form the extension autofills as a demo; storage afterwards held `foundInputStatus` rows for `first_name`, `last_name`, `email`, `phone_stripped`, `linkedin`, `eligible_for_attribution`, and a tracked input `"Why are you a good fit for Simplify"`.
2. `GET https://sabre.simplify.jobs/?v=3.1.9` → 200, gzip, **958,711 bytes on the wire** (31.8 MB inflated), same etag/last-modified as the direct fetch. Two later requests to the same URL show no response in NetLog (coalesced/cached).
3. `GET https://storage.googleapis.com/simplify-public-assets/tutorial-resume/1704468484.pdf` → 200 (demo resume for the tutorial; parsed by the bundled pdf.js worker).
4. `GET /v2/candidate/me/` → 401 (auth probe, repeated on each page the content script loads).
5. `GET /v2/candidate/me/resume/paginate?size=25&first_page_load_default_resume=true` → 401; `GET /v2/candidate/me/resume/<uuid>` → 401.
6. `POST /v2/keywords/jd-to-keywords` → 401 ×4 (resume-score keyword extraction attempted for the tutorial JD and the Greenhouse JD).
7. On the Greenhouse posting, the page target loaded `contentScriptMain.js`, `pageScript.js`, `content.css`, Inter font and the "Village" avatar images from the extension's dynamic `chrome-extension://<guid>/` origin. The panel rendered with job title, company, pay range and "Confirmed live in the last 24 hours", which means job-info extraction (`trackedObjExtractors` → `greenhouse:anthropic/jobs/5183044008`) ran locally without auth.
8. Content script fetched `https://boards.greenhouse.io/uncacheable_attributes/presigned_fields?fields[]=resume` — this is Greenhouse's own page code, not Simplify.
9. **Not observed**: `boar.simplify.jobs/capture/` analytics, Axiom, Village API, LinkedIn Voyager. The panel showed the "Before you autofill" consent card (Accept / Essentials only) and no consent was given, which matches the `requirePrivacyAgreement` gate in the content bundle.
10. `triggerFill` sent through the worker returned `false` (no `fill` function in the store while signed out), consistent with the static trace.

## REA notes

- REA's scenario tool crashed on first run: a Playwright response with `status: 0` (the extension's `chrome-extension://` resources loading into the page) fails REA's event schema (`status >= 100`). Rerun without the `network` event family succeeded; network came from the CDP logger + NetLog instead. Worth reporting upstream.
- REA connect mode can only attach to **page** targets, so extension service-worker traffic needs a separate CDP session or NetLog.
- Branded Google Chrome 155 silently ignored `--load-extension`; Chrome for Testing 151 (Playwright's build) loads it. Unpacked load also requires removing the store's `_metadata/` folder.

## What an authenticated capture would add

Signing in inside the owned profile (your action, not mine) would expose: the normalized profile payload (`/v2/candidate/me/*`), `/v2/candidate/me/copilot/answer/batch` request/response bodies for tracked questions, `/v2/candidate/me/copilot/tracked-inputs/v3` and `/report`, tracker writes (`/tracker/job-posting/applied`), and the analytics stream after consent.
