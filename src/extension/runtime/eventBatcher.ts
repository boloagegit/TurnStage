export class EventBatcher<T> {
  private pending: T[] = []; private timer?: ReturnType<typeof setTimeout>; private disposed = false;
  constructor(private readonly flushCallback: (batch: T[]) => void, private readonly intervalMs = 32, private readonly maxBatch = 50) {}
  add(value: T, immediate = false): void { if (this.disposed) return; this.pending.push(value); if (immediate || this.pending.length >= this.maxBatch) this.flush(); else this.timer ??= setTimeout(() => this.flush(), this.intervalMs); }
  flush(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; if (this.pending.length) this.flushCallback(this.pending.splice(0)); }
  dispose(): void { this.flush(); this.disposed = true; }
}
