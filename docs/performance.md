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
| `turnstage.streamBatchIntervalMs` | `32` | 16–100 ms; batching interval for host-to-Webview `session.snapshot` messages |
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

## Host-to-Webview update path

The custom editor's `sendSession` function queues changes through
`EventBatcher` using `streamBatchIntervalMs` and a maximum batch of 50 changes.
A burst therefore produces fewer `session.snapshot` messages than one message
per event, while the maximum batch forces progress under continuous input. The
snapshot contains the current session, raw/normalized arrays, errors, metrics,
and local runs.

Terminal changes bypass the timer and flush immediately. There is no
sequence-range field in the host protocol because the Webview still receives a
bounded current-state snapshot rather than event deltas.

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
- message text/markdown deltas are merged into one part per type by the
  reducer;
- chat auto-scrolls only while the user remains near the bottom, with a Jump
  to latest control otherwise;
- stream updates are delivered as snapshots at the configured debounce rate;
- CSS uses VS Code theme variables and reduced-motion rules rather than a
  separate visual runtime.
- Chat screenshot rendering is user-triggered, capped at 8 million output
  pixels, and bounded again by a 24 MiB clipboard-side PNG limit.

The current UI does not virtualize the conversation message list, does not use
`React.memo`, and does not defer syntax highlighting (code is rendered as text
inside a simple code block). Fixed-height event rows do not expand; selection
updates a separate detail region. Inspector text search and event-type
filtering are implemented; sequence-range batches and incremental citation
indexing are not.

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

Measured 2026-08-28 with Node 26.3.1 on macOS 26.5.2 arm64. These are
microbenchmarks and do not substitute for a VS Code UI trace.

| Scenario | Result | Environment/date | Notes |
| --- | --- | --- | --- |
| SSE representative chunks | 0.0022 ms mean; 445,632.68 runs/s | Node 26.3.1, 2026-08-28 | Chunk-safe parser microbenchmark |
| NDJSON representative chunks | 0.0011 ms mean; 891,845.46 runs/s | Node 26.3.1, 2026-08-28 | Chunk-safe parser microbenchmark |
| One event through all matching rules | 0.0012 ms mean; 851,220.47 runs/s | Node 26.3.1, 2026-08-28 | Generic mapping overhead |
| 20,000 text deltas | 22.1482 ms mean; 45.1504 runs/s | Node 26.3.1, 2026-08-28 | Two all-match mapping rules |
| 5,000 raw events | 1.0522 ms mean; 950.35 runs/s | Node 26.3.1, 2026-08-28 | No drop for the benchmark payload |
| 100 tool/citation/follow-up groups | 0.2332 ms mean; 4,287.55 runs/s | Node 26.3.1, 2026-08-28 | 300 reducer events |
| Abort, timeout, disconnect cleanup | Unit paths passed; UI trace not measured | Vitest, 2026-08-28 | Do not infer browser responsiveness |
| Production bundle sizes | 150,042 B host; 385,256 B Webview JS; 97,919 B CSS | esbuild, 2026-08-28 | Minified, `vscode` external; integration bundle excluded from VSIX |

## Current performance limitations

- Raw and normalized events are bounded by the configured event limit, and
  messages by the configured conversation limit; full recorded runs can still
  be substantially larger than their list summaries.
- Recorded-run lists send bounded summaries to the Webview; full raw events,
  normalized events, requests, and snapshots remain host-side.
- Host snapshot updates are batched by `streamBatchIntervalMs` with a maximum
  batch of 50 changes; terminal updates are flushed immediately.
- Conversation messages use browser content visibility rather than a fully
  windowed list. Raw-event details render separately from fixed-height rows.
- Replay event pacing is scheduler-based and is not validated by a full UI
  trace under Extension Host load; displayed message timings remain the
  original recorded measurements.
- Bounded pre-data reconnect records its count, but not accumulated reconnect
  delay.
- A benchmark runner exists; CI performance gates and automated memory-budget
  assertions are not yet defined.
