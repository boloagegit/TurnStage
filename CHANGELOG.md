# Changelog

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
