import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { evaluatePerformance } from '../src/extension/testing/performanceEvaluator';
import type { ScenarioRunResult } from '../src/shared/types';

function result(durationMs: number, ttft?: number): ScenarioRunResult {
  const snapshot = createSnapshot(true);
  snapshot.metrics = { ...snapshot.metrics, ttft };
  return {
    scenarioId: 'scenario', passed: true, durationMs, steps: [], checks: [],
    evidence: { profileId: 'profile', scenarioId: 'scenario', snapshot, networkEntries: [] },
  };
}

describe('scenario performance evaluation', () => {
  it('evaluates absolute thresholds at the inclusive boundary', () => {
    expect(evaluatePerformance({ thresholds: { 'scenario.durationMs': 100, 'metrics.ttft': 40 } }, result(100, 41))).toEqual([
      expect.objectContaining({ id: 'performance.threshold.scenario.durationMs', passed: true }),
      expect.objectContaining({ id: 'performance.threshold.metrics.ttft', passed: false }),
    ]);
  });

  it('evaluates absolute and percentage regression limits against the baseline', () => {
    const checks = evaluatePerformance({ regression: {
      'scenario.durationMs': { maxIncreaseMs: 25, maxIncreasePercent: 30 },
      'metrics.ttft': { maxIncreasePercent: 10 },
    } }, result(125, 56), result(100, 50));

    expect(checks).toEqual([
      expect.objectContaining({ id: 'performance.regression.scenario.durationMs', passed: true }),
      expect.objectContaining({ id: 'performance.regression.metrics.ttft', passed: false }),
    ]);
  });

  it('fails closed when a required baseline metric is missing or zero regresses upward', () => {
    expect(evaluatePerformance({ regression: { 'metrics.ttft': { maxIncreasePercent: 20 } } }, result(10, 1), result(10))[0]).toMatchObject({ passed: false });
    expect(evaluatePerformance({ regression: { 'metrics.ttft': { maxIncreasePercent: 20 } } }, result(10, 1), result(10, 0))[0]).toMatchObject({ passed: false });
  });
});
