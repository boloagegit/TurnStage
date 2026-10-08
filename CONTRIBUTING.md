# Contributing to TurnStage

Keep changes provider-neutral, bounded, and consistent across the VS Code
extension and standalone Web app. Use VS Code theme tokens in the extension
and preserve Web's amber theme.

## Development setup

Use Node.js 24, npm, and VS Code 1.106 or later for extension work:

```sh
npm ci
npm run build:all
```

Press F5 for an Extension Development Host, or run `npm run web:dev` for Web.
The [development guide](docs/development.md) covers the mock server, repository
layout, all ten visual scripts, Python tests, conditional TLS tests, and
integration modes. Start source validation with:

```sh
npm run typecheck
npm run lint
npm test
```

Run integration and visual/manual checks when the changed behavior requires
them. Release validation must follow [AGENTS.md](AGENTS.md), including both
trusted and Restricted Mode. Do not distribute different artifact contents
under a version already handed to a user, including documentation-only changes.

Use `npm run mock-server` and synthetic Profiles for manual tests.
Never commit real credentials, private URLs, customer prompts, transcripts, or
backend payloads.

## Pull requests

- Open an issue before making a large architecture, schema, storage, security,
  compatibility, or UX change.
- Keep deterministic test outcomes separate from advisory model output.
- Treat timeouts, incomplete evidence, and infrastructure failures as failures
  to establish a pass.
- Add focused tests for the changed behavior and preserve light, dark,
  high-contrast, narrow, keyboard, and localization behavior when applicable.
- Use workspace width for responsive layout in both hosts; Web's sidebar
  counts toward the available space. Follow the [UI checklist](docs/vscode-extension-ui-guidelines.md#pull-request-acceptance-checklist).
- Keep VS Code-only CSS scoped to `html[data-host='vscode']`. Do not add
  layout measurement or repaint listeners just to adjust styles.
- Localization bundles contain duplicate keys. Add entries as text; do not
  parse and reserialize `l10n/bundle.l10n*.json`.
- Update public documentation and the changelog when behavior changes.
- Keep generated output and release evidence out of commits. Preserve
  current candidate packages and validation records during cleanup.

By contributing, you agree that your contribution is licensed under the MIT
License in [`LICENSE`](LICENSE).
