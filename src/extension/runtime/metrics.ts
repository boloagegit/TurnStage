import type { MetricsSnapshot, NormalizedEvent, RawStreamEvent } from '../../shared/types';

export class MetricsCollector {
  readonly value: MetricsSnapshot = { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0, reconnectCount: 0 };
  private gaps: number[] = []; private previousEventAt?: number; private startedAt = 0;
  start(): void { this.startedAt = Date.now(); this.value.requestStartedAt = this.startedAt; }
  headers(ms: number): void { this.value.headersLatency ??= ms; }
  chunk(bytes: number, firstLatency: number): void { this.value.byteCount += bytes; if (firstLatency) this.value.firstChunkLatency ??= firstLatency; }
  raw(event: RawStreamEvent): void { this.value.eventCount++; this.value.firstEventLatency ??= event.receivedAt - this.startedAt; if (event.parseError) this.value.parseErrorCount++; if (this.previousEventAt) this.gaps.push(event.receivedAt - this.previousEventAt); this.previousEventAt = event.receivedAt; }
  normalized(event: NormalizedEvent): void { if ((event.type === 'content.text.delta' || event.type === 'content.markdown.delta') && this.value.ttft === undefined) this.value.ttft = event.receivedAt - this.startedAt; }
  mappingError(count = 1): void { this.value.mappingErrorCount += count; }
  unmatched(): void { this.value.unmatchedEventCount++; }
  reconnectCount(count: number): void {
    if (!Number.isFinite(count) || count < 0) return;
    this.value.reconnectCount = Math.max(this.value.reconnectCount ?? 0, Math.floor(count));
  }
  finish(reason?: string): void { const now = Date.now(); this.value.totalDuration = now - this.startedAt; this.value.streamDuration = this.value.headersLatency === undefined ? undefined : now - (this.startedAt + this.value.headersLatency); if (this.gaps.length) { this.value.averageEventGap = this.gaps.reduce((a, b) => a + b, 0) / this.gaps.length; this.value.maxEventGap = Math.max(...this.gaps); } this.value.abortReason = reason; }
}
