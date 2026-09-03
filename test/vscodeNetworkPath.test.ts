import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  remoteName: undefined as string | undefined,
}));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (key: string, fallback?: unknown) => mock.values.has(key) ? mock.values.get(key) : fallback }) },
  env: { get remoteName() { return mock.remoteName; } },
}));

import { inspectVSCodeNetworkPath, resolveVSCodeInsecureTlsRoute } from '../src/extension/connection/vscodeNetworkPath';

describe('VS Code network path adapter', () => {
  afterEach(() => { mock.values.clear(); mock.remoteName = undefined; vi.unstubAllEnvs(); });

  it('reduces VS Code and environment configuration to non-secret facts', () => {
    mock.values.set('proxySupport', 'override');
    mock.values.set('proxy', 'https://user:secret@proxy.corp:8443');
    mock.values.set('noProxy', ['localhost', '.internal.corp']);
    mock.values.set('systemCertificates', true);
    vi.stubEnv('HTTPS_PROXY', 'https://another-secret@proxy.example');
    mock.remoteName = 'ssh-remote';

    const result = inspectVSCodeNetworkPath('https://service.example/chat');
    expect(result).toMatchObject({ runtime: 'remote', route: 'likely-proxied', proxyConfigured: true, environmentProxyConfigured: true, noProxyConfigured: true });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('proxy.corp');
    expect(JSON.stringify(result)).not.toContain('internal.corp');
  });

  it('uses only an explicit direct or manual proxy route for insecure TLS', () => {
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(name, '');
    mock.values.set('proxySupport', 'override');
    expect(resolveVSCodeInsecureTlsRoute('https://service.example/chat')).toEqual({ mode: 'unknown' });

    mock.values.set('proxy', 'http://user:secret@proxy.corp:8080');
    expect(resolveVSCodeInsecureTlsRoute('https://service.example/chat')).toEqual({ mode: 'manual-proxy', proxyUrl: 'http://user:secret@proxy.corp:8080' });

    mock.values.set('noProxy', ['service.example']);
    expect(resolveVSCodeInsecureTlsRoute('https://service.example/chat')).toEqual({ mode: 'direct' });
  });
});
