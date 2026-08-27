# VS Code UI audit — 2026-08-27

This audit applies `docs/vscode-extension-ui-guidelines.md` to the current
manifest, extension source, Webview source, and the rebuilt standalone Webview
renders in `artifacts/turnstage-vscode-guidelines-desktop.png`,
`artifacts/turnstage-profile-configuration.png`, and
`artifacts/turnstage-vscode-guidelines-narrow.png`. These ignored review
artifacts are not Extension Development Host screenshots, so native workbench
placement is verified from `package.json`, extension source, and trusted plus
Restricted Mode Extension Host tests rather than inferred from the images.

**Current status:** all findings from the initial audit and the final hardening
re-audit are resolved in the current working tree. The final gate reports 31
test files and 186 tests passed, including React DOM keyboard behavior, axe,
real local SSE transport, and session-flow tests. Typecheck, lint, package,
trusted Extension Host, and Restricted Mode Extension Host checks also pass.

## Resolved findings

### Resolved P1 — profile children were command-only Tree rows

`src/extension/views/profileTreeProvider.ts:10-19,50-63,84` adds eight section
children beneath every profile. Each child exists only to execute
`turnstage.openProfileSection`. VS Code's View guidance says Tree items should
represent data and should not be used as single-action buttons. This also makes
the Sidebar hierarchy much deeper and noisier than the underlying resource
model.

Resolution: profiles are now leaf resource rows. Section navigation remains in
the opened profile editor instead of creating eight command-only Tree children.

### Resolved P1 — profile context menu exposed too many direct actions

`package.json:274-328` contributes eleven direct commands for one profile item:
Run, Open, Start Session, Select Environment, Open Environment, Validate, Open
as Text, Migrate, Export, Duplicate, and Delete. VS Code recommends no more than
three actions on an item and moving large groups into submenus.

Resolution: Run and Open remain the two inline actions. Remaining commands are
grouped into Session, Profile Tools, and Manage Profile submenus.

### Resolved P1 — inspector tabs lacked the keyboard tab pattern

`src/webview/main.tsx:112-127` uses `role="tablist"` and roving `tabIndex`, but
does not implement Left/Right arrow navigation and does not connect tabs to
`tabpanel` elements with `aria-controls` and `aria-labelledby`. A keyboard user
can reach only the selected tab through Tab and cannot move to the other tabs
using the expected composite-widget keys.

Resolution: the tabs now have stable IDs, `aria-controls`, labelled tabpanels,
roving focus, ArrowLeft/ArrowRight, Home, and End behavior.

### Resolved P1 — the Raw Events listbox lacked composite keyboard behavior

`src/webview/main.tsx:159-168` gives every event row `role="option"` while every
visible row remains a native button in the Tab order. There is no roving focus,
Arrow/Home/End navigation, or focused-option state, and the listbox itself is
labelled "Inspector views" instead of events. This becomes especially costly
for long streams.

Resolution: Raw and Normalized lists now use one roving Tab stop, view-specific
names, ArrowUp/ArrowDown, Home, End, Enter, and Space. Virtualization and the
screen-reader full-list path remain available.

### Resolved P1 — the test workspace could clip at medium editor widths

`src/webview/styles.css:55` requires two columns of at least `23em` plus a
splitter, but `src/webview/styles.css:127` does not stack them until `38em`.
This leaves a range in which the minimum columns are wider than the Webview
while the container uses `overflow: hidden`. VS Code editor groups and Panels
can routinely enter this width range.

Resolution: the stack breakpoint is based on the actual two-column minimum.
The 600-pixel render reflows to chat above Debug without horizontal clipping.

### Resolved P2 — the Webview recreated editor chrome

`src/webview/main.tsx:43-47` draws an internal editor toolbar with the profile
title, context, environment, transport, state, and New Conversation action.
The real custom editor already has native tab/title chrome, while
`package.json:330-335` contributes only Open as Text to the native editor title.
The duplicate bar consumes vertical space and makes a Webview imitation of the
workbench.

Resolution: the duplicate Webview editor toolbar was removed. New Conversation
and Open as Text are native custom-editor title actions.

### Resolved P2 — profile configuration was presented as VS Code Settings

`src/webview/SettingsWorkspace.tsx:53-76` labels the profile editor "Settings",
adds a "Settings toolbar" and breadcrumb, and uses Settings-specific visual
tokens. These controls edit the active `*.turnstage.jsonc` profile, not
extension-level `turnstage.*` preferences. VS Code requires extension settings
to use the native Settings UI and discourages recreating it in a Webview.

Resolution: the surface is explicitly named Profile Configuration, the Settings
breadcrumb imitation is removed, and extension preferences remain under
`contributes.configuration`.

### Resolved P2 — profile help was hover-only and not focusable

`src/webview/SettingsWorkspace.tsx:74,282` renders help as a non-focusable
`span` whose explanation is available through `title`. Keyboard users cannot
focus or deliberately open the explanation, and browser title tooltips are not
a robust accessible disclosure.

Resolution: section and card descriptions are concise visible text. The
non-focusable `title`-only help spans were removed.

### Resolved P2 — the Profiles Welcome View was overloaded

`package.nls.json:30` puts five workflows into one empty-state message: Create,
initialize workspace, initialize user, import, and open demo. The official View
guidance asks Welcome content to stay concise and reserve button treatment for
primary actions.

Resolution: trusted workspaces show Create Profile as the single primary action
and direct secondary workflows to TurnStage commands. Restricted Mode keeps the
built-in demo as its single available action.

## Confirmed compliant foundations

- `package.json:211-239` uses one Activity Bar View Container and one native
  Profiles Tree View.
- `package.json:400-410` uses a `CustomTextEditorProvider` for
  `*.turnstage.jsonc`, which is appropriate for synchronized visual editing of
  a text document.
- Extension preferences are contributed under `contributes.configuration`
  rather than stored only in the Webview.
- Webview workbench styling is based on `--vscode-*` variables; the reviewed
  CSS contains no ordinary hard-coded hex/RGB theme palette.
- Workbench-like action icons use Codicons in `src/webview/Icon.tsx`, and Tree
  icons use `ThemeIcon`.
- The chat/debug splitter has separator semantics and keyboard resizing.
- Forced-colors and reduced-motion rules are present, and the current inspector
  event rows are compact 30-pixel rows rather than oversized cards.

## Final hardening re-audit

The second pass found issues not covered by the initial source-level tests. All
were fixed before the final score was assigned:

- Secret-persist control values now remain host-only, are excluded from every
  Webview/run/fixture snapshot, and are neither read nor written in Restricted
  Mode. Resolved environment secrets and known secret-control values are
  redacted from URLs, custom headers, bodies, opening content, errors, events,
  and persisted runs, including backend echoes.
- Restricted Mode disables trust-sensitive native and Webview actions before
  invocation while preserving profile inspection and fixture replay. Persisted
  legacy runs stay unloaded because SecretStorage cannot be consulted safely.
- Profile Configuration is reachable from the native **Configure Profile**
  action and contains compact navigation for all seven sections. Profiles
  remain resource leaf rows rather than command-only Tree hierarchies.
- Message selection and actions are keyboard operable. The actions use an ARIA
  group rather than claiming an incomplete composite toolbar pattern.
- The splitter reports its measured visual position and uses that same state
  for pointer and keyboard resizing, including its Home/End bounds.
- The Profiles View has an icon; the native editor title has only one primary
  icon action; send and stop use Codicons instead of inline SVG copies.
- Profile Tree descriptions, tooltips, command labels, manifest titles, and new
  runtime messages have English and Traditional Chinese catalog coverage. The
  test gate recursively scans every Extension Host TypeScript source file.
- Start, Run, Replay, and Export wait for the Custom Editor controller and no
  longer silently no-op or expose placeholder-only actions.
- The extension no longer claims unsupported multiple editors per document;
  document reload work is debounced and stale asynchronous loads are discarded.
- Every non-modal extension notification offers a localized **Do not show
  again** action backed by a User-scope preference.
- Reduced-motion behavior uses explicit static states rather than a global
  near-zero animation-duration override.
- React DOM and axe tests exposed and fixed two further semantic errors: ARIA
  labels on role-less spans and skipped heading levels.
- The final Impeccable detector pass reports zero findings.
- Export notifications render non-file URIs without assuming a local `fsPath`,
  preserving Virtual Workspace support.

## Audit boundary

The final evidence includes source review, keyboard helper tests, desktop and
600-pixel standalone Webview renders, and trusted/untrusted Extension Host
integration runs. The screenshots remain standalone Webview renders rather
than real Extension Development Host captures; native contribution placement
is verified from the manifest and Extension Host activation tests.
