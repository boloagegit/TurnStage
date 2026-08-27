# TurnStage contributor instructions

## Versioning and release

- Follow Semantic Versioning (`MAJOR.MINOR.PATCH`). Choose the next version by comparing the intended artifact with the last VSIX that was handed to a user, uploaded, or published—not merely with the latest commit.
- Never distribute different VSIX contents under the same version. Once a VSIX has been handed to a user, uploaded, or published, any later artifact with different contents must use a higher version.
- Use PATCH for backward-compatible bug, UI, accessibility, security, and performance fixes.
- Use MINOR for backward-compatible user-facing features, commands, settings, profile fields, or export formats. Before `1.0.0`, also use MINOR for breaking changes.
- After `1.0.0`, use MAJOR for breaking command, setting, profile, storage, protocol, or data-format changes.
- Test- or documentation-only changes do not require a bump when no artifact is distributed. If a new VSIX is distributed, bump by at least PATCH even when only tests or documentation changed.
- Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together for every release. Prefer `npm version <patch|minor|major> --no-git-tag-version` so the two package files remain synchronized, then write the matching changelog entry.
- A changelog entry must summarize user-visible behavior, compatibility or migration requirements, and material security or operational changes. Do not fill it with internal test implementation details.

Before producing a release VSIX:

1. Review the source diff and confirm the selected version against the last distributed artifact.
2. Update the required version and changelog files.
3. Run `npm run typecheck`.
4. Run `npm run lint`.
5. Run `npm test -- --run`.
6. Run `npm run test:integration` in both the normal and Restricted Mode paths supplied by the integration runner.
7. For Webview layout, theme, responsive, icon, or accessibility changes, review wide and narrow editor layouts plus light, dark, high-contrast, 200% zoom, and keyboard-only behavior before packaging.
8. Run `npx vsce ls --tree` to review the intended package contents, then run `npm run package` and verify that the resulting filename is `turnstage-X.Y.Z.vsix`.
9. Inspect the exact artifact with `unzip -l turnstage-X.Y.Z.vsix`. Confirm it contains no credentials, local-only artifacts, `.exe`, `.dll`, or `.node` files.
10. Run `npm audit --omit=dev --audit-level=high` and record the artifact checksum with `shasum -a 256 turnstage-X.Y.Z.vsix`.
11. Confirm `git diff --check` passes and the worktree contains no unintended changes before committing the release source.

- Packaging success is not release approval. Report unit, SSE, accessibility, trusted/Restricted Extension Host, package-content, vulnerability, and checksum evidence separately.
- Commit synchronized source, changelog, and version files only after the release checks pass.
- Create a release tag such as `v0.2.0` only when the user explicitly requests it.
- Publishing to the VS Code Marketplace or any external distribution system requires separate, explicit user authorization. A local VSIX build is not evidence of publication.
