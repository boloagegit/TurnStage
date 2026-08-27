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

    expect(evidence.result).toEqual({ sawData: true, aborted: false });
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

    expect(evidence.result).toEqual({ sawData: true, aborted: false });
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

  it('surfaces HTTP status and idle-timeout failures with stable error types', async () => {
    await expect(collect('http-401')).rejects.toMatchObject({ type: 'HttpStatusError', details: { status: 401 } });
    await expect(collect('http-500')).rejects.toMatchObject({ type: 'HttpStatusError', details: { status: 500 } });
    await expect(collect('idle-timeout', { idleTimeoutMs: 100 })).rejects.toMatchObject({ type: 'IdleTimeoutError' });
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

    expect(result).toEqual({ sawData: true, aborted: true });
    expect(events.map(eventName)).toEqual(['start', 'status']);
  }, 5_000);

  it('streams NDJSON over real HTTP and flushes a final line without a newline', async () => {
    const evidence = await collectProtocol('ndjson', '/transport/ndjson');

    expect(evidence.result).toEqual({ sawData: true, aborted: false });
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

    expect(evidence.result).toEqual({ sawData: true, aborted: false });
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
