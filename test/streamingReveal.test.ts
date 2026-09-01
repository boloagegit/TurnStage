import { describe, expect, it } from 'vitest';
import { advanceGraphemeBoundary, calculateRevealStep, resolveRevealPacing } from '../src/webview/streamingReveal';

describe('adaptive streaming reveal', () => {
  it('uses bounded frame rates instead of one render per character', () => {
    expect(resolveRevealPacing('calm')).toEqual({ intervalMs: 48, initialGraphemes: 2, minimumGraphemes: 2 });
    expect(resolveRevealPacing('balanced')).toEqual({ intervalMs: 36, initialGraphemes: 3, minimumGraphemes: 3 });
    expect(resolveRevealPacing('fast')).toEqual({ intervalMs: 24, initialGraphemes: 5, minimumGraphemes: 5 });
  });

  it('never splits CJK, emoji sequences, combining marks, or surrogate pairs', () => {
    const family = '👨‍👩‍👧‍👦';
    const combined = 'e\u0301';
    const text = `你${family}${combined}好`;
    const first = advanceGraphemeBoundary(text, 0, 1);
    const second = advanceGraphemeBoundary(text, first, 1);
    const third = advanceGraphemeBoundary(text, second, 1);
    expect(text.slice(0, first)).toBe('你');
    expect(text.slice(first, second)).toBe(family);
    expect(text.slice(second, third)).toBe(combined);
    expect(text.slice(third, advanceGraphemeBoundary(text, third, 1))).toBe('好');
  });

  it('accelerates as the visual-lag deadline approaches', () => {
    expect(calculateRevealStep(1_000, 600, 36, 0)).toBe(63);
    expect(calculateRevealStep(1_000, 600, 36, 580)).toBe(1_000);
    expect(calculateRevealStep(0, 600, 36, 0)).toBe(0);
  });

  it('drains a single very large event within the configured visual-lag budget', () => {
    const text = '回'.repeat(100_000);
    const intervalMs = 36;
    const maxVisualLagMs = 600;
    let position = 0;
    let elapsed = 0;
    while (position < text.length && elapsed <= maxVisualLagMs) {
      const step = calculateRevealStep(text.length - position, maxVisualLagMs, intervalMs, elapsed);
      position = advanceGraphemeBoundary(text, position, step);
      elapsed += intervalMs;
    }
    expect(position).toBe(text.length);
    expect(elapsed).toBeLessThanOrEqual(maxVisualLagMs + intervalMs);
  });
});
