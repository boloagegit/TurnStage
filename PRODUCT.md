# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

TurnStage serves developers, QA engineers, AI application teams, and red-team practitioners who need to exercise a chat or agent backend from VS Code, a standalone browser app, or a headless CLI, understand its streamed behavior, and turn known failures into repeatable regression tests.

## Product Purpose

TurnStage is a config-driven chat and stream testing workbench. It connects a versioned Profile to a real or synthetic backend, renders the resulting conversation, exposes Network and event evidence, and lets teams replay or test observable behavior. Success means a user can reproduce a behavior, locate its evidence, and share an accurate bounded result without exposing credentials.

## Positioning

TurnStage is the execution, observation, and structured-evidence layer for chat and agent testing. In red-team workflows, people or external systems design attacks; TurnStage sends known cases reproducibly, records Chat, Network, and Events, evaluates explicit observable prohibitions, and preserves the case as a regression test. It is not an autonomous attack-generation platform or a model-safety certification system.

## Operating Context

VS Code users work with Git-managed `*.turnstage.jsonc` Profiles, environments, fixtures, Test Explorer, and the custom editor. Network-backed runs require Workspace Trust. Web users use deployment-owned presets or browser-local copies, imported suites, and browser storage. The CLI runs repository-linked cases using process-environment secrets. Teams share versioned JSONC/CSV cases and exported evidence; the hosts do not automatically share storage.

## Capabilities and Constraints

- In VS Code, the Extension Host owns HTTP/SSE, files, secrets, trust, diagnostics, test execution, and exports. The Webview receives redacted state and owns presentation. The Web host supplies browser networking, storage, and controllers to the same shared React workspace; it does not load the VSIX.
- Adversarial tests reuse the Scenario execution boundary and support ordered fixed-script turns, explicit forbidden content, URLs, CTAs, tools, and normalized events, bounded turns, and a case timeout.
- Domain outcomes are `Resisted`, `Attack succeeded`, `Indeterminate`, and `Infrastructure error`. A timeout never counts as `Resisted`.
- VS Code supports Test Explorer and workspace-linked suites. Both hosts expose separate General tests and Red Team workflows with a unified case/latest-result list, targeted rerun, history, and evidence navigation. Manual runs have no fixed aggregate case ceiling; explicit budgets, per-case bounds, concurrency, and device capacity still apply. Copilot runs retain separate execution budgets.
- JSONC suites are the lossless Git-friendly exchange format. CSV is a convenient bulk-authoring projection with one row per turn. Test definitions and evidence exports remain separate.
- Workspace-relative suite links are portable. An explicitly selected external suite uses a local opaque authorization bound to the exact Profile URI; collaborators and other machines must link their own copy.
- Adversarial execution is deterministic and bounded: no LLM Judge, PyRIT runtime, external classifier, adaptive branching, or unlimited automatic attacks.
- VS Code secrets remain in SecretStorage. Web session secrets remain in page memory, while plaintext Profile/Environment credentials can be stored and included in portable exports. Known sensitive fields are redacted from evidence projections; detailed reports can still contain confidential conversations and payloads.
- At workspace widths of 1,024px or less, both hosts switch between Chat and the other tabs without unmounting their views. VS Code follows workbench styling; Web retains its amber theme.

## Evidence on Hand

The repository contains working Profile, Scenario, Test Explorer, SSE/NDJSON, Network, Raw/Normalized Events, baseline/candidate comparison, Fault Lab, visual regression, mock-server fixtures, and sanitized JSON/JUnit/HTML Evidence Bundle implementations. No external customer claims, safety benchmarks, or certification evidence should be invented.

## Product Principles

- Make the common workflow short: explore, capture a case, rerun, inspect the abnormal result, and export evidence.
- Prefer observable, deterministic evidence over implied semantic judgment.
- Fail closed when execution or evidence is incomplete; never turn timeout or missing evidence into a pass.
- Keep large suites reviewable, Git-manageable, bounded, resumable, and explicit about request volume.
- Show what happened, in which turn, and where the evidence is before exposing raw detail.

## Accessibility & Inclusion

All Profile editor and result workflows must remain keyboard-operable, localized in English, Traditional Chinese, Japanese, and Korean, readable in light, dark, and high-contrast themes, usable at 200% zoom, and functional in wide and narrow workspaces.
