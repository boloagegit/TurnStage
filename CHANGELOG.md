# Changelog

## Unreleased

## 0.22.4

- Added direct structured editing for an individual case in a linked adversarial
  JSONC, JSON, or CSV suite. TurnStage loads only the selected case, preserves
  unrelated rows, cases, comments, and CSV columns, and requires an explicit
  save with stale-revision and read-back verification.
- Added searchable, copyable, theme-aware syntax highlighting to read-only JSON
  inspectors and JSON/JSONC Markdown fences while keeping editable JSON fields
  as plain source inputs.
- Collapsed Chat preview size, orientation, and zoom controls into an on-demand
  settings panel so the primary toolbar remains usable at narrow widths.
- Linked-suite writes remain blocked in Restricted Mode, bounded to the exact
  Profile-authorized source, serialized per editor, and capped before parsing.

## 0.22.3

- Added the native **TurnStage: Go to…** picker for direct Chat, Debug, Red Team,
  and Configure navigation, plus pushed save/validation state in Configure.
- Made result and event triage faster with deferred search, attention/problem
  presets, active-filter counts, clear actions, actionable empty states, and
  sticky Red Team result headers while preserving bounded pagination.
- Replaced overlay notifications with in-flow status, added Host-verified Open,
  Reveal, and Copy Path actions for exports, and added a prompt-free safe result
  summary. Destructive case edits and suite unlinking now share bounded undo.

## 0.22.2

- Added a one-click duplicate action to Profile rows and made the empty Profile
  creation workflow explicit, localized, and confirmation-backed.
- Normalized bounded Opening starter payloads so common string and partial-object
  options render safely without granting malformed remote data action behavior.
- Reworked the Activity Bar mark with a larger, square, theme-aware signal-fork
  silhouette verified for legibility in both dark and light VS Code themes.

## 0.22.1

- Corrected the README and product, architecture, performance, Profile schema,
  adversarial-testing, and security documentation to match the 0.22 runtime.
- Documented incremental session checkpoints/deltas, progressive Chat mounting,
  adaptive Assistant reveal, the three-pane Debug/Red Team/Configure workspace,
  bounded Red Team catalogs, and Profile-bound external suite authorizations.
- Refreshed the repeatable benchmark record and clarified which measurements are
  microbenchmarks rather than Extension Host or end-to-end UI evidence.

## 0.22.0

- Reworked the Red Team workspace for large suites with bounded catalog loading, compact filtering and pagination, clearer result actions, causal evidence navigation, and explicit campaign or run progress without rendering every case at once.
- Added incremental session updates and bounded progressive message rendering so long conversations, dense event histories, tab restoration, and multi-turn evidence remain responsive while preserving the complete canonical session state.
- Added adaptive Assistant response reveal for large provider events, with configurable pace, maximum visual lag, and independent caret, dots, or shimmer indicators. Existing `effect` settings remain compatible; Evidence, TTFT, events, and formal test outcomes are never delayed by the presentation layer.
- Expanded validation, localization, accessibility, high-frequency event, Unicode, mock-server, Extension Host, visual-matrix, and million-character performance coverage. Hidden Webviews, terminal states, reduced motion, screen readers, timeouts, cancellations, and incomplete evidence continue to fail or flush safely rather than becoming false passes.

## 0.19.0

- Renamed the broad Evidence workspace to Debug and kept Network, Raw Events, Normalized Events, Metrics, Errors, and Runs together under the clearer diagnostic label. Existing persisted workspace state continues to normalize safely.
- Added one-click opening for safe workspace-relative linked adversarial CSV, JSON, and JSONC suites. The Extension Host verifies that the requested path is an exact link from the current Profile before opening it in the editor.
- Added persistent run, rerun, cancellation, and replay feedback across workspace tabs. Duplicate operations are rejected, Stop remains available while work is active, and cancelled or incomplete runs are never reported as completed.
- Raw Events now show both cumulative elapsed time and the adjacent event gap, derived from the complete unfiltered stream so search and filters cannot distort timing evidence.
- Reverified the existing incremental Assistant streaming experience with real HTTP SSE fixtures, batched Webview updates, configurable caret, dots, or shimmer indicators, progress and tool cards, Stop, replay, and reading-position preservation.

## 0.18.0

- Preserved the active TurnStage workspace, Configure section, Evidence tab, Red Team expansion, Network inspector state, submitted-form state, splitter, filters, selections, viewport, and bounded reading positions when VS Code releases and recreates a hidden Profile Webview.
- Profile layout defaults now apply only on the first open without a valid checkpoint; they no longer replace an explicitly selected Evidence tab during rehydration. New sessions still clear stale message and event selections, while same-session tab switches retain them.
- Kept `retainContextWhenHidden` disabled to avoid retaining large hidden DOM trees. Scroll checkpoint writes are fixed-key, bounded, throttled, and flushed when the Webview becomes hidden; malformed or legacy state is normalized before use.
- Added DOM, state-boundary, browser reload, responsive, accessibility, and Extension Development Host regression coverage for Webview recreation and tab switching.

## 0.17.0

- Added direct workspace-relative `.adversarial.csv` suite linking across the Profile GUI, Test Explorer, CLI, schema, watcher, and report pipeline. A Profile can mix independent JSONC and CSV suites without conversion; CSV retains ordered multi-turn cases and per-case repetitions, while JSONC remains the lossless format for suite-only defaults and metadata.
- Hardened replay lifecycle and persistence. Stop now drains active replay work, repeated replay survives editor close/reopen, event capture remains complete, and the Replay page can delete one recorded run or clear the current Profile's local history through native confirmation. Deletion is serialized with concurrent saves, rejected while a request or replay is active, and never removes separately exported files.
- Refined VS Code Webview navigation and action hierarchy with a dedicated Red Team tab, compact table-based case settings, contextual overflow actions, persistent right-pane state, searchable syntax-highlighted JSON evidence, bounded event virtualization, generic message tags, and causal evidence beside adversarial results rather than above them.
- Expanded real Extension Host and mock-server coverage for mixed JSONC/CSV suites, repeated probabilistic outcomes, tab rehydration, Stop/replay recovery, debug evidence, Restricted Mode, and packaging boundaries. Existing version-1 Profiles and adversarial suites remain compatible; this release still does not add an LLM judge, external classifier, adaptive attack generator, arbitrary executable scripts, or unbounded execution.

## 0.16.0

- Added the stable VS Code-native `@turnstage` Chat participant with bounded `/diagnose`, `/run`, `/compare`, `/configure`, and `/evidence` workflows. It orchestrates only TurnStage language-model tools, preserves native confirmations for network runs, Profile edits, and response disclosure, renders evidence actions and deterministic follow-ups, supports English and Traditional Chinese prompts, and retains only sanitized IDs and outcome metadata across turns.
- Existing Diagnose with Copilot, Advisory response-quality review, Profile Doctor, and Campaign summary actions now open `@turnstage` directly. Chat orchestration is capped at four model rounds and six tool calls, duplicate side effects fail closed, cancellation and model/quota failures never become passes, and raw prompts, transcripts, headers, payloads, URLs, or secrets are not written to Chat metadata or TurnStage logs.
- Copilot test runs now accept one or more stable `{ profileId, caseId, suiteId? }` selector objects, with the reserved `@inline` disambiguator for Profile-inline Scenarios. The simpler top-level pair and existing exact Test Explorer ids remain supported through the explicit `exactSelectors` compatibility input, while missing, mixed, unknown, invented, or ambiguous selection fails before network execution.

## 0.15.0

- Added bounded Test Campaigns for selecting scenarios, adversarial suites, tags, and failed or unstable cases; campaigns support deterministic planning, configurable concurrency and repetitions, cancellation, checkpoint/resume, selective reruns, baseline comparison, compact progress, and sanitized HTML evidence without converting incomplete or timed-out work into a pass.
- Added safe bulk adversarial JSONL import and export alongside the existing CSV workflow. Imports validate schema and limits before execution, reject unsafe or oversized records, preserve multi-turn cases and per-case repetition settings, and keep executable behavior, secrets, raw responses, URLs, headers, and payloads out of exported evidence.
- Added a native structured **TurnStage Log** output channel with cached log-level checks, lazy high-frequency diagnostics, bounded single-line records, operation identifiers, and start/progress/end lifecycle entries for tests, campaigns, Connection Doctor, Copilot tools, and local-history recovery. Error notifications can open the channel directly, while payload content and secrets remain excluded.
- Existing version-1 Profiles, scenarios, adversarial suites, CLI behavior, and report consumers remain compatible. Campaign limits are explicit and bounded; this release does not add an LLM judge, external classifier, adaptive attack generation, arbitrary scripts, or unbounded execution.

## 0.14.1

- Hardened request deadlines and cancellation so Opening and CLI response-body reads cannot outlive their configured timeout. Oversized responses now fail closed, active Opening and Stop requests are aborted during replacement or disposal, and timeout, user cancellation, infrastructure failure, and excessive evidence remain distinguishable.
- Expanded privacy controls for URL-encoded secret values, sensitive redirect headers, Network inspection, CLI environment variables, and Restricted Mode configuration. Authorization, cookies, tokens, passwords, credentials, API keys, and reversible encoded secret representations remain excluded from logs, persisted runs, exports, diagnostics, and Webview payloads.
- Added bounded processing for Profile, Environment, fixture, suite, run-history, Evidence Bundle, event, message, regular-expression, and PNG inputs. Large adversarial batches retain compact planning and bounded concurrency, with explicit confirmation before a manual batch can issue more than 250 requests.
- Existing version-1 Profiles, scenarios, suites, reports, and CLI arguments remain compatible and require no migration. Previously accepted oversized or potentially unsafe inputs may now be rejected, truncated from non-authoritative debug history, or require a smaller file before execution; these limits do not convert timeouts or incomplete evidence into passes.

## 0.14.0

- Added a safe **Create Profile from cURL** workflow for bounded OpenAI-compatible requests. TurnStage parses without invoking a shell, rejects unsafe flags and expansion, removes captured prompts, messages, tools, and payload content, converts unknown header and query values to SecretStorage references, URI-encodes URL secrets, and requires review before creating a Profile.
- Added **Connection Doctor** for the latest relevant stream exchange. It explains bounded HTTP, protocol, timing, mapping, and terminal evidence without sending another request; stop requests and cleared or stale session evidence are excluded. A user-initiated Copilot handoff includes only sanitized structural findings and continues to forbid secret, proxy, VPN, and certificate recommendations.
- Added bounded batch planning, selective reruns, and compact reliability statistics for repeated adversarial cases, including coverage, resistance and attack rates, Wilson intervals, p95 TTFT/duration, and fail-closed verdicts. Attempts must follow explicit start/complete transitions, baseline/candidate runs count both targets against safety budgets, and timeout, cancellation, infrastructure errors, and incomplete samples never pass.
- Added a sanitized causal evidence timeline and deterministic failure clustering to Test Explorer evidence navigation and HTML Evidence Bundles. Evidence Bundle version 5 includes structural timeline, reliability, cluster, digest, and privacy metadata while continuing to exclude prompts, assistant content, headers, URLs, bodies, raw payloads, and secrets.
- Existing version-1 Profiles, scenarios, linked suites, CLI behavior, and Copilot tools remain compatible; all new Profile fields and UI actions are optional. Report consumers should accept Evidence Bundle manifest/policy version 5 and the additional reliability, timeline, and failure-cluster fields. This release does not add a GitHub CI workflow, LLM judge, external classifier, adaptive attack generator, PyRIT integration, or unbounded execution.

## 0.13.0

- Added deterministic Copilot-assisted diagnosis for failed, slow, unstable, comparison, and configuration scenarios. Diagnostics separate measured evidence from bounded hypotheses, retain run/profile scope, and link back to available Chat, Network, and Event evidence without exposing prompts, response text, headers, bodies, full URLs, or secrets.
- Added digest-locked Profile remediation for a narrow allowlist of timing, retry, parser, and mapping settings. TurnStage opens a native diff, requires explicit confirmation, rechecks Workspace Trust and source integrity, validates the result, and performs a verified rollback when saving or post-apply validation fails; tests are never rerun automatically.
- Added optional Advisory response-quality rubrics. Only explicitly selected Assistant responses are disclosed through a bounded two-step grant, common secret and URL forms are rejected, advisory findings cannot change formal test outcomes or CI exit codes, and sanitized run/profile-scoped metadata is available in Evidence Bundle version 4.
- Added Copilot run safety and traceability boundaries: one tool invocation is capped at 500 attempts and 5,000 requests, aggregate evidence is invocation-scoped with bounded retention, active requests are cancelled if Workspace Trust is lost, and Copilot-triggered runs never write configured CI reports or Recorded Runs. Existing Profiles, scenarios, adversarial suites, CLI behavior, and five existing Copilot tools remain compatible; the four new tools and optional quality-rubric fields require no migration.

## 0.12.0

- Added bounded repeated adversarial execution for probabilistic models. Suites can set a default repetition count and individual cases can override it from 1–50; each attempt uses a fresh conversation, results retain all four authoritative outcomes, and the aggregate reports stable resistance, stable attack success, instability, or inconclusive evidence. Fail-fast, cancellation, resume, timeout, and request-count limits remain explicit, and incomplete samples never pass.
- Added five GitHub Copilot language-model tools for explainable impact selection, confirmed test execution, failure inspection, schema-valid regression drafting, and validation. Tools enforce Workspace Trust, cancellation, pagination, bounded output, evidence redaction, and integrity checks; drafting never writes to the workspace and network execution requires confirmation.
- Added a headless `turnstage` CLI for the same profile and linked-suite contracts, including changed-file, profile, case, and tag selection; repetition and timeout policy overrides; JSON, JUnit, HTML, and evidence output; deterministic CI exit codes; and offline provenance verification. Request-backed, static, and disabled openings are supported with bounded responses, redirect policy, timeouts, and configured fallbacks; secrets come only from process environment variables and `.env` files are not loaded.
- Upgraded Evidence Bundles with canonical SHA-256 provenance, sanitized environment identity, per-file digests, and tamper verification. HTML evidence now includes repetition counts and stability summaries while continuing to exclude prompts, assistant content, raw payloads, header values, URLs, and secrets.
- Existing version-1 Profiles, scenarios, and version-1 adversarial suites remain compatible because repetitions, source bindings, and CI options are optional. This release does not add an LLM judge, external classifier, PyRIT integration, adaptive or unbounded attacks, arbitrary executable test scripts, or automatic Copilot changes.

## 0.11.0

- Added bounded adversarial regression cases to existing Scenarios. Fixed single- or multi-turn scripts can prohibit visible content, URLs, calls to action, tool interactions, and exact normalized events; every run ends as Resisted, Attack succeeded, Indeterminate, or Infrastructure error, and timeout or incomplete evidence never passes.
- Added Profile GUI authoring, save-current-conversation capture, Git-manageable versioned JSONC suites, and one-row-per-turn CSV import/export with explicit duplicate handling, strict validation, spreadsheet-formula protection, and practical 100-case coverage. Suites are capped at 500 cases, 2,000 turns, and 10 turns per case; execution concurrency is configurable from 1–8 and defaults to 3.
- Added compact latest results and a domain-first failure summary with a primary Chat, Network, Raw Events, or Normalized Events evidence action. Distinct adversarial-capture and visual-baseline icons, transient operation feedback, recoverable local deletion, accessible Network attempt labels, and responsive theme-aware layouts reduce ambiguity during triage. Evidence Bundle version 2 now includes sanitized adversarial summary, turn, finding, network, and event CSVs; prompts, assistant content, URLs, headers, payloads, raw events, response bodies, and secrets remain excluded.
- Existing version-1 Profiles remain compatible because adversarial fields and suite links are optional. Consumers of TurnStage contract reports must accept report version 2 and its additional adversarial summary fields. This release does not add an LLM judge, external classifier, PyRIT integration, adaptive attack generation, arbitrary scripts, or unbounded execution.

## 0.10.0

- Added profile-defined multi-turn conversation contracts with a VS Code-native Test Explorer hierarchy, declarative bounded assertions, automatic terminal-state invariants, isolated non-secret scenario controls, and clickable failure evidence that reopens the related Network or Event row. Scenario evidence is memory-only, contract requests require Workspace Trust, and existing version-1 profiles remain compatible because `tests` is optional.
- Added optional isolated baseline/candidate runs, bounded dynamic-field ignore rules, nine millisecond-based performance thresholds and regression budgets, and a VS Code-native Scenarios GUI. Missing baseline metrics fail closed, secret controls remain unavailable, and existing scenarios run unchanged when the new fields are absent.
- Added sanitized versioned JSON and JUnit contract reports through native run/export commands or an explicit trusted-workspace output directory. Reports contain IDs, status, durations, counts, difference paths, and check metadata only; raw events, messages, prompts, headers, request/response bodies, assertion values, and Debug evidence are excluded.
- Added an isolated Fault Lab for deterministic request delay, stream delay, synthetic HTTP status, disconnect, and malformed-event scenarios. Faults apply only to Test Explorer runs, use fixed bounded numeric controls, and do not change normal profile sessions.
- Added real PNG visual baselines and pixel-difference output for the Chat viewport, with VS Code-native Save Baseline and Compare actions plus configurable difference and channel tolerances. Existing profiles remain compatible because visual settings are optional.
- Added a privacy-bounded Evidence Bundle with an offline responsive HTML report, JSON, JUnit, and a manifest. Visible chat screenshots are excluded by default and require a separate explicit opt-in; raw events, request and response bodies, header values, message content, secrets, and profile or scenario display names remain excluded.
- Added passive W3C `traceparent` and standard request-ID correlation in the Network inspector, search, and sanitized reports. TurnStage does not create spans, inject headers, load an OpenTelemetry SDK, or send telemetry to a collector.
- Changed the Trusted-Workspace Network inspector to display the exact outgoing `Authorization` header, matching browser developer tools. The value remains live-session-only and is excluded from Output, request previews, Recorded Runs, exports, and Restricted Mode; cookies, API keys, proxy authorization, response data, and known-secret echoes retain their existing redaction.
- Expanded privacy-bounded Output diagnostics with profile/environment IDs, request-build time, request header/body sizes, response request/trace IDs, last event and age, terminal-event state, maximum chunk gap, and parser/mapping/unmatched/drop counts. Output still omits all header values, request/response bodies, query values, and SSE payloads.

## 0.9.0

- Added a Chrome-style Debug Network inspector with compact Opening, Stream-attempt, retry, and Stop rows plus searchable Headers, Payload, bounded Response, and Timing details. Timeout rows retain the HTTP/header/first-chunk phase and structured failure so an idle timeout after HTTP 200 is distinguishable from DNS, TLS, connection, or total-request failures.
- Network diagnostics are live-session-only, retain at most 50 entries and 64 KiB of response preview per entry, and reuse request-header, response-header, and known-secret redaction before data reaches the Webview. Existing profiles and recorded runs remain compatible and require no migration.

## 0.8.0

- Added a compact Restart Session action to the Chat header and a modal confirmation before every new-conversation path clears the current messages, conversation IDs, and live event data. Recorded runs remain available.
- Added persistent, accessible feedback for message actions. Copy, retry, and edit-and-resend now acknowledge the interaction, while Inspect switches the right pane to Debug, opens Raw Events, selects and focuses the last event linked to the message, and explains when no linked event exists.
- Added correlated Opening, Stream, and Stop diagnostics to the TurnStage Output Channel. The default info level records request phase, method, query-free endpoint, selected variant, timeout configuration, response status/content type, first-chunk latency, terminal counts, and safe network error codes; debug adds attempt, chunk, SSE event, mapping, retry, and timeout metadata.
- Output diagnostics do not record headers, request bodies, query values, SSE payloads, HTTP error bodies, or known secret values. Existing version-1 profiles, environments, recorded runs, and Restricted Mode behavior remain compatible and require no migration.

## 0.7.0

- Changed the Chat camera action to copy the rendered PNG directly to the local system clipboard instead of opening a save dialog. The localized accessible label and status now describe copying, and the image is ready to paste immediately after the success announcement.
- Starts the clipboard write during the user gesture and supplies the asynchronously rendered PNG to that operation. Screenshot bytes stay inside the local Webview, never cross the Extension Host protocol, touch the workspace file system, or make a network request.
- Preserved the 8-megapixel render cap, 24 MiB decoded PNG limit, signature validation, centered wide-layout composer, mobile insets, and Restricted Mode compatibility. Existing profiles and runs require no migration.

## 0.6.1

- Fixed exported Chat PNGs positioning the composer against the leading edge in wide Responsive and Web viewports. The composer now shares the same centered content insets as the header and conversation while preserving the existing compact mobile margins.
- Added output-image regression coverage that checks the generated PNG itself for balanced composer margins. Existing profiles, runs, and screenshot files require no migration.

## 0.6.0

- Added a localized, keyboard-accessible camera action to the Chat preview toolbar. It captures only the logical Chat viewport as a PNG—excluding the viewport controls and Debug pane—and uses the native VS Code save dialog.
- Screenshot generation is user-initiated and bounded to 8 megapixels. The Extension Host validates the PNG data URL, base64 encoding, file signature, safe filename, and a 24 MiB decoded-size limit before writing only to the selected URI; TurnStage does not retain the image.
- Existing profiles, recorded runs, and Restricted Mode behavior remain compatible and require no migration. Screenshot export remains available in Restricted Mode because it performs no network request.

## 0.5.2

- Added an explicit localized `Opening` label above profile opening content in Chat so it cannot be mistaken for a streamed Assistant response. Existing profiles require no migration.

## 0.5.1

- Changed the Assistant message footer to show only TurnStage-measured TTFT and total duration by default. Backend-reported duration and token metrics remain available in Debug and require an explicit `metrics.messageEnabled` opt-in before appearing in chat; `usage.updated` parts are likewise hidden unless `ui.components.usage.visible` is enabled.
- Renamed the bundled diagnostic example from the ambiguous `E2E` label to `Backend reported`. Existing profile mappings and recorded values remain compatible; no migration is required.

## 0.5.0

- Added host-measured TTFT and total duration to every Assistant response. Live messages use waiting/streaming states instead of displaying a false zero, recorded runs retain the measurements, and Replay shows the original recorded timings beside profile-mapped message metrics.
- Added a compact metrics selector to Profile Configuration. `metrics.messageEnabled` accepts the built-in `ttft` and `totalDuration` IDs plus any metric emitted through `message.metric.updated`.
- Added explicit successful profile-validation feedback and made Custom Editor titles reliable before asynchronous profile loading completes.
- Expanded the synthetic POST + SSE contract, fixtures, and tests while keeping contract-specific fields and unknown custom-card events in profile mappings and Raw Events rather than the generic runtime. The mock delay override is now `TURNSTAGE_MOCK_CONTRACT_SLOW_DELAY_MS`.
- Raised the minimum supported VS Code version from 1.96 to 1.106 after testing the semantic Custom Editor title and Webview flow across adjacent releases. Existing version-1 profiles and prior run exports remain compatible and require no migration.
- Network requests and run import remain unavailable in Restricted Mode; fixture replay, request redaction, SecretStorage ownership, bounded event/message retention, and URI/command allowlists are unchanged.

## 0.4.1

- Fixed the chat composer so Enter and the in-field Send button clear the submitted draft immediately while preserving the trimmed message sent to the Extension Host.
- Added a bounded `TURNSTAGE_MOCK_ENTERPRISE_SLOW_DELAY_MS` override to the bundled mock server so streaming, control locking, and user-cancel behavior can be inspected reliably in the installed extension.
- Existing profiles and stored runs remain compatible and require no migration. Request ownership, workspace-trust restrictions, redaction, and SecretStorage behavior are unchanged.

## 0.4.0

- Added persistent Raw Events and Normalized inspectors with text, event-type, mapping-status, event-health, and terminal-event filters plus compact VS Code-native status icons.
- Added a synthetic enterprise POST + SSE mock contract and adaptation guide covering request-backed openings, first and continuation turns, abort-then-stop behavior, partial failures, actions, diagnostics, and deterministic streaming modes.
- Kept proprietary and unknown events inspectable without assigning product-specific behavior. The bundled custom-card fixture remains unmatched in Raw Events, while contract-specific CTA fields are normalized by the example profile instead of the extension runtime.
- Existing version-1 profiles remain compatible and require no migration. Secret values remain in VS Code SecretStorage, request previews stay redacted, and unknown raw events continue through the bounded debug pipeline.

## 0.3.0

- Added persistent Mobile, Tablet, Web, and Responsive chat preview sizes. Web previews use a centered readable conversation column and omit mobile-only device chrome.
- Added an auto-growing multiline chat composer and profile-configurable Assistant streaming indicators (caret, dots, shimmer, or none) with bounded speed and intensity controls. Existing profiles use a subtle caret by default, and reduced-motion preferences disable animation.
- Expanded profile-driven chat configuration for starters, opening requests and responses, fallbacks, failure policy, request variant headers, stop requests, remote-session scopes, visible metrics, response actions, follow-ups, forms, and citations.
- Added safe Markdown rendering with links routed through the extension URI policy, bounded code blocks, and code-copy controls. Added host-mediated confirmations and working built-in action behavior for retry, abort, reset, request, citation, URI, form, and inspector actions.
- Added versioned local-run import with legacy export compatibility, profile validation, bounded file reads, duplicate-safe IDs, and localized feedback. Replay now restores recorded chat context, rejects runs without raw events, and exposes clear progress and blocking states.
- Recorded Runs now sends bounded summaries instead of full persisted run payloads and exposes request, event, message, error, and reconnect details without leaking request bodies or headers.
- Added configurable message/event memory bounds, real Webview event batching, reconnect metrics, log-level filtering, project fixture discovery, complete JSON-document streaming, and text-mode SSE/NDJSON handling.
- Existing version-1 profiles remain compatible. New fields and limits use backward-compatible defaults; imported run files continue to accept the previous export format.
- Security-sensitive links, commands, setting patches, and workspace fixture paths remain allowlisted and workspace trust restrictions continue to disable network requests.

## 0.2.3

- Profile editor tabs now use the profile display name with a TurnStage suffix instead of looking like ordinary JSONC text tabs.
- Added a compact, theme-aware profile identity bar to the Test workspace without changing the mobile chat surface.
- Added repeatable Playwright visual regression coverage for Webview rehydration, responsive layouts, themes, high contrast, zoom-equivalent sizing, and keyboard focus.
- Existing profiles remain compatible and no migration is required.

## 0.2.2

- Fixed profile editors remaining on “Loading profile…” after their Webview was recreated when switching away and back.
- `Run Profile` continues to open the TurnStage Custom Editor; the `.turnstage.jsonc` tab name only identifies the editable profile backing file.
- Existing profiles remain compatible and no migration is required.

## 0.2.1

- Fixed a resize-observer feedback loop that continuously reduced the chat preview pane while the editor was open.
- Automatically resets legacy auto-shrunk split state to the 64/36 default while preserving split ratios explicitly chosen by the user.

## 0.2.0

- Added an application-wide TurnStage editor language setting with Auto, Traditional Chinese, and English options, plus a Command Palette language switcher.
- Added the native VS Code walkthrough and refined profile navigation, profile configuration, chat composer, responsive phone preview, Debug inspector, accessibility, and theme-variable usage.
- Added safer bounded SSE/NDJSON parsing, controlled redirects, pre-data reconnect handling, early terminal cancellation, and stronger validation for forms, profiles, requests, and persisted runs.
- Hardened workspace-trust behavior, user/workspace profile discovery, duplicate diagnostics, run persistence, clipboard feedback, long-content rendering, and invalid persisted data handling.
- Existing version-1 profiles remain compatible; no profile migration is required. New limits and language preferences use backward-compatible defaults.

## 0.1.0

- Initial TurnStage release with config-driven HTTP/SSE chat sessions, event mapping, replay, metrics, secure secrets, a native profile tree, and a React custom editor.
