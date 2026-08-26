import type { PreparedRequest, RawStreamEvent } from '../../shared/types';
import { NdjsonParser, SseParser, toRawEvent } from './streamParser';
import { TurnStageError } from '../errors';

export interface StreamSink { onHeaders(latencyMs: number, contentType: string): void; onChunk(bytes: number, latencyMs: number): void; onEvent(event: RawStreamEvent): Promise<void> | void }
export interface TransportResult { sawData: boolean; aborted: boolean }

export class HttpStreamTransport {
  async start(request: PreparedRequest, protocol: RawStreamEvent['protocol'], sink: StreamSink, signal: AbortSignal): Promise<TransportResult> {
    const startedAt = Date.now(); let totalTimer: ReturnType<typeof setTimeout> | undefined; let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sawData = false;
    const localAbort = new AbortController();
    const abort = () => localAbort.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (request.timeoutMs) totalTimer = setTimeout(() => localAbort.abort(new TurnStageError('TimeoutError', 'The total request timeout elapsed.')), request.timeoutMs);
    const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); if (request.idleTimeoutMs) idleTimer = setTimeout(() => localAbort.abort(new TurnStageError('IdleTimeoutError', 'The stream idle timeout elapsed.')), request.idleTimeoutMs); };
    try {
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: localAbort.signal });
      const contentType = response.headers.get('content-type') ?? ''; sink.onHeaders(Date.now() - startedAt, contentType);
      if (!response.ok) { const body = (await response.text()).slice(0, 4096); throw new TurnStageError('HttpStatusError', `HTTP ${response.status}: ${body || response.statusText}`, { status: response.status }); }
      const expected = protocol === 'sse' ? 'text/event-stream' : protocol === 'ndjson' ? /ndjson|jsonl/ : undefined;
      if (expected && (typeof expected === 'string' ? !contentType.includes(expected) : !expected.test(contentType))) throw new TurnStageError('UnexpectedContentTypeError', `Expected ${String(expected)}, received ${contentType || 'no content type'}.`);
      if (!response.body) throw new TurnStageError('NetworkError', 'The response had no readable body.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); const parser = protocol === 'sse' ? new SseParser() : new NdjsonParser(); let sequence = 0; let firstChunk = true; resetIdle();
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        resetIdle(); sink.onChunk(value.byteLength, firstChunk ? Date.now() - startedAt : 0); firstChunk = false;
        const text = decoder.decode(value, { stream: true });
        if (protocol === 'text-stream') { if (text) { sawData = true; await sink.onEvent(toRawEvent(protocol, text, ++sequence, startedAt)); } continue; }
        const parsed = parser.feed(text);
        for (const item of parsed) { sawData = true; const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any) : toRawEvent(protocol, item as string, ++sequence, startedAt); await sink.onEvent(event); }
      }
      const decoderTail = decoder.decode(); if (protocol === 'text-stream' && decoderTail) { sawData = true; await sink.onEvent(toRawEvent(protocol, decoderTail, ++sequence, startedAt)); }
      const tail = protocol === 'text-stream' ? [] : parser.finish();
      for (const item of tail) { sawData = true; const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any) : toRawEvent(protocol, item as string, ++sequence, startedAt); await sink.onEvent(event); }
      return { sawData, aborted: false };
    } catch (error) {
      if (localAbort.signal.aborted || signal.aborted) {
        const reason = localAbort.signal.reason;
        if (reason instanceof TurnStageError) throw reason;
        return { sawData, aborted: true };
      }
      if (error instanceof TurnStageError) throw error;
      throw new TurnStageError('NetworkError', error instanceof Error ? error.message : String(error));
    } finally {
      signal.removeEventListener('abort', abort); if (totalTimer) clearTimeout(totalTimer); if (idleTimer) clearTimeout(idleTimer);
    }
  }
}
