# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

TurnStage serves developers, QA engineers, AI application teams, and red-team practitioners who need to exercise an arbitrary chat or agent backend from VS Code, understand its streamed behavior, and turn known failures into repeatable regression tests.

## Product Purpose

TurnStage is a config-driven chat and stream testing workbench. It connects a versioned Profile to a real or synthetic backend, renders the resulting conversation, exposes Network and event evidence, and lets teams replay or test observable behavior. Success means a user can reproduce a behavior, locate its evidence, and share an accurate bounded result without exposing credentials.

## Positioning

TurnStage is the execution, observation, and structured-evidence layer for chat and agent testing. In red-team workflows, people or external systems design attacks; TurnStage sends known cases reproducibly, records Chat, Network, and Events, evaluates explicit observable prohibitions, and preserves the case as a regression test. It is not an autonomous attack-generation platform or a model-safety certification system.

## Operating Context

Users work in desktop or remote VS Code with Git-managed `*.turnstage.jsonc` Profiles, environments, fixtures, Test Explorer, the TurnStage Custom Editor, and exported reports. Network-backed runs require Workspace Trust. Teams may maintain tens to hundreds of fixed-script, single- or multi-turn adversarial cases in shared versioned suites and use CSV for spreadsheet-oriented bulk authoring.

## Capabilities and Constraints

- The Extension Host owns HTTP/SSE, files, secrets, trust, policy, diagnostics, test execution, and exports. The Webview receives redacted structured state and owns presentation and interaction.
- Adversarial tests reuse the Scenario execution boundary and support ordered fixed-script turns, explicit forbidden content, URLs, CTAs, tools, and normalized events, bounded turns, and a case timeout.
- Domain outcomes are `Resisted`, `Attack succeeded`, `Indeterminate`, and `Infrastructure error`. A timeout never counts as `Resisted`.
- Test Explorer remains the primary run and CI surface. The Profile editor provides efficient authoring, latest-result triage, and evidence navigation rather than a second runner.
- JSONC suites are the lossless Git-friendly exchange format. CSV is a convenient bulk-authoring projection with one row per turn. Test definitions and evidence exports remain separate.
- First-version adversarial execution is deterministic and bounded: no LLM Judge, PyRIT runtime, external classifier, adaptive branching, or unlimited automatic attacks.
- Secrets remain in SecretStorage and are excluded from previews, reports, case exports where applicable, and evidence bundles. Sensitive prompts or conversation content require explicit export choices.

## Evidence on Hand

The repository contains working Profile, Scenario, Test Explorer, SSE/NDJSON, Network, Raw/Normalized Events, baseline/candidate comparison, Fault Lab, visual regression, mock-server fixtures, and sanitized JSON/JUnit/HTML Evidence Bundle implementations. No external customer claims, safety benchmarks, or certification evidence should be invented.

## Product Principles

- Make the common workflow short: explore, capture a case, rerun, inspect the abnormal result, and export evidence.
- Prefer observable, deterministic evidence over implied semantic judgment.
- Fail closed when execution or evidence is incomplete; never turn timeout or missing evidence into a pass.
- Keep large suites reviewable, Git-manageable, bounded, resumable, and explicit about request volume.
- Show what happened, in which turn, and where the evidence is before exposing raw detail.

## Accessibility & Inclusion

All Profile editor and result workflows must remain keyboard-operable, localized in English and Traditional Chinese, readable in light, dark, and high-contrast themes, usable at 200% zoom, and functional in wide and narrow editor layouts.
