import type { RawStreamEvent } from '../../shared/types';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';

export interface ParsedSse { event?: string; id?: string; retry?: number; data: string; raw: string }
export interface StreamParserOptions { maxEventBytes?: number; maxRecordBytes?: number }

export const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
export const STREAM_RECORD_TOO_LARGE_ERROR = 'StreamRecordTooLargeError';

const utf8Encoder = new TextEncoder();

export class SseParser {
  private buffer = '';
  private lines: string[] = [];
  private eventBytes = 0;
  private readonly maxEventBytes: number;
  private initialInputSeen = false;
  private pendingCarriageReturn = false;
  private pendingCarriageReturnLineCompleted = false;

  constructor(options: StreamParserOptions = {}) {
    this.maxEventBytes = normalizeByteLimit(options.maxEventBytes ?? options.maxRecordBytes, DEFAULT_MAX_EVENT_BYTES);
  }

  feed(chunk: string): ParsedSse[] {
    chunk = this.stripInitialBom(chunk);
    const output: ParsedSse[] = [];
    let carriageReturnResolved = false;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.pendingCarriageReturn) {
        if (chunk[offset] === '\n') {
          if (!this.pendingCarriageReturnLineCompleted) {
            this.addBytes(1);
            const event = this.completeLine(); if (event) output.push(event);
          }
          this.pendingCarriageReturn = false;
          this.pendingCarriageReturnLineCompleted = false;
          carriageReturnResolved = false;
          offset += 1;
          continue;
        }
        if (!this.pendingCarriageReturnLineCompleted) {
          const event = this.completeLine(); if (event) output.push(event);
        }
        this.pendingCarriageReturn = false;
        this.pendingCarriageReturnLineCompleted = false;
        carriageReturnResolved = true;
      }

      const carriageReturn = chunk.indexOf('\r', offset);
      const lineFeed = chunk.indexOf('\n', offset);
      const index = carriageReturn < 0 ? lineFeed : lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed);
      if (index < 0) { this.append(chunk.slice(offset)); break; }
      this.append(chunk.slice(offset, index));
      if (chunk[index] === '\r') {
        this.addBytes(1);
        this.pendingCarriageReturn = true;
        if (!this.buffer && carriageReturnResolved) {
          const event = this.completeLine(); if (event) output.push(event);
          this.pendingCarriageReturnLineCompleted = true;
        }
        carriageReturnResolved = false;
      } else {
        this.addBytes(1);
        const event = this.completeLine(); if (event) output.push(event);
        carriageReturnResolved = false;
      }
      offset = index + 1;
    }
    return output;
  }

  finish(): ParsedSse[] {
    const output: ParsedSse[] = [];
    if (this.pendingCarriageReturn) {
      if (!this.pendingCarriageReturnLineCompleted) {
        const event = this.completeLine(); if (event) output.push(event);
      }
      this.pendingCarriageReturn = false;
      this.pendingCarriageReturnLineCompleted = false;
    }
    if (this.buffer) { this.lines.push(this.buffer); this.buffer = ''; }
    const event = this.dispatch(); if (event) output.push(event);
    return output;
  }

  private append(value: string): void {
    if (!value) return;
    this.addBytes(byteLength(value));
    this.buffer += value;
  }

  private addBytes(bytes: number): void {
    if (this.eventBytes + bytes > this.maxEventBytes) throw streamRecordTooLarge('sse', this.maxEventBytes, this.eventBytes + bytes);
    this.eventBytes += bytes;
  }

  private stripInitialBom(chunk: string): string {
    if (this.initialInputSeen || !chunk) return chunk;
    this.initialInputSeen = true;
    return chunk.charCodeAt(0) === 0xfeff ? chunk.slice(1) : chunk;
  }

  private completeLine(): ParsedSse | undefined {
    const line = this.buffer;
    this.buffer = '';
    if (line === '') return this.dispatch();
    this.lines.push(line);
    return undefined;
  }

  private dispatch(): ParsedSse | undefined {
    if (!this.lines.length) { this.eventBytes = 0; return; }
    const lines = this.lines; this.lines = [];
    let event: string | undefined; let id: string | undefined; let retry: number | undefined; const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id' && !value.includes('\0')) id = value; else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    }
    this.eventBytes = 0;
    if (!data.length) return;
    return { event, id, retry, data: data.join('\n'), raw: lines.join('\n') };
  }
}

export class NdjsonParser {
  private buffer = '';
  private recordBytes = 0;
  private readonly maxRecordBytes: number;

  constructor(options: StreamParserOptions = {}) {
    this.maxRecordBytes = normalizeByteLimit(options.maxRecordBytes ?? options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
  }

  feed(chunk: string): string[] {
    const output: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const index = chunk.indexOf('\n', offset);
      if (index < 0) { this.append(chunk.slice(offset)); break; }
      this.append(chunk.slice(offset, index));
      this.addBytes(1);
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.recordBytes = 0;
      if (line.trim()) output.push(line);
      offset = index + 1;
    }
    return output;
  }

  finish(): string[] { const line = this.buffer.trim(); this.buffer = ''; this.recordBytes = 0; return line ? [line] : []; }

  private append(value: string): void {
    if (!value) return;
    this.addBytes(byteLength(value));
    this.buffer += value;
  }

  private addBytes(bytes: number): void {
    if (this.recordBytes + bytes > this.maxRecordBytes) throw streamRecordTooLarge('ndjson', this.maxRecordBytes, this.recordBytes + bytes);
    this.recordBytes += bytes;
  }
}

function byteLength(value: string): number { return utf8Encoder.encode(value).byteLength; }

function normalizeByteLimit(value: number | undefined, fallback: number): number {
  if (value === 0) return 0;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function streamRecordTooLarge(protocol: 'sse' | 'ndjson', maxBytes: number, observedBytes: number): TurnStageError {
  return new TurnStageError(STREAM_RECORD_TOO_LARGE_ERROR, localize('The {protocol} stream record exceeded the maximum size of {maxBytes} bytes.', { protocol, maxBytes }), { protocol, maxBytes, observedBytes });
}

export function toRawEvent(protocol: RawStreamEvent['protocol'], raw: string, sequence: number, startedAt: number, sse?: ParsedSse): RawStreamEvent {
  const text = sse?.data ?? raw; let data: unknown = text; let parseError: string | undefined;
  if (protocol !== 'text-stream') try { data = JSON.parse(text); } catch (error) { if (text !== '[DONE]') parseError = error instanceof Error ? error.message : String(error); }
  return { sequence, receivedAt: Date.now(), elapsedMs: Date.now() - startedAt, protocol, sse: sse ? { event: sse.event, id: sse.id, retry: sse.retry } : undefined, raw, data, parseError };
}
