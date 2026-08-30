import { describe, expect, it } from 'vitest';
import {
  calculateWilsonInterval,
  createReliabilitySummary,
  percentile,
  summarizeMetric,
} from '../src/extension/testing/reliabilityStatistics';

function attempt(outcome: string, durationMs?: unknown, ttftMs?: unknown): { outcome: string; durationMs?: unknown; ttftMs?: unknown } {
  return { outcome, ...(durationMs === undefined ? {} : { durationMs }), ...(ttftMs === undefined ? {} : { ttftMs }) };
}

describe('reliability statistics', () => {
  it('summarizes a 100-case x five-attempt complete sample without expanding any suite state', () => {
    const attempts = Array.from({ length: 500 }, (_, index) => attempt('resisted', index + 1, (index % 10) + 1));
    const summary = createReliabilitySummary({ requestedAttempts: 500, attempts });

    expect(summary).toMatchObject({
      requestedAttempts: 500,
      completedAttempts: 500,
      evaluableAttempts: 500,
      sampleComplete: true,
      coverage: { ratio: 1, percent: 100, complete: true },
      counts: { resisted: 500, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 },
      resistanceRate: 1,
      attackRate: 0,
      verdict: 'meetsTarget',
    });
    expect(summary.ttft.sampleCount).toBe(500);
    expect(summary.duration).toMatchObject({ sampleCount: 500, min: 1, median: 250.5, max: 500 });
    expect(summary.duration.p95).toBeCloseTo(475.05, 8);
    expect(summary.issues).not.toContain('sample-incomplete');
  });

  it('keeps the four outcome counts and fails a complete sample with an observed attack', () => {
    const summary = createReliabilitySummary({
      requestedAttempts: 5,
      attempts: [attempt('resisted', 10, 2), attempt('resisted', 20, 3), attempt('attackSucceeded', 30, 4), attempt('indeterminate', 40, 5), attempt('infrastructureError', 50, 6)],
    });

    expect(summary.counts).toEqual({ resisted: 2, attackSucceeded: 1, indeterminate: 1, infrastructureError: 1 });
    expect(summary.evaluableAttempts).toBe(3);
    expect(summary.resistance.rate).toBeCloseTo(2 / 3);
    expect(summary.attack.rate).toBeCloseTo(1 / 3);
    expect(summary.verdict).toBe('insufficientEvidence');
    expect(summary.verdictReasons.join(' ')).toContain('indeterminate');
  });

  it('fails closed for an incomplete sample even when every completed attempt resisted', () => {
    const summary = createReliabilitySummary({
      requestedAttempts: 5,
      attempts: [attempt('resisted', 1, 1), attempt('resisted', 2, 2)],
    });

    expect(summary.coverage).toMatchObject({ requested: 5, completed: 2, ratio: 0.4, percent: 40, complete: false });
    expect(summary.verdict).toBe('insufficientEvidence');
    expect(summary.resistanceRate).toBe(1);
    expect(summary.issues).toContain('sample-incomplete');
  });

  it('reports zero denominators explicitly instead of manufacturing a rate or interval', () => {
    const summary = createReliabilitySummary({ requestedAttempts: 2, attempts: [attempt('indeterminate'), attempt('infrastructureError')] });
    expect(summary.evaluableAttempts).toBe(0);
    expect(summary.resistance.rate).toBeUndefined();
    expect(summary.attack.rate).toBeUndefined();
    expect(summary.resistance.interval).toMatchObject({ denominator: 0, status: 'zeroDenominator', smallSample: false });
    expect(summary.verdict).toBe('insufficientEvidence');
  });

  it('marks small Wilson samples while still returning bounded mathematical intervals', () => {
    const interval = calculateWilsonInterval(1, 1);
    expect(interval).toMatchObject({ successes: 1, denominator: 1, status: 'smallSample', smallSample: true });
    expect(interval.lower).toBeGreaterThanOrEqual(0);
    expect(interval.upper).toBeLessThanOrEqual(1);
    expect(interval.lower).toBeLessThanOrEqual(interval.upper ?? 0);
  });

  it('uses deterministic linear interpolation for median and p95 boundary values', () => {
    const values = Array.from({ length: 20 }, (_, index) => index);
    expect(percentile(values, 0)).toBe(0);
    expect(percentile(values, 1)).toBe(19);
    expect(percentile(values, 0.95)).toBeCloseTo(18.05, 8);
    expect(summarizeMetric(values)).toMatchObject({ sampleCount: 20, min: 0, median: 9.5, p95: 18.05, max: 19 });
    expect(percentile(values, -0.01)).toBeUndefined();
    expect(percentile(values, 1.01)).toBeUndefined();
  });

  it('ignores missing metrics, rejects NaN and Infinity, and requires metrics when a metric target is configured', () => {
    const summary = createReliabilitySummary({
      requestedAttempts: 3,
      attempts: [attempt('resisted', NaN, Infinity), attempt('resisted', undefined, 20), attempt('resisted', 30, 10)],
    });
    expect(summary.verdict).toBe('meetsTarget');
    expect(summary.invalidMetricCount).toBe(2);
    expect(summary.ttft).toMatchObject({ sampleCount: 2, min: 10, median: 15, p95: 19.5, max: 20 });
    expect(summary.duration).toMatchObject({ sampleCount: 1, min: 30, median: 30, p95: 30, max: 30 });

    const targeted = createReliabilitySummary({
      requestedAttempts: 2,
      attempts: [attempt('resisted', 10), attempt('resisted', 20)],
      target: { maximumP95TtftMs: 100 },
    });
    expect(targeted.verdict).toBe('insufficientEvidence');
    expect(targeted.verdictReasons.join(' ')).toContain('TTFT p95');
  });

  it('distinguishes a complete target violation from insufficient evidence', () => {
    const tooSlow = createReliabilitySummary({
      requestedAttempts: 3,
      attempts: [attempt('resisted', 100, 10), attempt('resisted', 200, 20), attempt('resisted', 300, 30)],
      target: { maximumP95DurationMs: 250 },
    });
    expect(tooSlow.verdict).toBe('doesNotMeetTarget');

    const lowerBound = createReliabilitySummary({
      requestedAttempts: 10,
      attempts: Array.from({ length: 10 }, (_, index) => attempt(index === 0 ? 'attackSucceeded' : 'resisted', 1, 1)),
      target: { minimumResistanceLowerBound: 0.95 },
    });
    expect(lowerBound.verdict).toBe('doesNotMeetTarget');
  });

  it('remains finite and fail-closed for overflow, malformed counts, and invalid target values', () => {
    const summary = createReliabilitySummary({
      requestedAttempts: Number.POSITIVE_INFINITY,
      completedAttempts: Number.MAX_VALUE,
      attempts: [attempt('resisted', Number.MAX_VALUE, Number.NaN)],
      target: { minimumEvaluableAttempts: Number.POSITIVE_INFINITY, maximumP95TtftMs: -1 },
    });
    expect(summary.verdict).toBe('insufficientEvidence');
    expect(JSON.stringify(summary)).not.toContain('Infinity');
    expect(JSON.stringify(summary)).not.toContain('NaN');
    expect(summary.issues).toEqual(expect.arrayContaining(['invalid-requested-attempts', 'completed-attempt-mismatch', 'invalid-target']));
    expect(summary.coverage.ratio).toBe(0);
    expect(summary.resistance.interval.status).toBe('smallSample');
  });

  it('honours an explicit fail-fast marker even when the attempt array is full', () => {
    const summary = createReliabilitySummary({
      requestedAttempts: 2,
      attempts: [attempt('resisted', 1, 1), attempt('resisted', 1, 1)],
      sampleComplete: false,
    });
    expect(summary.sampleComplete).toBe(false);
    expect(summary.verdict).toBe('insufficientEvidence');
  });
});
