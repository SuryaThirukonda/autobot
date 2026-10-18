# simplify_rea — reverse-engineering two autofill extensions, and Autobot

| Folder | What |
|---|---|
| `autobot/` | **The deliverable.** A deterministic, local-only job-application autofill Chrome extension reconstructed from the analysis. See `autobot/README.md`. |
| `docs/AUTOFILL-PROCESS.md` | Consolidated write-up of how Simplify Copilot and Jobright autofill work and what Autobot keeps from each. |
| `analysis/FINDINGS.md` | Static reverse-engineering notes for Simplify Copilot 3.1.9 (architecture, trigger path, config grammar, fill engine, AI path, auth). |
| `analysis/live/CAPTURE.md` | Live capture: Simplify's remote config vs bundled copy, runtime traffic, REA scenario evidence, and the REA status-0 bug repro (`repro-ext/`, draft issue not filed). |
| `analysis/pretty/`, `analysis/jobright/pretty/` | *Not in this repo.* Prettified bundles for both extensions; line references in the docs point here. Regenerate locally (see below). |
| `targets/` | *Not in this repo.* Pristine copies of both extensions (Simplify Copilot 3.1.9, Jobright Autofill 1.24.1) as installed from the Chrome Web Store. |
| `tests/` | Fixture pages, the headless end-to-end runner, and a live smoke test. |
| `tools/` | Icon generator. |

The third-party extension code is not redistributed here. To reproduce the analysis, copy the two extensions from a Chrome/Brave profile (`<profile>/Extensions/pbanhockgagggenencehbnadejlgchfc/3.1.9_0` and `.../odcnpipkhjegpefkfplmedhmkmmhmoko/1.24.1_0`) into `targets/`, then prettify with `npx prettier@3 --parser babel --print-width 120 <bundle> > analysis/pretty/<name>.js`. Large generated artifacts (REA JSON graphs, NetLog, the 31 MB live config) are also git-ignored; regenerate with `npx -y rea-agents@latest analyze-javascript-application targets/<ext> --json` and `curl https://sabre.simplify.jobs/?v=3.1.9`.

## Quick start

```bash
npm install
npm test            # 48/48 fixture checks
# then load autobot/ as an unpacked extension (chrome://extensions → Developer mode → Load unpacked)
```
