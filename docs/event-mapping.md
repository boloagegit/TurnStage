# Event mapping and normalized events

TurnStage separates backend wire events from the chat state used by the
renderer:

```text
SSE / NDJSON / fixture record
  → RawStreamEvent
  → MappingEngine rule match
  → path extraction
  → version-1 NormalizedEvent
  → reduceEvent(SessionSnapshot)
```

Mappings live in `profile.stream.mappings`. The shipped examples are
`resources/templates/basic-sse-chat.turnstage.jsonc` and
`resources/templates/agent-flow.turnstage.jsonc`.

## Raw events

The transport assigns an increasing sequence within a request and emits this
shape:

```ts
interface RawStreamEvent {
  sequence: number;
  receivedAt: number;       // epoch milliseconds
  elapsedMs: number;        // from transport start
  protocol: 'sse' | 'ndjson' | 'json' | 'text-stream' | 'fixture';
  sse?: { event?: string; id?: string; retry?: number };
  raw: string;              // wire event or line
  data: unknown;            // parsed JSON, or original text
  parseError?: string;
  mappingRuleId?: string;
  mappingError?: string;
}
```

SSE metadata comes from `event`, `id`, and numeric `retry` fields. NDJSON has no
SSE metadata. If JSON parsing fails, `data` remains the original text and
`parseError` is recorded; the raw record is still available to the mapper and
inspector. The string `[DONE]` is kept as a sentinel without a parse error.

The SSE parser is chunk-safe: it accepts CR/LF/CRLF, an optional leading BOM,
comments, multiline `data`, blank-line dispatch, arbitrary chunk boundaries,
and a final partial event. The
NDJSON parser buffers a partial line, ignores blank lines, and flushes a final
line at end of stream. A `text-stream` transport record is emitted for each
non-empty decoded body chunk and intentionally skips JSON parsing. A raw event
is created only for a dispatched SSE event with at least one data field, a
non-empty NDJSON line, or a non-empty text-stream chunk.

## Rule shape

```jsonc
{
  "id": "message",
  "match": { "event": "message" },
  "emit": {
    "type": "content.text.delta",
    "text": { "path": "$.text" }
  }
}
```

`id` identifies the rule. `match` can contain:

| Field | Meaning |
| --- | --- |
| `event` | Exact match against `raw.sse.event` |
| `path` | Dotted path read from `raw.data`; a leading `$`/`$.` is optional |
| `operator` | `equals` (default), `notEquals`, `exists`, `notExists`, `oneOf`, `contains`, `startsWith`, `endsWith`, or `regex` |
| `value` | Comparison value, including an array for `oneOf` |

An event condition and a path condition are ANDed. A rule with only `event`
matches that SSE event. A rule with an empty `match` is unconditional. For
clarity, put a `path` or `event` in every non-unconditional rule; a condition
with neither does not become a useful value comparison.

`equals` and `notEquals` use JavaScript strict equality. `exists` means the
value is neither `undefined` nor `null`; `notExists` is its inverse. `contains`
checks array membership for arrays and a string substring otherwise.
String operators coerce the actual and expected values to strings. `regex`
tests at most the first 4096 characters of the actual value. The semantic
validator limits the pattern to 256 characters, rejects a basic nested-
quantifier shape, and checks compilation; accepted expressions are compiled
once when the Mapping Engine is created.

## Extraction

An emit leaf of the exact form `{ "path": "$.field" }` reads a value from the
raw event data. `$` and `$.` both mean the root; dotted object traversal is
supported.

```jsonc
{
  "type": "tool.completed",
  "toolCallId": { "path": "$.toolCallId" },
  "result": { "path": "$.result" }
}
```

Extraction recursively walks arrays and objects, so a nested object can contain
several path leaves. Literal values are retained. Mapping extraction does not
use request-template `$value` or transforms; those belong to request bodies and
headers.

The mapper emits:

```ts
interface NormalizedEvent {
  version: 1;
  type: string;
  sequence: number;
  receivedAt: number;
  rawSequence?: number;
  mappingRuleId?: string;
  [key: string]: unknown;
}
```

The event receives the raw sequence/timestamp and the rule ID. A rule may emit
any string `type`; reducer behavior is defined only for the event types listed
below.

## Rule order and mapping mode

Rules are copied when `SessionController` is created. They are evaluated in
profile order for each raw event:

- `firstMatch` (the default): stop after the first match unless that rule has
  `continue: true`;
- `allMatches`: evaluate every rule, regardless of `continue`.

The validator warns when an unconditional first-match rule makes the following
rule unreachable. It does not perform a complete reachability analysis.

Matched rule IDs are joined onto `raw.mappingRuleId`. If extraction/matching
throws, the mapper records `{ ruleId, message }`; the transport continues. The
controller copies the error to `raw.mappingError`, adds a `MappingError` to the
snapshot, and increments `mappingErrorCount`.

If no rule emits an event, `unmatchedEventCount` increments. The raw event is
still retained until the raw buffer limit and remains visible in the Raw Events
inspector. Unknown backend event names therefore do not stop a turn.

## Normalized event types handled by the reducer

The current reducer handles these types:

| Type | Snapshot effect |
| --- | --- |
| `conversation.started` | Set conversation ID, optionally assistant ID, and turn to streaming |
| `conversation.title.updated` | Set conversation title |
| `content.text.delta` | Append text to one assistant text part |
| `content.markdown.delta` | Append markdown to one assistant markdown part |
| `content.citation` | Add a citation-reference message part |
| `progress.started` / `progress.updated` | Upsert a running progress part |
| `progress.completed` | Mark the progress part completed |
| `tool.started` | Create a running tool-call part |
| `tool.arguments.delta` | Append tool arguments to a tool-call part |
| `tool.completed` / `tool.failed` | Complete/fail a tool-call part and attach result/error |
| `citation.upsert` | Add or merge a citation by ID |
| `citation.attach` | Add a citation if its ID is not present |
| `followup.upsert` / `followup.remove` | Add/merge or remove follow-up chips |
| `action.upsert` / `action.remove` | Add/merge or remove response actions |
| `form.upsert` | Add a declarative form part |
| `diagnostic.updated` | Add a diagnostic part |
| `usage.updated` | Add a usage part |
| `stream.completed` | Set turn to completed, then finalize |
| `stream.failed` | Add a stream error and finalize as failed |
| `stream.aborted` | Finalize as aborted |

The reducer creates an assistant message when an event arrives and no pending
assistant exists. This allows message/content events before a start event. It
deduplicates an event when sequence, type, and mapping rule ID all match an
existing normalized event.

## Examples

### Basic SSE

The Basic SSE profile maps a minimal event sequence:

```jsonc
"mappings": [
  { "id": "start", "match": { "event": "start" },
    "emit": { "type": "conversation.started",
      "conversationId": { "path": "$.conversationId" },
      "assistantMessageId": { "path": "$.assistantMessageId" } } },
  { "id": "status", "match": { "event": "status" },
    "emit": { "type": "progress.updated", "text": { "path": "$.text" } } },
  { "id": "message", "match": { "event": "message" },
    "emit": { "type": "content.text.delta", "text": { "path": "$.text" } } },
  { "id": "done", "match": { "event": "done" },
    "emit": { "type": "stream.completed" } }
]
```

The local mock server emits `start`, `status`, `message`, `title`, and `done`.
The fixture contains the same event family and is replayed without network
access.

### Agent flow

The Agent Flow profile additionally maps `tool_call`, `tool_result`,
`citation`, `citation_reference`, `action`, `form`, `followup`, `diagnostic`,
`usage`, `title`, and `error`. For example:

```jsonc
{
  "id": "citation",
  "match": { "event": "citation" },
  "emit": { "type": "citation.upsert", "citation": { "path": "$" } }
}
```

The citation data is copied as an entity; a later citation with the same ID
merges into the existing message citation.

## Completion, errors, and sentinels

Before mapping, `SessionController.acceptRaw()` checks whether `raw.data` is
equal to `stream.doneValue` (default `[DONE]`). A sentinel completes the turn
without requiring a mapping rule. A mapped `stream.completed`, `stream.failed`,
or `stream.aborted` event also goes through the shared finalization path.

If the transport ends without a terminal event, `unexpectedEndPolicy` controls
the result: `fail` (the runtime default) creates `UnexpectedStreamEndError`,
while `completeWithWarning` records a warning and completes. Parse errors do
not by themselves end the stream; they remain visible and can lead to an
unmatched mapping.

## Current limits and authoring advice

- Regex rules are compiled once when the engine is created; path extraction is
  intentionally evaluated against each raw event.
- The Events editor includes a paste/test surface that previews matched rules,
  normalized events, and mapping errors without executing arbitrary code.
- Unknown normalized event types are retained in `normalizedEvents` but have no
  reducer effect.
- Citation references use stable, message-local numeric labels and late
  metadata upserts update the corresponding Sources entry.
- `form.upsert` merges an existing form with the same ID.
- The reducer's tool placeholder handling is intentionally permissive for
  out-of-order data, but does not expose a separate `tool-result` message role.
- The request transport uses line-oriented NDJSON for `json` as well as
  `ndjson`; `text-stream` has a decoded-chunk path but no record framing beyond
  transport chunks.
