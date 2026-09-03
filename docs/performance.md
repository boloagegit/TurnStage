# Performance and measurement plan

This document records the current performance controls, repeatable measurement
steps, and observed results. Run `npm run benchmark` to repeat the core
measurements.

## Runtime budgets

The contributed VS Code settings are:

| Setting | Default | Bounds / role |
| --- | ---: | --- |
| `turnstage.maxBufferedEvents` | `5000` | Minimum 100; caps raw and normalized events retained in a live session |
| `turnstage.maxConversationMessages` | `500` | 50–5000; caps conversation messages retained in memory |
| `turnstage.maxBufferedBytes` | `10485760` | Minimum 1048576; caps JSON byte size of the raw-event buffer (10 MiB default) |
| `turnstage.streamBatchIntervalMs` | `32` | 16–100 ms; batching interval for Host-to-Webview session updates after the initial checkpoint |
| `turnstage.runRetention` | `20` | 1–100; fallback local-run retention |
| `turnstage.profileGlob` | `.vscode/turnstage/profiles/*.turnstage.jsonc` | Discovery scope, not a throughput limit |
| `turnstage.logLevel` | `info` | Filters Output Channel entries; `debug` adds per-attempt, chunk, event, retry, timeout, and mapping metadata without payloads |

`EventBuffer` stores each raw event with a JSON byte estimate. On overflow it
removes the oldest entries until both event and byte limits are satisfied and
increments `droppedEventCount`. `clear()` resets values and the dropped count.
The Webview warns when drops occurred.

Normalized events use the same event-count ceiling, conversation messages use
`maxConversationMessages`, and runtime errors retain the newest 500 entries.
The snapshot records each dropped category so the Webview can warn explicitly.
A single raw event larger than the byte budget can be evicted by the raw buffer.

The live Network inspector retains at most 50 request attempts. Each response
preview is capped at 64 KiB before it crosses into the Webview; Stop responses
are also read through that bound. Network entries are ephemeral and are reset
with the session rather than copied into Recorded Runs.

Connection Doctor inspects at most 1,000 raw and normalized events and an
8 KiB response prefix, and returns no response content. The causal timeline
retains at most 256 structural entries; the Profile Webview renders at most 16
at once. Failure clustering processes at most 500 result items. Batch planning
rejects plans above its case, attempt, request, or concurrency ceilings before
execution, while reliability aggregation processes a bounded attempt sample and
ignores non-finite durations.

## Host-to-Webview update path

The custom editor first sends a full `session.snapshot` checkpoint. Its
`sendSession` function then queues changes through `EventBatcher` using
`streamBatchIntervalMs`; the normal flush asks `SessionDeltaTracker` for a
bounded `session.delta`. Event arrays carry a retained-sequence boundary and an
append-only suffix, messages carry remove IDs and changed tail upserts, and run,
request-preview, or Network projections are included only when changed.

The tracker deliberately returns no delta when the session identity changed or
retained event ordering can no longer be proven. The host then sends and records
a fresh full checkpoint. The Webview performs the same base-session check and
requests a resync instead of applying a mismatched delta. Terminal changes
bypass the timer and flush immediately.

The Webview keeps the current Tree-selected section, draft, inspector tab,
split size, and linked message/event selection through VS Code's
`getState`/`setState`. It does
not use `localStorage` as an authority. Panel disposal clears the editor timer,
disposes listeners/controller, and aborts an active request through the
controller.

## Rendering behavior

The current UI includes these performance-conscious choices:

- raw and normalized event inspectors use a fixed-row virtual list and render a
  small visible window;
- event details render in a separate inspector region; tool JSON remains in a
  collapsible element;
- read-only JSON inspectors share a memoized bounded formatter and tokenized
  syntax view with local search rather than introducing an editor runtime;
- linked adversarial discovery sends at most 100 prompt-free case summaries and
  loads only the selected case body for structured editing;
- message text/markdown deltas are merged into one part per type by the
  reducer;
- Chat initially mounts the latest 200 messages and lets the user reveal earlier
  history in 200-message steps up to 1,000 mounted messages;
- Markdown input is bounded and its parsed block tree is memoized by message
  text;
- chat auto-scrolls only while the user remains near the bottom, with a Jump
  to latest control otherwise;
- stream updates use bounded deltas after a full checkpoint, at the configured
  batching interval;
- adaptive Assistant reveal segments even a large single-event response into a
  bounded visual schedule and catches up within `maxVisualLagMs`; it never delays
  canonical events, TTFT, evidence, or terminal state;
- Opening response normalization visits at most 8 configured blocks, 20 items
  per block, and 200 nodes for a JSON detail block before publishing one
  canonical snapshot; no provider-specific renderer or editor runtime is loaded;
- preview size, orientation, and zoom controls mount in a native disclosure only
  when requested so narrow toolbars retain their primary actions;
- CSS uses VS Code theme variables and reduced-motion rules rather than a
  separate visual runtime.
- Chat screenshot rendering is user-triggered, capped at 8 million output
  pixels, and bounded again by a 24 MiB clipboard-side PNG limit.

The conversation list is not a fully virtualized variable-height list; the
1,000 mounted-message cap is a deliberate UI bound below the configurable
5,000-message canonical session ceiling. Fixed-height event rows do not expand;
selection updates a separate detail region. Inspector text search and
event-type filtering are implemented. Delta messages use sequence boundaries,
but incremental citation indexing is not implemented.

## Activation and bundle behavior

The manifest does not use wildcard activation. Activation is tied to the
TurnStage view, custom editor, and contributed commands. Profile discovery is
performed by the Tree View's `getChildren`; the file watcher refreshes on the
profile glob and debounces for 150 ms. The watcher is disposed with the tree
provider.

`esbuild.mjs` creates separate bundles:

- Extension Host: Node platform, CommonJS, external `vscode`, Node 20 target;
- Webview: browser platform, IIFE, ES2022 target.

Production builds minify; watch builds keep source maps. `vscode` is not bundled
into the host output. The repository has no bundle-size reporting script, so
record sizes from the exact build under test rather than quoting an estimate.

Initialization does not scan/copy templates until the user explicitly runs
Initialize Workspace. Built-in fixtures are read when a built-in demo editor is
loaded, not at extension activation. Network requests begin only for explicit
opening/session actions (static openings are local).

## Metrics collected per run

`MetricsCollector` records fields in `MetricsSnapshot`:

| Metric | Definition in current code |
| --- | --- |
| `requestStartedAt` | Epoch time when the turn metrics collector starts |
| `headersLatency` | First response-header callback minus request start |
| `firstChunkLatency` | First non-empty body chunk callback latency |
| `firstEventLatency` | First raw event received time minus request start |
| `ttft` | First mapped text/markdown delta received time minus request start |
| `streamDuration` | Finish time minus request start plus headers latency, when headers latency exists |
| `totalDuration` | Finish time minus request start |
| `eventCount` | Number of raw events accepted |
| `byteCount` | Sum of body chunk byte lengths |
| `averageEventGap` | Mean interval between consecutive raw event timestamps |
| `maxEventGap` | Maximum interval between consecutive raw event timestamps |
| `parseErrorCount` | Raw events with a parse error |
| `mappingErrorCount` | Mapping errors reported by the engine |
| `unmatchedEventCount` | Raw events producing no normalized events |
| `reconnectCount` | Number of bounded reconnect attempts made before the first raw event |
| `abortReason` | Reason supplied when an aborted run is finalized |

TTFT is therefore a first displayable text/markdown normalized event, not the
first arbitrary backend event. A run does not expose reconnect-delay or
percentile metrics, even when bounded pre-data reconnect is configured.
Percentiles must be calculated externally from multiple runs, never invented
for a single run. Token usage is shown only when supplied
by a backend `usage.updated` event; character counts must not be labeled as
tokens.

The active Assistant message mirrors `ttft` and `totalDuration` from this run
collector. TTFT becomes visible when the first displayable delta is mapped;
total duration becomes visible only at a terminal state. Recorded runs persist
those values with the message, and replay restores the original recorded
measurements rather than replacing them with the replay scheduler's wall time.

## Repeatable benchmark scenarios

Run the exact same build and VS Code/Node version for each scenario. Use only
example values and a deterministic fixture/mock server; do not send real
credentials or production traffic.

1. **Large text stream:** feed 20,000 `content.text.delta` events, record host
   processing time, Webview update count, interaction responsiveness, final
   text completeness, and raw/normalized memory.
2. **Raw-event cap:** feed 5,000 raw events, then repeat with a payload large
   enough to cross `maxBufferedBytes`; verify ordering of retained events and
   the displayed drop count.
3. **Mixed agent flow:** include multiple tool calls, tool results, citation
   upserts/attachments, follow-ups, actions, forms, diagnostics, and usage;
   expand tool JSON during streaming and inspect the final snapshot.
4. **User scrolling:** scroll upward during a long stream and verify that
   selection/position is preserved, auto-scroll pauses, and Jump to latest is
   available.
5. **Abort/disconnect:** abort while waiting for the first event and while
   streaming; exercise remote-stop success/failure, timeout, and disconnect;
   confirm turn finalization and request/timer/listener cleanup.

For each run capture:

- commit/build identifier, OS, VS Code version, Extension Host placement, and
  Node version;
- profile/settings and fixture mode;
- wall-clock duration, metrics snapshot, retained/dropped event counts;
- bundle byte sizes (`dist/extension.js`, `dist/webview.js`, and any shipped
  style asset);
- qualitative UI observations and any error/output lines.

## Observed results

Measured 2026-09-01 with Node 26.3.1 on macOS 26.5.2 arm64. These are
microbenchmarks and do not substitute for a VS Code UI trace.

| Scenario | Result | Environment/date | Notes |
| --- | --- | --- | --- |
| SSE representative chunks | 0.0026 ms mean; 387,350.29 runs/s | Node 26.3.1, 2026-09-01 | Chunk-safe parser microbenchmark |
| NDJSON representative chunks | 0.0017 ms mean; 583,894.89 runs/s | Node 26.3.1, 2026-09-01 | Chunk-safe parser microbenchmark |
| One event through all matching rules | 0.0023 ms mean; 441,687.91 runs/s | Node 26.3.1, 2026-09-01 | Generic mapping overhead |
| 20,000 text deltas | 38.2364 ms mean; 26.1531 runs/s | Node 26.3.1, 2026-09-01 | Two all-match mapping rules |
| 5,000 raw events | 1.5875 ms mean; 629.92 runs/s | Node 26.3.1, 2026-09-01 | No drop for the benchmark payload |
| 100 tool/citation/follow-up groups | 0.1315 ms mean; 7,605.03 runs/s | Node 26.3.1, 2026-09-01 | 300 reducer events |
| 5,000 correlated text deltas | 1.2996 ms mean; 769.44 runs/s | Node 26.3.1, 2026-09-01 | Reducer aggregation path |
| Apply one delta to 5,000 events and 500 messages | 0.0375 ms mean; 26,667.71 runs/s | Node 26.3.1, 2026-09-01 | Existing checkpoint plus one append/upsert delta |
| Serialize bounded delta | 0.0011 ms mean; 925,761.69 runs/s | Node 26.3.1, 2026-09-01 | Same update as the full-snapshot comparison |
| Serialize equivalent full snapshot | 1.6936 ms mean; 590.45 runs/s | Node 26.3.1, 2026-09-01 | 5,001 events and 500 messages |
| Plan one-million-character adaptive reveal | 66.8725 ms mean; 14.9538 runs/s | Node 26.3.1, 2026-09-01 | Segmentation/planning microbenchmark, not elapsed visual reveal time |
| Normalize maximum opening response | 0.0471 ms mean; 21,230.41 runs/s | Node 26.3.1, 2026-09-03 | 8 blocks, 20 choices, 20 fields, and bounded JSON projections |
| Abort, timeout, disconnect cleanup | Unit paths passed; UI trace not measured | Vitest, 2026-09-01 | Do not infer browser responsiveness |
| Production bundle sizes | 646,114 B host; 616,242 B Webview JS; 170,985 B CSS; 188,487 B CLI | esbuild, 2026-09-03 | Minified, `vscode` external; integration bundle excluded from VSIX |

## Current performance limitations

- Raw and normalized events are bounded by the configured event limit, and
  messages by the configured conversation limit; full recorded runs can still
  be substantially larger than their list summaries.
- Recorded-run lists send bounded summaries to the Webview; full raw events,
  normalized events, requests, and snapshots remain host-side.
- Host updates are batched by `streamBatchIntervalMs`; normal updates use deltas
  after a full checkpoint, and terminal updates are flushed immediately.
- Conversation history uses progressive bounded mounting rather than a fully
  virtualized variable-height list. Raw-event details render separately from
  fixed-height rows.
- Replay event pacing is scheduler-based and is not validated by a full UI
  trace under Extension Host load; displayed message timings remain the
  original recorded measurements.
- Bounded pre-data reconnect records its count, but not accumulated reconnect
  delay.
- A benchmark runner exists; CI performance gates and automated memory-budget
  assertions are not yet defined.
