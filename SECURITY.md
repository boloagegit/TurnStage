# Security policy

## Supported versions

TurnStage is currently a public preview. Security fixes are provided for the
latest released version. Upgrade to the latest Marketplace or GitHub release
before reporting a problem that may already be fixed.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include secrets,
private endpoints, prompts, transcripts, headers, payloads, or customer data in
an issue.

Use a [private GitHub security advisory](https://github.com/boloagegit/TurnStage/security/advisories/new)
and include:

- the affected TurnStage and VS Code versions;
- the operating system and local, remote, WSL, or container context;
- the smallest safe reproduction without real credentials or customer data;
- the expected and observed security boundary;
- whether the behavior requires Workspace Trust or an explicit confirmation.

You will receive an acknowledgement when the report has been reviewed. No
response or remediation time is guaranteed during the public preview.

## Scope

Security-sensitive areas include Workspace Trust, SecretStorage, request and
proxy handling, TLS options, redirects, linked files, Webview messages,
Copilot disclosures, output redaction, saved runs, and exported evidence.

The detailed implementation model and known boundaries are documented in
[`docs/security.md`](docs/security.md).

