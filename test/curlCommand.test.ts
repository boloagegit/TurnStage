import { describe, expect, it } from 'vitest';
import { CURL_SECRET_PLACEHOLDER, networkCurlCommand, shellQuote } from '../src/shared/curlCommand';
import { parseCurlCommand } from '../src/extension/connection/curlParser';
import { networkTimeWindow, networkTimingPhases } from '../src/webview/main';
import type { NetworkExchange } from '../src/shared/types';

const entry: NetworkExchange = {
  id: 'n1', kind: 'stream', attempt: 1, method: 'POST', url: 'https://api.example.test/v1/chat?x=1', state: 'completed', startedAt: 1_000,
  requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer real-token', 'X-Trace': "it's" },
  requestBody: { messages: [{ role: 'user', content: "Don't leak" }] },
  timing: { headers: 120, firstChunk: 300, total: 900 }, transferredBytes: 10, eventCount: 3,
};

describe('copy as cURL', () => {
  it('quotes every value and never copies a credential header', () => {
    const command = networkCurlCommand(entry);
    expect(command).not.toContain('real-token');
    expect(command).toContain(`-H 'Authorization: ${CURL_SECRET_PLACEHOLDER}'`);
    expect(command).toContain(`-H 'X-Trace: it'\\''s'`);
    expect(command.split(' \\\n  ')[0]).toBe(`curl 'https://api.example.test/v1/chat?x=1'`);
    expect(command).toContain('-N');
    expect(command).toContain(`--data-raw '{"messages":[{"role":"user","content":"Don'\\''t leak"}]}'`);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('produces a command the safe cURL importer reads back', () => {
    const parsed = parseCurlCommand(networkCurlCommand(entry));
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toBe('https://api.example.test/v1/chat?x=1');
    expect(parsed.bodyFormat).toBe('json');
  });

  it('omits the method for a plain GET', () => {
    expect(networkCurlCommand({ ...entry, kind: 'history', method: 'GET', requestBody: undefined, requestHeaders: {} })).toBe(`curl 'https://api.example.test/v1/chat?x=1'`);
  });
});

describe('network timing', () => {
  it('splits a request into waiting, first chunk, and streaming', () => {
    expect(networkTimingPhases(entry).map(({ id, startMs, durationMs }) => [id, startMs, durationMs])).toEqual([['waiting', 0, 120], ['first-chunk', 120, 180], ['streaming', 300, 600]]);
    expect(networkTimingPhases({ timing: { total: 50 } })).toEqual([]);
    expect(networkTimingPhases({ timing: { headers: 40, total: 50 } }).map((phase) => phase.id)).toEqual(['waiting']);
  });

  it('places every request on one shared time scale', () => {
    expect(networkTimeWindow([entry, { ...entry, id: 'n2', startedAt: 2_000, timing: { total: 500 } }])).toEqual({ start: 1_000, end: 2_500 });
    expect(networkTimeWindow([])).toBeUndefined();
  });
});
