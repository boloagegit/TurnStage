import { describe, expect, it } from 'vitest';
import type { PreparedRequest } from '../src/shared/types';
import { createRequestFetch } from '../src/extension/transport/requestFetch';

function request(allowInvalidCertificates = false): PreparedRequest {
  return {
    method: 'POST', url: 'https://localhost:9443/chat', headers: {},
    ...(allowInvalidCertificates ? { tls: { allowInvalidCertificates: true } } : {}),
    redacted: { method: 'POST', url: 'https://localhost:9443/chat', headers: {}, ...(allowInvalidCertificates ? { tls: { allowInvalidCertificates: true } } : {}) },
  };
}

describe('request fetch isolation', () => {
  it('keeps ordinary requests on the VS Code-patched global fetch', async () => {
    const handle = await createRequestFetch(request());
    expect(handle.mode).toBe('vscode');
    expect(handle.fetch).toBe(globalThis.fetch);
    await handle.dispose();
  });

  it('creates and disposes a request-local insecure dispatcher', async () => {
    const handle = await createRequestFetch(request(true), { mode: 'direct' });
    expect(handle.mode).toBe('insecure-direct');
    await handle.dispose();
    await handle.dispose();
  });

  it('fails closed for unknown routes, non-HTTPS targets, and invalid proxies', async () => {
    await expect(createRequestFetch(request(true), { mode: 'unknown' })).rejects.toThrowError(/cannot preserve this system-managed proxy route/i);
    await expect(createRequestFetch({ ...request(true), url: 'http://localhost/chat' }, { mode: 'direct' })).rejects.toThrowError(/only for HTTPS requests/i);
    await expect(createRequestFetch(request(true), { mode: 'manual-proxy', proxyUrl: 'file:///secret-proxy' })).rejects.toThrowError(/explicit proxy cannot be used/i);
  });
});
