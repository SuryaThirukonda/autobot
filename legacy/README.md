# legacy/ — frozen earlier versions of autobot

These folders are snapshots of the two versions that were merged into the single extension at [`autobot/`](../autobot). They are kept for reference and comparison only. They are **not maintained**, and fixes land in `autobot/` only.

| Folder | What it is | Source |
|---|---|---|
| `autobot-v1/` | The first extension, from REA analysis of Simplify Copilot 3.1.9 and Jobright 1.24.1: config-driven ATS plans (Greenhouse, Lever, Ashby, Workday, generic), Simplify value maps, page-world React bridge, file-picker interception, Simplify-style sidebar, Simplify profile importer, instant-absent plan executor, Playwright host. | Commit `64139b8`, folder `autobot/` |
| `autobot-v2/` | v1 plus multi-round option search for school, major, location and company fields, rebuilt from Jobright's "client search" loop with a local deterministic resolver (`engine/search.js`, `engine/search-widgets.js`). Described in [`docs/v2_REA_analysis.md`](../docs/v2_REA_analysis.md). | Folder `v2/`, never committed before this snapshot |

The only edit made to either snapshot is the manifest `name` ("autobot legacy v1", "autobot legacy v2"), so a loaded copy can't be mistaken for the main extension. Neither snapshot contains a personal profile.

## Using a snapshot

- **Load it:** `chrome://extensions` (or `brave://extensions`) → Developer mode → Load unpacked → pick the folder. Remove it again before using the main extension: all three bind Alt+Shift+A and would fill the same fields.
- **Test it:** `node tests/run.mjs --ext=legacy/autobot-v1` or `--ext=legacy/autobot-v2`, and `node tests/search-unit.mjs --ext=legacy/autobot-v2`. The shared suites skip the blocks for features a snapshot lacks (option search in v1, per-ATS names and rerun checks in both). On 2026-10-18 both snapshots passed every check that applied to them. The test suite that matched v1 exactly is in commit `64139b8`.
