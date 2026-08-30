import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedRequest } from '../src/shared/types';
import { fetchBoundedText } from '../src/extension/transport/boundedFetch';

afterEach(() => vi.unstubAllGlobals());

describe('bounded fetch body reader', () => {
  it('accepts a response exactly at the limit and rejects the first byte beyond it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('test')));
    await expect(fetchBoundedText(request(), { maxBytes: 4, timeoutMs: 1000, rejectOnTruncate: true })).resolves.toMatchObject({ text: 'test', bytes: 4, truncated: false });

    let observed = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('tests')));
    await expect(fetchBoundedText(request(), { maxBytes: 4, timeoutMs: 1000, rejectOnTruncate: true, onTruncate: (bytes) => { observed = bytes; } })).rejects.toMatchObject({ type: 'ResponseTooLargeError' });
    expect(observed).toBe(5);
  });

  it('distinguishes an external cancellation from a deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const controller = new AbortController();
    const pending = fetchBoundedText(request(), { controller, maxBytes: 10, timeoutMs: 1000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ type: 'UserAbortError' });
  });
});

function request(): PreparedRequest {
  return { method: 'GET', url: 'https://example.test/data', headers: {}, redacted: { method: 'GET', url: 'https://example.test/data', headers: {} } };
}
