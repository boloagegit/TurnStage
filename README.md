<p align="center">
  <img src="media/icon.png" alt="TurnStage" width="96" height="96">
</p>

<h1 align="center">TurnStage</h1>

<p align="center">
  <strong>Debug the stream. Save the case. Check the next run.</strong>
</p>

<p align="center">
  The testing workbench for streaming LLM chat and agent APIs,
  in VS Code, in the browser, or from the command line.
</p>

<p align="center">
  <a href="https://github.com/boloagegit/TurnStage/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/boloagegit/TurnStage/ci.yml?branch=main&label=CI"></a>
  <a href="https://github.com/boloagegit/TurnStage/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/boloagegit/TurnStage"></a>
  <img alt="VS Code 1.106 or later" src="https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.106-007acc">
  <img alt="Public preview" src="https://img.shields.io/badge/status-public%20preview-orange">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=turnstage.turnstage">Install</a> ·
  <a href="#try-it-in-two-minutes">Try it</a> ·
  <a href="https://github.com/boloagegit/TurnStage/blob/main/docs/README.md">Docs</a> ·
  <a href="https://github.com/boloagegit/TurnStage/blob/main/CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/boloagegit/TurnStage/blob/main/README.zh-TW.md">繁體中文</a>
</p>

![A synthetic TurnStage Web demo: chat, stream events, a saved regression case, its re-run, and red-team outcomes](media/marketplace/turnstage-demo.gif)

## Why TurnStage

A streaming chat or agent backend can look fine in a single `curl` and still
break in the details users feel: the first token arrives late, an event is
malformed or missing, a stop request does not stop, a link or tool call shows
up where it should not. Those details live in the stream, not only in the final
text, and they are easy to lose between "I saw it once" and "it is fixed".

TurnStage keeps the whole loop in one place:

| Step | What you do |
| --- | --- |
| **Describe** | Write one JSONC Profile for the request, controls, and event mapping of an SSE or NDJSON API. |
| **Explore** | Chat with the backend and inspect each request, header, payload, timing, raw event, normalized event, and error. |
| **Capture** | Save a conversation as a single- or multi-turn regression case, with checks suggested from the reply. |
| **Re-run** | Run suites, compare with an accepted baseline, review history, and export a report; detailed reports can still hold confidential content. |

## Highlights

- **See every layer.** HTTP request and response, time to first token, total time,
  raw stream events, normalized events, and errors, side by side with the chat.
- **Configuration, not code.** A Profile is a Git-friendly `.turnstage.jsonc` file
  with validation that points at the field to fix. Import an existing call with
  **Create Profile from cURL**; the command is parsed, never executed.
- **Regression cases with their results.** Author inline, import JSONC or
  CSV, or link suite files. Each case shows its latest outcome; open a run's
  retained Chat, Network, and Events from its result for as long as that evidence
  is kept.
- **Reproducible red-team checks.** Replay fixed adversarial messages against
  explicit prohibitions on content, URLs, CTAs, tools, or events, with outcomes
  that never turn a timeout or missing evidence into a pass.
- **Careful with secrets.** No product telemetry and no cloud service. VS Code
  keeps secrets in SecretStorage, and Restricted Mode blocks network-backed
  operations.
- **Three hosts, one workspace.** The VS Code extension, a standalone static Web
  app, and a repository-local CLI share Profiles and event mappings.
- **Accessible and localized.** English, Traditional Chinese, Japanese, and Korean;
  light, dark, and high-contrast themes; keyboard-operable at 200% zoom.
- **Optional Copilot help.** The `@turnstage` participant can diagnose evidence and
  propose fixes. Everything else works without it.

## Try it in two minutes

You need Node.js 24 and a browser. No account, API key, or LLM is involved: the
bundled mock server simulates a streaming backend on your machine.

```sh
git clone https://github.com/boloagegit/TurnStage.git
cd TurnStage
npm ci
npm run mock-server   # terminal 1: simulated SSE backend on http://127.0.0.1:8787
npm run web:dev       # terminal 2: TurnStage Web on http://127.0.0.1:18784
```

Open `http://127.0.0.1:18784`, choose **Basic SSE Chat**, and send a message.
Then open **Debug** to read the request, the streamed events, and the timing. Use
the **Mock Scenario** control to try split chunks, a slow stream, malformed
events, partial errors, HTTP failures, and disconnects, then press **Save as
test** to keep the conversation as a regression case.

![TurnStage Web showing a chat reply and its Network evidence against the local mock server](media/marketplace/web-quickstart.png)

Prefer VS Code? Install **TurnStage** from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=turnstage.turnstage)
or enter `ext install turnstage.turnstage` in Quick Open, run **TurnStage:
Initialize Workspace**, and open the starter Profile. The
[VS Code guide](docs/vscode-user-guide.md) covers trust, secrets, conversation
history, and the full workflow.

## Choose your host

| Host | Use it for | Start here |
| --- | --- | --- |
| VS Code extension | Git-managed Profiles and suites, Test Explorer, local evidence, and optional Copilot assistance | [Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=turnstage.turnstage) · [User guide](docs/vscode-user-guide.md) |
| Standalone Web app | Browser chat and testing, deployment-owned presets, local Profile copies, and portable exports | [User guide](docs/web-user-guide.en.md) · [繁體中文](docs/web-user-guide.md) · [Deploy Web](docs/web-deployment.md) |
| Repository-local CLI | Run linked cases against your backend and verify exported provenance | [CLI and test reference](docs/automated-testing.md#running-and-copilot) |

The Web app is a separate static build and does not load the VSIX. Web data
belongs to the browser origin; extension data belongs to VS Code. The extension
supports desktop and remote Extension Hosts, not `vscode.dev`.

To build the Web app as a ZIP for your own server, run `npm run package:web`,
extract `turnstage-web-<version>.zip`, and serve the directory over HTTP or
HTTPS. No Node.js or VS Code is needed to serve it. See
[Web deployment](docs/web-deployment.md) for local preview, the API proxy, CORS,
and deployment-owned Profiles.

## Explore and inspect

Chat sits beside **Debug**, **General tests**, **Red Team**, and **Configure**.
Inspect a response's request, headers, payload, timing, raw events, normalized
events, and errors. The **Conversations** drawer switches, searches, and deletes
saved conversations. Profiles can list server conversations, load their history,
and compare it with the local reply after each turn.

At workspace widths of 1,024px or less, **Chat** becomes the first tab in both
VS Code and Web. Switching keeps drafts, scroll position, and streaming state.
VS Code uses workbench theme tokens; Web keeps its amber theme.

![Synthetic conversation and Network evidence](media/marketplace/stream-debug.png)

## Keep regression cases with their results

Create single- or multi-turn cases inline, import JSONC/CSV, or link suite
files in VS Code. Each case shows its latest outcome and duration, alongside
live status during a run. **Last run** summarizes the current cases' latest
results and provides outcome filters, targeted rerun, and run history.

Pause stops dispatching new cases and lets active cases finish. Resume
continues the same run; Stop aborts active requests while keeping completed
results. After an interrupted Web run, explicitly choose which remaining
cases to run. TurnStage does not silently resend a request with an unknown
outcome.

![Synthetic general-test cases](media/marketplace/test-case-management.png)

Open a result's captured Chat, Network, and Events, compare a run with an
accepted baseline, or export a report. Detailed HTML reports include case
results, timing, retained evidence, search, filtering, and print layouts.
Large suites have no fixed total-case ceiling; device memory, browser storage,
API capacity, per-case limits, and explicitly configured budgets still apply.

![Synthetic general-test results and history](media/marketplace/automated-tests.png)

## Reproduce red-team regressions

Red Team has its own cases, history, and deterministic outcomes:
**Resisted**, **Attack succeeded**, **Indeterminate**, and
**Infrastructure error**. Run fixed adversarial messages against configured
prohibitions on content, URLs, CTAs, tools, or normalized events. Repeat cases
in fresh conversations to inspect stability. A timeout or incomplete evidence
does not establish resistance.

![Synthetic red-team results and evidence](media/marketplace/red-team-evidence.png)

All screenshots and the demo use synthetic local fixtures. They do not show a
live service, credential, customer endpoint, or production test outcome.

## What TurnStage is, and is not

TurnStage is the **execution, observation, and evidence layer** for chat and
agent testing. People or external tools design the attacks and the cases;
TurnStage sends them reproducibly, records what happened, evaluates explicit
observable rules, and keeps the case as a regression test.

Pass and fail come from deterministic rules, never from an LLM judge. TurnStage
does not generate attacks on its own or certify that a model is safe. The
optional Copilot evidence review can add advisory quality ratings, but they
cannot change a test outcome. It fails closed: a timeout, an infrastructure
error, or missing evidence is never reported as a pass.

## Credentials, trust, and Copilot

Requests go to the active Profile's configured endpoint. TurnStage sends no
automatic product telemetry and operates no cloud service. Request-backed
openings can run when a trusted Profile opens; inspect imported Profiles
before using them. VS Code Restricted Mode blocks network-backed operations
and conversation archive access.

VS Code resolves secrets through SecretStorage. Web session secrets remain
in page memory; plaintext credentials in a browser-local Profile or
Environment are saved and can be exported. Detailed reports may contain
confidential conversation or payload data even when known secrets are masked.
Read [Privacy](PRIVACY.md) and the [security model](docs/security.md).

The optional `@turnstage` Copilot participant can diagnose evidence, run
guarded tests, compare results, or propose configuration repairs. Core chat,
replay, testing, CLI, and exports work without Copilot. Advisory model output
cannot relabel deterministic results.

TurnStage is a public preview. It executes known tests and records observable
evidence; it does not certify model safety or generate autonomous attacks.

## FAQ

**Which backends does it work with?** HTTP chat and agent APIs that stream
Server-Sent Events or NDJSON. A Profile describes the request and maps raw
events to TurnStage's normalized events, so it is not tied to one model
provider. Starter Profiles cover a basic SSE chat, an agent flow, and a
synthetic enterprise contract.

**Do I need an API key, an account, or Copilot?** Not to try it: the mock server
needs none of them. For your own backend you supply its credentials. Copilot is
optional.

**Is it an LLM evaluation or benchmark framework?** No. It tests observable
behavior (events, timing, content, links, tools) with deterministic rules, and
outcomes never come from a judge model. Optional Copilot ratings of answer
quality are advisory and cannot relabel a result.

**Where does my data go?** Requests go to the endpoint in your Profile, and
TurnStage itself sends no telemetry. Evidence stays in VS Code, in the browser
origin, or in files you export. If you explicitly invoke the optional Copilot
features, VS Code and your selected model provider process the bounded prompts
and data involved; see [Privacy](PRIVACY.md).

**Can I run it in CI or share cases with a team?** Cases are JSONC or CSV files
that live in Git. The repository-local CLI runs linked cases, can write JUnit
reports, and uses exit codes that distinguish failures from indeterminate runs,
so a CI job can gate on it. See [Automated testing](docs/automated-testing.md#running-and-copilot).

**Is it free?** Yes. TurnStage is MIT-licensed.

## Develop and contribute

Contributions are welcome: bug reports with sanitized evidence, Profile
examples against synthetic backends, documentation fixes, and code. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), and open an issue first for larger changes.
If TurnStage saves you time, a star helps other people find it.

Use Node.js 24, npm, and VS Code 1.106 or later for extension development.

```sh
npm ci
npm run build:all
```

Press F5 for an Extension Development Host, or run `npm run web:dev` for Web.
The [development guide](docs/development.md) covers checks, TLS fixtures,
visual validation, packaging, repository layout, and generated output.

See the [documentation index](docs/README.md) for user guides and references,
[CHANGELOG.md](CHANGELOG.md) for releases, and [SUPPORT.md](SUPPORT.md) for help.
TurnStage is licensed under [MIT](LICENSE).
