/** Pauses case dispatch without interrupting a case's turns or repetitions. */
export class TestRunControl {
  private pauseRequested = false;
  private cancelled = false;
  private activeCases = 0;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<() => void>();

  get state(): 'running' | 'pausing' | 'paused' | 'cancelling' {
    return this.cancelled ? 'cancelling' : this.pauseRequested ? this.activeCases ? 'pausing' : 'paused' : 'running';
  }

  pause(): boolean {
    if (this.cancelled || this.pauseRequested) return false;
    this.pauseRequested = true;
    this.notify();
    return true;
  }

  resume(): boolean {
    if (this.cancelled || !this.pauseRequested) return false;
    this.pauseRequested = false;
    this.wake();
    this.notify();
    return true;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.wake();
    this.notify();
  }

  async acquire(): Promise<boolean> {
    while (this.pauseRequested && !this.cancelled) await new Promise<void>((resolve) => this.waiters.add(resolve));
    if (this.cancelled) return false;
    this.activeCases += 1;
    return true;
  }

  release(): void {
    const previous = this.state;
    this.activeCases = Math.max(0, this.activeCases - 1);
    if (this.state !== previous) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
