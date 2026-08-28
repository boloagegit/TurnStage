import type {
  ScenarioCheckResult,
  ScenarioPerformanceDefinition,
  ScenarioPerformanceMetric,
  ScenarioRunResult,
} from '../../shared/types';
import { localize } from '../l10n';

export const scenarioPerformanceMetrics: readonly ScenarioPerformanceMetric[] = [
  'scenario.durationMs',
  'metrics.headersLatency',
  'metrics.firstChunkLatency',
  'metrics.firstEventLatency',
  'metrics.ttft',
  'metrics.streamDuration',
  'metrics.totalDuration',
  'metrics.averageEventGap',
  'metrics.maxEventGap',
];

export function evaluatePerformance(
  definition: ScenarioPerformanceDefinition | undefined,
  candidate: ScenarioRunResult,
  baseline?: ScenarioRunResult,
): ScenarioCheckResult[] {
  if (!definition) return [];
  const checks: ScenarioCheckResult[] = [];
  const candidateMetrics = metricValues(candidate);
  const baselineMetrics = baseline ? metricValues(baseline) : undefined;

  for (const [metric, maximum] of Object.entries(definition.thresholds ?? {}) as Array<[ScenarioPerformanceMetric, number]>) {
    const actual = candidateMetrics[metric];
    checks.push({
      id: `performance.threshold.${metric}`,
      label: localize('{metric} stays at or below {maximum} ms', { metric, maximum }),
      passed: typeof actual === 'number' && Number.isFinite(actual) && actual <= maximum,
      kind: 'performance',
      actual,
      expected: { maximumMs: maximum },
      location: { kind: 'profile', path: `tests.performance.thresholds.${metric}` },
    });
  }

  for (const [metric, limit] of Object.entries(definition.regression ?? {}) as Array<[ScenarioPerformanceMetric, { maxIncreaseMs?: number; maxIncreasePercent?: number }]>) {
    const actual = candidateMetrics[metric];
    const reference = baselineMetrics?.[metric];
    const increaseMs = typeof actual === 'number' && typeof reference === 'number' ? actual - reference : undefined;
    const increasePercent = increaseMs === undefined || reference === undefined ? undefined : reference === 0 ? (increaseMs <= 0 ? 0 : Number.POSITIVE_INFINITY) : (increaseMs / reference) * 100;
    const hasBound = limit.maxIncreaseMs !== undefined || limit.maxIncreasePercent !== undefined;
    const passed = hasBound
      && typeof actual === 'number'
      && typeof reference === 'number'
      && (limit.maxIncreaseMs === undefined || increaseMs! <= limit.maxIncreaseMs)
      && (limit.maxIncreasePercent === undefined || increasePercent! <= limit.maxIncreasePercent);
    checks.push({
      id: `performance.regression.${metric}`,
      label: localize('{metric} stays within the configured baseline regression limit', { metric }),
      passed,
      kind: 'performance',
      actual: { candidateMs: actual, baselineMs: reference, increaseMs, increasePercent },
      expected: limit,
      location: { kind: 'profile', path: `tests.performance.regression.${metric}` },
    });
  }
  return checks;
}

export function performanceMetricValue(result: ScenarioRunResult, metric: ScenarioPerformanceMetric): number | undefined {
  return metricValues(result)[metric];
}

function metricValues(result: ScenarioRunResult): Partial<Record<ScenarioPerformanceMetric, number>> {
  const metrics = result.evidence.snapshot.metrics;
  return {
    'scenario.durationMs': result.durationMs,
    'metrics.headersLatency': metrics.headersLatency,
    'metrics.firstChunkLatency': metrics.firstChunkLatency,
    'metrics.firstEventLatency': metrics.firstEventLatency,
    'metrics.ttft': metrics.ttft,
    'metrics.streamDuration': metrics.streamDuration,
    'metrics.totalDuration': metrics.totalDuration,
    'metrics.averageEventGap': metrics.averageEventGap,
    'metrics.maxEventGap': metrics.maxEventGap,
  };
}
