import type { PreparedRequest, RawStreamEvent } from '../../shared/types';
import { DEFAULT_MAX_EVENT_BYTES, NdjsonParser, SseParser, toRawEvent } from './streamParser';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';
import { fetchWithRedirectPolicy } from './fetchPolicy';

export const DEFAULT_MAX_ERROR_BODY_BYTES = 4_096;
export interface HttpStreamTransportOptions { maxErrorBodyBytes?: number; maxEventBytes?: number }
export type StreamSinkEventResult = void | boolean;
export interface StreamSink { onHeaders(latencyMs: number, contentType: string): void; onChunk(bytes: number, latencyMs: number): void; onEvent(event: RawStreamEvent): Promise<StreamSinkEventResult> | StreamSinkEventResult }
export interface TransportResult { sawData: boolean; aborted: boolean }

export class HttpStreamTransport {
  constructor(private readonly options: HttpStreamTransportOptions = {}) {}

  async start(request: PreparedRequest, protocol: RawStreamEvent['protocol'], sink: StreamSink, signal: AbortSignal): Promise<TransportResult> {
    const startedAt = Date.now();
    const reconnect = request.reconnect;
    const maxAttempts = Math.min(5, Math.max(0, reconnect?.maxAttempts ?? 0));
    for (let attempt = 0; ; attempt++) {
      const elapsed = Date.now() - startedAt;
      const remainingTimeout = request.timeoutMs === undefined ? undefined : request.timeoutMs - elapsed;
      if (remainingTimeout !== undefined && remainingTimeout <= 0) throw new TurnStageError('TimeoutError', localize('The total request timeout elapsed.'));
      try {
        return await this.startAttempt({ ...request, timeoutMs: remainingTimeout }, protocol, sink, signal);
      } catch (error) {
        if (!(error instanceof TurnStageError) || attempt >= maxAttempts || !isRetryable(error, reconnect?.retryOnStatuses)) throw error;
        const baseDelay = Math.max(0, reconnect?.baseDelayMs ?? 500);
        const maxDelay = Math.max(baseDelay, reconnect?.maxDelayMs ?? 10_000);
        const retryAfter = typeof error.details.retryAfterMs === 'number' ? error.details.retryAfterMs : undefined;
        const delayMs = Math.min(maxDelay, retryAfter ?? baseDelay * 2 ** attempt);
        await abortableDelay(delayMs, signal);
      }
    }
  }

  private async startAttempt(request: PreparedRequest, protocol: RawStreamEvent['protocol'], sink: StreamSink, signal: AbortSignal): Promise<TransportResult> {
    const startedAt = Date.now(); let totalTimer: ReturnType<typeof setTimeout> | undefined; let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sawData = false;
    const localAbort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => localAbort.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (request.timeoutMs) totalTimer = setTimeout(() => localAbort.abort(new TurnStageError('TimeoutError', localize('The total request timeout elapsed.'))), request.timeoutMs);
    const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); if (request.idleTimeoutMs) idleTimer = setTimeout(() => localAbort.abort(new TurnStageError('IdleTimeoutError', localize('The stream idle timeout elapsed.'))), request.idleTimeoutMs); };
    try {
      const response = await fetchWithRedirectPolicy(request, localAbort.signal);
      const contentType = response.headers.get('content-type') ?? ''; sink.onHeaders(Date.now() - startedAt, contentType);
      if (!response.ok) { const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')); const body = await readResponseBodyPrefix(response, normalizeByteLimit(this.options.maxErrorBodyBytes, DEFAULT_MAX_ERROR_BODY_BYTES)); throw new TurnStageError('HttpStatusError', localize('HTTP {status}: {detail}', { status: response.status, detail: body || response.statusText }), { status: response.status, retryAfterMs, sawData }); }
      const expected = protocol === 'sse' ? 'text/event-stream' : protocol === 'ndjson' ? /ndjson|jsonl/ : undefined;
      if (expected && (typeof expected === 'string' ? !contentType.includes(expected) : !expected.test(contentType))) throw new TurnStageError('UnexpectedContentTypeError', localize('Expected {expected}, received {actual}.', { expected: String(expected), actual: contentType || localize('no content type') }));
      if (!response.body) throw new TurnStageError('NetworkError', localize('The response had no readable body.'));
      reader = response.body.getReader(); const decoder = new TextDecoder(); const maxEventBytes = normalizeByteLimit(this.options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES); const parser = protocol === 'sse' ? new SseParser({ maxEventBytes }) : new NdjsonParser({ maxRecordBytes: maxEventBytes }); let sequence = 0; let firstChunk = true; resetIdle();
      const emit = async (event: RawStreamEvent): Promise<boolean> => { sawData = true; return (await sink.onEvent(event)) !== false; };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        resetIdle(); sink.onChunk(value.byteLength, firstChunk ? Date.now() - startedAt : 0); firstChunk = false;
        const text = decoder.decode(value, { stream: true });
        if (protocol === 'text-stream') { assertEventBytes(protocol, value.byteLength, maxEventBytes); if (text && !(await emit(toRawEvent(protocol, text, ++sequence, startedAt)))) { await cancelReader(reader); return { sawData, aborted: false }; } continue; }
        const parsed = parser.feed(text);
        for (const item of parsed) { const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any) : toRawEvent(protocol, item as string, ++sequence, startedAt); if (!(await emit(event))) { await cancelReader(reader); return { sawData, aborted: false }; } }
      }
      const decoderTail = decoder.decode(); if (protocol === 'text-stream' && decoderTail) { assertEventBytes(protocol, new TextEncoder().encode(decoderTail).byteLength, maxEventBytes); if (!(await emit(toRawEvent(protocol, decoderTail, ++sequence, startedAt)))) return { sawData, aborted: false }; }
      const tail = protocol === 'text-stream' ? [] : parser.finish();
      for (const item of tail) { const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any) : toRawEvent(protocol, item as string, ++sequence, startedAt); if (!(await emit(event))) return { sawData, aborted: false }; }
      return { sawData, aborted: false };
    } catch (error) {
      if (reader) await cancelReader(reader);
      if (localAbort.signal.aborted || signal.aborted) {
        const reason = localAbort.signal.reason;
        if (reason instanceof TurnStageError) throw reason;
        return { sawData, aborted: true };
      }
      if (error instanceof TurnStageError) throw new TurnStageError(error.type, error.message, { ...error.details, sawData });
      throw new TurnStageError('NetworkError', error instanceof Error ? error.message : String(error), { sawData });
    } finally {
      if (reader) { try { reader.releaseLock(); } catch { /* The reader may already be released by fetch. */ } }
      signal.removeEventListener('abort', abort); if (totalTimer) clearTimeout(totalTimer); if (idleTimer) clearTimeout(idleTimer);
    }
  }
}

function isRetryable(error: TurnStageError, configuredStatuses: number[] | undefined): boolean {
  if (error.details.sawData === true) return false;
  if (error.type === 'NetworkError' || error.type === 'IdleTimeoutError') return true;
  if (error.type !== 'HttpStatusError') return false;
  const status = error.details.status;
  const statuses = configuredStatuses?.length ? configuredStatuses : [429, 502, 503, 504];
  return typeof status === 'number' && statuses.includes(status);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.max(0, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new TurnStageError('UserAbortError', localize('The request was stopped.'));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new TurnStageError('UserAbortError', localize('The request was stopped.'))); };
    function done(): void { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); } catch { /* Terminal sink cancellation is intentional. */ }
}

async function readResponseBodyPrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body || maxBytes <= 0) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let consumedBytes = 0;
  let truncated = false;
  try {
    while (consumedBytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - consumedBytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      body += decoder.decode(chunk, { stream: true });
      consumedBytes += chunk.byteLength;
      if (consumedBytes >= maxBytes) { truncated = true; break; }
    }
    body += decoder.decode();
    return body;
  } finally {
    if (truncated) {
      try { await reader.cancel(); } catch { /* The response is already closing. */ }
    }
    reader.releaseLock();
  }
}

function normalizeByteLimit(value: number | undefined, fallback: number): number {
  if (value === 0) return 0;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function assertEventBytes(protocol: RawStreamEvent['protocol'], observedBytes: number, maxBytes: number): void {
  if (observedBytes > maxBytes) throw new TurnStageError('StreamRecordTooLargeError', localize('The {protocol} stream record exceeded the maximum size of {maxBytes} bytes.', { protocol, maxBytes }), { protocol, maxBytes, observedBytes });
}
