import { describe, expect, it, vi } from 'vitest';
import { TestRunControl } from '../src/shared/testRunControl';

describe('case dispatch pause and cancellation', () => {
  it('drains active cases before pausing and resumes waiting workers', async () => {
    const control = new TestRunControl();
    const states: string[] = [];
    control.subscribe(() => states.push(control.state));
    expect(await control.acquire()).toBe(true);
    expect(await control.acquire()).toBe(true);
    expect(control.pause()).toBe(true);
    expect(control.state).toBe('pausing');
    const dispatched = vi.fn();
    const waiting = control.acquire().then(dispatched);
    control.release();
    expect(control.state).toBe('pausing');
    control.release();
    await Promise.resolve();
    expect(control.state).toBe('paused');
    expect(dispatched).not.toHaveBeenCalled();
    expect(control.resume()).toBe(true);
    await waiting;
    expect(dispatched).toHaveBeenCalledWith(true);
    expect(states).toEqual(['pausing', 'paused', 'running']);
    control.release();
  });

  it('unblocks every paused worker on cancellation without dispatching', async () => {
    const control = new TestRunControl();
    control.pause();
    const workers = Array.from({ length: 8 }, () => control.acquire());
    control.cancel();
    expect(await Promise.all(workers)).toEqual(Array(8).fill(false));
    expect(control.resume()).toBe(false);
    expect(control.pause()).toBe(false);
    expect(control.state).toBe('cancelling');
  });

  it('honors another pause before resumed workers dispatch', async () => {
    const control = new TestRunControl();
    control.pause();
    const waiting = control.acquire();
    control.resume();
    control.pause();
    await Promise.resolve();
    expect(control.state).toBe('paused');
    control.cancel();
    expect(await waiting).toBe(false);
  });
});
