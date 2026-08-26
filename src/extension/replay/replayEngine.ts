import type { RawStreamEvent } from '../../shared/types';

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4;

export class ReplayEngine {
  private index = 0;
  private speed: ReplaySpeed;
  private status: 'idle' | 'playing' | 'paused' | 'completed' | 'stopped' = 'idle';
  private timer?: ReturnType<typeof setTimeout>;
  private waiter?: () => void;

  constructor(
    private readonly events: RawStreamEvent[],
    speed: ReplaySpeed,
    private readonly accept: (event: RawStreamEvent) => Promise<void>,
    private readonly changed: (state: { status: ReplayEngine['status']; speed: ReplaySpeed; index: number; total: number }) => void,
  ) { this.speed = speed; this.emit(); }

  async play(): Promise<void> {
    if (this.status === 'completed' || this.status === 'stopped') return;
    this.status = 'playing'; this.emit();
    while (this.index < this.events.length && this.currentStatus() !== 'stopped') {
      if (this.currentStatus() === 'paused') { await new Promise<void>((resolve) => { this.waiter = resolve; }); continue; }
      const event = this.events[this.index]!;
      if (this.index > 0) { const previous = this.events[this.index - 1]!; const delay = Math.max(0, event.elapsedMs - previous.elapsedMs) / this.speed; if (delay) await this.wait(delay); }
      if (this.currentStatus() !== 'playing') continue;
      await this.accept({ ...event, receivedAt: Date.now() }); this.index++; this.emit();
    }
    if (this.currentStatus() !== 'stopped') { this.status = 'completed'; this.emit(); }
  }

  pause(): void { if (this.status === 'playing') { this.status = 'paused'; this.clearTimer(); this.emit(); } }
  resume(): void { if (this.status === 'paused') { this.status = 'playing'; this.wake(); this.emit(); } }
  async step(): Promise<void> { if (!['idle', 'paused'].includes(this.status) || this.index >= this.events.length) return; this.status = 'paused'; await this.accept({ ...this.events[this.index]!, receivedAt: Date.now() }); this.index++; if (this.index >= this.events.length) { this.status = 'completed'; this.wake(); } this.emit(); }
  stop(): void { if (this.status === 'completed') return; this.status = 'stopped'; this.clearTimer(); this.wake(); this.emit(); }
  setSpeed(speed: ReplaySpeed): void { this.speed = speed; this.emit(); }
  dispose(): void { this.stop(); }

  private async wait(ms: number): Promise<void> { await new Promise<void>((resolve) => { this.waiter = resolve; this.timer = setTimeout(() => { this.timer = undefined; this.waiter = undefined; resolve(); }, ms); }); }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private wake(): void { const waiter = this.waiter; this.waiter = undefined; waiter?.(); }
  private currentStatus(): ReplayEngine['status'] { return this.status; }
  private emit(): void { this.changed({ status: this.status, speed: this.speed, index: this.index, total: this.events.length }); }
}
