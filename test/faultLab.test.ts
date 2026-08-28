import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedRequest, RawStreamEvent } from '../src/shared/types';
import { HttpStreamTransport, type StreamSink } from '../src/extension/transport/transport';

function request(): PreparedRequest {
  return {
    method: 'POST',
    url: 'https://example.test/chat',
    headers: { Accept: 'text/event-stream' },
    body: '{}',
    redacted: { method: 'POST', url: 'https://example.test/chat', headers: {} },
  };
}

function sink(events: RawStreamEvent[]): StreamSink {
  return {
    onHeaders: () => undefined,
    onChunk: () => undefined,
    onEvent: (event) => { events.push(event); },
  };
}

function sseResponse(body = 'event: message\ndata: {"ok":true}\n\n'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('Fault Lab transport injections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails with a synthetic HTTP status before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpStreamTransport({ faults: { httpStatus: 418 } }).start(
      request(), 'sse', sink([]), new AbortController().signal,
    )).rejects.toMatchObject({
      type: 'FaultLabHttpStatusError',
      details: { status: 418, sawData: false, faultLab: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes a deterministic disconnect after the configured event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('event: first\ndata: {"ok":true}\n\nevent: second\ndata: {"ok":true}\n\n')));
    const events: RawStreamEvent[] = [];

    await expect(new HttpStreamTransport({ faults: { disconnectAfterEvents: 1 } }).start(
      request(), 'sse', sink(events), new AbortController().signal,
    )).rejects.toMatchObject({
      type: 'FaultLabDisconnectError',
      details: { sequence: 1, sawData: true, faultLab: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.sse?.event).toBe('first');
  });

  it('replaces the configured event with a bounded parse error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse()));
    const events: RawStreamEvent[] = [];

    await expect(new HttpStreamTransport({ faults: { corruptEventAt: 1 } }).start(
      request(), 'sse', sink(events), new AbortController().signal,
    )).resolves.toEqual({ sawData: true, aborted: false, reconnectCount: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      data: undefined,
      parseError: 'Fault Lab injected a malformed event.',
      raw: '{fault-lab:malformed}',
    });
  });
});
