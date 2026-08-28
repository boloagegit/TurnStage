import type { PreparedRequest, RawStreamEvent } from '../../shared/types';
import { DEFAULT_MAX_EVENT_BYTES, NdjsonParser, SseParser, toRawEvent } from './streamParser';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';
import { fetchWithRedirectPolicy } from './fetchPolicy';

export const DEFAULT_MAX_ERROR_BODY_BYTES = 4_096;
export type TransportDiagnostic =
  | { type: 'attempt.started'; attempt: number; remainingTimeoutMs?: number }
  | { type: 'retry.scheduled'; attempt: number; nextAttempt: number; delayMs: number; errorType: string; status?: number }
  | { type: 'timeout.fired'; attempt: number; kind: 'total' | 'idle'; elapsedMs: number; sawData: boolean };
export interface HttpStreamTransportOptions { maxErrorBodyBytes?: number; maxEventBytes?: number; onDiagnostic?: (event: TransportDiagnostic) => void }
export type StreamSinkEventResult = void | boolean;
export interface StreamSink { onHeaders(latencyMs: number, contentType: string, status?: number, headers?: Record<string, string>): void; onChunk(bytes: number, latencyMs: number): void; onEvent(event: RawStreamEvent): Promise<StreamSinkEventResult> | StreamSinkEventResult }
/**
 * reconnectCount is the exact number of reconnect attempts made after the
 * initial request. It is zero when the initial request succeeds or when no
 * retry is allowed.
 */
export interface TransportResult { sawData: boolean; aborted: boolean; reconnectCount: number }

interface AttemptResult { sawData: boolean; aborted: boolean }

export class HttpStreamTransport {
  constructor(private readonly options: HttpStreamTransportOptions = {}) {}

  async start(request: PreparedRequest, protocol: RawStreamEvent['protocol'], sink: StreamSink, signal: AbortSignal, dataFormat: 'json' | 'text' = 'json'): Promise<TransportResult> {
    const startedAt = Date.now();
    const reconnect = request.reconnect;
    const maxAttempts = Math.min(5, Math.max(0, reconnect?.maxAttempts ?? 0));
    let reconnectCount = 0;
    for (let attempt = 0; ; attempt++) {
      const elapsed = Date.now() - startedAt;
      const remainingTimeout = request.timeoutMs === undefined ? undefined : request.timeoutMs - elapsed;
      if (remainingTimeout !== undefined && remainingTimeout <= 0) {
        this.diagnostic({ type: 'timeout.fired', attempt: attempt + 1, kind: 'total', elapsedMs: elapsed, sawData: false });
        throw withReconnectCount(new TurnStageError('TimeoutError', localize('The total request timeout elapsed.')), reconnectCount);
      }
      this.diagnostic({ type: 'attempt.started', attempt: attempt + 1, ...(remainingTimeout !== undefined ? { remainingTimeoutMs: remainingTimeout } : {}) });
      try {
        const result = await this.startAttempt({ ...request, timeoutMs: remainingTimeout }, protocol, sink, signal, dataFormat, attempt + 1);
        return { ...result, reconnectCount };
      } catch (error) {
        if (!(error instanceof TurnStageError)) throw error;
        if (attempt >= maxAttempts || !isRetryable(error, reconnect?.retryOnStatuses)) throw withReconnectCount(error, reconnectCount);
        const baseDelay = Math.max(0, reconnect?.baseDelayMs ?? 500);
        const maxDelay = Math.max(baseDelay, reconnect?.maxDelayMs ?? 10_000);
        const retryAfter = typeof error.details.retryAfterMs === 'number' ? error.details.retryAfterMs : undefined;
        const delayMs = Math.min(maxDelay, retryAfter ?? baseDelay * 2 ** attempt);
        this.diagnostic({ type: 'retry.scheduled', attempt: attempt + 1, nextAttempt: attempt + 2, delayMs, errorType: error.type, ...(typeof error.details.status === 'number' ? { status: error.details.status } : {}) });
        try { await abortableDelay(delayMs, signal); }
        catch (delayError) { throw delayError instanceof TurnStageError ? withReconnectCount(delayError, reconnectCount) : delayError; }
        reconnectCount++;
      }
    }
  }

  private async startAttempt(request: PreparedRequest, protocol: RawStreamEvent['protocol'], sink: StreamSink, signal: AbortSignal, dataFormat: 'json' | 'text', attempt: number): Promise<AttemptResult> {
    const startedAt = Date.now(); let totalTimer: ReturnType<typeof setTimeout> | undefined; let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sawData = false;
    const localAbort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => localAbort.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (request.timeoutMs) totalTimer = setTimeout(() => {
      this.diagnostic({ type: 'timeout.fired', attempt, kind: 'total', elapsedMs: Date.now() - startedAt, sawData });
      localAbort.abort(new TurnStageError('TimeoutError', localize('The total request timeout elapsed.')));
    }, request.timeoutMs);
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (request.idleTimeoutMs) idleTimer = setTimeout(() => {
        this.diagnostic({ type: 'timeout.fired', attempt, kind: 'idle', elapsedMs: Date.now() - startedAt, sawData });
        localAbort.abort(new TurnStageError('IdleTimeoutError', localize('The stream idle timeout elapsed.')));
      }, request.idleTimeoutMs);
    };
    try {
      const response = await fetchWithRedirectPolicy(request, localAbort.signal);
      const contentType = response.headers.get('content-type') ?? ''; sink.onHeaders(Date.now() - startedAt, contentType, response.status, Object.fromEntries(response.headers.entries()));
      if (!response.ok) { const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')); const body = await readResponseBodyPrefix(response, normalizeByteLimit(this.options.maxErrorBodyBytes, DEFAULT_MAX_ERROR_BODY_BYTES)); throw new TurnStageError('HttpStatusError', localize('HTTP {status}: {detail}', { status: response.status, detail: body || response.statusText }), { status: response.status, retryAfterMs, sawData, responseBody: body }); }
      const expected = protocol === 'sse' ? 'text/event-stream' : protocol === 'ndjson' ? /ndjson|jsonl/ : undefined;
      if (expected && (typeof expected === 'string' ? !contentType.includes(expected) : !expected.test(contentType))) throw new TurnStageError('UnexpectedContentTypeError', localize('Expected {expected}, received {actual}.', { expected: String(expected), actual: contentType || localize('no content type') }));
      if (!response.body) throw new TurnStageError('NetworkError', localize('The response had no readable body.'));
      reader = response.body.getReader(); const decoder = new TextDecoder(); const maxEventBytes = normalizeByteLimit(this.options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES); const parser = protocol === 'sse' ? new SseParser({ maxEventBytes }) : protocol === 'ndjson' || protocol === 'fixture' ? new NdjsonParser({ maxRecordBytes: maxEventBytes }) : undefined; let jsonBuffer = ''; let jsonBytes = 0; let sequence = 0; let firstChunk = true; resetIdle();
      const emit = async (event: RawStreamEvent): Promise<boolean> => { sawData = true; return (await sink.onEvent(event)) !== false; };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        resetIdle(); sink.onChunk(value.byteLength, firstChunk ? Date.now() - startedAt : 0); firstChunk = false;
        const text = decoder.decode(value, { stream: true });
        if (protocol === 'text-stream') { assertEventBytes(protocol, value.byteLength, maxEventBytes); if (text && !(await emit(toRawEvent(protocol, text, ++sequence, startedAt)))) { await cancelReader(reader); return { sawData, aborted: false }; } continue; }
        if (protocol === 'json') { jsonBytes += value.byteLength; assertEventBytes(protocol, jsonBytes, maxEventBytes); jsonBuffer += text; continue; }
        const parsed = parser!.feed(text);
        for (const item of parsed) { const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any, dataFormat) : toRawEvent(protocol, item as string, ++sequence, startedAt, undefined, dataFormat); if (!(await emit(event))) { await cancelReader(reader); return { sawData, aborted: false }; } }
      }
      const decoderTail = decoder.decode(); if (protocol === 'text-stream' && decoderTail) { assertEventBytes(protocol, new TextEncoder().encode(decoderTail).byteLength, maxEventBytes); if (!(await emit(toRawEvent(protocol, decoderTail, ++sequence, startedAt)))) return { sawData, aborted: false }; }
      if (protocol === 'json') { if (decoderTail) { jsonBytes += new TextEncoder().encode(decoderTail).byteLength; assertEventBytes(protocol, jsonBytes, maxEventBytes); jsonBuffer += decoderTail; } if (jsonBuffer.trim()) await emit(toRawEvent(protocol, jsonBuffer, ++sequence, startedAt, undefined, dataFormat)); return { sawData, aborted: false }; }
      const tail = protocol === 'text-stream' ? [] : parser!.finish();
      for (const item of tail) { const event = protocol === 'sse' ? toRawEvent(protocol, (item as any).raw, ++sequence, startedAt, item as any, dataFormat) : toRawEvent(protocol, item as string, ++sequence, startedAt, undefined, dataFormat); if (!(await emit(event))) return { sawData, aborted: false }; }
      return { sawData, aborted: false };
    } catch (error) {
      if (reader) await cancelReader(reader);
      if (localAbort.signal.aborted || signal.aborted) {
        const reason = localAbort.signal.reason;
        if (reason instanceof TurnStageError) throw reason;
        return { sawData, aborted: true };
      }
      if (error instanceof TurnStageError) throw new TurnStageError(error.type, error.message, { ...error.details, sawData });
      const networkCode = networkErrorCode(error);
      throw new TurnStageError('NetworkError', error instanceof Error ? error.message : String(error), { sawData, ...(networkCode ? { networkCode } : {}) });
    } finally {
      if (reader) { try { reader.releaseLock(); } catch { /* The reader may already be released by fetch. */ } }
      signal.removeEventListener('abort', abort); if (totalTimer) clearTimeout(totalTimer); if (idleTimer) clearTimeout(idleTimer);
    }
  }

  private diagnostic(event: TransportDiagnostic): void {
    try { this.options.onDiagnostic?.(event); } catch { /* Diagnostics must never affect a request. */ }
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

function withReconnectCount(error: TurnStageError, reconnectCount: number): TurnStageError {
  if (reconnectCount <= 0 || error.details.reconnectCount === reconnectCount) return error;
  return new TurnStageError(error.type, error.message, { ...error.details, reconnectCount });
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

export function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
