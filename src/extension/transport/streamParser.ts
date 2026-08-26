import type { RawStreamEvent } from '../../shared/types';

export interface ParsedSse { event?: string; id?: string; retry?: number; data: string; raw: string }

export class SseParser {
  private buffer = '';
  private lines: string[] = [];
  feed(chunk: string): ParsedSse[] {
    this.buffer += chunk;
    const output: ParsedSse[] = [];
    let index: number;
    while ((index = this.nextLineEnd(this.buffer)) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') { const event = this.dispatch(); if (event) output.push(event); }
      else this.lines.push(line);
    }
    return output;
  }
  finish(): ParsedSse[] {
    if (this.buffer) { this.lines.push(this.buffer.replace(/\r$/, '')); this.buffer = ''; }
    const event = this.dispatch(); return event ? [event] : [];
  }
  private nextLineEnd(value: string): number { return value.indexOf('\n'); }
  private dispatch(): ParsedSse | undefined {
    if (!this.lines.length) return;
    const lines = this.lines; this.lines = [];
    let event: string | undefined; let id: string | undefined; let retry: number | undefined; const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id' && !value.includes('\0')) id = value; else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    }
    if (!data.length) return;
    return { event, id, retry, data: data.join('\n'), raw: lines.join('\n') };
  }
}

export class NdjsonParser {
  private buffer = '';
  feed(chunk: string): string[] { this.buffer += chunk; const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? ''; return lines.filter((line) => line.trim()); }
  finish(): string[] { const line = this.buffer.trim(); this.buffer = ''; return line ? [line] : []; }
}

export function toRawEvent(protocol: RawStreamEvent['protocol'], raw: string, sequence: number, startedAt: number, sse?: ParsedSse): RawStreamEvent {
  const text = sse?.data ?? raw; let data: unknown = text; let parseError: string | undefined;
  if (protocol !== 'text-stream') try { data = JSON.parse(text); } catch (error) { if (text !== '[DONE]') parseError = error instanceof Error ? error.message : String(error); }
  return { sequence, receivedAt: Date.now(), elapsedMs: Date.now() - startedAt, protocol, sse: sse ? { event: sse.event, id: sse.id, retry: sse.retry } : undefined, raw, data, parseError };
}
