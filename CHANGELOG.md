# Changelog

## Unreleased

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
