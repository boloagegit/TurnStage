## Read one run from left to right

The phone preview shows what a chat user would see. Debug explains how that
result was produced:

| View | What to verify |
| --- | --- |
| Request | Resolved, redacted request |
| Raw Events | Transport order, timing, and original payload |
| Normalized | Events produced by mapping rules |
| Metrics | Latency, volume, and mapping counters |
| Errors | Transport, parsing, mapping, and runtime failures |
| Runs | Saved evidence and deterministic replay |

Select a chat message to find its source event, or select an event to find the
message it changed.
