export class EventBuffer<T> {
  private values: Array<{ value: T; bytes: number }> = []; private bytes = 0; dropped = 0;
  constructor(private readonly maxEvents: number, private readonly maxBytes: number) {}
  push(value: T): void { const bytes = Buffer.byteLength(JSON.stringify(value)); this.values.push({ value, bytes }); this.bytes += bytes; while (this.values.length > this.maxEvents || this.bytes > this.maxBytes) { const removed = this.values.shift(); if (!removed) break; this.bytes -= removed.bytes; this.dropped++; } }
  all(): T[] { return this.values.map((item) => item.value); }
  replace(values: readonly T[]): void { this.clear(); for (const value of values) this.push(value); }
  clear(): void { this.values = []; this.bytes = 0; this.dropped = 0; }
}
