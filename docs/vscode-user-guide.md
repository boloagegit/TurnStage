# TurnStage in VS Code

Configure a chat or agent API, inspect its streamed behavior, and keep
reproducible cases with their evidence. This guide covers the desktop and
remote extension. For the browser app, see the [Web user guide](web-user-guide.md);
for F5 and source builds, see [Developing TurnStage](development.md).

## Install and open a Profile

Install [TurnStage from the Marketplace](https://marketplace.visualstudio.com/items?itemName=turnstage.turnstage),
or enter `ext install turnstage.turnstage` in Quick Open. VS Code 1.106 or
later is required.

1. Open a workspace folder and the **TurnStage** Activity Bar view.
2. Run **TurnStage: Initialize Workspace** and choose a starter option.
3. Select a Profile in the **Profiles** view to open its custom editor.
4. Check its endpoint and Environment in **Configure** before sending traffic.

Initialization is explicit: installing the extension or opening its sidebar
does not create Profile files. Existing files offer **Skip**, **Create Copy**,
or **Replace**, with an additional confirmation before replacement.

For an existing API, run **TurnStage: Create Profile from cURL**. Review the
sanitized untitled draft and choose **Create Sanitized Profile**. The parser
does not invoke a shell; it excludes captured messages/tools and converts
detected credentials to SecretStorage references.

## Try the local mock server

From a checkout with dependencies installed, run this in another terminal:

```sh
npm run mock-server
```

The server listens on `http://127.0.0.1:8787` by default. Initialize the
workspace using the mock-server option, then open **Basic SSE Chat**.
Send a message and use **Mock Scenario** to try split chunks, a slow stream,
malformed events, partial errors, HTTP failures, or disconnected responses.
**Server rewrites saved answer** exercises server-history differences.
The server simulates responses and does not call an LLM.

| Starter | Contract |
| --- | --- |
| [Basic SSE Chat](../resources/templates/basic-sse-chat.turnstage.jsonc) | POST + SSE, static opening, first/continuation requests, stop, and optional server history |
| [Agent Flow](../resources/templates/agent-flow.turnstage.jsonc) | Request-backed opening, controls, Markdown, tools, citations, forms, follow-ups, and rich-content modes |
| [Enterprise Chat Contract](../resources/templates/enterprise-chat.turnstage.jsonc) | Synthetic application contract, opening fallback, actor selection, metrics, actions, and remote stop |

See the [enterprise example](enterprise-chat-profile-guide.md) for setup.
The [Local Environment](../resources/templates/local.environment.jsonc)
contains the loopback `baseUrl`, without secret values. For a fixture-only
demo without workspace writes or API requests, run **TurnStage: Run Profile**
without a selected Profile.

## Navigate the editor

In a wide workspace, Chat stays beside **Debug**, **General tests**,
**Red Team**, and **Configure**. Debug contains Network, Raw Events,
Normalized Events, Metrics, Errors, and Runs. Configure edits the current
Profile, not VS Code's application settings.

At a workspace width of 1,024px or less, **Chat** becomes the first tab.
Switches preserve the draft, scroll, filters, and streamed response; reloading
restores the selected side. At very narrow widths, Chat uses an icon with an
accessible label. Arrow keys, Home, and End move between tabs, including Chat.

Use **TurnStage: Go to…** to jump to Chat, Debug, General tests, Red Team,
or Configure. A response's inspect action opens Debug; the gear opens
Configure. Hidden views stay mounted, so switching keeps their state.

GUI configuration changes are structured edits to `.turnstage.jsonc` and
participate in VS Code Undo/Redo. Use Save, Open JSONC, Validate, and the
first validation issue in Configure's toolbar. The [Profile schema](profile-schema.md)
defines complete fields and validation behavior.

## Chat and saved conversations

Inspect an Assistant response to compare rendered and assembled raw content.
Copy, Retry, Edit-and-resend, and Inspect act on individual messages.
The compact footer shows built-in TTFT and total-turn time by default;
mapped metrics and usage display are opt-in.

Stop aborts the local stream and attempts a configured remote stop request.
Partial content remains available. New conversation is disabled while a turn
is active and starts a new session with the configured opening and controls.

Open **Conversations** to search, switch, or delete saved conversations.
Escape closes the drawer and returns focus to its button. With local
conversation preservation enabled, starting a new conversation does not need
the destructive-restart confirmation.

A Profile can configure `conversations.list`, `conversations.history`, and
`history.conversations` independently. Server endpoints allow loading prior
messages; `verifyAfterTurn` compares the completed reply with server history.
The toolbar reports a match or the number of differences. This diagnostic
does not silently replace the local reply. See [conversation history fields](profile-schema.md#conversation-drawer-and-history).

## General tests and Red Team

1. Open **General tests → Cases** or **Red Team → Cases**.
2. Create an inline case, import a suite, or link a workspace JSONC/CSV file.
3. Review the case and request plan, then run a case or selection.
4. Open the result's evidence or **Results** for detailed outcomes and history.

Both case lists show the latest outcome and duration, plus live run status.
**Last run** summarizes the latest recorded outcome of each current case;
those outcomes may come from different runs. No second completed-run card is
added to the unified list.

General tests filter by **All**, **Failed**, and **Not run**. Failed includes
errors. Red Team summarizes **Resisted** and **Not resisted**; case outcomes
remain **Resisted**, **Attack succeeded**, **Indeterminate**, and
**Infrastructure error**. The non-resisted group includes inconclusive and
error outcomes, not only successful attacks.

The targeted rerun uses the cases counted as failures/non-resisted by the
summary. **Run history** opens that test kind's history. Filters persist when
switching between test kinds; clearing a kind's history resets its filter to All.

Pause stops dispatching and drains active cases. Resume continues the same
run; Stop aborts active requests and retains completed results. Timeouts or
incomplete evidence never establish a pass. See [automated testing](automated-testing.md)
and [adversarial testing](adversarial-testing.md) for formats, repeats,
comparison, reports, budgets, Test Explorer, and CLI.

Workspace suite links are portable. An explicitly chosen external file uses
local authorization bound to the exact Profile; other machines link their
own copy. Reports and Evidence Bundles are separate from case exports.
Detailed HTML may contain confidential conversations or payloads.

## Debug and replay

**Debug → Network** lists Opening, Stream, retry, and Stop requests. Select
a request for Headers, Payload, Response, and Timing. Sensitive outgoing
headers are masked. Network entries belong to the live session, are cleared
on reset, and are not part of recorded-run persistence.

For a failed request, compare status, first-chunk timing, total timeout, and
idle timeout. **TurnStage: Open Output** opens a correlated diagnostic
timeline. `turnstage.logLevel=debug` adds transport and mapping metadata;
Output excludes headers, bodies, query values, and payloads. Configure's
**Connection Doctor → Analyze latest response** reuses bounded evidence
without another API or model request.

**Debug → Runs** exposes recorded turns. Replay feeds saved raw events
through the mapping/reducer pipeline without contacting the backend. Runs
without raw events remain inspectable but cannot replay. Playback supports
speed selection, pause, resume, step, and stop. Import/export uses versioned
`*.turnstage-run.json` files; deleting local history does not delete exports.

Server conversation history, local saved conversations, recorded turns, and
reference-only remote IDs serve different purposes. A reference-only ID does
not load previous messages. See the [Profile schema](profile-schema.md).

## Profile storage and secrets

Workspace configuration lives under:

```text
.vscode/turnstage/
├── profiles/*.turnstage.jsonc
├── environments/*.environment.jsonc
└── fixtures/*.jsonl
```

**TurnStage: Initialize User Profiles** creates reusable configuration under
the extension's global storage. Workspace Profiles resolve workspace
Environments first, then user Environments. User Profiles use user
Environments. A workspace Profile with the same ID replaces the user Profile
as a whole; the user item stays visible as Overridden. Files are not deep-merged.

Use **TurnStage: Set Secret** for `${secret.name}` references. The Extension
Host resolves SecretStorage values. Environment `secretReferences` map
placeholder names to storage keys, not the values. Keep real credentials
out of versioned Profiles and evidence.

Restricted Mode permits viewing/editing Profiles and bundled fixture replay.
It blocks network sessions, request-backed openings, server conversations,
conversation archive reads/writes, and trust-dependent actions. Trusted
request-backed openings can run when a Profile opens; review its destination.
Known secrets over non-loopback HTTP and invalid-certificate access require
their own explicit consent. See the [security model](security.md).

## Optional Copilot assistance

With a compatible VS Code language model, use `@turnstage /diagnose`, `/run`,
`/compare`, `/configure`, or `/evidence` with an exact Profile, Run, Evidence,
Case, or Failure ID. Profile Doctor and quality reviews are explicit advisory
operations and cannot relabel deterministic results. Core chat, replay,
tests, CLI, and exports remain available without Copilot.

## Commands and settings

The manifest in [package.json](../package.json) is the complete reference.
The following tables collect common commands and settings; see
[performance](performance.md) for runtime bounds.

| Command | Purpose |
| --- | --- |
| `turnstage.initializeWorkspace` | Create starter workspace files with conflict handling |
| `turnstage.createProfile` | Create a duplicate-safe empty profile |
| `turnstage.importProfile` | Import a valid JSONC profile with duplicate-safe naming |
| `turnstage.initializeUser` | Initialize reusable user profiles and a user environment |
| `turnstage.duplicateProfile` / `turnstage.deleteProfile` | Copy a discovered profile or move it to Trash after confirmation |
| `turnstage.openProfile` | Open a profile in the custom editor |
| `turnstage.goTo` | Jump to Chat, Debug, Tests, Red Team, or Configure with a native Quick Pick |
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
| `turnstage.changeDisplayLanguage` | Choose Auto, Traditional Chinese, Japanese, Korean, or English for TurnStage profile editors |
| `turnstage.migrateProfile` | Migrate a version-0 profile after confirmation, backup, and diff review |
| `turnstage.refreshProfiles` | Refresh discovery and cross-file duplicate-ID diagnostics |

| Setting | Default | Effect |
| --- | ---: | --- |
| `turnstage.displayLanguage` | `auto` | Application-wide language for TurnStage profile editors: follow VS Code, Traditional Chinese, Japanese, Korean, or English |
| `turnstage.profileGlob` | `.vscode/turnstage/profiles/*.turnstage.jsonc` | Workspace-relative discovery glob |
| `turnstage.maxBufferedEvents` | `5000` | Maximum raw and normalized events kept in the live session |
| `turnstage.maxConversationMessages` | `500` | Maximum conversation messages kept in memory (50–5000) |
| `turnstage.maxBufferedBytes` | `10485760` | Maximum raw-buffer JSON bytes (10 MiB) |
| `turnstage.streamBatchIntervalMs` | `32` | Batching interval for Host-to-Webview session updates (16–100 ms); normal updates are deltas after a full checkpoint |
| `turnstage.runRetention` | `20` | Fallback local-run retention (1–100) |
| `turnstage.logLevel` | `info` | Minimum output-channel level: error, warn, info, or debug |
| `turnstage.notifications.enabled` | `true` | Show non-modal TurnStage notifications; selecting **Do not show again** sets it false at user scope |

Display language is application-scoped, discovery is resource-scoped, and
runtime limits are window-scoped. Endpoint-specific configuration belongs
in Profiles and Environments.
