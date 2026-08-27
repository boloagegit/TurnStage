# VS Code extension UI guidelines

This document is the required UI review standard for TurnStage. It translates
the official VS Code extension UX, Webview, Custom Editor, theming, icon, and
accessibility guidance into repository-level acceptance criteria. "Must" means
a change is not ready to merge until it complies or records a justified
exception. "Should" means reviewers expect compliance unless the change has a
documented product reason not to follow it.

Official guidance was last checked on 2026-08-27. When this document and the
current VS Code documentation disagree, the current official documentation is
authoritative and this document must be updated.

## Product surface and contribution model

- TurnStage must use one Activity Bar View Container for its related views. A
  View Container opens native Sidebar views; it must not act as a shortcut that
  opens an editor or runs a command.
- The Activity Bar container icon must be a 24-by-24 monochrome SVG that uses
  `currentColor`, follows the VS Code product-icon visual weight, and does not
  duplicate an existing product icon. Every contributed View must also declare
  an icon so it remains identifiable if the user moves it to another container.
- Profiles and other navigable resources must use native Tree Views. Tree items
  must represent data or resources, not exist only as command buttons.
- The Sidebar should contain only related TurnStage views, normally one view
  and never more than three to five. Hierarchy must remain shallow.
- Chat simulation and its inspector may use a Custom Text Editor because the
  combined interactive experience cannot be expressed by the native Tree,
  Settings, or text editor APIs alone.
- Webviews must open only in a relevant user context. They must not open on
  install or use promotional, onboarding, or wizard content that belongs in a
  Welcome View, Walkthrough, Quick Pick, or notification.

## Sidebar, Tree View, and menus

- A profile Tree item must open the profile editor and expose a compact set of
  contextual actions. Do not create child rows solely to jump to sections of
  the same editor.
- A Tree item must expose no more than three direct actions. Additional related
  commands should be grouped into a submenu, Command Palette, or the opened
  editor's contextual toolbar.
- A View title toolbar must contain only high-value actions. Use Codicons,
  concise tooltips, `when` clauses, and stable ordering.
- Empty-state Welcome content must be concise. It may contain explanatory text,
  links, and only the most important primary action; secondary workflows should
  move to the Command Palette or an overflow menu.
- Context menus must be contextual, grouped by purpose, and kept short. Large
  command groups must use submenus.
- Command names must use the same `TurnStage` category, describe an explicit
  action, and be hidden from the Command Palette when they are meaningful only
  in a specific UI context.

## Native Settings versus profile configuration

- Every extension preference under `turnstage.*` must be contributed through
  `contributes.configuration` so it appears in the native VS Code Settings UI
  with a useful default, description, and documentation link when needed.
- TurnStage must not recreate extension Settings in a Webview.
- Editing a `*.turnstage.jsonc` document through a Custom Text Editor is profile
  configuration, not extension Settings. The UI must call it **Profile
  Configuration** or **Profile Editor** and must not imitate the native Settings
  title, breadcrumb, or information architecture in a way that blurs this
  boundary.
- Profile-specific schema fields may be edited visually only when every change
  remains synchronized with the underlying JSONC document.

## Custom Text Editor behavior

- The `TextDocument` is the source of truth. Structured edits must use
  `WorkspaceEdit` so undo, redo, dirty state, save, revert, and hot exit retain
  normal editor behavior.
- Multiple editors for the same document must remain synchronized.
- Every edit must be the smallest practical `WorkspaceEdit`, preserve comments
  and existing JSONC formatting outside the edited value, and avoid host-to-
  Webview-to-host update loops.
- Invalid documents must show a recoverable error state and preserve access to
  the underlying text. Change-driven parsing or rendering must be debounced
  when the work could affect editor responsiveness.
- Commands that apply to the active profile should use native editor-title
  actions when appropriate instead of recreating VS Code editor chrome inside
  the Webview.
- The primary `editor/title` navigation group must contain at most one icon
  action. Secondary actions belong in the overflow menu.

## Webview security, state, and lifecycle

- Webviews must use a restrictive Content Security Policy with
  `default-src 'none'`, nonce-authorized local scripts, and no network access
  unless the feature explicitly requires and documents it.
- `localResourceRoots` and enabled capabilities must be limited to the minimum
  resources required by the surface. Workspace, profile, stream, and user input
  must be validated or safely rendered; untrusted content must never become
  executable HTML, script, a command URI, or an unrestricted external URI.
- Secret values must remain in the Extension Host. A Webview may submit a new
  secret value to the host, but snapshots, history, fixtures, diagnostics, and
  host-to-Webview messages must contain only non-secret values or an explicit
  boolean configured-state.
- Webview UI state should use `getState` and `setState`. Do not enable
  `retainContextWhenHidden` unless a measured requirement justifies its memory
  cost.

## Theme, typography, spacing, and icons

- Webview colors, borders, focus indicators, fonts, and controls must derive
  from `--vscode-*` theme variables. Do not introduce literal product colors
  for ordinary workbench UI.
- The UI must remain usable in light, dark, and high-contrast themes. Custom
  mobile-preview decoration may establish its own composition, but its text,
  controls, and interactive states must still meet contrast and focus
  requirements.
- Workbench-like actions must use Codicons or `ThemeIcon`. Icons must inherit
  `currentColor`, remain understandable under Product Icon Themes, and have a
  concise accessible label and tooltip.
- Font family, font size, line height, and spacing should follow VS Code tokens
  or relative units. Density should match the surrounding workbench; inspector
  rows and toolbars must not be inflated into card-like application UI.
- Explanatory copy must be concise and progressively disclosed. Persistent
  prose is reserved for information required to understand state, risk, or the
  next action.

## Accessibility and responsive behavior

- Every interaction must be operable using only the keyboard and expose an
  accessible name. Semantic HTML controls are preferred over ARIA emulation.
- Focus must be visible and follow a natural order. Composite widgets such as
  tabs, toolbars, and listboxes must be one Tab stop and implement the expected
  arrow-key navigation rather than placing every child in the page Tab order.
- Tabs must connect each `tab` with its `tabpanel` using stable IDs,
  `aria-controls`, and `aria-labelledby`. Selection state must be announced.
- Splitters must expose separator semantics, current bounds, and keyboard
  resizing. Streaming, validation, and error state changes that matter to the
  user must be announced without flooding assistive technology.
- The Webview must reflow without horizontal clipping when the editor group or
  Panel becomes narrow. It must support VS Code zoom, large text, forced colors,
  and reduced motion.
- Motion must not be the only way to communicate streaming or progress, and
  nonessential animation must stop when reduced motion is requested.

## Notifications and progress

- Notifications must be reserved for information that needs immediate
  attention. Repeated or low-priority state belongs in the relevant view,
  editor, Output Channel, or status surface.
- Long-running work must show contextual progress and provide cancellation when
  the operation can be cancelled. Errors must explain the next useful action
  without repeating the same notification.
- Every non-modal notification must offer a localized **Do not show again**
  action backed by a user-level preference. User-initiated operations should
  prefer inline confirmation, the relevant View, or the Output Channel when no
  immediate attention is required.

## Localization and Workspace Trust

- Manifest strings must use `%key%` references. Extension Host UI must use
  `vscode.l10n.t`; Webview copy must use the project localization layer. New
  user-facing strings require English and Traditional Chinese entries plus a
  parity test.
- Trust-sensitive commands must be hidden or disabled with contribution-point
  context keys and guarded again at runtime because commands may be invoked
  programmatically.
- In Restricted Mode, network, command execution, file mutation, and secret
  access must fail closed. Fixture replay and other explicitly safe read-only
  behavior may remain available. `restrictedConfigurations` must list any
  preference whose untrusted value could broaden capability.

## Pull request acceptance checklist

- The chosen VS Code surface is the smallest native or custom surface that can
  support the workflow.
- Sidebar hierarchy and item actions remain compact and contextual.
- Extension Settings and profile configuration are visibly distinct.
- All workbench-like styling uses VS Code theme variables and Codicons.
- Keyboard-only operation covers toolbars, tabs, listboxes, forms, splitters,
  dialogs, and message actions.
- Light, dark, high-contrast, forced-colors, reduced-motion, zoom, and narrow
  editor behavior have been checked.
- Custom Editor edits preserve TextDocument synchronization and native editor
  lifecycle behavior.
- Empty, loading, streaming, stopped, invalid, error, restricted-workspace, and
  large-event states have been checked where the change affects them.
- A screenshot or recording used as review evidence is identified as either a
  real Extension Development Host capture or a standalone Webview render.
- Webview CSP, resource roots, state persistence, input handling, secret
  boundaries, localization parity, and runtime Workspace Trust guards have been
  checked.

Items such as one-Tab-stop composite widgets, exact splitter bounds, fixture
retention, and screenshot provenance are deliberate TurnStage-specific
hardening rules. They extend the official guidance and are not presented as
verbatim VS Code requirements.

## Official sources

- [UX Guidelines overview](https://code.visualstudio.com/api/ux-guidelines/overview)
- [Activity Bar](https://code.visualstudio.com/api/ux-guidelines/activity-bar)
- [Sidebars](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [Views and View Containers](https://code.visualstudio.com/api/ux-guidelines/views)
- [Webviews UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews)
- [Webview API guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Custom Editors API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [Settings UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/settings)
- [Command Palette and commands](https://code.visualstudio.com/api/ux-guidelines/command-palette)
- [Commands API guide](https://code.visualstudio.com/api/extension-guides/command)
- [Context menus](https://code.visualstudio.com/api/ux-guidelines/context-menus)
- [Editor actions](https://code.visualstudio.com/api/ux-guidelines/editor-actions)
- [Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks)
- [Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)
- [Panel](https://code.visualstudio.com/api/ux-guidelines/panel)
- [Status Bar](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [Theme color reference](https://code.visualstudio.com/api/references/theme-color)
- [Codicons in labels](https://code.visualstudio.com/api/references/icons-in-labels)
- [VS Code accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility)
- [VS Code localization API](https://code.visualstudio.com/api/references/vscode-api#l10n)
- [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
