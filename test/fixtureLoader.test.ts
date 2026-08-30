import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { fs: {} } }));

import { MAX_FIXTURE_EVENTS, parseFixture } from '../src/extension/runtime/fixtureLoader';

describe('bounded fixture parsing', () => {
  it('parses multi-event JSONL and clamps hostile delays', () => {
    const events = parseFixture('{"event":"start","data":{}}\n\n{"event":"done","data":"ok","delayMs":999999999}', 100);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sequence: 1, receivedAt: 100, protocol: 'fixture' });
    expect(events[1]!.elapsedMs).toBe(24 * 60 * 60 * 1000);
  });

  it('fails closed for malformed records and an excessive event count', () => {
    expect(() => parseFixture('{not-json}')).toThrow(/line 1/i);
    expect(() => parseFixture('{"event":"","data":{}}')).toThrow(/event name/i);
    expect(() => parseFixture(Array.from({ length: MAX_FIXTURE_EVENTS + 1 }, () => '{"event":"x"}').join('\n'))).toThrow(/more than/i);
  });
});
