# Developing TurnStage

For contribution expectations, see [CONTRIBUTING.md](../CONTRIBUTING.md).
This guide covers the local developer workflow; release checks and version
decisions are defined in [AGENTS.md](../AGENTS.md).

## Setup and run

Use Node.js 24 and npm with the committed lockfile. The extension requires
VS Code 1.106 or later. Extension Host and CLI bundles target Node 20;
the shared Webview targets ES2022.

```sh
npm ci
npm run build:all
```

For the extension, open this repository in VS Code and press F5 using
**Run TurnStage Extension**. The launch configuration compiles first and
opens an Extension Development Host. In another terminal, run:

```sh
npm run mock-server
```

In the development host, initialize a workspace with the mock-server starter
option and open **Basic SSE Chat**. The mock API listens on
`http://127.0.0.1:8787` by default and does not call an LLM. See the
[VS Code guide](vscode-user-guide.md#try-the-local-mock-server) for the
conversation and test workflow.

For Web development:

```sh
npm run web:dev
```

For the production Web build, use `npm run web:build`, then
`npm run web:preview`. Vite serves the contents of `web-dist`.
Use [Web deployment](web-deployment.md) for ZIP deployment and the optional
same-origin API proxy.

## Verification

The basic source checks are:

```sh
npm run typecheck
npm run lint
npm test
python3 -B -m unittest discover -s test -p 'test_*.py'
npm run build:all
npm run test:integration
git diff --check
```

`typecheck` includes extension, CLI, shared Webview, Web, and TypeScript tests.
`npm test` runs the full Vitest suite. `npm run test:web` and
`npm run test:sse` are useful subsets. Python tests cover `serve.py` and the
Profile catalog generator; `-B` avoids writing bytecode caches.

The integration runner creates isolated workspaces and user-data directories
and runs both trusted and untrusted Extension Hosts. Restricted Mode checks
include no conversation list/history requests and no conversation archive
reads or writes. It downloads VS Code into `.vscode-test`; on Linux, run it
under `xvfb-run -a` when no display is available. Set
`TURNSTAGE_VSCODE_VERSION=1.106.0` to exercise the minimum supported version.
To test an already validated local VSIX, set `TURNSTAGE_TEST_VSIX=auto` for
`node test/integration/runTest.mjs`.

### Include the live TLS tests

Without a fixture, `test/insecureTlsLive.test.ts` is conditional. Create a
temporary self-signed certificate and pass its paths only to the test run:

```sh
tls_fixture_dir=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$tls_fixture_dir/key.pem" -out "$tls_fixture_dir/cert.pem" \
  -days 1 -subj '/CN=localhost'
TURNSTAGE_TEST_TLS_CERT="$tls_fixture_dir/cert.pem" \
TURNSTAGE_TEST_TLS_KEY="$tls_fixture_dir/key.pem" npm test
rm -r "$tls_fixture_dir"
```

These tests cover strict rejection, request-local invalid-certificate access,
timeout enforcement, and HTTP CONNECT proxy routing. Do not change global
Node or browser TLS verification to run them.

### Visual and manual checks

Build both hosts before running the ten current validation scripts:

```sh
npm run build:all
node test/visual/unifiedTests.visual.mjs
node test/visual/interfacePolish.visual.mjs
node test/visual/conversationContinuity.visual.mjs
node test/visual/webAbServices.visual.mjs
node test/visual/webCaseScale.visual.mjs
node test/visual/webRunControl.visual.mjs
node test/visual/webLibrary.visual.mjs
node test/visual/webJsoncVisual.visual.mjs
node test/visual/richContent.visual.mjs
node test/visual/testReport.visual.mjs
```

Install Playwright Chromium with `npx playwright install chromium` if a
supported local Chrome/Edge or downloaded Chromium is unavailable. Scripts
write screenshots and results under `artifacts/`. Browser harness coverage
does not replace real VS Code checks.

`profileWorkspace.visual.mjs` is an older script with known stale layout
expectations. It remains in the repository for repair and is not part of the
ten-script validation set above; it must not be reported as passing.

For UI changes, follow the [UI review checklist](vscode-extension-ui-guidelines.md#pull-request-acceptance-checklist):
wide and narrow workspaces, light/dark/high-contrast themes, 200% zoom,
keyboard-only navigation, reduced motion, and trusted/Restricted Mode.
Narrow layout uses the workspace width (at most 1,024px), including Web's
sidebar, rather than the browser window width.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/extension` | VS Code activation, Profiles, secrets, requests, history, tests, and Copilot |
| `src/webview` | Shared React conversation, configuration, tests, and inspectors |
| `src/shared` | Host protocol, domain types, schemas, and shared helpers |
| `src/cli` | Headless runner and evidence verification |
| `web/src` | Browser host, catalog, browser storage, and Web controllers |
| `resources` | Complete starter Profiles, schemas, and synthetic fixtures |
| `examples` | Local mock API and response-style example |
| `test` | Unit, Python, integration, benchmark, and visual tests |
| `scripts` | Validator generation, Web packaging, serving, and catalog updates |
| `docs` | User guides, deployment, reference, and contributor documentation |

## Generated files and cleanup

`node_modules`, `dist`, `web-dist`, `.vscode-test`, `artifacts`, coverage,
Python caches, and packaged VSIX/ZIP files are local generated output ignored
by Git. `dist/cli.js` is the executable CLI; `dist/test` is used by integration
tests. An Extension Development Host may still be running from `.vscode-test`.

Keep release candidates and their checksum/validation evidence together.
Before removing a download or an old build, check that it is not in use.
Move older release files outside the checkout when they need to remain
recoverable. Avoid broad `git clean` commands that can remove current evidence.

## Packaging and releases

`npm run package` builds a VSIX; `npm run package:web` builds the standalone
Web ZIP. Both use the version in `package.json` and write to the repository
root. `npx vsce ls --tree` previews the extension file list without packaging.

A documentation change does not require a version bump by itself. If a new
artifact is distributed after a previous artifact with different contents,
the version must increase, even for documentation-only changes. Follow
[AGENTS.md](../AGENTS.md) before building a replacement release artifact.
Packaging, committing, tagging, pushing, and publishing are separate actions.
