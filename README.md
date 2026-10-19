# simplify_rea: reverse-engineering two autofill extensions into autobot

| Folder | What |
|---|---|
| `autobot/` | **The deliverable.** autobot 0.2.0, a deterministic, local-only job-application autofill extension. It combines both reverse-engineering passes: the config-driven fill engine from Simplify Copilot and Jobright, and Jobright's multi-round option search with a local resolver. See `autobot/README.md`. |
| `legacy/` | Frozen snapshots of the two earlier builds, `autobot-v1` and `autobot-v2`, kept for comparison. Not maintained. See `legacy/README.md`. |
| `docs/AUTOFILL-PROCESS.md` | How Simplify Copilot and Jobright autofill work, and what autobot keeps from each. |
| `docs/v2_REA_analysis.md` | The second REA pass: how Jobright's option search was found, analysed and rebuilt, how it was tested, and what was open. |
| `docs/SEARCH-REA.md` | How Jobright 1.24.1's option search works (REA evidence IDs, line references) and how autobot maps to it. The verified claim ledger is in `docs/SEARCH-REA-claims.md`. |
| `analysis/FINDINGS.md` | Static reverse-engineering notes for Simplify Copilot 3.1.9 (architecture, trigger path, config grammar, fill engine, AI path, auth). |
| `analysis/live/CAPTURE.md` | Live capture: Simplify's remote config vs bundled copy, runtime traffic, REA scenario evidence, and the REA status-0 bug repro (`repro-ext/`, draft issue not filed). |
| `analysis/pretty/`, `analysis/jobright/pretty/` | *Not in this repo.* Prettified bundles for both extensions; line references in the docs point here. Regenerate locally (see below). |
| `targets/` | *Not in this repo.* Pristine copies of both extensions (Simplify Copilot 3.1.9, Jobright Autofill 1.24.1) as installed from the Chrome Web Store. |
| `tests/` | Fixture pages, the headless end-to-end runner, the search unit tests, and live smoke tests for real postings and the popup path. |
| `tools/` | Icon generator, form dumper, Simplify profile importer, the Playwright host (`playwright-fill.mjs`), and `carve-parcel.mjs` (splits a prettified Parcel bundle into per-module files so REA can parse bundles that exhaust its heap). |

The third-party extension code is not redistributed here. To reproduce the analysis, copy the two extensions from a Chrome/Brave profile (`<profile>/Extensions/pbanhockgagggenencehbnadejlgchfc/3.1.9_0` and `.../odcnpipkhjegpefkfplmedhmkmmhmoko/1.24.1_0`) into `targets/`, then prettify with `npx prettier@3 --parser babel --print-width 120 <bundle> > analysis/pretty/<name>.js`. Large generated artifacts (REA JSON graphs, NetLog, the 31 MB live config) are also git-ignored; regenerate with `npx -y rea-agents@latest analyze-javascript-application targets/<ext> --json` and `curl https://sabre.simplify.jobs/?v=3.1.9`.

## Quick start

```bash
npm install
npm run test:all     # search-logic unit tests, then the browser fixture suite against autobot/
npm run pack         # dist/autobot-<version>.zip, without your profile file
```

Then load `autobot/` as an unpacked extension: `chrome://extensions` → Developer mode → Load unpacked.
