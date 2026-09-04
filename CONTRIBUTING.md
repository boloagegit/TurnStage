# Contributing to TurnStage

Thanks for helping improve TurnStage. Keep changes provider-neutral, bounded,
and consistent with VS Code's native interaction patterns.

## Development setup

Requirements:

- Node.js 24
- npm
- VS Code 1.106 or later

Install and verify the project:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:visual
```

Use `npm run mock-server` and the bundled synthetic Profiles for manual tests.
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
- Update public documentation and the changelog when behavior changes.

By contributing, you agree that your contribution is licensed under the MIT
License in [`LICENSE`](LICENSE).
