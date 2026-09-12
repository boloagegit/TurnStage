# TurnStage Web deployment

TurnStage Web is a static browser application. It does not require code-server, OpenVSCode Server, Theia, Node.js, or a VS Code Extension Host in production.

## Build the archive

```bash
npm ci
npm run package:web
```

The command creates `turnstage-web-<version>.zip`. Extract its contents into the document root of any static HTTP server. Do not open `index.html` through `file://`; browser modules and security controls require HTTP or HTTPS.

## Minimal Linux example

If the company server already has Nginx, copy the extracted files into a dedicated directory and point an Nginx `root` at that directory. A minimal location is:

```nginx
location /turnstage/ {
    alias /opt/turnstage-web/;
    try_files $uri $uri/ /turnstage/index.html;
}
```

The archive has no server-side runtime dependency. HTTPS, authentication, access logging, and network policy remain responsibilities of the company reverse proxy.

## Official catalog and browser-local profiles

`turnstage-catalog.json` is loaded beside `index.html` at startup with `no-store` caching. It is the deployment-owned catalog of official Profile and Environment presets, so a company can replace this one file after extracting the archive without rebuilding TurnStage Web. The included catalog selects the three bundled examples and local mock environment.

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

Each entry must contain exactly one `bundled` key or one inline `profile`/`environment` value. The catalog is bounded to 1 MiB, 100 Profiles, 100 Environments, and 512 KiB per entry. A malformed, oversized, duplicated, or unsupported catalog is rejected as a whole and the bundled defaults remain available.

Official presets are never written to browser storage and are immutable in the UI. Their configuration controls are disabled and the editor explains that the user must select **Duplicate** to create an editable browser-local copy with its catalog origin and version. An edit attempt is also rejected by the Web host, so a future or stale UI cannot mutate the deployment-owned entry implicitly. A newer official entry version is shown without overwriting the copy. Browser-local imports and new Profiles remain editable, deletable, and exportable. For backward compatibility, an existing browser-local Profile with the same ID deterministically overrides the official entry; deleting that local override reveals the current official preset.

Inline catalog entries may contain plaintext credentials when every user of that deployment is intentionally allowed to receive them. The browser can read the complete catalog response, so the Web server and reverse proxy must restrict access appropriately. Anyone who can fetch the deployed static files can read those credentials. For per-user credentials, use `${secret.name}` references instead; values entered in the session-secret UI remain in page memory only.

## Browser-to-target connectivity

Requests originate from each user's browser, not from the Linux server. Every target API must therefore:

- be reachable from the user's browser;
- use a certificate trusted by the browser;
- allow the TurnStage Web origin through CORS;
- permit the required methods and request headers.

TurnStage Web cannot disable TLS verification or silently use a system proxy. Profiles, Environments, and display preferences use versioned browser `localStorage`; this includes plaintext credentials written into Profile or Environment JSON. Optional `${secret.*}` values are kept only in page memory and are cleared on refresh. Larger suites, runs, evidence, campaigns, and visual baselines use IndexedDB.

## Compatibility boundary

The Web build shares the production TurnStage React workspace, Profile codec and validator, request builder, SSE/NDJSON parsers, mapping engine, reducer, scenario runner, adversarial evaluator, evidence timeline, campaign planner, replay engine, and redaction logic with the VSIX. Browser-native adapters provide:

- Deployment-configurable official Profile and Environment catalogs plus browser-local creation, import, selection, duplication, editing, deletion, single-file portable Profile export/import, and four display languages.
- Complete browser fallbacks for every VS Code theme token consumed by the shared UI, with persistent dark, light, and system appearance modes.
- Memory-only secrets, live browser `fetch`, chat, network/event/metric/error inspection, connection analysis, and safe HTTP(S) links.
- IndexedDB-backed run replay/import/export, functional and adversarial CSV/JSONC/JSONL suites, evidence, JSON/JUnit/HTML reports, zipped evidence bundles, campaigns, and per-viewport visual baselines.

VS Code Test Explorer, VS Code commands, workspace filesystem linking, SecretStorage, and GitHub Copilot model calls remain Extension Host capabilities. Controls without a browser-native equivalent are disabled in Web and identify the VS Code-only boundary; supported testing and storage actions route to browser-native equivalents. All Copilot-labelled actions are disabled in Web, and the Web host rejects direct Copilot messages instead of substituting a local download.

Test-suite import is intentionally different from workspace linking. Web imports a standalone copy into IndexedDB and can edit, run, and export that browser copy. It cannot retain a live path to the user's original file, detect external file changes, or write back to that file. Therefore Link, Refresh linked source, and Open original source controls are disabled in Web; stale or direct link messages are rejected by the Web host instead of being silently treated as imports.

Browser data is origin-scoped. Moving the static files to a different scheme, host, or port creates a different browser storage origin; export anything that must move with the deployment first. Clearing site data removes browser-local TurnStage data.
