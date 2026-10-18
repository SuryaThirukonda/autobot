[Bug] capture_browser_scenario aborts with an uncaught ZodError when an extension's `use_dynamic_url` resource produces a status-0 response

<!-- body below -->

### Before submitting

- [x] I searched the open and closed issues for a related report.
- [x] I removed credentials, tokens, private paths, and sensitive target data.

### Area

Process capture or runtime observation

### Observed behavior

`rea capture-browser-scenario` (connect mode, `capture.events: ["network"]`) terminates the whole CLI process with an uncaught `ZodError` as soon as the attached browser has an extension whose `web_accessible_resources` entry sets `"use_dynamic_url": true` and a page (or the extension's own service worker) loads one of those resources. No Evidence is written: stdout is empty and the exit code is 1.

```
ZodError: [
  {
    "origin": "number",
    "code": "too_small",
    "minimum": 100,
    "inclusive": true,
    "path": ["status"],
    "message": "Too small: expected number to be >=100"
  }
]
    at PlaywrightScenarioEvents.push (rea-agents/dist/cli-runtime/composition__browserScenario-BtPb1c1y.js:2043:47)
    at Object.emit (composition__browserScenario-BtPb1c1y.js:1935:29)
    at PlaywrightScenarioNetwork.response (composition__browserScenario-BtPb1c1y.js:1605:36)
    at BrowserContext.onResponse (composition__browserScenario-BtPb1c1y.js:1956:50)
    at BrowserContext._callHandler (playwright-core/lib/client/eventEmitter.js:66:29)
    ...
```

Mechanism, from a CDP trace taken alongside the failing run (observed, not inferred):

- Chrome serves `chrome-extension://<GUID>/<path>` (the dynamic alias) by an **internal redirect** to `chrome-extension://<extension-id>/<path>`. CDP emits `Network.requestWillBeSent` for the real URL with `redirectResponse.status === 0`, then a normal `responseReceived` with status 200 for the real URL.
- Playwright's `CRNetworkManager._handleRequestRedirect` builds a `Response` from that `redirectResponse` payload, so `BrowserContext` emits a `response` event whose `response.status()` is `0`.
- REA's `PlaywrightScenarioNetwork.response` forwards `status: response.status()` into the `response` event variant, whose schema is `z.number().int().min(100).max(599)` (`dist/domain/browserScenarioCaptureValues.js`). The validation throws inside the Playwright event handler and nothing catches it, so the process exits instead of producing Evidence with a limitation.

A Playwright script using `chromium.connectOverCDP` + `context.on("response")` against the same browser records 23 responses with status 0 in one page load, all `chrome-extension://<GUID>/...` URLs, originating both from the page (scripts, CSS, fonts, images) and from the extension service worker (`request.serviceWorker()` set).

### Reproduction

Reproduced 2/2 with the 3-file extension below, and 3/3 with a production extension (Simplify Copilot 3.1.9, which uses `use_dynamic_url: true`). Removing `"network"` from `capture.events` avoids the crash; removing `use_dynamic_url` also avoids it (the same extension then yields status-200 responses and `request` / `request-finished` events only).

`repro-ext/manifest.json`
```json
{
  "manifest_version": 3,
  "name": "status0-repro",
  "version": "1.0",
  "content_scripts": [{ "matches": ["*://*/*"], "js": ["content.js"], "run_at": "document_end" }],
  "web_accessible_resources": [{ "resources": ["injected.js"], "matches": ["*://*/*"], "use_dynamic_url": true }]
}
```
`repro-ext/content.js`
```js
const s = document.createElement("script");
s.src = chrome.runtime.getURL("injected.js");
document.documentElement.appendChild(s);
```
`repro-ext/injected.js`
```js
console.log("status0-repro injected");
```

1. Launch an unbranded Chromium with the extension and a loopback CDP port (branded Google Chrome ≥137 ignores `--load-extension`):
   ```bash
   chrome --user-data-dir=/tmp/repro-profile --no-first-run \
     --disable-extensions-except=$PWD/repro-ext --load-extension=$PWD/repro-ext \
     --remote-debugging-port=9334 --remote-allow-origins=http://127.0.0.1:9334 https://example.com/
   ```
2. Take the page `target_id` from `rea list-browser-targets http://127.0.0.1:9334`.
3. Run:
   ```bash
   npx -y rea-agents@6.7.0 capture-browser-scenario '{
     "browser": { "mode": "connect", "cdp_endpoint": "http://127.0.0.1:9334", "target_id": "<id>" },
     "start_url": { "url": "https://example.com/", "query": [] },
     "actions": [ { "step_id": "settle", "action": "wait_for_timeout", "duration_ms": 3000 } ],
     "capture": { "at_end": ["url"], "events": ["network"] } }' --format json
   ```
4. Observe the ZodError above, exit code 1, empty stdout.

Environment: rea-agents 6.7.0 (npx), playwright-core 1.58.2, Chrome for Testing 151.0.7922.34 (Playwright `chromium-1234` build), Node.js 24.20.0, Ubuntu 26.04 x86-64. Launch mode not tested (it cannot load an extension); whether the same status-0 redirect responses occur for other internal redirects (e.g. `chrome://` or `blob:` → extension) is NOT_ENOUGH_INFO.

### Expected behavior

A single out-of-range status should not abort the capture. Either of these matches the documented contract that scenario network records are evidence with explicit limitations rather than a hard failure:

- Accept `status: 0` on the `response` variant (or widen the range to `0..599`) and tag the record, e.g. `limitations: ["status 0 reported by Playwright for an internal redirect"]`, or
- Map a non-HTTP status to the existing `request-unfinished` / a new `response-unavailable` shape, and keep the real 200 response that follows for the redirected URL.

In all cases the error should be caught at the event boundary and surfaced in `limitations` / `completeness` instead of propagating out of the Playwright event handler and killing the process.

### Impact and scope

Any connect-mode scenario against a browser that has an extension using `use_dynamic_url` (a common MV3 pattern) fails completely when `network` events are requested; the operator gets no Evidence, not even for the steps that completed. Workarounds: drop `"network"` from `capture.events` (loses REA's network evidence for the run), or disable the extension (not possible when the extension is the analysis target). Launch mode is unaffected only because it cannot load extensions. Other event families (`console`, `frames`, `workers`, `page-errors`) completed normally on the same page.
