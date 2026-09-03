# Automated conversation testing

TurnStage's **Tests** workspace is for deterministic functional, regression,
comparison, performance, and Fault Lab cases. Red Team remains separate because
its four outcomes and repeated-sample rules answer a different question.

## Inline and linked cases

Keep a few cases in `tests.scenarios`. For a larger collection, use **Tests →
Scenarios → More actions → Link suite** and select a `.tests.jsonc`,
`.tests.json`, or CSV file. The Profile stores the references in
`tests.contractSuites`; linked files remain the source of truth and are not
copied into Profile JSONC.

Workspace-relative links are portable and work in VS Code and the TurnStage
CLI. An explicitly selected file outside the workspace receives an opaque,
Profile-bound local authorization. No absolute external path is written into
the Profile, and another machine must link that file again.

The Profile editor receives at most 100 prompt-free linked-case summaries and
shows 25 at a time. Opening one case loads only that case's full content.
Saving is explicit, requires Workspace Trust, verifies a SHA-256 source
revision, serializes concurrent writes, and reads the file back. If another
editor changed the source, TurnStage refuses to overwrite it and asks for a
reload.

## JSONC format

JSONC is the lossless format for shared source bindings and case metadata:

```jsonc
{
  "format": "turnstage-contract-suite",
  "version": 1,
  "id": "conversation-regression",
  "name": "Conversation regression",
  "sourceBinding": { "sourceGlobs": ["src/chat/**"] },
  "cases": [{
    "id": "multi-turn-follow-up",
    "name": "Multi-turn follow-up",
    "tags": ["release"],
    "steps": [
      { "id": "first", "input": "Start a request." },
      {
        "id": "follow-up",
        "input": "Continue it.",
        "assertions": [{ "path": "turn.state", "operator": "equals", "value": "completed" }]
      }
    ],
    "performance": { "thresholds": { "metrics.ttft": 2000 } }
  }]
}
```

A suite can contain at most 500 cases, 100 steps per case, and 10,000 enabled
steps. Unsupported fields, duplicate IDs, invalid paths, malformed assertions,
and executable-looking additions fail validation rather than being ignored.

## CSV format

CSV uses one row per conversation turn. Download **CSV template** for the exact
header. Case fields repeat on each row; JSON cells preserve tags, assertions,
source bindings, controls, comparison, performance, and Fault Lab settings.
Formula-leading text is escaped on export. A CSV can remain linked and editable
without conversion; use JSONC if comments or suite-level metadata must be
preserved.

## Running and Copilot

Run one case from its row, run all functional cases from Tests, or use VS Code
Test Explorer. The CLI loads workspace-relative linked suites directly and
supports the same stable Profile, Suite, Case, tag, and changed-file selectors.
Reports and evidence retain Suite and Case identity.

GitHub Copilot's TurnStage tools discover linked cases using prompt-free
metadata, validate their current digest, preview bounded request cost, and run
the exact stable Suite and Case IDs. A Copilot-triggered run still requires
Workspace Trust and the existing confirmation flow. TurnStage does not send
linked prompts proactively, expose secrets, allow executable test scripts, or
let Advisory model feedback change deterministic outcomes.
