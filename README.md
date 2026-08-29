# TurnStage

**Config-driven AI chat simulation and stream testing for VS Code**

TurnStage is a VS Code extension for exercising an arbitrary chat or agent
backend from a versioned, Git-friendly `*.turnstage.jsonc` profile. A profile
describes the opening experience, request variants, stream protocol, event
mapping, and the UI data that can be rendered as chat content, progress, tools,
citations, follow-ups, actions, forms, diagnostics, and usage.

It is a stream-testing workbench, not a fixed-format chat client or a general
API client. Requests run in the Extension Host; the React Webview is a
renderer and inspector.

## Current implementation at a glance

- Native VS Code Activity Bar container, `Profiles` Tree View, Welcome View,
  commands, Output Channel, Problems diagnostics, SecretStorage, and a custom
  editor for `*.turnstage.jsonc`.
- JSONC profiles and environments with JSON Schema association plus a semantic
  validator and a version-0-to-1 migration command with backup/diff review.
- Static, request-backed, and disabled openings; starter buttons can send or
  fill the composer.
- POST/HTTP streaming through the Extension Host, including SSE parsing and
  line-delimited NDJSON parsing, abort, total/idle timeouts, bounded pre-data
  reconnect, controlled redirects, and unexpected-end handling.
- Configurable request variants, typed `$value` extraction, interpolation,
  transforms, redacted request previews, normalized event mapping, and a
  reducer-backed chat snapshot.
- A profile-scoped **Test** workspace with a Chrome Device Mode-inspired
  viewport toolbar beside a resizable Debug inspector. Responsive mode follows
  the Chat pane; device presets, custom width/height, rotation, and Fit/100%/
  75%/50% zoom test the same RWD chat surface without adding fake device chrome.
  A camera action copies only the logical Chat viewport to the system clipboard
  as a PNG, ready to paste into an issue, document, or chat.
  Messages and their raw/normalized events can be selected in either direction.
- Native Profile Tree resource rows with compact **Run**, **Open**, and
  **Configure Profile** actions. Profile Configuration provides eight
  profile-specific sections in the Custom Editor; Test remains the live chat
  and Debug/Runs surface.
- Profile-defined multi-turn conversation contracts in VS Code's native Test
  Explorer. Each step receives declarative assertions plus built-in terminal-
  state invariants; a failed assertion can reopen the captured session and
  focus its related Network, Raw Events, or Normalized evidence. Optional
  baseline/candidate comparison, performance budgets, Fault Lab injection,
  real PNG visual baselines, passive trace/request ID correlation, and
  sanitized JSON/JUnit/HTML evidence bundles support regression and CI without
  executing profile code or sending background telemetry.
- A localhost-only synthetic mock server and three starter profiles, including
  an enterprise first-turn/multi-turn contract example with no real identity or
  credentials.
- Bounded adversarial regression cases that replay fixed single- or multi-turn
  attack scripts and classify them as Resisted, Attack succeeded,
  Indeterminate, or Infrastructure error. Bulk JSONC suites and one-row-per-
  turn CSV import/export support large case sets; timeout never counts as a
  pass, and results link back to Chat, Network, and Events evidence.
- Per-case and suite-default repetitions run in fresh conversations and expose
  stable resistance, stable attack success, unstable, or inconclusive sample
  status without converting timeout or incomplete samples into a pass.
- Five bounded VS Code language-model tools let GitHub Copilot find, validate,
  run, and inspect TurnStage tests or draft a regression without writing files.
  Network runs require VS Code confirmation and Workspace Trust; tool output is
  paginated, redacted, and protected by optional integrity fingerprints.
- An executable `turnstage` CLI runs the same fixed Scenario contracts in CI,
  supports changed-file selection through explicit `sourceBinding` metadata,
  emits deterministic exit codes and sanitized JSON/JUnit/HTML/evidence output,
  and verifies SHA-256 provenance manifests from Evidence Bundles.

The implementation is intentionally explicit about limitations in the bundled
`docs/turnstage-architecture.md`, `docs/profile-schema.md`,
`docs/event-mapping.md`, `docs/security.md`, `docs/performance.md`, and
`docs/edge-case-hardening.md`, and `docs/adversarial-testing.md`
documents.

## Requirements and installation

The repository uses npm (`package-lock.json`) and the npm scripts in
`package.json`. Install dependencies and build the extension bundle with:

```sh
npm install
npm run compile
```

The extension manifest targets VS Code `^1.106.0`. The Extension Host bundle is
built for Node 20, the headless CLI targets Node 20, and the Webview bundle for ES2022; use a Node runtime
compatible with the local esbuild/VS Code toolchain.

For local development, open this folder in VS Code and run the extension from
an Extension Development Host. The production packaging command is:

```sh
npm run package
```

That command compiles and invokes `vsce package --no-dependencies`, producing
a VSIX in the project root (VSIX files are ignored by Git).

After compilation, the repository-local CLI can run linked profile tests against
a configured backend (secrets are resolved only from process environment
variables; `.env` files are never loaded):

```sh
./dist/cli.js run --workspace . --changed-file src/chat/client.ts --format junit
./dist/cli.js verify path/to/evidence/provenance.json
```

TurnStage currently targets desktop and remote VS Code Extension Hosts. It
does not declare a `browser` entry and therefore does not claim support for
`vscode.dev` or `github.dev`.

## First run

1. Open a workspace folder in VS Code.
2. Open the **TurnStage** Activity Bar view.
3. Run **TurnStage: Initialize Workspace** and choose a starter option.
4. Select a profile in the `Profiles` Tree View to open the Custom Editor.
5. Use **Configure Profile** for the eight profile configuration sections, or
   use **Run Profile** for the phone chat preview and Debug inspector. Recorded
   runs are in the Debug panel's **Runs** tab.
6. Open VS Code's **Testing** view to run any scenarios declared under
   `tests.scenarios`. Conversation-contract tests make real profile requests
   and therefore require a trusted workspace. **TurnStage: Run Conversation
   Contracts** provides the same deterministic extension-owned entry point for
   automation.
7. Configure comparison, performance, and report settings from
   **Configure Profile → Scenarios**, or edit the same fields in JSONC. Run
   **TurnStage: Export Contract Test Report** to save the latest sanitized
   results manually.
8. Add known red-team regressions under **Configure Profile → Scenarios →
   Adversarial tests**. Use JSONC suites for Git-managed bulk cases or CSV for
   spreadsheet exchange, then triage the four outcomes in Test Explorer or the
   Profile's latest-results list.

Initialization is explicit. Merely installing the extension, opening a
workspace, or opening the sidebar does not create profile files. Existing
files are offered **Skip**, **Create Copy**, or **Replace**; replacement needs
an additional confirmation.

The built-in demo can also be opened without writing to the workspace by
running **TurnStage: Run Profile** with no selected profile. It uses the
bundled Basic SSE fixture and does not issue a network request.

## Profile storage layers

The Profiles view separates **Workspace** and **User** profiles. Workspace
initialization writes this layout under the selected workspace folder:

```text
.vscode/
└── turnstage/
    ├── profiles/
    │   ├── basic-sse-chat.turnstage.jsonc
    │   ├── agent-flow.turnstage.jsonc
    │   └── enterprise-chat.turnstage.jsonc
    ├── environments/
    │   └── local.environment.jsonc
    └── fixtures/                 # only for the mock-server option
        ├── basic-sse-chat.jsonl
        ├── agent-flow.jsonl
        └── enterprise-chat.jsonl
```

The extension ships equivalent templates, schemas, and fixtures under
`resources/`. Profiles and environment files are ordinary workspace files and
can be reviewed and committed to Git. Secret values must not be committed.

**TurnStage: Initialize User Profiles** writes reusable profiles and
environments under the extension's `globalStorageUri/configuration` directory.
Those files are available to every workspace handled by the same Extension
Host. A Workspace profile resolves environments from its own workspace first
and falls back to the user definition when IDs match; a User profile uses User
environments, which avoids ambiguous overrides in multi-root workspaces.
Creating or importing a profile asks which layer should receive the file.
A Workspace profile with the same `id` is treated as the project's full-file
replacement for the User profile; the User item remains visible and is marked
**Overridden** so its reusable base can still be edited. Profile files are not
deep-merged because mapping-array order and security policy must remain
explicit.

## Starter profiles

### Basic SSE Chat

`resources/templates/basic-sse-chat.turnstage.jsonc` is a small POST + SSE
profile. It has a static opening, two starters, first-turn and continuation
request variants, a stop request, text/progress/title/done/error mappings, a
split chat/inspector layout, local run retention, and metrics. It intentionally
does not include tools, forms, citations, actions, or follow-ups.

### Agent Flow

`resources/templates/agent-flow.turnstage.jsonc` demonstrates a request-backed
opening, dynamic starter options, fallback text, actor/model/debug controls,
first-turn and continuation variants, bearer-secret resolution, stop handling,
and mappings for progress, markdown, tools, citations, actions, forms,
follow-ups, diagnostics, usage, title, completion, and failure.

### Enterprise Chat Contract

`resources/templates/enterprise-chat.turnstage.jsonc` is a synthetic contract
fixture for a common POST + SSE application flow. It covers a request-backed
opening with a 7021 fallback, optional opening choices, different first-turn and
continuation bodies, global actor selection, per-turn event counts, remote
stop, partial-content retention, error finalization, follow-ups, CTA payloads,
diagnostics, and reference-only remote history. Its unknown `custom_card`
fixture deliberately remains unmatched and inspectable in Raw Events instead
of becoming a built-in renderer. All identity and profile values are visibly
synthetic. See `docs/enterprise-chat-profile-guide.md` for setup and adaptation.

### Local environment

`resources/templates/local.environment.jsonc` contains only non-secret values:

```jsonc
{
  "version": 1,
  "id": "local",
  "name": "Local Mock Server",
  "variables": { "baseUrl": "http://127.0.0.1:8787" },
  "secretReferences": { "apiToken": "local-api-token" }
}
```

`secretReferences` maps a profile placeholder name to a SecretStorage key; it
does not store the value.

## Profile-driven conversation

### Opening

`opening.mode` is `static`, `request`, or `disabled`.

- `static` displays the configured message immediately and makes no opening
  request.
- `request` runs only after **Start Session** (or the explicit start command),
  resolves the response message and starter paths, and can use a configured
  fallback for a network failure.
- `disabled` leaves the session ready without an opening message.

Opening requests have a bounded timeout and expose retry, configured fallback,
and request-inspection actions on failure. Fallback rules are evaluated in
order against response data, HTTP status, a missing-message marker, or the
runtime error type; an unconditional fallback is the final catch-all.

### First turn and continuation

`conversation.send.variants` are evaluated in order. The starter templates use
`conversation.id` to select `first-turn` when it does not exist and
`continuation` when it does. An interaction is carried in
`turn.interaction`, including starter, follow-up, response-action, form-submit,
and retry metadata.

### HTTP streams

Network work is host-side. SSE uses `fetch`, an `AbortController`, UTF-8
decoding, chunk-safe parsing, event/id/retry fields, comments, multiline data,
CR/LF/CRLF, an optional leading BOM, blank-line dispatch, a partial final event,
and the `[DONE]` sentinel.
NDJSON uses a chunk-safe line buffer. HTTP status and content-type failures,
network failures, total timeout, idle timeout, user abort, and panel disposal
become runtime results.

Reconnect is opt-in and bounded. It is attempted only before the first raw
event, so a partially received response is never automatically replayed.
Redirects are processed manually with a bounded hop count; the default policy
allows same-origin redirects only. Explicit cross-origin following strips
credential headers and headers containing SecretStorage-resolved values.

`json`, `text-stream`, and `fixture` are accepted profile transport values.
`text-stream` emits decoded chunks as raw events without JSON parsing; `json`
buffers one bounded complete JSON document instead of treating lines as
records. `dataFormat: "text"` keeps SSE/NDJSON payloads as text. Fixture
profiles load `.vscode/turnstage/fixtures/<profile-id>.jsonl` and replay it
through the same mapping/reducer pipeline without a network request.

### Mapping and chat content

Each stream mapping matches an SSE event name and/or a data path, extracts
`{ "path": "$.field" }` values, and emits a version-1 normalized event. The
reducer turns normalized events into the current `SessionSnapshot`:

- text and markdown deltas append to assistant parts;
- progress updates maintain a collapsible progress part;
- tool start/argument/result events maintain tool-call parts;
- citation, follow-up, and response-action events upsert message entities;
- forms, diagnostics, and usage become message parts;
- completion, failure, and abort terminal events finish the turn.

See `docs/event-mapping.md` for event types and matching semantics.

### Citation, follow-up, action, and form

These are declarative event payloads. The Webview renders source lists,
follow-up chips, response-action buttons, and form fields. Citation opening and
VS Code command execution are mediated by the Extension Host. Forms validate
required values, maximum length, and patterns in the Webview before sending a
`formSubmit` interaction.

The current UI exposes built-in copy/retry/edit actions and does not execute
arbitrary backend JavaScript, HTML, CSS, shell commands, or unallowlisted VS
Code commands. Cancelling a rendered form clears its local values and marks it
cancelled without sending a request.

### Stop, errors, and new conversations

Stop changes the turn to `stopping`, aborts the local fetch, optionally sends a
configured remote stop request, and finalizes the turn as `aborted`. Remote
stop failure is a non-blocking warning; local completion remains aborted.

Every normal terminal path calls the idempotent `finalizeTurn` path. A
completed, failed, or aborted run ends the assistant status, updates metrics,
and (unless disabled) records a local run. `unexpectedEndPolicy` defaults to
failure; `completeWithWarning` is also supported.

**New conversation** is disabled while a turn is active. It creates a new
session snapshot, clears conversation/event state, preserves configured
controls, and runs the opening flow again.

## History, Replay, and Metrics

Local runs are stored in VS Code global storage under the profile ID, retained
according to `history.localRuns.maxRuns` or `turnstage.runRetention`, and can
be imported or exported as versioned `*.turnstage-run.json` files. Import also
accepts the legacy unversioned export, rejects mismatched profile IDs, and
creates a new run ID instead of overwriting a duplicate. A replay restores the
recorded conversation through the last user message, then feeds saved raw
events through the same Mapping Engine and reducer; it never calls the backend.
Runs recorded without raw events remain inspectable and exportable but are
clearly marked as unavailable for replay.

Profiles may also enable reference-only remote session history. It stores only
the conversation ID and metadata scoped by workspace/profile/actor/environment.
Applying one never fabricates history: TurnStage clears the visible chat and
states that previous messages were not loaded.

Replay preserves recorded event spacing and supports 0.25×, 0.5×, 1×, 2×, and
4× playback plus pause, resume, step, and stop. Single-run metrics include
headers latency, first chunk/event latency, TTFT, stream/total duration, event
and byte counts, event gaps, parse/mapping/unmatched counts, and abort reason.
No percentile statistics are produced.

Each chat message has VS Code-native icon actions for Copy, Retry,
Edit-and-resend, and Inspect. They are visible by default for discoverability;
profiles can opt into interaction-only visibility. Backends can also expose
arbitrary per-message measurements through `message.metric.updated` mappings,
including message correlation, display format, and first/last/sum/min/max/count
aggregation. Assistant messages also expose built-in TTFT and total-turn time,
measured by the Extension Host from the request start. The compact footer shows
only these two built-ins by default. `metrics.messageEnabled` can explicitly
opt into a mapped metric ID, but backend-reported duration or token values stay
out of the chat surface by default and remain available in Debug data. A
backend `usage.updated` message part is likewise hidden in Chat unless
`ui.components.usage.visible` is explicitly enabled.

The test workspace keeps Chat on the left and provides Debug and Configure as
two modes of the right pane. Configure exposes the same seven profile sections
as the command-driven configuration flow, including request, stream mapping,
Chat UI, history, metrics, and security. Every GUI edit is applied as a
structured `WorkspaceEdit` to the open `.turnstage.jsonc` document, so the
profile file remains the source of truth and VS Code Undo/Redo continues to
work. Open JSONC remains available from the configuration toolbar.

Debug's **Network** tab presents every Opening, Conversation Stream attempt,
retry, and Stop request as a compact request list. Selecting a row exposes
Chrome-style **Headers**, **Payload**, **Response**, and **Timing** views,
including status, first-chunk latency, total/idle timeout settings, transferred
bytes, event count, and a structured failure such as `IdleTimeoutError`. The
filter searches request kind, method, URL, status, state, and variant. Network
entries are live-session diagnostics: restarting the session clears them and
they are not added to Recorded Runs. In a Trusted Workspace, the Network
Headers view shows the exact outgoing `Authorization` value so authentication
problems can be compared with Chrome DevTools. Other structurally sensitive
headers remain masked.

## Commands and settings

Commands are registered under the `turnstage` namespace:

| Command | Purpose |
| --- | --- |
| `turnstage.initializeWorkspace` | Create starter workspace files with conflict handling |
| `turnstage.createProfile` | Create a duplicate-safe empty profile |
| `turnstage.importProfile` | Import a valid JSONC profile with duplicate-safe naming |
| `turnstage.initializeUser` | Initialize reusable user profiles and a user environment |
| `turnstage.duplicateProfile` / `turnstage.deleteProfile` | Copy a discovered profile or move it to Trash after confirmation |
| `turnstage.openProfile` | Open a profile in the custom editor |
| `turnstage.configureProfile` | Open Profile Configuration for the selected profile |
| `turnstage.runProfile` | Open/run a selected profile or the built-in Basic demo |
| `turnstage.startSession` | Explicitly execute a request-backed opening |
| `turnstage.abortRequest` | Stop an active turn |
| `turnstage.newConversation` / `turnstage.clearConversation` | Reset conversation state |
| `turnstage.validateProfile` | Publish Problems diagnostics |
| `turnstage.openAsText` | Open the same document in VS Code's text editor |
| `turnstage.selectEnvironment` / `turnstage.openEnvironment` | Select or edit an effective workspace or user environment |
| `turnstage.setSecret` / `turnstage.removeSecret` / `turnstage.listSecretNames` | Manage secret names and values |
| `turnstage.replayRun` / `turnstage.importRun` / `turnstage.exportRun` | Replay the latest run, or import/export versioned local-run files |
| `turnstage.openOutput` | Show the TurnStage Output Channel |
| `turnstage.changeDisplayLanguage` | Choose Auto, Traditional Chinese, or English for TurnStage profile editors |
| `turnstage.migrateProfile` | Migrate a version-0 profile after confirmation, backup, and diff review |
| `turnstage.refreshProfiles` | Refresh discovery and cross-file duplicate-ID diagnostics |

The contributed settings are:

| Setting | Default | Effect |
| --- | ---: | --- |
| `turnstage.displayLanguage` | `auto` | Application-wide language for TurnStage profile editors: follow VS Code, Traditional Chinese, or English |
| `turnstage.profileGlob` | `.vscode/turnstage/profiles/*.turnstage.jsonc` | Workspace-relative discovery glob |
| `turnstage.maxBufferedEvents` | `5000` | Maximum raw and normalized events kept in the live session |
| `turnstage.maxConversationMessages` | `500` | Maximum conversation messages kept in memory (50–5000) |
| `turnstage.maxBufferedBytes` | `10485760` | Maximum raw-buffer JSON bytes (10 MiB) |
| `turnstage.streamBatchIntervalMs` | `32` | Batching interval for host-to-Webview snapshots (16–100 ms) |
| `turnstage.runRetention` | `20` | Fallback local-run retention (1–100) |
| `turnstage.logLevel` | `info` | Minimum output-channel level: error, warn, info, or debug |
| `turnstage.notifications.enabled` | `true` | Show non-modal TurnStage notifications; selecting **Do not show again** sets it false at user scope |

For request failures, run **TurnStage: Open Output**. The default `info` level
records a correlated request timeline with the profile/environment, request
build time, method, URL without its query or fragment, selected variant,
header/body byte counts, configured timeouts, response status/content type,
safe server request/trace IDs, first-chunk latency, last event, terminal-event
state, maximum chunk gap, parser/mapping/drop counts, byte/event totals, and
retry count. Safe network-client error codes distinguish DNS, proxy, TLS,
connection, and TurnStage timeout failures. Set `turnstage.logLevel` to `debug`
to add each transport attempt, chunk, SSE event name, mapping result, retry
delay, and the exact timeout that fired.
Headers, request bodies, query values, SSE payloads, and known secrets are not
written to the Output Channel.

Use **Debug → Network** for the request and response view. For a timeout, first
check whether a row received an HTTP status, then compare **Headers**, **First
chunk**, **Total**, and **Idle timeout** under Timing. Output remains the more
durable correlated timeline; Network deliberately includes bounded, redacted
request/response previews for the current editor session only, with the explicit
exception that outgoing `Authorization` is visible there. Output never records
that header value.

`displayLanguage` has VS Code `application` scope, so one User setting applies
across projects. `profileGlob` has VS Code `resource` scope. The runtime-limit settings use
explicit `window` scope, so they can be set once in User Settings and optionally
overridden by a workspace. Machine-specific reusable endpoint and command data
belongs in a User environment; credentials remain in SecretStorage.

## Workspace Trust and secrets

In an untrusted workspace, profiles remain viewable/editable and bundled
fixture replay remains available, but session requests and request-backed
openings are blocked. The Webview displays a restricted-mode banner. Citation
opening also requires trust.

Use **TurnStage: Set Secret** to store a value in VS Code SecretStorage. Only
the Extension Host resolves `${secret.name}`. Request previews redact sensitive
headers and secret/token/password-like body fields before sending data to the
Webview. See `docs/security.md` for the exact current policy and its boundaries.

## Local mock server

The mock server uses Node's built-in HTTP module and listens only on
`127.0.0.1:8787`:

```sh
npm run mock-server
```

Endpoints used by the starter profiles:

```text
POST /basic/chat/stream
POST /basic/chat/stop
POST /agent/opening
POST /agent/chat/stream
POST /agent/chat/stop
POST /v1/chat/opening
POST /v1/chat/stream
POST /v1/chat/stop
```

The server emits example SSE events and has deterministic modes selected by
`x-turnstage-mode` or `body.mode`: `normal`, `slow`, `chunk-split`,
`malformed-json`, `unknown-event`, `partial-error`, `http-401`, `http-500`,
`idle-timeout`, and `disconnect`. It does not call an LLM. Do not treat the
example endpoint or `example.com` citation as a production service.

Both starter profiles expose these values as a **Mock Scenario** control in the
mobile chat preview, so streaming and failure modes can be switched without
editing request headers or JSON.

The Enterprise Chat Contract profile additionally exposes `contract-slow`,
`contract-error`, `contract-actions`, and `opening-options`. Its mock API
validates trimmed input, first-turn versus continuation fields, stop IDs, and
the `start → status → message → title → done` terminal sequence. This server is
only a behavioral simulator; it never calls an internal service or an LLM.

## Development checks

Available scripts are:

```sh
npm run typecheck
npm run lint
npm test
npm run test:sse
npm run test:integration
npm run benchmark
npm run compile
npm run package
```

`npm run test:sse` starts the real local HTTP server on an ephemeral port and
verifies incremental SSE delivery, split chunks, malformed and unknown events,
HTTP/idle failures, and partial-stream abort behavior. `npm run test:integration`
launches a clean VS Code Extension Host and verifies
activation, command registration, workspace discovery, and profile validation.
`npm run benchmark` measures parser, mapping, bounded-buffer, and reducer
scenarios. Observed results and their environment are recorded in
`docs/performance.md`.

## Further reading

- Architecture and runtime lifecycle: `docs/turnstage-architecture.md`
- Profile and environment schema: `docs/profile-schema.md`
- Raw-event mapping and normalized events: `docs/event-mapping.md`
- Security, trust, secrets, and redaction: `docs/security.md`
- Performance budgets and measurement plan: `docs/performance.md`
- Required VS Code UI review standard: `docs/vscode-extension-ui-guidelines.md`
- Current VS Code UI audit: `docs/vscode-ui-audit-2026-08-27.md`

## Scope boundaries

The first implementation does not provide a low-code drag-and-drop builder,
arbitrary user scripts/components/styles, provider SDKs, Copilot/MCP
integration, cloud sync, accounts, collaborative storage, automatic telemetry,
or automatic backend actions. Configured actions require a user interaction and
VS Code command actions require an allowlist.
