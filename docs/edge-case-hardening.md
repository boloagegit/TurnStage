# Edge-case hardening matrix

This matrix records the failure boundaries covered by the runtime and Webview.
“Automated” means a deterministic unit, DOM, accessibility, or mock-transport
test exists; it is not a claim of manual verification in every VS Code build.

| Area | Expected boundary | Status |
| --- | --- | --- |
| Terminal events | Ignore and cancel transport data after the first terminal event | Automated |
| Remote stop | Bound a hanging stop request with timeout and cancellation | Automated |
| Payload limits | Bound HTTP error previews and individual stream records | Automated |
| Protocol | Reject wrong discriminants, IDs, paths, cycles, deep or oversized values | Automated |
| Forms | Bind submissions to one source message and revalidate values on the host | Automated |
| Stored history | Drop malformed runs/session references without blocking valid records | Automated |
| Concurrent history | Serialize per-key writes to prevent lost updates | Automated |
| Runtime profiles | Enforce structural and numeric limits even when schema diagnostics were bypassed | Automated |
| SSE framing | Accept CR, LF, CRLF, leading BOM, split frames, and final partial frames | Automated |
| Reconnect | Retry only before the first event, with bounded attempts/backoff and `Retry-After` | Automated |
| Redirects | Bound hops, default to same-origin, and strip secrets on explicit cross-origin follow | Automated |
| Split layout | Prefer the chat pane, adapt minimum tracks, stack when narrow, and recover corrupt state | Automated |
| International text | Support RTL plus long CJK, emoji, URLs, and labels with logical, breakable layout | Automated |
| Assistive technology | Render a bounded event window while retaining full-list ARIA positions | Automated |
| Conversation scrolling | Follow only near the tail; preserve reading position and expose Jump to latest | Automated |
| Clipboard | Report unavailable or rejected clipboard writes visibly and through a live region | Automated |
| Persisted controls | Namespace values by control type and ignore incompatible legacy values | Automated |
| Editor disposal | Await pending persistence work during extension deactivation | Automated |

The complete verification commands are `npm test -- --run`, `npm run
typecheck`, `npm run lint`, `npm run compile`, and `git diff --check`. Extension
Development Host and packaged-VSIX checks remain separate release evidence.
