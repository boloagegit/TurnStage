import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { PreparedRequest, RawStreamEvent } from '../src/shared/types';
import { HttpStreamTransport, type StreamSink } from '../src/extension/transport/transport';

let server: ChildProcessWithoutNullStreams;
let baseUrl: string;

beforeAll(async () => {
  server = spawn(process.execPath, [resolve(import.meta.dirname, '../examples/mock-server/server.mjs')], {
    env: { ...process.env, TURNSTAGE_MOCK_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  baseUrl = await waitForServer(server);
}, 5_000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => server.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(() => { server.kill('SIGKILL'); resolveTimeout(); }, 1_000)),
  ]);
});

describe('HttpStreamTransport against the real SSE mock server', () => {
  it('delivers normal SSE events incrementally instead of buffering the response', async () => {
    const evidence = await collect('slow');

    expect(evidence.result).toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    expect(evidence.contentType).toContain('text/event-stream');
    expect(evidence.events.map(eventName)).toEqual(['start', 'status', 'message', 'message', 'title', 'done']);
    expect(evidence.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(evidence.events[2]?.data).toEqual({ text: 'Here is the ' });
    expect(evidence.events[3]?.data).toEqual({ text: 'sample result.' });
    expect(evidence.eventTimes.at(-1)! - evidence.eventTimes[0]!).toBeGreaterThanOrEqual(2_000);
    expect(evidence.chunkSizes.length).toBeGreaterThan(1);
  }, 8_000);

  it('reassembles SSE frames split across network chunks', async () => {
    const evidence = await collect('chunk-split');

    expect(evidence.result).toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    expect(evidence.events.map(eventName)).toEqual(['start', 'status', 'message', 'message', 'title', 'done']);
    expect(evidence.chunkSizes.length).toBeGreaterThan(evidence.events.length);
  });

  it('preserves malformed and unknown events for the debug inspector while continuing', async () => {
    const malformed = await collect('malformed-json');
    const unknown = await collect('unknown-event');

    expect(malformed.events.find((event) => event.parseError)?.raw).toContain('{not-json}');
    expect(eventName(malformed.events.at(-1)!)).toBe('done');
    expect(unknown.events.map(eventName)).toContain('custom_event');
    expect(eventName(unknown.events.at(-1)!)).toBe('done');
  });

  it('treats json as one complete document and honors text dataFormat for SSE', async () => {
    const originalFetch = globalThis.fetch;
    const events: RawStreamEvent[] = [];
    try {
      globalThis.fetch = (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{\n  "message":'));
          controller.enqueue(new TextEncoder().encode(' "complete"\n}'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      await new HttpStreamTransport().start(request('normal'), 'json', { onHeaders: () => undefined, onChunk: () => undefined, onEvent: (event) => { events.push(event); } }, new AbortController().signal);
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toEqual({ message: 'complete' });

      events.length = 0;
      globalThis.fetch = (async () => new Response('event: message\ndata: plain text\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
      await new HttpStreamTransport().start(request('normal'), 'sse', { onHeaders: () => undefined, onChunk: () => undefined, onEvent: (event) => { events.push(event); } }, new AbortController().signal, 'text');
      expect(events[0]?.data).toBe('plain text');
      expect(events[0]?.parseError).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces HTTP status and idle-timeout failures with stable error types', async () => {
    await expect(collect('http-401')).rejects.toMatchObject({ type: 'HttpStatusError', details: { status: 401 } });
    await expect(collect('http-500')).rejects.toMatchObject({ type: 'HttpStatusError', details: { status: 500 } });
    await expect(collect('idle-timeout', { idleTimeoutMs: 100 })).rejects.toMatchObject({ type: 'IdleTimeoutError' });
  });

  it('retries bounded pre-data 429 responses while honoring the configured status policy', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '0' } });
      return new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    const events: RawStreamEvent[] = [];
    try {
      await expect(new HttpStreamTransport().start({ ...request('normal'), reconnect: { maxAttempts: 2, baseDelayMs: 0, retryOnStatuses: [429] } }, 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: (event) => { events.push(event); return false; },
      }, new AbortController().signal)).resolves.toEqual({ sawData: true, aborted: false, reconnectCount: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(2);
    expect(events.map(eventName)).toEqual(['done']);
  });

  it('reports every attempted reconnect when the retry budget is exhausted', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '0' } });
    }) as typeof fetch;
    try {
      await expect(new HttpStreamTransport().start({ ...request('normal'), reconnect: { maxAttempts: 2, baseDelayMs: 0, retryOnStatuses: [429] } }, 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: () => undefined,
      }, new AbortController().signal)).rejects.toMatchObject({
        type: 'HttpStatusError',
        details: { status: 429, reconnectCount: 2 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(3);
  });

  it('does not reconnect after partial data because a replay could duplicate side effects', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      let reads = 0;
      return {
        ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: { getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads === 1) return { value: new TextEncoder().encode('event: start\ndata: {}\n\n'), done: false };
            throw new Error('connection lost');
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }) },
      } as unknown as Response;
    }) as typeof fetch;
    const events: RawStreamEvent[] = [];
    try {
      await expect(new HttpStreamTransport().start({ ...request('normal'), reconnect: { maxAttempts: 2, baseDelayMs: 0 } }, 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: (event) => { events.push(event); },
      }, new AbortController().signal)).rejects.toMatchObject({ type: 'NetworkError', details: { sawData: true } });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(1);
    expect(events.map(eventName)).toEqual(['start']);
  });

  it('bounds non-success error-body reads before constructing the HTTP error', async () => {
    const originalFetch = globalThis.fetch;
    let reads = 0;
    let canceled = false;
    let textCalled = false;
    const response = {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { value: new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz'), done: false };
          },
          cancel: async () => { canceled = true; },
          releaseLock: () => undefined,
        }),
      },
      text: async () => { textCalled = true; return 'this should not be called'; },
    } as unknown as Response;
    globalThis.fetch = (async () => response) as typeof fetch;
    try {
      await expect(new HttpStreamTransport({ maxErrorBodyBytes: 8 }).start(request('normal'), 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: () => undefined,
      }, new AbortController().signal)).rejects.toMatchObject({
        type: 'HttpStatusError',
        message: 'HTTP 503: 01234567',
        details: { status: 503 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
    expect(textCalled).toBe(false);
  });

  it('delivers partial stream errors and reports abrupt disconnects after partial data', async () => {
    const partial = await collect('partial-error');
    expect(partial.events.map(eventName)).toEqual(['start', 'status', 'message', 'message', 'title', 'error']);

    const disconnectedEvents: RawStreamEvent[] = [];
    await expect(new HttpStreamTransport().start(request('disconnect'), 'sse', {
      onHeaders: () => undefined,
      onChunk: () => undefined,
      onEvent: (event) => { disconnectedEvents.push(event); },
    }, new AbortController().signal)).rejects.toMatchObject({ type: 'NetworkError' });
    expect(disconnectedEvents.map(eventName).slice(0, 4)).toEqual(['start', 'status', 'message', 'message']);
    expect(disconnectedEvents.map(eventName)).not.toContain('done');
  });

  it('streams the complete agent event vocabulary over the same transport', async () => {
    const evidence = await collect('normal', {}, '/agent/chat/stream');
    expect(evidence.events.map(eventName)).toEqual([
      'start', 'status', 'tool_call', 'tool_result', 'message', 'message', 'citation',
      'citation_reference', 'action', 'form', 'followup', 'diagnostic', 'usage', 'title', 'done',
    ]);
  });

  it('returns deterministic client errors for invalid mock requests', async () => {
    const malformed = await fetch(`${baseUrl}/basic/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ code: 'INVALID_JSON' });

    const wrongStop = await fetch(`${baseUrl}/not-a-real/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(wrongStop.status).toBe(404);
  });

  it('aborts an in-flight stream after partial data without losing sawData evidence', async () => {
    const abortController = new AbortController();
    const events: RawStreamEvent[] = [];
    const result = await new HttpStreamTransport().start(request('slow'), 'sse', {
      onHeaders: () => undefined,
      onChunk: () => undefined,
      onEvent: (event) => {
        events.push(event);
        if (events.length === 2) abortController.abort();
      },
    }, abortController.signal);

    expect(result).toEqual({ sawData: true, aborted: true, reconnectCount: 0 });
    expect(events.map(eventName)).toEqual(['start', 'status']);
  }, 5_000);

  it('cancels the reader when the sink returns false after a terminal event', async () => {
    const originalFetch = globalThis.fetch;
    let reads = 0;
    let canceled = false;
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return {
              value: new TextEncoder().encode('event: start\ndata: {}\n\nevent: next\ndata: {}\n\n'),
              done: false,
            };
          },
          cancel: async () => { canceled = true; },
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;
    globalThis.fetch = (async () => response) as typeof fetch;
    const events: RawStreamEvent[] = [];
    try {
      await expect(new HttpStreamTransport().start(request('normal'), 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: async (event) => { events.push(event); return false; },
      }, new AbortController().signal)).resolves.toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(reads).toBe(1);
    expect(canceled).toBe(true);
    expect(events.map(eventName)).toEqual(['start']);
  });

  it('enforces the configured maximum event size through the HTTP transport', async () => {
    const originalFetch = globalThis.fetch;
    let canceled = false;
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => ({ value: new TextEncoder().encode('data: oversized\n\n'), done: false }),
          cancel: async () => { canceled = true; },
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;
    globalThis.fetch = (async () => response) as typeof fetch;
    try {
      await expect(new HttpStreamTransport({ maxEventBytes: 8 }).start(request('normal'), 'sse', {
        onHeaders: () => undefined,
        onChunk: () => undefined,
        onEvent: () => undefined,
      }, new AbortController().signal)).rejects.toMatchObject({
        type: 'StreamRecordTooLargeError',
        details: { protocol: 'sse', maxBytes: 8 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(canceled).toBe(true);
  });

  it('streams NDJSON over real HTTP and flushes a final line without a newline', async () => {
    const evidence = await collectProtocol('ndjson', '/transport/ndjson');

    expect(evidence.result).toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    expect(evidence.contentType).toContain('application/x-ndjson');
    expect(evidence.events.map((event) => event.data)).toEqual([
      { kind: 'first', value: 1 },
      { kind: 'second', value: 2 },
    ]);
    expect(evidence.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(evidence.chunkSizes.length).toBeGreaterThan(1);
  });

  it('delivers a plain text stream incrementally without JSON parse errors', async () => {
    const evidence = await collectProtocol('text-stream', '/transport/text-stream');

    expect(evidence.result).toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    expect(evidence.contentType).toContain('text/plain');
    expect(evidence.events.map((event) => event.data).join('')).toBe('first second');
    expect(evidence.events.every((event) => event.parseError === undefined)).toBe(true);
    expect(evidence.events.length).toBeGreaterThan(1);
  });

  it('rejects an incompatible content type before emitting stream events', async () => {
    await expect(collectProtocol('sse', '/transport/wrong-content-type')).rejects.toMatchObject({
      type: 'UnexpectedContentTypeError',
    });
  });

  it('enforces the total request timeout independently of the idle timeout', async () => {
    await expect(collect('idle-timeout', { timeoutMs: 100, idleTimeoutMs: undefined })).rejects.toMatchObject({
      type: 'TimeoutError',
    });
  });

  it('serves opening and remote-stop contracts from the real mock server', async () => {
    const opening = await fetch(`${baseUrl}/agent/opening`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(opening.status).toBe(200);
    await expect(opening.json()).resolves.toMatchObject({
      message: expect.any(String),
      options: expect.arrayContaining([expect.objectContaining({ behavior: 'send' }), expect.objectContaining({ behavior: 'fill' })]),
    });

    const stop = await fetch(`${baseUrl}/agent/chat/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'conversation-1', clientRequestId: 'request-1' }),
    });
    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toEqual({ stopped: true, conversationId: 'conversation-1', clientRequestId: 'request-1' });
  });
});

async function collect(mode: string, overrides: Partial<PreparedRequest> = {}, path = '/basic/chat/stream') {
  const events: RawStreamEvent[] = [];
  const eventTimes: number[] = [];
  const chunkSizes: number[] = [];
  let contentType = '';
  const startedAt = Date.now();
  const sink: StreamSink = {
    onHeaders: (_latency, value) => { contentType = value; },
    onChunk: (bytes) => { chunkSizes.push(bytes); },
    onEvent: (event) => { events.push(event); eventTimes.push(Date.now() - startedAt); },
  };
  const result = await new HttpStreamTransport().start({ ...request(mode, path), ...overrides }, 'sse', sink, new AbortController().signal);
  return { result, contentType, events, eventTimes, chunkSizes };
}

async function collectProtocol(protocol: RawStreamEvent['protocol'], path: string) {
  const events: RawStreamEvent[] = [];
  const chunkSizes: number[] = [];
  let contentType = '';
  const prepared: PreparedRequest = {
    method: 'POST',
    url: `${baseUrl}${path}`,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    timeoutMs: 2_000,
    redacted: { method: 'POST', url: `${baseUrl}${path}`, headers: {} },
  };
  const result = await new HttpStreamTransport().start(prepared, protocol, {
    onHeaders: (_latency, value) => { contentType = value; },
    onChunk: (bytes) => { chunkSizes.push(bytes); },
    onEvent: (event) => { events.push(event); },
  }, new AbortController().signal);
  return { result, contentType, events, chunkSizes };
}

function request(mode: string, path = '/basic/chat/stream'): PreparedRequest {
  return {
    method: 'POST',
    url: `${baseUrl}${path}`,
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'x-turnstage-mode': mode },
    body: JSON.stringify({ message: 'SSE integration test' }),
    timeoutMs: 8_000,
    redacted: { method: 'POST', url: `${baseUrl}${path}`, headers: {} },
  };
}

function eventName(event: RawStreamEvent): string | undefined {
  return event.sse?.event;
}

function waitForServer(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveServer, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the SSE mock server.')), 4_000);
    let output = '';
    const finish = (value: string) => { clearTimeout(timeout); resolveServer(value); };
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(match[1]);
    });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`SSE mock server exited before it was ready (code ${code}): ${output}`)));
  });
}
