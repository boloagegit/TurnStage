# TurnStage documentation

TurnStage runs as a VS Code extension, a standalone Web app, and a
repository-local CLI. Start with the guide for the host you use; Profiles and
event mappings are shared, while storage, credentials, and available actions
depend on that host.

## Start here

| Goal | Guide |
| --- | --- |
| Understand TurnStage and choose a host | [Project overview](../README.md) |
| Install, configure, and use the extension | [VS Code user guide](vscode-user-guide.md) |
| Use the browser app, import cases, and back up local data | [Web user guide — 繁體中文](web-user-guide.md) |
| Build or deploy Web, configure the API proxy and default Profiles | [Web deployment](web-deployment.md) |
| Try a synthetic enterprise chat contract | [Enterprise chat example](enterprise-chat-profile-guide.md) |

## Tests and evidence

| Topic | Reference |
| --- | --- |
| General tests, inline cases, linked JSONC/CSV, CLI, and Copilot selectors | [Automated testing](automated-testing.md) |
| Red-team outcomes, repeated attempts, campaigns, and evidence | [Adversarial testing](adversarial-testing.md) |
| Timing, retention budgets, benchmarks, and measured limitations | [Performance](performance.md) |

## Configure a backend

| Topic | Reference |
| --- | --- |
| Profile and Environment fields, conversation history, controls, and validation | [Profile schema](profile-schema.md) |
| SSE/NDJSON raw events, extraction, mappings, and normalized events | [Event mapping](event-mapping.md) |
| Trust, network requests, credentials, exports, and redaction | [Security model](security.md) |

Complete starter files are in [resources/templates](../resources/templates).
Use the schema reference for field definitions and the mapping reference for
event semantics rather than copying partial examples into a new Profile.

## Develop and maintain

| Topic | Reference |
| --- | --- |
| Dependencies, F5, mock server, TLS fixtures, tests, builds, and repository layout | [Development guide](development.md) |
| Contribution and review expectations | [Contributing](../CONTRIBUTING.md) |
| Extension, Web, CLI, runtime lifecycle, and storage boundaries | [Architecture](turnstage-architecture.md) |
| Theme, keyboard, accessibility, and responsive acceptance | [VS Code UI guidelines](vscode-extension-ui-guidelines.md) |
| Runtime failure boundaries covered by automated tests | [Hardening matrix](edge-case-hardening.md) |
| Product positioning and constraints | [Product brief](../PRODUCT.md) |
| Versioning, release validation, packaging, and authorization | [Contributor instructions](../AGENTS.md) |

## Policies and historical records

Read [Privacy](../PRIVACY.md), [Security reporting](../SECURITY.md),
[Support](../SUPPORT.md), and the [Code of conduct](../CODE_OF_CONDUCT.md) for
the public project policies. Changes by version are in the
[changelog](../CHANGELOG.md).

The [2026-08-27 UI audit](archive/vscode-ui-audit-2026-08-27.md) records the
implementation and checks at that date. It is historical evidence; current
behavior is described by the user guides and current source.
