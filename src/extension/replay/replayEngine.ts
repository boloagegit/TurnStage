import type { RawStreamEvent } from '../../shared/types';

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4;
export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'completed' | 'stopped' | 'failed';
export interface ReplayState { status: ReplayStatus; speed: ReplaySpeed; index: number; total: number }

export class ReplayEngine {
  private index = 0;
  private speed: ReplaySpeed;
  private status: ReplayStatus = 'idle';
  private failure?: unknown;
  private timer?: ReturnType<typeof setTimeout>;
  private waiter?: () => void;

  constructor(
    private readonly events: RawStreamEvent[],
    speed: ReplaySpeed,
    private readonly accept: (event: RawStreamEvent) => Promise<void | boolean>,
    private readonly changed: (state: ReplayState) => void,
  ) { this.speed = speed; this.emit(); }

  async play(): Promise<void> {
    if (this.isTerminal()) return;
    this.status = 'playing'; this.emit();
    try {
      while (this.index < this.events.length && !this.isTerminal()) {
        if (this.currentStatus() === 'paused') { await new Promise<void>((resolve) => { this.waiter = resolve; }); continue; }
        const event = this.events[this.index]!;
        if (this.index > 0) { const previous = this.events[this.index - 1]!; const delay = Math.max(0, event.elapsedMs - previous.elapsedMs) / this.speed; if (delay) await this.wait(delay); }
        if (this.currentStatus() !== 'playing') continue;
        const keepGoing = await this.accept({ ...event, receivedAt: Date.now() }); this.index++; if (keepGoing === false) this.index = this.events.length; this.emit(); if (keepGoing === false) break;
      }
      if (this.currentStatus() === 'playing') { this.status = 'completed'; this.emit(); }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  pause(): void { if (this.status === 'playing') { this.status = 'paused'; this.clearTimer(); this.emit(); } }
  resume(): void { if (this.status === 'paused') { this.status = 'playing'; this.wake(); this.emit(); } }
  async step(): Promise<void> {
    if (!['idle', 'paused'].includes(this.status) || this.index >= this.events.length) return;
    this.status = 'paused';
    try {
      const keepGoing = await this.accept({ ...this.events[this.index]!, receivedAt: Date.now() }); this.index++; if (keepGoing === false) this.index = this.events.length; if (this.index >= this.events.length) { this.status = 'completed'; this.wake(); } this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  stop(): void { if (this.isTerminal()) return; this.status = 'stopped'; this.clearTimer(); this.wake(); this.emit(); }
  setSpeed(speed: ReplaySpeed): void { this.speed = speed; this.emit(); }
  dispose(): void { this.stop(); }
  getState(): ReplayState { return { status: this.status, speed: this.speed, index: this.index, total: this.events.length }; }
  getFailure(): unknown { return this.failure; }

  private async wait(ms: number): Promise<void> { await new Promise<void>((resolve) => { this.waiter = resolve; this.timer = setTimeout(() => { this.timer = undefined; this.waiter = undefined; resolve(); }, ms); }); }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private wake(): void { const waiter = this.waiter; this.waiter = undefined; waiter?.(); }
  private fail(error: unknown): void { if (this.status === 'stopped') return; this.failure = error; this.status = 'failed'; this.clearTimer(); this.wake(); this.emit(); }
  private isTerminal(): boolean { return ['completed', 'stopped', 'failed'].includes(this.status); }
  private currentStatus(): ReplayStatus { return this.status; }
  private emit(): void { this.changed({ status: this.status, speed: this.speed, index: this.index, total: this.events.length }); }
}
