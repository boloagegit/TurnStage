# TurnStage Web deployment

TurnStage Web is a static browser application. It does not require code-server, OpenVSCode Server, Theia, Node.js, or a VS Code Extension Host in production.

## Build the archive

```bash
npm ci
npm run package:web
```

The command creates `turnstage-web-<version>.zip`. Extract its contents into the document root of any static HTTP server. Do not open `index.html` through `file://`; browser modules and security controls require HTTP or HTTPS.

## Preview the extracted archive locally

After extracting the ZIP, change into the extracted directory that contains `index.html` and run:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/` in a browser. Python 3.6 supports this command; Python is needed only for this optional local preview, not to build or run the deployed Web archive. The server serves the current directory, so running it beside the ZIP instead of inside the extracted directory will not open TurnStage Web. Stop it with Ctrl+C. Python's `http.server` is not intended for production; use a managed static HTTP server or reverse proxy for shared access. A local preview does not start the optional mock API, and real API calls still require browser reachability, trusted TLS, and CORS permission.

## One-command Web server with an optional API proxy

The archive also includes `serve.py` for a simple internal deployment using Python 3.6+ standard-library modules only. It contains no company endpoint. Its listener and optional upstream are supplied at startup.

The command-line options take precedence over environment variables:

| Purpose | Command-line option | Environment variable | Safe default |
| --- | --- | --- | --- |
| Web listen port | `--port` | `TURNSTAGE_WEB_PORT` | `8000` |
| Web listen address | `--bind` | `TURNSTAGE_WEB_BIND` | `127.0.0.1` (local machine only) |
| `/api/` upstream | `--upstream` | `TURNSTAGE_API_UPSTREAM` | disabled |

To expose Web on the network and forward `/api/` to one HTTP service, run from the extracted directory containing `index.html`:

```bash
python3 serve.py --port 9095 --bind 0.0.0.0 --upstream http://127.0.0.1:9098
```

Open `http://SERVER_IP:9095/`. Set the Profile/Environment API base URL to `http://SERVER_IP:9095/api`, or set a request URL directly to `http://SERVER_IP:9095/api/chat` when the upstream endpoint is `/chat`. The script strips `/api` before forwarding, so `/api/chat` reaches `http://127.0.0.1:9098/chat`. The upstream service on 9098 is not modified. Change `--upstream` only if the fixed upstream is at a different reachable HTTP address; the script does not proxy arbitrary Profile URLs or automatically route other services. Requests routed through `/api/` come from the Web server, not from each user's browser, and the browser sees one origin, avoiding CORS for this route. Requests pointed directly at another IP or port still need browser reachability and CORS.

The IP addresses and ports in that command are examples. Replace them with values for the deployment. If `--upstream` and `TURNSTAGE_API_UPSTREAM` are both omitted, static Web still works but `/api/` returns HTTP 503 instead of silently forwarding to a built-in destination.

The equivalent environment-variable form is:

```bash
TURNSTAGE_WEB_PORT=9095 \
TURNSTAGE_WEB_BIND=0.0.0.0 \
TURNSTAGE_API_UPSTREAM=http://127.0.0.1:9098 \
python3 serve.py
```

The proxy forwards request methods, body, authentication headers, response status and headers, and flushes SSE/NDJSON chunks as they arrive. Request bodies are limited to 16 MiB. It does not log URLs or secrets. To keep it running after SSH logout:

For an A/B topology where A hosts TurnStage Web and an existing relay forwards to HTTPS service B, set `--upstream` (or `TURNSTAGE_API_UPSTREAM`) to the relay's HTTP origin and point shared Profiles at `http://A_IP:WEB_PORT/api`. Certificate trust between the relay and B is the relay's responsibility; TurnStage Web and the browser do not disable HTTPS verification. The repository's `npm run test:visual:web-ab` exercises this complete path with dynamically allocated test ports, a test-only relay, and self-signed B, including chat, opening, local case uploads, general tests, and Red Team. It does not validate an organization's actual relay configuration or network policies.

```bash
nohup python3 serve.py --port 9095 --bind 0.0.0.0 --upstream http://127.0.0.1:9098 > /tmp/turnstage-web-9095.log 2>&1 < /dev/null &
echo $!
```

Keep the displayed PID to stop that exact process later. This Python server does not auto-restart after a crash or reboot and is not a hardened production reverse proxy. Restrict access on the company network, prefer HTTPS for sensitive data, and use a managed proxy such as Nginx for a durable shared deployment.

## Minimal Linux example

If the company server already has Nginx, copy the extracted files into a dedicated directory and point an Nginx `root` at that directory. A minimal location is:

```nginx
location /turnstage/ {
    alias /opt/turnstage-web/;
    try_files $uri $uri/ /turnstage/index.html;
}
```

The archive has no server-side runtime dependency. HTTPS, authentication, access logging, and network policy remain responsibilities of the company reverse proxy.

## Serve by IP over ordinary HTTP

For an internal deployment without a domain or TLS certificate, TurnStage Web also works at `http://SERVER_IP:9095/`. Unlike a localhost preview, this is an insecure browser origin, so Web uses an HTTP-compatible UUID and digest implementation. Text copy uses a browser gesture fallback; the chat screenshot action downloads a PNG instead of copying an image to the clipboard. Browser-specific policy can still deny clipboard access, in which case TurnStage reports the failure.

If the SSE proxy is on port 9098 of the same server and Nginx is already available, expose only port 9095 to users and route `/api/` internally:

```nginx
server {
    listen 9095;
    server_name _;
    root /opt/turnstage-web;

    location /api/ {
        proxy_pass http://127.0.0.1:9098/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Set the Profile's API base URL to `http://SERVER_IP:9095/api` (substitute the actual server IP). This keeps browser requests on the Web page's origin, so the 9098 service does not need a browser-facing port or CORS. `proxy_pass` above removes `/api/` before forwarding; adjust it if the SSE proxy itself expects that prefix. A Profile pointing directly at `http://SERVER_IP:9098` is also possible, but that port must be reachable from every user's browser and permit the Web origin through CORS, including any preflight `OPTIONS` request and configured headers. Never use `localhost:9098` in a shared Profile: it refers to the user's own device.

HTTP provides no confidentiality or integrity for the Web app, Profiles, requests, SSE responses, or plaintext tokens. Use this mode only on a trusted internal network with access controls appropriate to the data; prefer HTTPS when tokens or sensitive test content cross an untrusted network. Changing between HTTP and HTTPS or between ports changes the browser storage origin, so export browser-local data before changing the address.

## Add official Profiles from VS Code files

The extracted Web archive contains empty `profiles/` and `environments/` folders plus `update_profiles.py`. Copy your existing VS Code `*.turnstage.jsonc` files into `profiles/`. Nested directories are supported, for example `profiles/Payments/SIT/chat.turnstage.jsonc`; the Web sidebar displays **Default → Payments → SIT → chat**. If a Profile names an Environment, also copy its `*.environment.jsonc` file into `environments/`. From the extracted directory containing `index.html`, run:

```bash
python3 update_profiles.py
```

This uses only the Python 3.6+ standard library; no `pip` install is needed. It scans the two folders recursively and regenerates the adjacent `turnstage-catalog.json` as a list of file paths. The original JSONC files, including comments, stay unchanged. Refresh the Web page to load the new default Profiles. Run the command again after adding, removing, renaming, or changing a file or directory. Python runs only for this update step, not while users browse TurnStage. If the Linux Web server has no Python, run the command on another computer against the extracted archive and upload the resulting files together.

When `profiles/` is empty, the generated catalog keeps the three bundled examples; when it contains files, those become the official Profile list instead. The same rule applies to `environments/`, with the bundled local Environment used only when that folder is empty. A missing or invalid Environment reference makes the catalog fail validation, so copy both files when needed. Existing Unicode or space-containing filenames are supported; file names must end in `.turnstage.jsonc` or `.environment.jsonc` as appropriate. The generated catalog supports up to 100 files of each kind and 512 KiB per file.

The script refuses to overwrite a manually customized catalog. The folder workflow and the manually authored catalog workflow below are alternatives; do not edit the generated catalog by hand. Server folders and their Profiles remain read-only to Web users. To rename, remove, or reorder server folders, change directories on the server (display order is alphabetical by directory name), regenerate the catalog, and refresh the page. Browser-local folders can instead be nested, renamed, moved up/down, or deleted from the sidebar without changing server files; deleting one moves its contents up one level after confirmation. Only browser-supported features run in Web: VS Code workspace links, Test Explorer, Copilot, and SecretStorage do not become available just because their Profile file is shared.

## Official catalog and browser-local profiles

`turnstage-catalog.json` is loaded beside `index.html` at startup with `no-store` caching. It is the deployment-owned catalog of official Profile and Environment presets, so a company can replace this one file after extracting the archive without rebuilding TurnStage Web. The included catalog selects the three bundled examples and local mock environment. Use the folder command above for ordinary VS Code JSONC files; the inline form below is for administrators who intentionally maintain the catalog by hand.

An organization entry can instead carry an inline Profile or Environment. For example:

```json
{
  "format": "turnstage-web-catalog",
  "version": 1,
  "id": "company-catalog",
  "revision": "2026.09.1",
  "profiles": [{
    "id": "payments-test",
    "version": "4",
    "category": "Payments",
    "tags": ["internal", "test"],
    "profile": {
      "version": 1,
      "id": "payments-test",
      "name": "Payments test",
      "environment": "payments-test",
      "conversation": { "send": { "method": "POST", "url": "${env.baseUrl}/chat", "headers": { "Authorization": "Bearer shared-sit-token" } } },
      "stream": { "transport": "sse", "mappings": [] }
    }
  }],
  "environments": [{
    "id": "payments-test",
    "version": "2",
    "environment": {
      "version": 1,
      "id": "payments-test",
      "name": "Payments test",
      "variables": { "baseUrl": "https://payments-test.example.com", "apiKey": "shared-sit-api-key" }
    }
  }]
}
```

Each entry must contain exactly one `bundled` key, a generated local `file` path, or an inline `profile`/`environment` value. The catalog is bounded to 1 MiB, 100 Profiles, 100 Environments, and 512 KiB per entry. A malformed, oversized, duplicated, or unsupported catalog is rejected as a whole and the bundled defaults remain available.

Official presets are never written to browser storage. The Web sidebar lists Profiles only; Environments remain catalog data resolved through the selected Profile and are not a separate sidebar editor. **Duplicate** creates an editable browser-local Profile without changing the official entry. An edit attempt on an official Profile is also rejected by the Web host. Browser-local Profiles open directly in a syntax-highlighted JSONC editor with line numbers, section navigation, search, formatting, completion, and live syntax/schema/platform checks. Errors block Save and can be selected to jump to their source; warnings explain settings that Web ignores or only VS Code/CLI can run. Save is explicit. Unsaved drafts are kept in browser storage and restored after reopening; if the saved source changed meanwhile, Web asks whether to restore or discard the older draft. Invalid edits and drafts do not replace the saved copy or write to the deployment's source file. A newer official entry version is shown without overwriting the copy. A portable Profile import/export includes its referenced Environment, so users can move a complete configuration without a separate Environment control. Browser-local imports and new Profiles remain editable, deletable, and exportable. For backward compatibility, an existing browser-local Profile with the same ID deterministically overrides the official entry; deleting that local override reveals the current official preset.

Inline catalog entries may contain plaintext credentials when every user of that deployment is intentionally allowed to receive them. The browser can read the complete catalog response, so the Web server and reverse proxy must restrict access appropriately. Anyone who can fetch the deployed static files can read those credentials. For per-user credentials, use `${secret.name}` references instead; values entered in the session-secret UI remain in page memory only.

## Browser-to-target connectivity

When a Profile points directly at a target API, requests originate from each user's browser, not from the Linux server. Every directly addressed API must therefore:

- be reachable from the user's browser;
- use a certificate trusted by the browser;
- allow the TurnStage Web origin through CORS;
- permit the required methods and request headers.

The optional `serve.py` or Nginx `/api/` route is different: the browser connects to the same Web origin, and the Web server connects to the one configured upstream. That upstream must be reachable from the Web server, but does not need to be reachable from each browser or provide CORS for this route. A Profile must actually use the Web origin's `/api` URL to get this behavior.

Web does not show an additional TurnStage connection approval prompt. Selecting a Profile may automatically send its configured opening request; sending a message uses its configured conversation URL and credentials. Only install or select Profiles from sources you trust. Browser TLS and CORS checks still apply, and HTTP does not protect credentials in transit.

The Web Network inspector records opening responses, including bounded previews of non-successful HTTP responses, so a failed opening can be distinguished from a missing browser request. A non-2xx response from the `/api/` upstream is not converted into a successful opening; inspect its status and Response tab to correct the upstream path or request format.

TurnStage Web cannot disable TLS verification or silently use a system proxy. If an existing VS Code Profile contains `tls.allowInvalidCertificates`, Web ignores that flag and lets the browser enforce normal certificate checks; HTTP `/api/` routes do not need that flag. Profiles, Environments, and display preferences use versioned browser `localStorage`; this includes plaintext credentials written into Profile or Environment JSON. Optional `${secret.*}` values are kept only in page memory and are cleared on refresh. Larger suites, runs, evidence, campaigns, and visual baselines use IndexedDB.

## Compatibility boundary

The Web build shares the production TurnStage React workspace, Profile codec and validator, request builder, SSE/NDJSON parsers, mapping engine, reducer, scenario runner, adversarial evaluator, evidence timeline, campaign planner, replay engine, and redaction logic with the VSIX. Browser-native adapters provide:

- Deployment-configurable official Profile and Environment catalogs, with Profile-focused browser-local creation, import, selection, duplication, editing, deletion, single-file portable Profile export/import, and four display languages.
- Complete browser fallbacks for every VS Code theme token consumed by the shared UI, with persistent dark, light, and system appearance modes.
- Memory-only secrets, live browser `fetch`, chat, network/event/metric/error inspection, connection analysis, and safe HTTP(S) links.
- IndexedDB-backed run replay/import/export, functional and adversarial CSV/JSONC/JSONL suites, evidence, JSON/JUnit/HTML reports, zipped evidence bundles, campaigns, and per-viewport visual baselines.

VS Code Test Explorer, VS Code commands, workspace filesystem linking, SecretStorage, and GitHub Copilot model calls remain Extension Host capabilities. Controls without a browser-native equivalent are disabled in Web and identify the VS Code-only boundary; supported testing and storage actions route to browser-native equivalents. All Copilot-labelled actions are disabled in Web, and the Web host rejects direct Copilot messages instead of substituting a local download.

Test-suite import is intentionally different from workspace linking. Web imports a standalone copy into IndexedDB and can edit, run, and export that browser copy. It cannot retain a live path to the user's original file, detect external file changes, or write back to that file. Therefore Link, Refresh linked source, and Open original source controls are disabled in Web; stale or direct link messages are rejected by the Web host instead of being silently treated as imports.

Browser data is origin-scoped. Moving the static files to a different scheme, host, or port creates a different browser storage origin; export anything that must move with the deployment first. Clearing site data removes browser-local TurnStage data.
