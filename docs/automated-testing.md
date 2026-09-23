# Automated conversation testing

TurnStage has separate **General tests** and **Red Team** top-level tabs beside
**Debug** and **Configure**. Choose one, then use its **Cases** or **Results** tab. Both types
use the same search, paging, and case-management pattern, but selection and
results stay separate because their judgments differ:
general cases check configured assertions; Red Team cases evaluate prohibited
effects and repeated samples. Comparison, performance regression against a
VS Code baseline, and Fault Lab checks require the extension. Web can evaluate
absolute performance thresholds and disables unsupported cases before sending traffic.

## Inline and linked cases

Keep a few cases in `tests.scenarios`. For a larger collection, use **General tests →
Cases → More case actions → Link suite** and select a `.tests.jsonc`,
`.tests.json`, or CSV file. The Profile stores the references in
`tests.contractSuites`; linked files remain the source of truth and are not
copied into Profile JSONC.

The case menu also exports JSONC or CSV. In VS Code, export includes the
Profile's inline general-test cases; linked suite files stay separate and can
be opened directly. In Web, export includes inline cases and the imported
browser-local copies for the active Profile. Web can import a JSONC or CSV
copy; it never changes the original file. Reimporting a suite with the same ID
asks before replacing its browser copy, preserving its case identity. Use a
different suite ID to keep both copies. The Profile menu can export the Profile,
its Environment, and imported suites together in one portable JSON file. If
cases from different sources use the same ID or fail per-case validation,
combined export stops with an error rather than downloading an invalid suite.
This portable file does not contain run history or detailed evidence. Red Team offers the same JSONC/CSV choices
plus its own JSONL format.

Use **Save as test…** from Chat, a recorded run with a snapshot, or a test
result with evidence to create a functional or adversarial draft. The capture
flow copies at most 10 ordered user messages, never assistant responses,
headers, bodies, or credentials. It can write inline, append to an existing
linked CSV/JSONC suite, or create a new JSONC suite. Every captured case starts
as **Needs review**, stays out of Test Explorer, CLI runs, campaigns, and Run
all, and becomes executable only after **Mark ready** is saved. Capture
provenance contains identifiers, timestamp, and a redacted Profile digest;
conversation text remains only in the normal case steps.

Workspace-relative links are portable and work in VS Code and the TurnStage
CLI. An explicitly selected file outside the workspace receives an opaque,
Profile-bound local authorization. No absolute external path is written into
the Profile, and another machine must link that file again.

A Profile opened outside the configured `turnstage.profileGlob` can still run
its General tests and Red Team cases from the Profile editor. Test Explorer
discovers matching workspace and user Profiles by default; a directly run
Profile is also shown while its editor remains open.

The Profile editor receives every prompt-free linked-case summary and shows 25
at a time. Each type's case list searches by name, ID,
tag, or source. Select a case in its list to edit it; each test type keeps its
own add, import, and link actions in that same view. Opening one linked
case loads only that case's full content.
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

A suite has no case-count or aggregate-step ceiling. A single case can contain
at most 100 steps. Unsupported fields, duplicate IDs, invalid paths, malformed assertions,
and executable-looking additions fail validation rather than being ignored.

## CSV format

CSV uses one row per conversation turn. Download **CSV template** for the exact
header. Case fields repeat on each row; JSON cells preserve tags, assertions,
source bindings, controls, comparison, performance, and Fault Lab settings.
Formula-leading text is escaped on export. A CSV can remain linked and editable
without conversion; use JSONC if comments or suite-level metadata must be
preserved.

## Running and Copilot

Run one case from its row, or select several cases of the current type and
choose **Run selected** to start immediately.
**Select all selectable cases** adds the cases shown in the list, across its pages,
except drafts needing review, incomplete cases, and cases requiring VS Code-only
checks in Web. Each excluded row shows the exact reason; the button shows the
selectable and total counts. With search active it selects only matching cases.
TurnStage Web selection and manual execution have no fixed case, attempt, or
request ceiling. Browser storage and the user's device remain the practical
limit; executing cases still sends requests to the configured target service.
If a suite or campaign defines its own request or duration budget, that explicit
user configuration is still checked before a run starts.
Drafts marked **Needs review** and Web-unsupported cases cannot be selected or
run. If a previously selected case becomes unavailable, the selection is
rejected before any request is sent instead of running a partial batch. A
completed run offers **View test results**. Results lists the latest
session evidence and a separate, metadata-only run history. A completed run
can be accepted as a comparison baseline; future runs classify new failures,
recoveries, changed case definitions or settings, execution errors, and
incomplete results. Select an earlier run and use **Rerun non-passing cases**
to resolve its exact case identities again; the new history entry retains a
source-run reference. Web also checkpoints each completed case. After a browser
reload interrupts a run, its history shows completed and unfinished cases;
**Run remaining cases** sends only the unfinished ones after the user chooses it.
Missing, renamed, or still-unreviewed cases stop
the rerun before any request is sent. A cancelled repeated case retains the
number of attempts that actually completed instead of being treated as a pass.
History keeps 20 recent runs plus the accepted baseline. **Clear history**
requires confirmation and removes only the current Profile's current test
type from run-history records. If that removes the baseline, it is cleared too;
other test history and detailed evidence remain. Detailed evidence may
expire separately. A history row offers **Open evidence** only while the
underlying evidence is present; otherwise it explicitly says that the detailed
evidence has expired. A history entry is not a permanent evidence archive.
**Export this run** writes JSON, JUnit XML, or HTML for the chosen run's complete
case list, joining only that run's retained evidence. If any recorded evidence
has expired, TurnStage stops the export rather than mixing in another run.
Cases that did not finish are shown as errors in JUnit so a cancelled batch
cannot be mistaken for an all-passing CI run. Web JSON and HTML also retain the
run status, case identity, and completed attempt counts.

VS Code Test Explorer and the CLI remain available. The CLI loads
workspace-relative linked suites directly and supports stable Profile, Suite,
Case, tag, and changed-file selectors. Reports and evidence retain Suite and
Case identity.

GitHub Copilot's TurnStage tools discover linked cases using prompt-free
metadata, validate their current digest, preview bounded request cost, and run
the exact stable Suite and Case IDs. A Copilot-triggered run still requires
Workspace Trust and the existing confirmation flow. TurnStage does not send
linked prompts proactively, expose secrets, allow executable test scripts, or
let Advisory model feedback change deterministic outcomes.
