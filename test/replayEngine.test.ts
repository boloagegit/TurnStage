import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawStreamEvent } from '../src/shared/types';
import { ReplayEngine } from '../src/extension/replay/replayEngine';

const events: RawStreamEvent[] = [0, 100, 300].map((elapsedMs, index) => ({ sequence: index + 1, receivedAt: elapsedMs, elapsedMs, protocol: 'fixture', raw: '{}', data: { index } }));

describe('ReplayEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('respects elapsed timing and playback speed', async () => {
    vi.useFakeTimers(); const accepted: number[] = []; const states: string[] = [];
    const engine = new ReplayEngine(events, 2, async (event) => { accepted.push(event.sequence); }, (state) => states.push(state.status));
    const playing = engine.play(); await vi.advanceTimersByTimeAsync(49); expect(accepted).toEqual([1]); await vi.advanceTimersByTimeAsync(1); expect(accepted).toEqual([1, 2]); await vi.advanceTimersByTimeAsync(100); await playing;
    expect(accepted).toEqual([1, 2, 3]); expect(states.at(-1)).toBe('completed');
  });

  it('pauses, steps, resumes, changes speed, and stops', async () => {
    vi.useFakeTimers(); const accepted: number[] = [];
    const engine = new ReplayEngine(events, 1, async (event) => { accepted.push(event.sequence); }, () => undefined);
    const playing = engine.play(); engine.pause(); await vi.advanceTimersByTimeAsync(500); expect(accepted).toEqual([1]); await engine.step(); expect(accepted).toEqual([1, 2]); engine.setSpeed(4); engine.resume(); await vi.advanceTimersByTimeAsync(50); await playing; expect(accepted).toEqual([1, 2, 3]);
    const stopped: number[] = []; const second = new ReplayEngine(events, 1, async (event) => { stopped.push(event.sequence); }, () => undefined); const secondPlaying = second.play(); second.stop(); await secondPlaying; expect(stopped).toEqual([1]);
  });

  it('stops consuming delayed trailing events when the sink reaches a terminal event', async () => {
    vi.useFakeTimers(); const accepted: number[] = []; const states: Array<{ status: string; index: number; total: number }> = [];
    const engine = new ReplayEngine(events, 1, async (event) => { accepted.push(event.sequence); return false; }, (state) => states.push(state));

    await engine.play();

    expect(accepted).toEqual([1]);
    expect(states.at(-1)).toMatchObject({ status: 'completed', index: events.length, total: events.length });
  });

  it('enters a terminal failed state and releases playback when the event sink throws', async () => {
    const states: string[] = [];
    const engine = new ReplayEngine(events, 1, async () => { throw new Error('code runtime failed'); }, (state) => states.push(state.status));

    await expect(engine.play()).rejects.toThrow('code runtime failed');

    expect(engine.getState()).toMatchObject({ status: 'failed', index: 0, total: events.length });
    expect(engine.getFailure()).toBeInstanceOf(Error);
    expect(states.at(-1)).toBe('failed');
  });
});
