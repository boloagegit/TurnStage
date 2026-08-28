# Profile and environment schema

TurnStage configuration is JSON with comments and trailing commas allowed
(JSONC). Profiles use the `*.turnstage.jsonc` suffix; environments use
`*.environment.jsonc`. The shipped templates are the most useful complete
examples:

- `resources/templates/basic-sse-chat.turnstage.jsonc`
- `resources/templates/agent-flow.turnstage.jsonc`
- `resources/templates/local.environment.jsonc`

Both file patterns are associated with a JSON Schema in `package.json`, and
the custom editor also runs `ProfileValidator` for semantic diagnostics. The
profile schema is versioned at `version: 1`.

The **Migrate Profile** command can update a profile with a missing/`0` version
to version `1` after confirmation. It creates a `<profile>.v0.backup` file,
applies a structured edit, and opens a diff for review. Versions other than
`0` and `1` are rejected; this is a narrow version-field migration, not a
general schema conversion.

## Profile root

The schema requires `version`, `id`, `name`, `conversation`, and `stream`.

| Property | Type / values | Current behavior |
| --- | --- | --- |
| `$schema` | string, optional | Editor schema hint; normally points to the bundled profile schema |
| `version` | `1` | Other versions are rejected by the semantic validator |
| `id` | lowercase slug matching `^[a-z0-9][a-z0-9-]*$` in the schema | Used for control keys and local-run storage |
| `name` | non-empty string | Label in the Tree View and custom editor |
| `description` | string, optional | Display/documentation metadata |
| `environment` | string, optional | Selects an environment by ID; an unknown ID is diagnosed when environments are discovered |
| `controls` | array of controls, optional | Rendered above the chat and sent in request context |
| `opening` | opening definition, optional | Static/request/disabled opening behavior |
| `conversation` | object, required | Contains `send` and optional `stop` definitions |
| `stream` | stream definition, required | Transport and mapping rules |
| `ui` | object, optional | Layout/composer/component hints; schema intentionally allows extra UI keys |
| `history` | object, optional | Local-run settings; schema and types allow extra keys |
| `errorPolicy` | boolean-valued object, optional | Error display/continuation hints; not every flag is interpreted by the runtime |
| `security` | object, optional | URI scheme/domain and VS Code command allowlists |
| `metrics` | object, optional | Optional list of metric names |

The root schema has `additionalProperties: false`, so an unknown root key is a
JSON Schema error even where a nested object deliberately permits extensions.

## Controls

```jsonc
{
  "id": "actor",
  "type": "select",
  "label": "Simulation Actor",
  "default": "actor-a",
  "persist": "workspace",
  "resetOnNewConversation": false,
  "options": [
    { "label": "Test Actor A", "value": "actor-a" },
    { "label": "Test Actor B", "value": "actor-b" }
  ]
}
```

`type` is `select`, `boolean`, or `text`. A select uses string-valued
`options`; a boolean renders a checkbox; text renders an input. `default` is
untyped. `persist` may be `workspace`, `global`, `none`, or `secret` in the
schema/type. Workspace/global values use VS Code state, `none` remains
session-local, and `secret` values are JSON-encoded in SecretStorage. Control
workspace keys include workspace identity, profile ID, and control ID. Global
and secret keys include profile ID and control ID but omit workspace identity,
so they can be reused across projects. Existing workspace-qualified global and
secret keys are migrated when the profile is next loaded.

Controls are disabled while the turn is active. **New conversation** preserves
configured controls unless their definition explicitly sets
`resetOnNewConversation: true`, in which case the default is restored and any
persistent value is updated.

Duplicate control IDs are reported by `ProfileValidator`. The current
validator does not check that select options are unique or that a default is a
valid option.

## Opening

```jsonc
{
  "opening": {
    "mode": "request",
    "trigger": "sessionStart",
    "request": {
      "method": "POST",
      "url": "${env.baseUrl}/agent/opening",
      "headers": { "Content-Type": "application/json" },
      "body": { "scenarioId": "sample-scenario" }
    },
    "response": {
      "messagePath": "$.message",
      "startersPath": "$.options"
    },
    "fallbacks": [{
      "message": "Hello, I am a test assistant. What would you like to explore?",
      "starters": []
    }],
    "failurePolicy": {
      "allowRetry": true,
      "useFallbackOnNetworkError": true
    }
  }
}
```

`mode` is:

- `static`: uses `message` and `starters` without a network request;
- `request`: runs when the user invokes **Start Session** (and is blocked by
  Workspace Trust when untrusted);
- `disabled`: no opening message.

`request` is a request definition without variants in the shared TypeScript
model. The schema is permissive through its request reference. A request
opening reads the response paths (defaults `$.message` and `$.options`) and
requires the message value to be a string. Fallbacks are evaluated in order
against response data, HTTP status, missing-message state, or error type. An
unconditional fallback acts as a catch-all. When `allowRetry` is enabled, a
failed opening exposes Retry; configured fallback and request-inspection
actions are also shown when applicable.

Starters have `id`, `label`, `prompt`, and `behavior` (`send`, `fill`, or
`action`), with an optional `actionId`. `send` submits immediately, while
`fill` puts the prompt in the composer. The current opening renderer does not
invoke starter `action` behavior.

## Requests and variants

Every profile must contain `conversation.send` with `method` and `url`. The
semantic validator also requires at least one `variants` entry, even though
the JSON Schema request definition makes `variants` optional in general.

```jsonc
{
  "conversation": {
    "send": {
      "method": "POST",
      "url": "${env.baseUrl}/basic/chat/stream",
      "headers": {
        "Accept": "text/event-stream",
        "Content-Type": "application/json"
      },
      "variants": [
        {
          "id": "first-turn",
          "when": { "path": "conversation.id", "operator": "notExists" },
          "body": {
            "message": { "$value": "input.text" }
          }
        },
        {
          "id": "continuation",
          "when": { "path": "conversation.id", "operator": "exists" },
          "body": {
            "message": { "$value": "input.text" },
            "conversationId": { "$value": "conversation.id" }
          }
        }
      ],
      "timeoutMs": 120000,
      "idleTimeoutMs": 30000,
      "reconnect": {
        "maxAttempts": 2,
        "baseDelayMs": 500,
        "maxDelayMs": 10000,
        "retryOnStatuses": [429, 502, 503, 504]
      },
      "redirectPolicy": "same-origin",
      "maxRedirects": 5
    }
  }
}
```

Request methods are `POST`, `GET`, `PUT`, `PATCH`, or `DELETE`. Headers are
string-valued; body is untyped JSON. A variant may override headers and body,
and is selected by the first matching `when` in declaration order. A variant
without `when` matches unconditionally. Request URLs must resolve to `http:`
or `https:`.

`reconnect.maxAttempts` is limited to 0–5. Delays are bounded by
`baseDelayMs` (0–30000) and `maxDelayMs` (0–120000); retry status values must
be HTTP 4xx/5xx codes. Reconnect occurs only before the first stream event.
`redirectPolicy` is `same-origin` (default), `follow`, or `error`, with
`maxRedirects` limited to 0–10. Cross-origin `follow` never forwards standard
credential headers or header values containing a secret resolved for the
current request.

The request context contains these top-level objects:

```text
input.text
conversation.id
conversation.messages
conversation.lastUserMessage
conversation.lastAssistantMessage
opening.message
controls.<id>
env.<name>
profile.id / profile.name
workspace.folder
runtime.simulationContext
turn.clientRequestId
turn.startedAt
turn.assistantMessageId
turn.interaction
```

The supported request condition operators are `equals`, `notEquals`, `exists`,
`notExists`, `oneOf`, `contains`, `startsWith`, `endsWith`, and bounded
`regex`. Regex validation uses the same pattern/input limits and nested-
quantifier guard as mapping rules.

## Stop

`conversation.stop` has `strategy: "abortOnly"` or
`"abortThenRequest"`. The latter requires a `request` according to semantic
validation. Optional fields are `requiredContext`,
`onMissingContext: "localAbortWithWarning"`, `preservePartialContent`, and
`appendSystemNotice`.

Current execution always aborts the local fetch first. For `abortThenRequest`,
it then builds and sends the stop request when the workspace is trusted. A
missing `requiredContext` entry skips the remote request and records a
non-blocking remote-stop warning. The stop request reuses the live turn's
client request ID and start timestamp. The stop response is not streamed or
interpreted. When `appendSystemNotice` is true, a user or remote abort appends a
completed system message after the preserved partial assistant response.

## Stream

```jsonc
{
  "stream": {
    "transport": "sse",
    "dataFormat": "json",
    "mappingMode": "firstMatch",
    "unexpectedEndPolicy": "fail",
    "doneValue": "[DONE]",
    "mappings": []
  }
}
```

`transport` accepts `sse`, `ndjson`, `json`, `text-stream`, or `fixture`.
`mappings` is required and must contain at least one rule. `dataFormat` is
`json` or `text`; it selects whether framed SSE/NDJSON payloads are JSON-decoded
or preserved as text. `mappingMode` is `firstMatch` or `allMatches`; default
runtime behavior is first-match. `unexpectedEndPolicy` is `fail` or
`completeWithWarning`; runtime default is failure. `doneValue` defaults to the
string `[DONE]` and is checked before mapping.

The current HTTP implementation uses the SSE parser for `sse`, the
line-oriented parser for `ndjson`, one bounded complete document for `json`,
and a decoded-chunk path for `text-stream` (without higher-level record
framing). A fixture profile loads
`.vscode/turnstage/fixtures/<profile-id>.jsonl`; bundled demo profiles load the
equivalent extension resource. Both replay without a network call. See
[event-mapping.md](event-mapping.md) for mapping rules.

## UI, history, errors, security, metrics

The `ui` object supports typed layout presets (`chat-only`, `split-inspector`,
`chat-with-metrics`, `compact`), inspector position/width, composer hints,
Assistant streaming indicators (`none`, `caret`, `dots`, or `shimmer`) with a
bounded animation speed (`400`–`4000` ms) and intensity (`10`–`100` percent),
lock hints, component visibility metadata, and message action names. The
Webview applies layout/composer settings, component visibility, labels, and
active-turn allow/disable lists. The allow list wins while a turn is active;
Stop, Inspector, Configuration, history viewing, and Copy keep safe defaults.
`ui.messageActionVisibility` is `always` by default so Copy, Retry,
Edit-and-resend, and Inspect remain discoverable. Set it to `interaction` to
hide the row until its message is hovered or receives keyboard focus; touch
layouts keep the actions visible because hover is unavailable.
Message actions still resolve through the host-owned action registry and
command allowlist rather than arbitrary profile code.

`history.localRuns` can specify `enabled`, `maxRuns`, and record flags. Runs are
stored in extension global storage. The individual flags control whether raw
events, normalized events, and the chat snapshot are included; request
metadata, metrics, and the terminal result remain available. A run without raw
events cannot reproduce event replay.

`history.remoteSessions.mode: "referenceOnly"` stores conversation ID, title,
timestamp, actor, and environment in VS Code global state under a workspace-
and-profile-scoped key. Applying a reference sets the conversation ID and
clears visible chat content; because no message-load endpoint is configured,
TurnStage explicitly says that previous messages were not loaded.

`errorPolicy` fields are booleans: `preservePartialContent`, `showErrorPart`,
`keepConversationId`, `allowContinuation`, and `releaseAllLocks`. Failed turns
show an error part unless `showErrorPart` is explicitly false, can discard
partial assistant content, can clear the conversation ID, and can require a
new conversation before another send. Reaching any terminal state releases
active-turn locks.

`security` accepts `allowedUriSchemes` (`https`, `http`, `file`),
`allowedDomains`, and `allowedCommands`. URI and command checks are host-side;
see [security.md](security.md).

`metrics.enabled` is a unique string array for run-level metric presentation.
`metrics.messageEnabled` optionally restricts which metrics are rendered below
an Assistant message. The built-in IDs are `ttft` and `totalDuration`; any
mapped per-message metric ID can be listed beside them. An empty or omitted
list shows only the two built-ins; mapped backend values require explicit
opt-in. Per-message samples are
emitted through `message.metric.updated`; the mapping supplies the metric ID,
extracted value, optional message ID, label, unit, display format, and
aggregation. See
[event-mapping.md](event-mapping.md#per-message-metrics). The run collector
still emits the fields described in [performance.md](performance.md),
regardless of an enabled-list filter.

Backend `usage.updated` data is also hidden from Chat by default because its
token accounting cannot be verified by TurnStage. It remains inspectable in
Debug; set `ui.components.usage.visible` to `true` only when the backend's
measurement scope is understood.

## Environment schema

Environment files use this shape:

```jsonc
{
  "version": 1,
  "id": "local",
  "name": "Local Mock Server",
  "variables": {
    "baseUrl": "http://127.0.0.1:8787"
  },
  "secretReferences": {
    "apiToken": "local-api-token"
  }
}
```

TurnStage registers both profile and environment schemas with VS Code by file
name, so copied starter files do not need a relative `$schema` path. This keeps
validation working in workspace and user profile directories alike.

The environment schema requires `version`, `id`, `name`, and `variables`,
rejects unknown root properties, and permits arbitrary JSON values under
`variables`. `id` uses the same lowercase-slug pattern. `secretReferences` is
an optional string-to-string map and never contains a secret value. When a
profile resolves `${secret.apiToken}`, the host maps `apiToken` to the
environment's `local-api-token` SecretStorage key (or uses the placeholder name
when no mapping exists).

## JSONC and validation workflow

`ProfileCodec` parses comments and trailing commas with `jsonc-parser` and
returns both a typed value and a parse tree. Parse errors prevent controller
creation. VS Code JSON validation handles schema-level diagnostics; the
semantic validator publishes diagnostics to Problems and the Webview.

Current semantic checks include:

- profile version, ID, name, send request, request variant, and stream mapping;
- duplicate control IDs and mapping IDs;
- required emit fields for known normalized event types;
- regex type/length/basic nested-quantifier/compilation checks;
- immediate unreachable-rule warning after an unconditional first-match rule;
- required stop request for `abortThenRequest`;
- supported URI schemes;
- declared secret references for the selected environment;
- known request template roots plus referenced controls/environment variables;
- known message action IDs and UI lock component names;
- duplicate literal response-action IDs and starter action IDs;
- a warning for strings that resemble a token in the profile.

Validation errors block controller/session request creation. Duplicate profile
IDs are diagnosed across discovered files with related locations. Template
validation covers known context roots and statically resolvable controls,
environment variables, and secret references; deeply dynamic backend paths
remain runtime-validated. Migration is implemented
separately and is limited to the version-0-to-1 operation described above.

## Editing and discovery rules

Profiles are discovered by the configured workspace-relative glob, with
`node_modules` and `.git` excluded. The custom editor reads and watches the
same `TextDocument` as the native text editor. Visual edits use structured
JSONC edits and VS Code Undo/Redo; **Open Configuration as Text** opens the
same URI with the default text editor. The visual editor patches profile
metadata plus supported Flow, request, mapping, layout, composer, component
visibility, and active-turn lock paths. Mapping arrays support add, edit,
delete, and reorder through structured JSONC edits, preserving comments
outside the edited value.
