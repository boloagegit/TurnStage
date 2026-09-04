# Privacy

TurnStage is a local-first VS Code extension. It has no TurnStage-operated
backend, advertising SDK, analytics SDK, or automatic telemetry service.

## Data that stays on your machine

Profiles, environments, linked-suite authorizations, campaign checkpoints,
visual baselines, and recorded-run history are stored in the workspace or VS
Code extension storage. Secret values are stored through VS Code
`SecretStorage`; TurnStage stores secret names separately so they can be listed
without displaying their values.

Recorded-run retention defaults to 20 runs per Profile and can be changed in
the Profile or with the `turnstage.runRetention` setting. You can remove
individual runs or clear a Profile's run history from the Runs interface.

## Network requests

TurnStage sends requests only to endpoints selected by the active Profile. A
request is initiated by a user action, a test or campaign run, or a trusted
Profile that explicitly configures a request-backed opening. Request-backed
openings run once when that Profile editor opens. Restricted Mode blocks these
requests.

TurnStage follows VS Code's network and proxy configuration by default. A
Profile can explicitly allow an invalid TLS certificate for a request. That
option weakens connection security, is isolated to the opted-in request path,
and is shown as a warning in the interface.

## GitHub Copilot and language models

Copilot integration is optional. TurnStage does not require the GitHub Copilot
extension for its chat, debug, replay, functional-test, adversarial-test, or
export workflows. When you explicitly invoke a TurnStage Copilot command or
language-model tool, VS Code and the selected model provider process the
bounded prompt and tool information under their own terms and privacy policy.

Response-quality review requires explicit content disclosure. Deterministic
test outcomes do not use an LLM judge and are not changed by Copilot output.

## Logs, evidence, and exports

The TurnStage Output channel records bounded operational metadata. It excludes
request and response bodies, event payloads, query values, and header values.
Known secret values are redacted from remaining diagnostic fields.

JSON, JUnit, HTML, and Evidence Bundle exports are created locally. TurnStage
does not upload them. Some interactive Debug views intentionally expose
request or response data needed for local diagnosis; review that data before
copying screenshots or sharing files.

For the complete technical boundary, read
[`docs/security.md`](docs/security.md). Report a privacy or security concern
using the process in [`SECURITY.md`](SECURITY.md).

