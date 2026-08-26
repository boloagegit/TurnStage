# Security model

TurnStage treats profiles and backend responses as untrusted configuration/data.
The Extension Host is the security boundary: it owns network requests, file
access, SecretStorage, URI checks, and command execution. The Webview receives
snapshots and redacted previews and renders declarative content.

## Webview isolation

The custom editor creates a Webview with:

```text
default-src 'none'
connect-src 'none'
img-src <webview CSP source>
style-src <webview CSP source> 'unsafe-inline'
font-src <webview CSP source>
script-src 'nonce-<random nonce>'
```

Scripts use a per-panel random nonce. `localResourceRoots` is restricted to the
extension `dist` directory. The panel does not use `EventSource`, direct
`fetch`, arbitrary iframes, or remote images. React renders message text and
code blocks as text; the current renderer does not inject backend HTML.

This protects the panel from becoming a direct backend client, but it is not a
complete content sanitizer for future renderers. Keep remote content as text
and preserve the `default-src 'none'`/`connect-src 'none'` policy when adding
features.

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
limits an HTTP error body shown in the error message to 4096 characters, and
supports AbortController cancellation and configured timeouts.

When `vscode.workspace.isTrusted` is false:

- profile discovery, editing, validation, and built-in fixture replay remain
  available;
- request-backed openings and conversation requests are blocked with
  `WorkspaceTrustError`;
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
value is intentionally sent to the Webview.

Do not put credentials in profile/environment files, fixtures, source code, or
mock-server values. Use example-only values such as `example-value` and the
local loopback endpoint.

## Redaction

Request previews and the redacted request stored in a local run apply two
layers:

1. Headers named `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, or
   `Proxy-Authorization` are replaced with a masked value while preserving a
   leading scheme such as `Bearer`.
2. Recursive body values under case-insensitive keys matching a sensitive
   header or `/secret|token|password/i` are replaced with mask text.

The resolved request itself remains host-side. The preview contains method,
URL, redacted headers/body, and selected variant ID. The semantic validator
also warns when profile text resembles a long `sk-`, `token-`, or `bearer-`
value; it does not move or delete the value automatically.

Redaction boundaries to account for when designing profiles:

- a secret interpolated into a URL is not masked by `redactHeaders`;
- arbitrary response/raw event data is not recursively scrubbed before being
  shown or recorded, so backends must not stream credentials;
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

## Current security limitations

- Full runtime validation of all Webview union payloads is not implemented.
- Profile validation does not resolve every template path, secret reference,
  action ID, or component name before runtime.
- URL secret interpolation and raw-event/run content redaction need stronger
  policy if profiles handle real credentials.
- The host message check validates the envelope/discriminant rather than every
  nested payload; allowlists and IDs should still be reviewed as privileged
  inputs.
- There is no telemetry, account system, cloud sync, or automatic external URL
  trust mechanism.
