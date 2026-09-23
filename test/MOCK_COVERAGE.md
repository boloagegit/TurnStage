# Deterministic mock verification

This matrix describes supported TurnStage behavior, not an organization's
private services. A green unit test, browser harness, and Extension Host run
are different kinds of evidence; none is a substitute for a live deployment.

| Product journey | Automated evidence |
| --- | --- |
| Install a packaged VSIX, activate it, discover Profiles and commands, run linked general and red-team cases, inspect history/reports, handle Workspace Trust, and edit/undo linked sources | `TURNSTAGE_TEST_VSIX=auto node test/integration/runTest.mjs` installs the current VSIX into a fresh extensions directory and runs the Extension Host suite in trusted and Restricted workspaces. The suite asserts the loaded product path is the isolated VSIX extraction. VS Code's test runner loads that extracted product in development-test mode; it does not exercise the Marketplace installation UI. |
| Run the development extension against the same deterministic service | `npm run test:integration` runs the same trusted and Restricted Extension Host suite plus CLI mock cases. |
| Parse SSE/NDJSON, map events, render opening/streamed responses, handle cancellation, errors, timeout, replay, stop, and bounded buffers | `npm test -- --run --maxWorkers=1` includes transport, parser, mapping, session, request, runtime, control, error, and security tests; `npm run test:sse` independently exercises real local HTTP/SSE. |
| Manage Web Profiles, search/filter, folders, read-only defaults, local copies, JSONC edit/validation, and browser persistence | `node test/visual/webLibrary.visual.mjs` and `node test/visual/webJsoncVisual.visual.mjs`; corresponding `test/web*.test.ts` and `test/profile*.test.ts` cover state and validation. |
| Connect Web A `/api` through a relay to HTTPS B, display opening and streamed chat, import JSONC/CSV, run general and red-team cases | `node test/visual/webAbServices.visual.mjs` uses a real browser, `serve.py`, a test-only relay, and self-signed HTTPS B. It separately asserts direct browser TLS rejection and same-origin API requests. |
| Import many cases, run selected cases, export/reimport suites | `node test/visual/webCaseScale.visual.mjs` imports 1,000 general cases, executes selected cases, and checks export/reimport and browser-local state. This is not a 1,000-concurrent-run soak test. |
| Render Markdown, HTML, CSS class rules, images and tables while blocking unsafe content | `node test/visual/richContent.visual.mjs` checks Web in a real browser and the shared VSIX Webview bundle in a browser harness, including responsive/theme behavior and CORS/TLS boundaries. |
| Navigate debug, general, red-team, settings, result and evidence views; keyboard, themes, zoom, locale, and dropdown layout | `npm run test:visual` and `node test/visual/interfacePolish.visual.mjs` exercise the current shared Webview/Browser UI in Chromium and save screenshots under `artifacts/visual-regression` and `artifacts/interface-polish`. These are browser harness screenshots, not native VS Code window screenshots. |
| Open complete offline HTML reports, search/filter/page cases, expand evidence, read charts and mobile layout | `node test/visual/testReport.visual.mjs` generates 100-case general and red-team reports and opens them from `file://` in Chromium. |
| Serve the Web archive and generate default-Profile catalog folders | `python3 -B -m unittest discover -s test -p 'test_*.py'` covers `serve.py` and `update_profiles.py`. |

The current CI runs the mock suites on Linux, macOS and Windows where
applicable; its browser-visual job uses Chromium on Linux. The standalone
`profileWorkspace.visual.mjs` is a historical, non-gating script from an older
tab design (including removed Campaigns/Timeline sections). Current UI paths
are tested by `unifiedTests.visual.mjs` and `interfacePolish.visual.mjs` instead.

Not verified by deterministic mocks: any organization's DNS, proxy, CORS, or
certificate deployment; a signed-in Copilot service/account; Marketplace
publishing or download; every possible user-authored Profile combination;
human visual acceptance of a real VS Code window. These require separate
environment-specific or manual evidence, not an invented mock pass.
