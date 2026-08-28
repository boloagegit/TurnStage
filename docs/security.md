# Security model

TurnStage treats profiles and backend responses as untrusted configuration/data.
The Extension Host is the security boundary: it owns network requests, file
access, SecretStorage, URI checks, and command execution. The Webview receives
snapshots and redacted previews and renders declarative content.

## Webview isolation

The custom editor creates a Webview with:

```text
default-src 'none'
connect-src <webview CSP source>
img-src <webview CSP source> data: blob:
style-src <webview CSP source> 'unsafe-inline'
font-src <webview CSP source> data:
script-src 'nonce-<random nonce>'
```

Scripts use a per-panel random nonce. `localResourceRoots` is restricted to the
extension `dist` directory. The panel does not use `EventSource`, call backend
URLs, load arbitrary iframes, or render remote images. `connect-src` permits
only the Webview resource origin so the screenshot renderer can embed the
already-bundled Codicon font; HTTP and HTTPS backend connections remain
blocked. React renders message text and code blocks as text; the current
renderer does not inject backend HTML.

This protects the panel from becoming a direct backend client, but it is not a
complete content sanitizer for future renderers. Keep remote content as text
and preserve `default-src 'none'` plus the extension-only `connect-src` policy
when adding features.

Chat screenshots are created from the logical Chat viewport, never the Debug
pane. A direct user gesture writes the generated image to the local system
clipboard through the Web Clipboard API. The Webview verifies the PNG data URL,
base64 syntax, PNG signature, and a 24 MiB decoded-size limit before copying.
The image does not cross the Host/Webview protocol, touch the workspace file
system, make a network request, or remain retained by TurnStage.

## Host/Webview messages

Every message carries:

```ts
{
  protocolVersion: 1,
  editorInstanceId: string,
  requestId: string
}
```

The host checks protocol version, editor instance ID, request ID type, and a
string discriminant through `isWebviewMessage`. The Webview applies the same
version/instance check to host messages. IDs used for citations, actions, forms,
and runs are looked up against host-owned controller state before an operation
is performed.

This is an envelope/discriminant check rather than full runtime validation of
every union payload. The host should therefore continue treating all Webview
fields as attacker-controlled: do not use a received URI, path, command, or
payload without a host-side lookup and policy check. Profile patches are
limited to the `name`, `description`, and `ui` roots and are applied with
structured JSONC edits.

## Network boundary and Workspace Trust

Network calls are made only by the Extension Host through `fetch`. Request URLs
are resolved from a profile/environment and must be `http:` or `https:`. The
SSE/NDJSON transport checks the expected content type for the selected parser,
limits an HTTP error body shown in the error message to 4096 bytes, limits a
single SSE/NDJSON record to 1 MiB by default, and supports AbortController
cancellation and configured timeouts. Redirects are handled manually with a
bounded hop count. The default is same-origin only; explicit cross-origin
following strips common credential headers and any header whose value contains
a secret resolved for that request.

When `vscode.workspace.isTrusted` is false:

- profile discovery, editing, validation, and built-in fixture replay remain
  available;
- persisted local runs are not loaded, because legacy run payloads may predate
  current value-based redaction and SecretStorage is intentionally unavailable;
- request-backed openings and conversation requests are blocked with
  `WorkspaceTrustError`;
- secret-persist controls are not read from SecretStorage and `control.set`
  cannot change or write them;
- citation opening is blocked;
- the Webview shows a restricted-mode banner.

The host checks trust even when a command is invoked directly. The
`invokeAction` path rejects profile commands in an untrusted workspace and then
enforces an allowlist for `vscodeCommand.invoke:<id>`. Treat profile actions and
allowlisted commands as privileged and review them before running.

The extension declares limited untrusted-workspace support in `package.json`.
Workspace paths and localhost URLs are interpreted by the current Extension
Host, which may be local, remote, WSL, or a development container.

## Secrets

Use these commands to manage values:

```text
TurnStage: Set Secret
TurnStage: Remove Secret
TurnStage: List Secret Names
```

`SecretService` stores values using `ExtensionContext.secrets` under a
`turnstage.<name>` key. It stores only the sorted name index in global state;
the list command returns names and never displays values. Environment files
contain only references:

```jsonc
{
  "secretReferences": {
    "apiToken": "local-api-token"
  }
}
```

When a template contains `${secret.apiToken}`, the host resolves `apiToken`
through that reference (or uses the placeholder name if no reference exists).
Missing values fail request construction with `MissingSecretError`. No secret
value is intentionally sent to the Webview. A `secret`-persist control is a
host-only request input: its value is omitted from `SessionSnapshot.controls`,
fixture snapshots, local-run snapshots, and the runs list sent to the Webview.
Trusted workspaces may still set that control through the host message path and
the host may resolve it in request/template context. Restricted workspaces do
not hydrate or persist the control, even when a Webview sends `control.set`.

Do not put credentials in profile/environment files, fixtures, source code, or
mock-server values. Use example-only values such as `example-value` and the
local loopback endpoint.

## Redaction

Request previews and the redacted request stored in a local run apply two
structural layers, plus value-based masking of resolved environment secrets and
the current profile's known secret-control values:

1. Headers named `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, or
   `Proxy-Authorization` are replaced with a masked value while preserving a
   leading scheme such as `Bearer`.
2. Recursive body values under case-insensitive keys matching a sensitive
   header or `/secret|token|password/i` are replaced with mask text.

The resolved request itself remains host-side. The preview contains method,
URL, redacted headers/body, and selected variant ID. Values resolved from
SecretStorage and known secret controls are masked wherever they appear in the
URL, arbitrary headers/body fields, errors, opening content, or recorded raw
and normalized event data. This also prevents a backend echo of a current
request secret from reaching the Webview or a newly recorded run. The semantic
validator also warns when profile text
resembles a long `sk-`, `token-`, or `bearer-` value; it does not move or delete
the value automatically.

Redaction boundaries to account for when designing profiles:

- arbitrary response/raw event data is not a general credential sanitizer;
  profiles should still ensure backends do not stream credentials unrelated to
  secrets resolved for the current editor session;
- the output channel currently logs opening/editor errors, not a structured
  secret-aware audit stream. Avoid putting sensitive values in error messages.

## URI and citation policy

The Webview sends a citation ID, not a URL/path. The host resolves the citation
from the current message snapshot and `UriPolicy` performs the following:

### URL citations

- trust is required;
- the parsed scheme must be in `security.allowedUriSchemes`, defaulting to
  `https`;
- `javascript`, `command`, and `data` are always rejected;
- when `allowedDomains` is non-empty, the URI authority must exactly match one
  of the entries;
- accepted URLs open through `vscode.env.openExternal`.

The profile validator accepts only `https`, `http`, and `file` in
`allowedUriSchemes`. The runtime's default is HTTPS-only, so opt into HTTP or
file behavior explicitly and review the profile before running it.

### File and symbol citations

The host resolves a relative citation path against the workspace folder that
contains the profile. Paths that resolve outside the workspace are rejected;
the document is opened with VS Code's text editor. The current implementation
does not apply citation ranges and does not implement `artifact` opening.

Do not pass arbitrary paths from a Webview click directly to
`workspace.fs`/`openTextDocument`; keep the citation-ID lookup and workspace
containment check in the host.

## Actions and forms

Backend events can describe response actions, but the host executes them only
after the user clicks a rendered action. Built-in actions include copy, retry,
abort, new conversation, and clear conversation. A command action must use the
`vscodeCommand.invoke:` prefix and match an exact string in
`profile.security.allowedCommands`; the profile cannot execute a shell or
arbitrary JavaScript.

Forms are declarative data. The Webview supports text, textarea, tel, email,
number, select, and checkbox fields, and validates required values, maximum
length, and regular-expression patterns before sending a `form.submit`
message. It does not evaluate HTML, CSS, React, Angular, or script supplied by
the backend. Cancelling clears the form's local values, marks it cancelled, and
sends no request; the host's `form.cancel` branch remains intentionally
side-effect free.

## Profile and content safety

JSONC is parsed by `jsonc-parser`; request templates use a fixed set of path
lookups and transforms (`trim`, `lowercase`, `uppercase`, `number`, `boolean`,
`json`, `default`, `join`). There is no `eval`, `new Function`, dynamic require,
user script, or profile-provided CSS/HTML execution path. Regex mappings are
limited to 256 characters by semantic validation and are tested against at
most 4096 characters of actual input.

The host should continue rejecting unknown protocol versions and untrusted
payloads. Avoid broadening `allowedPatchRoots`, URI schemes, command allowlists,
or Webview resource roots without a corresponding policy review.

## Logging, export, and review checklist

Before committing a profile or exporting a run, check that it contains no:

- API key, bearer token, cookie, password, or secret value;
- private endpoint or customer identifier;
- unreviewed `allowedDomains` or `allowedCommands` entry;
- citation path outside the intended workspace;
- backend event that carries credentials in raw data.

An exported run is JSON selected through a save dialog. Its request field is the
redacted request, but raw events, normalized events, snapshot content, and
backend diagnostics can contain arbitrary backend data. Treat exported runs as
potentially sensitive and store them accordingly.

Imported run files are untrusted input. TurnStage bounds the selected file at
20 MiB, validates the versioned or legacy run structure, requires a matching
profile ID, and writes only sanitized run data to profile-scoped global
storage. Import never starts a request, opens a citation, invokes an action, or
writes values to SecretStorage. Full imported payloads remain in the Extension
Host; the Webview receives only run summaries until replay is explicitly
selected.

## Current security limitations

- Profile validation does not resolve every template path, secret reference,
  action ID, or component name before runtime.
- value-based redaction covers secrets resolved for the current editor session,
  but cannot identify unrelated credentials emitted by a backend.
- Host/Webview messages are checked by discriminant and bounded nested shape,
  but allowlists, IDs, patch paths, URIs, and commands remain privileged and are
  revalidated at their host-owned action boundary.
- There is no telemetry, account system, cloud sync, or automatic external URL
  trust mechanism.
