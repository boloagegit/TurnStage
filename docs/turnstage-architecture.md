# TurnStage architecture

This document describes the implementation currently in this repository. The
profile is the source of runtime behavior; this is not a promise that every
concept in the original product brief is implemented.

## Boundaries

TurnStage is a desktop/remote VS Code extension with two bundles:

```text
Extension Host (dist/extension.js)
  VS Code APIs, profile files, validation, secrets, fetch, stream parsing,
  mapping, reducer, snapshots, local runs, Output Channel
           │ versioned postMessage envelope
           ▼
Webview (dist/webview.js + styles)
  React chat, tabs, forms, inspector, getState/setState UI state
```

The Webview does not open sockets, call backend URLs, read workspace files, or
execute VS Code commands. Its Content Security Policy permits connections only
to the Webview resource origin for embedding bundled fonts during Chat PNG
capture; direct HTTP and HTTPS connections from the panel remain blocked.

## Runtime data flow

For a workspace profile the main path is:

```text
ProfileRepository / TextDocument
  → ProfileCodec (JSONC parse + parse tree)
  → ProfileValidator + VS Code JSON validation
  → SessionController
  → RequestBuilder + TemplateResolver
  → HttpStreamTransport
  → SseParser or NdjsonParser
  → RawStreamEvent
  → MappingEngine
  → NormalizedEvent (version 1)
  → reduceEvent
  → SessionSnapshot
  → debounced session.snapshot message
  → React renderer and inspector
```

The custom editor owns one `TextDocument` and creates one controller for the
profile URI. Text changes trigger a re-parse and diagnostics update. Structured
UI changes are sent to the host as a patch and applied with `jsonc-parser`
`modify`/`applyEdits` through `WorkspaceEdit`; only the `name`, `description`,
and `ui` roots are patchable from the current UI editor.

The Profile Tree View discovers at most 500 workspace files using the
configured glob (default `.vscode/turnstage/profiles/*.turnstage.jsonc`) and
also reads user files from `globalStorageUri/configuration/profiles`. Workspace
and user scopes have separate tree groups and file watchers. Refreshes are
debounced by 150 ms and all watchers are disposed with the view provider.
Workspace profiles resolve environments from their own workspace before the
user environment directory. User profiles resolve only user environments so a
multi-root window cannot select an override from an unrelated folder.
When a Workspace and User profile share an ID, the Workspace file is the
project's full-file replacement. The User entry is retained and marked as
overridden; TurnStage deliberately does not deep-merge profile files because
stream mapping order and security policy require explicit review.

## Activation and VS Code integration

The manifest contributes one Activity Bar container named `TurnStage` and a
native `turnstage.profiles` Tree View. Activation is event-driven rather than
`"*"`: opening the view, opening the custom editor, or invoking a contributed
command activates the extension. Activation registers:

- `ProfileTreeProvider` for profile discovery and refresh;
- `TurnStageEditorProvider` for `*.turnstage.jsonc`;
- a JSONC content provider for built-in demo templates;
- the `TurnStage` Output Channel and `turnstage` DiagnosticCollection;
- commands for initialization, profiles, sessions, environments, secrets,
  replay/export, migration, and output.

`extensionKind` is `workspace` then `ui`. File access goes through
`workspace.fs`/`vscode.Uri` and request execution occurs in the Extension Host,
so a `localhost` URL refers to the environment where that host runs (local,
remote, WSL, or a development container). This repository does not claim
VS Code Web support.

When a profile is opened, the custom editor posts a profile snapshot,
validation diagnostics, and then session snapshots. A static opening starts
immediately after a valid controller is created. A request-backed opening stays
`notStarted` until **Start Session** is invoked.

Initialization is an explicit command. It creates directories and copies
templates/fixtures only after the user selects an option. `writeSafe` handles an
existing file with Skip/Create Copy/Replace and asks for confirmation before
Replace. There is no automatic initialization on install, activation, or view
display.

## Session and turn state

Session and turn state are separate fields in `SessionSnapshot`.

```ts
type SessionState =
  | 'notStarted'
  | 'loadingOpening'
  | 'ready'
  | 'resetting'
  | 'failed';

type TurnState =
  | 'idle'
  | 'submitting'
  | 'waitingStart'
  | 'streaming'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'aborted';
```

The active-turn predicate is the four non-terminal states
`submitting`, `waitingStart`, `streaming`, and `stopping`. The Webview derives
its composer/control/new-conversation disabled state from this predicate; it
does not maintain a second loading boolean.

Typical transitions:

```text
Opening: notStarted → loadingOpening → ready | failed
Turn:    idle → submitting → waitingStart → streaming
         streaming → completed | failed | stopping
         stopping → aborted
```

An event can create an assistant message before a `conversation.started`
event; the reducer is deliberately tolerant of a missing or late start event.
Conversation ID and assistant message ID are adopted when the normalized start
event supplies them.

## Opening lifecycle

`SessionController.startSession()` handles the three opening modes:

- `static`: publishes `opening.message` and `opening.starters` locally;
- `disabled`: clears the opening and marks the session ready;
- `request`: builds and sends the configured request, parses a JSON response,
  and reads `messagePath`/`startersPath` (defaults `$.message`/`$.options`).

Opening requests are host-side and are blocked in an untrusted workspace. If a
request-backed opening fails, the controller records the redacted request and
exposes retry, configured fallback, and request-inspection actions. Fallbacks
are checked in declaration order against response data, `response.status`,
`response.missingMessage`, or `error.type`; an entry without `match` is a
catch-all. Network fallback use remains gated by
`failurePolicy.useFallbackOnNetworkError`.

`ProfileMigrator` currently supports version `0` (or a missing version) to
version `1` by inserting/updating the version field. The **Migrate Profile**
command asks for confirmation, writes a `<profile>.v0.backup` file, applies a
`WorkspaceEdit`, and opens a VS Code diff. Other source versions are rejected;
this is not a general schema conversion.

## Turn lifecycle and finalization

`SessionController.send()` trims the input and ignores an empty input or an
active turn. It checks Workspace Trust, sets `submitting`, creates a client
request ID, builds the selected request variant, adds a completed user message
and pending assistant message, then starts `HttpStreamTransport`.

Raw and normalized event collections, their drop counters, and turn metrics are
reset before every accepted send. Conversation messages and the current
conversation ID remain available for multi-turn requests, while every recorded
run contains only the events from that turn.

Transport callbacks update metrics and pass each raw event to `acceptRaw()`.
`acceptRaw()` appends to the bounded raw buffer, maps it, records mapping
diagnostics, reduces normalized events, and observes terminal normalized events.

All turn termination paths converge on `finalizeTurn(result)`:

- stream completion, stream failure, abort, timeout, HTTP/network/build error,
  unexpected stream end, and panel disposal;
- assistant status changes to completed/failed/aborted;
- pending progress and tool parts are closed;
- configured user/remote aborts can append a completed system notice after the
  partial assistant content;
- failed results append an error part unless `showErrorPart` is false;
- metrics are finished and the snapshot is published;
- a local run is stored unless `history.localRuns.enabled` is false.

The `finalized` guard makes repeated calls no-ops, preventing duplicate history
records and duplicate terminal updates. The implementation resets the
controller's abort reference and clears transport timers in the transport's
`finally` block. `PanelDisposedError` is converted to an aborted result.

There are a few observable edge cases worth knowing: a request-build failure
can finish before a user/assistant message is created; `clearConversation()` clears
messages, conversation ID, raw/normalized events, and the raw buffer but does
not reset every other snapshot field.

## Request resolution

`RequestBuilder` chooses the first matching variant in declaration order. A
variant without `when` matches unconditionally. Supported request operators are
`equals`, `notEquals`, `exists`, `notExists`, `oneOf`, `contains`,
`startsWith`, `endsWith`, and bounded `regex`. Regex patterns and tested input
are length-limited, nested quantifiers are rejected, and invalid patterns do
not execute.

`TemplateResolver` supports:

- string interpolation such as `${env.baseUrl}`, `${profile.id}`, and
  `${secret.apiToken}`;
- typed values in `{ "$value": "conversation.messages" }`;
- optional transforms `trim`, `lowercase`, `uppercase`, `number`, `boolean`,
  `json`, `default`, and `join`.

The runtime context contains `input`, `conversation`, `opening`, `controls`,
`env`, `profile`, `workspace`, `runtime`, and `turn`. Missing non-secret paths
raise `RequestBuildError`; missing secrets raise `MissingSecretError`.
Resolved request bodies are JSON-encoded. The returned request preview contains
the method, URL, redacted headers/body, and selected variant ID.

## Transport and parsing

`HttpStreamTransport` uses `fetch` and a local `AbortController`. It reports
header latency and chunk bytes, checks HTTP status, validates
`text/event-stream` for SSE and `ndjson`/`jsonl` for NDJSON, then feeds decoded
chunks to a parser. Configured total and idle timeouts abort the local request.
Opt-in reconnect uses bounded exponential backoff and `Retry-After`, but only
before the first raw event. Redirects are manual and bounded; same-origin is the
default, while explicit cross-origin follow strips request credentials.

`SseParser` supports arbitrary chunk boundaries, CR/LF/CRLF line endings, an
optional leading BOM, blank-line dispatch, comment lines, `event`, `data`
(including multiline data), `id`, `retry`, and a partial event flushed by
`finish()`. `toRawEvent()` retains raw
text, parsed JSON (or the original text plus `parseError`), sequence, protocol,
timestamps, and SSE metadata. `[DONE]` remains a string sentinel.

`NdjsonParser` buffers incomplete lines, accepts CRLF/LF, ignores blank lines,
and flushes a final non-newline-terminated line. `json` currently uses this
line-oriented parser. `text-stream` has a separate path that emits each
decoded non-empty body chunk as a raw event without JSON parsing; it does not
provide higher-level text framing. `fixture` is treated as NDJSON only at the
send call and is normally consumed through built-in replay.

## Mapping and reduction

`MappingEngine` copies profile mapping rules when the controller is created.
For each raw event it can match an SSE event name, a data path, or an
unconditional rule. Path extraction supports dotted paths and a leading `$` or
`$.`. An emit object recursively extracts values represented by a sole
`{path: string}` object.

`mappingMode` is `firstMatch` by default; `allMatches` runs every matching rule.
In first-match mode, `continue: true` allows the next rule to run. Mapping
errors are attached to the raw event and snapshot error list without stopping
the transport. An event with no matching rule increments the unmatched count
and remains visible in the Raw Events inspector.

Normalized events always carry version `1`, `type`, the raw sequence and
received timestamp, and `mappingRuleId`. `reduceEvent()` deduplicates by
sequence/type/rule and updates the current assistant message. It supports text
and markdown deltas, progress, tool parts, citations, citation references,
follow-ups, actions, forms, diagnostics, usage, title, and terminal stream
events.

## Host/Webview protocol

Every message has:

```ts
{ protocolVersion: 1; editorInstanceId: string; requestId: string }
```

Webview-to-host message types include `webview.ready`, profile validation/text
operations, control changes, session/request/conversation operations,
`citation.open`, `action.invoke`, form operations, and run replay/import/export.
Host-to-Webview types include `host.ready`, `workspace.section`, `profile.snapshot`,
`profile.validation`, `session.snapshot`, `request.error`, `run.imported`,
`run.exported`, and `workspaceTrust.changed`.

`session.snapshot` carries only bounded local-run summaries for the Runs list;
raw events, normalized events, requests, and recorded chat snapshots remain in
the Extension Host and are resolved by run ID for replay or export.

The host validates the envelope and instance ID with `isWebviewMessage`; this
is a shallow discriminant check, not a full runtime schema validation of every
payload. IDs sent by the Webview are resolved against host-owned snapshot/run
state before citation, action, or export work is performed.

## Persistence and replay

Control values with `persist: "workspace"`, `"global"`, or `"secret"` use
`ExtensionContext.workspaceState`, `globalState`, or `secrets`. Workspace keys
include workspace identity, profile ID, and control ID. Global and secret
control keys intentionally omit workspace identity so the same profile ID can
reuse them across projects. Legacy workspace-qualified global/secret values
are read and migrated on first load. `none` values are session-local.
The Webview uses `getState`/`setState` only for transient UI state: the current
Tree-selected section, draft, inspector tab, split percentage, and linked
message/event selection.

`LocalRunRepository` stores per-profile JSON at the extension's
`globalStorageUri/runs/<profileId>.json`, applies retention, and imports or
exports a versioned run envelope through user-selected file dialogs. Import is
bounded, accepts legacy raw-run exports, requires the current profile ID, and
assigns a new ID on collision. A replay restores the recorded snapshot only
through its last user message, feeds recorded raw events through the same
mapping/reducer path, and finishes using the stored result. It never calls the
backend. Runs without raw events cannot be replayed. `ReplayEngine` preserves
recorded elapsed-time gaps at 0.25–4× speed and supports pause, resume, step,
and stop while publishing progress in the session snapshot.

Reference-only remote history is stored in VS Code global state with workspace,
profile, configured actor, and environment scope. Applying a reference adopts
the conversation ID but does not fabricate prior messages; the snapshot shows
an explicit “Previous messages were not loaded” system notice.

## UI composition

The native Profiles Tree is grouped into Workspace and User scopes. Workspace
profiles come from the configured workspace glob; user profiles come from
`globalStorageUri/configuration/profiles`. Every profile expands to
Test and seven settings sections; selecting a child opens the same Custom
Editor and the host sends `workspace.section` to select its surface. There is
no duplicate navigation sidebar inside the Webview. **Test** places a device
chat preview on the left and a resizable Debug inspector on the right. The
preview provides Responsive plus Mobile (375×812, 390×844, 430×932), Tablet
(768×1024, 1024×768), and Web (1280×720, 1440×900) sizes. Mobile and Tablet
retain device chrome; Web uses a centered readable conversation column. Every
mode renders controls, opening/starter chips, messages, progress, tools, forms,
citations, follow-ups, actions, and the composer. Debug provides Network, Raw Events, Normalized,
Metrics, Errors, and Runs views. Reducer-owned raw sequence metadata links
assistant messages with raw/normalized events in both directions.

Network is a bounded, live-session request inspector. It stores no host fetch
objects: the host emits a serializable redacted summary for Opening, each Stream
attempt, and Stop, while the Webview renders the list plus Headers, Payload,
Response, and Timing panels. The list is cleared on session restart and is not
part of `LocalRun` persistence.

Each settings child renders only its selected General, Opening & Flow, Request,
Stream & Mapping, Chat UI, History & Errors, or Security section. Raw and
normalized event lists use a fixed-height virtual list. Except for the custom
phone preview, the visual UI follows VS Code editor/pane/list/settings patterns
and theme variables, semantic form elements, keyboard tab navigation, a
keyboard-operable split separator, focus-visible outlines, reduced-motion and
forced-color styles, and polite live regions.

## Known runtime limitations

These are current implementation facts, not benchmark conclusions:

- Migration is limited to version `0`/missing-version profiles; it is not a
  general schema conversion. Import, duplicate, and Trash-backed delete are
  available for discovered workspace profiles.
- Semantic validation checks configured secret references, known message action
  IDs, and known UI lock component names, but it does not provide full
  profile-ID/action/component/path analysis.
- JSON Schema is contributed to VS Code; semantic validation is implemented in
  `ProfileValidator`, but the two do not cover every product-brief rule.
- Profile-configured component visibility and active-turn allow/disable lists
  are applied by the Webview. Required stop context is checked before the
  remote stop request; a missing value produces a non-blocking warning.
- The editor batches snapshots through `EventBatcher` at the configured
  interval with a maximum of 50 changes. Terminal updates bypass the timer for
  an immediate flush.
- Raw and normalized events are bounded by event limits, raw events also have
  a byte limit, and messages have a conversation limit. Run JSON does not have
  an equivalent global byte limit. Messages use browser
  content visibility rather than a fully windowed list. Stable per-message
  citation numbering and late citation metadata upsert are implemented. The
  inspector supports persistent text, event-type, mapping-status, event-health,
  and terminal-event filtering. Unknown vendor events remain available in Raw
  Events and do not imply a generic renderer.
- Disabling raw-event recording makes that run unavailable for replay; metrics,
  request metadata, and the terminal result remain available.
- Reconnect count is included in run metrics, but accumulated reconnect delay
  is not. `json` buffers one bounded complete document; `text-stream` has a
  decoded-chunk path but no record framing beyond transport chunks.

## Verification and measurements

The package scripts expose `typecheck`, `lint`, `test`, `test:integration`,
`benchmark`, `compile`, `package`, and `mock-server`. `test:integration`
launches a clean VS Code Extension Host. The following values were observed on 2026-08-26
with Node 26.3.1 on macOS 26.5.2 arm64:

| Scenario | Observed result | Notes |
| --- | --- | --- |
| 20,000 text deltas | 23.4273 ms mean (42.6853 runs/s) | Mapping through two all-match rules |
| 5,000 raw events | 1.0457 ms mean (956.26 runs/s) | 5,000-event, 10 MiB bounded buffer; no drops for this payload |
| 100 correlated tool/citation/follow-up groups | 0.1095 ms mean | 300 reducer events |
| Production bundles | 90,442 B host; 251,069 B Webview JS; 18,769 B CSS | Minified, `vscode` external |

See [performance.md](performance.md) for the repeatable procedure and the
distinction between these core microbenchmarks and browser/UI measurements.
