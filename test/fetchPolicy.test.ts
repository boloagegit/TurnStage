import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedRequest } from '../src/shared/types';
import { fetchWithRedirectPolicy } from '../src/extension/transport/fetchPolicy';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('fetchWithRedirectPolicy', () => {
  it('follows bounded same-origin redirects manually', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { Location: '/stream' } })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;

    await expect(fetchWithRedirectPolicy(prepared(), new AbortController().signal)).resolves.toMatchObject({ status: 200 });
    expect(calls.map(({ url }) => url)).toEqual(['https://api.example.test/chat', 'https://api.example.test/stream']);
    expect(calls.every(({ init }) => init?.redirect === 'manual')).toBe(true);
  });

  it('blocks cross-origin redirects by default', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 307, headers: { Location: 'https://other.example.test/stream' } })) as typeof fetch;
    await expect(fetchWithRedirectPolicy(prepared(), new AbortController().signal)).rejects.toMatchObject({ type: 'CrossOriginRedirectError' });
  });

  it('never carries invalid-certificate access across origins', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 307, headers: { Location: 'https://other.example.test/stream' } })) as typeof fetch;
    await expect(fetchWithRedirectPolicy(prepared({ redirectPolicy: 'follow', tls: { allowInvalidCertificates: true } }), new AbortController().signal))
      .rejects.toMatchObject({ type: 'InsecureTlsCrossOriginRedirectError' });
  });

  it('strips credentials and known secret values when cross-origin follow is explicit', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return calls.length === 1
        ? new Response(null, { status: 307, headers: { Location: 'https://other.example.test/stream' } })
        : new Response('ok', { status: 200 });
    }) as typeof fetch;
    const request = prepared({
      redirectPolicy: 'follow',
      headers: { Authorization: 'Bearer token', 'X-Custom-Secret': 'prefix-secret-value', 'Api-Key': 'literal-key', 'X-Access-Token': 'literal-token', Accept: 'text/event-stream' },
      secretValues: ['secret-value'],
    });

    await fetchWithRedirectPolicy(request, new AbortController().signal);
    const redirectedHeaders = new Headers(calls[1]?.headers);
    expect(redirectedHeaders.has('authorization')).toBe(false);
    expect(redirectedHeaders.has('x-custom-secret')).toBe(false);
    expect(redirectedHeaders.has('api-key')).toBe(false);
    expect(redirectedHeaders.has('x-access-token')).toBe(false);
    expect(redirectedHeaders.get('accept')).toBe('text/event-stream');
  });

  it('rejects redirects when configured and enforces the maximum count', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: '/again' } })) as typeof fetch;
    await expect(fetchWithRedirectPolicy(prepared({ redirectPolicy: 'error' }), new AbortController().signal)).rejects.toMatchObject({ type: 'RedirectRejectedError' });
    await expect(fetchWithRedirectPolicy(prepared({ maxRedirects: 1 }), new AbortController().signal)).rejects.toMatchObject({ type: 'TooManyRedirectsError' });
  });

  it('rejects non-http and credential-bearing redirect targets', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'file:///tmp/value' } })) as typeof fetch;
    await expect(fetchWithRedirectPolicy(prepared(), new AbortController().signal)).rejects.toMatchObject({ type: 'InvalidRedirectError' });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://user:pass@api.example.test/stream' } })) as typeof fetch;
    await expect(fetchWithRedirectPolicy(prepared(), new AbortController().signal)).rejects.toMatchObject({ type: 'InvalidRedirectError' });
  });
});

function prepared(overrides: Partial<PreparedRequest> = {}): PreparedRequest {
  return {
    method: 'POST',
    url: 'https://api.example.test/chat',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    redacted: { method: 'POST', url: 'https://api.example.test/chat', headers: {}, body: {} },
    ...overrides,
  };
}
