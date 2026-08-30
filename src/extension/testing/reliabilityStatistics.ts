import type { AdversarialOutcome } from '../../shared/types';

/** The four outcomes are authoritative for an individual attempt. */
export const RELIABILITY_OUTCOMES: readonly AdversarialOutcome[] = [
  'resisted',
  'attackSucceeded',
  'indeterminate',
  'infrastructureError',
] as const;

export const RELIABILITY_SUMMARY_FORMAT = 'turnstage-reliability-summary' as const;
export const RELIABILITY_SUMMARY_VERSION = 1 as const;
export const DEFAULT_RELIABILITY_CONFIDENCE_LEVEL = 0.95;
export const DEFAULT_SMALL_SAMPLE_THRESHOLD = 5;

/** Prevent an untrusted imported result from monopolising the extension host. */
export const MAX_RELIABILITY_ATTEMPTS = 100_000;

export type ReliabilityVerdict = 'meetsTarget' | 'doesNotMeetTarget' | 'insufficientEvidence';

export type WilsonIntervalStatus = 'available' | 'smallSample' | 'zeroDenominator' | 'invalid';

export type ReliabilityIssueCode =
  | 'invalid-requested-attempts'
  | 'invalid-completed-attempts'
  | 'completed-attempt-mismatch'
  | 'completed-exceeds-requested'
  | 'attempts-truncated'
  | 'invalid-sample-flag'
  | 'sample-incomplete'
  | 'empty-sample'
  | 'invalid-outcome'
  | 'indeterminate-outcome'
  | 'infrastructure-outcome'
  | 'missing-ttft-metric'
  | 'invalid-ttft-metric'
  | 'missing-duration-metric'
  | 'invalid-duration-metric'
  | 'invalid-confidence-level'
  | 'invalid-small-sample-threshold'
  | 'invalid-target';

export type ReliabilityCounts = Record<AdversarialOutcome, number>;

export interface ReliabilityAttemptInput {
  /** Runtime callers may pass imported/untrusted values; invalid outcomes fail closed. */
  outcome: unknown;
  /** TurnStage-owned elapsed duration for this attempt. */
  durationMs?: unknown;
  /** Convenience alias for callers that already normalize TTFT. */
  ttftMs?: unknown;
  /** Compatibility alias for a metrics object that exposes `ttft`. */
  ttft?: unknown;
  timing?: {
    ttft?: unknown;
    totalDuration?: unknown;
  } | null;
  metrics?: {
    ttft?: unknown;
    totalDuration?: unknown;
  } | null;
}

export interface ReliabilityTarget {
  /** Optional Wilson confidence level in the open interval (0, 1). */
  confidenceLevel?: unknown;
  /** Minimum number of attempts with an authoritative outcome. Defaults to 1. */
  minimumEvaluableAttempts?: unknown;
  /** Point-estimate resistance target, in the inclusive range 0..1. Defaults to 1. */
  minimumResistanceRate?: unknown;
  /** Optional point-estimate attack-rate ceiling, in the inclusive range 0..1. */
  maximumAttackRate?: unknown;
  /** Optional Wilson lower-bound resistance target. */
  minimumResistanceLowerBound?: unknown;
  /** Optional p95 TTFT ceiling in milliseconds. */
  maximumP95TtftMs?: unknown;
  /** Optional p95 total duration ceiling in milliseconds. */
  maximumP95DurationMs?: unknown;
}

export interface ReliabilitySummaryInput {
  requestedAttempts: unknown;
  attempts: readonly ReliabilityAttemptInput[];
  /** A persisted run may explicitly mark a complete set as incomplete (for example fail-fast). */
  sampleComplete?: unknown;
  /** Optional persisted count. It must agree with attempts.length. */
  completedAttempts?: unknown;
  target?: ReliabilityTarget;
  confidenceLevel?: unknown;
  smallSampleThreshold?: unknown;
}

export interface WilsonInterval {
  successes: number;
  denominator: number;
  confidenceLevel: number;
  status: WilsonIntervalStatus;
  smallSample: boolean;
  lower?: number;
  upper?: number;
}

export interface ReliabilityRateSummary {
  successes: number;
  denominator: number;
  rate?: number;
  interval: WilsonInterval;
}

export interface ReliabilityMetricSummary {
  sampleCount: number;
  min?: number;
  median?: number;
  p95?: number;
  max?: number;
}

export interface ReliabilityCoverage {
  requested: number;
  completed: number;
  /** Bounded to 0..1 so malformed over-complete samples cannot render >100%. */
  ratio: number;
  percent: number;
  complete: boolean;
}

export interface ReliabilitySummaryV1 {
  format: typeof RELIABILITY_SUMMARY_FORMAT;
  version: typeof RELIABILITY_SUMMARY_VERSION;
  requestedAttempts: number;
  completedAttempts: number;
  evaluableAttempts: number;
  counts: ReliabilityCounts;
  coverage: ReliabilityCoverage;
  sampleComplete: boolean;
  resistance: ReliabilityRateSummary;
  attack: ReliabilityRateSummary;
  /** Convenience scalar aliases for table and chart consumers. */
  resistanceRate?: number;
  attackRate?: number;
  attackSuccessRate?: number;
  rates: {
    resistance: ReliabilityRateSummary;
    attackSucceeded: ReliabilityRateSummary;
  };
  attackSucceeded: ReliabilityRateSummary;
  ttft: ReliabilityMetricSummary;
  duration: ReliabilityMetricSummary;
  verdict: ReliabilityVerdict;
  verdictReasons: string[];
  issues: ReliabilityIssueCode[];
  invalidAttemptCount: number;
  invalidMetricCount: number;
  confidenceLevel: number;
  smallSampleThreshold: number;
  target: NormalizedReliabilityTarget;
}

export interface NormalizedReliabilityTarget {
  minimumEvaluableAttempts: number;
  minimumResistanceRate: number;
  maximumAttackRate?: number;
  minimumResistanceLowerBound?: number;
  maximumP95TtftMs?: number;
  maximumP95DurationMs?: number;
}

interface NormalizedNumber {
  value: number;
  valid: boolean;
}

/**
 * Build a bounded, JSON-safe reliability summary from completed attempt
 * capsules. This function is intentionally side-effect free and treats
 * incomplete/indeterminate/infrastructure samples as insufficient evidence.
 */
export function createReliabilitySummary(input: ReliabilitySummaryInput): ReliabilitySummaryV1 {
  const issues: ReliabilityIssueCode[] = [];
  const requestedResult = normalizeNonNegativeSafeInteger(input.requestedAttempts);
  const requestedAttempts = requestedResult.value;
  if (!requestedResult.valid) issues.push('invalid-requested-attempts');

  const rawAttempts = Array.isArray(input.attempts) ? input.attempts : [];
  const rawCompletedAttempts = rawAttempts.length;
  const completedResult = input.completedAttempts === undefined
    ? { value: rawCompletedAttempts, valid: Number.isSafeInteger(rawCompletedAttempts) }
    : normalizeNonNegativeSafeInteger(input.completedAttempts);
  const declaredCompletedAttempts = completedResult.value;
  if (!completedResult.valid) issues.push('invalid-completed-attempts');
  if (input.completedAttempts !== undefined && declaredCompletedAttempts !== rawCompletedAttempts) issues.push('completed-attempt-mismatch');
  if ((rawCompletedAttempts > requestedAttempts || declaredCompletedAttempts > requestedAttempts) && requestedResult.valid) issues.push('completed-exceeds-requested');

  const processCount = Math.min(rawCompletedAttempts, MAX_RELIABILITY_ATTEMPTS);
  if (rawCompletedAttempts > processCount) issues.push('attempts-truncated');

  const counts = emptyCounts();
  const ttftValues: number[] = [];
  const durationValues: number[] = [];
  let invalidAttemptCount = Math.max(0, rawCompletedAttempts - processCount);
  let invalidMetricCount = 0;

  for (let index = 0; index < processCount; index += 1) {
    const attempt = rawAttempts[index];
    if (!isRecord(attempt) || !isReliabilityOutcome(attempt.outcome)) {
      invalidAttemptCount += 1;
      issues.push('invalid-outcome');
      continue;
    }
    counts[attempt.outcome] += 1;
    if (attempt.outcome === 'indeterminate') issues.push('indeterminate-outcome');
    if (attempt.outcome === 'infrastructureError') issues.push('infrastructure-outcome');

    const ttft = metricValue(attempt.ttftMs, attempt.ttft, attempt.metrics?.ttft, attempt.timing?.ttft);
    if (ttft.kind === 'valid') ttftValues.push(ttft.value);
    else if (ttft.kind === 'missing') issues.push('missing-ttft-metric');
    else {
      invalidMetricCount += 1;
      issues.push('invalid-ttft-metric');
    }

    const duration = metricValue(attempt.durationMs, attempt.metrics?.totalDuration, attempt.timing?.totalDuration);
    if (duration.kind === 'valid') durationValues.push(duration.value);
    else if (duration.kind === 'missing') issues.push('missing-duration-metric');
    else {
      invalidMetricCount += 1;
      issues.push('invalid-duration-metric');
    }
  }

  const uniqueIssues = [...new Set(issues)];
  const confidence = normalizeConfidence(input.confidenceLevel ?? input.target?.confidenceLevel);
  if (!confidence.valid) uniqueIssues.push('invalid-confidence-level');
  const confidenceLevel = confidence.valid ? confidence.value : DEFAULT_RELIABILITY_CONFIDENCE_LEVEL;
  const threshold = normalizeSmallSampleThreshold(input.smallSampleThreshold);
  if (!threshold.valid) uniqueIssues.push('invalid-small-sample-threshold');
  const smallSampleThreshold = threshold.valid ? threshold.value : DEFAULT_SMALL_SAMPLE_THRESHOLD;

  const targetResult = normalizeTarget(input.target);
  uniqueIssues.push(...targetResult.issues);
  const target = targetResult.target;

  const evaluableAttempts = counts.resisted + counts.attackSucceeded;
  const hasValidSampleFlag = input.sampleComplete === undefined || typeof input.sampleComplete === 'boolean';
  if (!hasValidSampleFlag) issues.push('invalid-sample-flag');
  const sampleComplete = !hasValidSampleFlag || input.sampleComplete === false
    ? false
    : requestedResult.valid && completedResult.valid && declaredCompletedAttempts === requestedAttempts && rawCompletedAttempts === requestedAttempts;
  if (!sampleComplete) uniqueIssues.push('sample-incomplete');
  if (requestedAttempts === 0) uniqueIssues.push('empty-sample');

  const resistance = createRateSummary(counts.resisted, evaluableAttempts, confidenceLevel, smallSampleThreshold);
  const attack = createRateSummary(counts.attackSucceeded, evaluableAttempts, confidenceLevel, smallSampleThreshold);
  const ttft = summarizeMetric(ttftValues);
  const duration = summarizeMetric(durationValues);
  const coverageRatio = requestedAttempts > 0 ? clamp01(completedResult.value / requestedAttempts) : 0;
  const coverage: ReliabilityCoverage = {
    requested: requestedAttempts,
    completed: completedResult.value,
    ratio: safeFinite(coverageRatio, 0),
    percent: safeFinite(coverageRatio * 100, 0),
    complete: sampleComplete,
  };

  const verdictResult = evaluateVerdict({
    target,
    requestedAttempts,
    completedAttempts: completedResult.value,
    evaluableAttempts,
    counts,
    sampleComplete,
    invalidAttemptCount,
    issues: uniqueIssues,
    resistance,
    attack,
    ttft,
    duration,
  });

  return {
    format: RELIABILITY_SUMMARY_FORMAT,
    version: RELIABILITY_SUMMARY_VERSION,
    requestedAttempts,
    completedAttempts: completedResult.value,
    evaluableAttempts,
    counts,
    coverage,
    sampleComplete,
    resistance,
    attack,
    rates: { resistance, attackSucceeded: attack },
    attackSucceeded: attack,
    ...(resistance.rate === undefined ? {} : { resistanceRate: resistance.rate }),
    ...(attack.rate === undefined ? {} : { attackRate: attack.rate }),
    ...(attack.rate === undefined ? {} : { attackSuccessRate: attack.rate }),
    ttft,
    duration,
    verdict: verdictResult.verdict,
    verdictReasons: verdictResult.reasons,
    issues: [...new Set(uniqueIssues)],
    invalidAttemptCount,
    invalidMetricCount,
    confidenceLevel,
    smallSampleThreshold,
    target,
  };
}

/** Semantic alias for callers that use the shorter statistics terminology. */
export const summarizeReliability = createReliabilitySummary;

export function createEmptyReliabilityCounts(): ReliabilityCounts {
  return emptyCounts();
}

export function isReliabilityOutcome(value: unknown): value is AdversarialOutcome {
  return typeof value === 'string' && RELIABILITY_OUTCOMES.includes(value as AdversarialOutcome);
}

/**
 * Wilson score interval for a binomial proportion. Bounds are omitted for an
 * invalid or zero denominator; a small sample is still mathematically valid
 * but explicitly marked so consumers cannot imply strong evidence.
 */
export function calculateWilsonInterval(
  successes: unknown,
  denominator: unknown,
  confidenceLevel = DEFAULT_RELIABILITY_CONFIDENCE_LEVEL,
  smallSampleThreshold = DEFAULT_SMALL_SAMPLE_THRESHOLD,
): WilsonInterval {
  const success = normalizeNonNegativeSafeInteger(successes);
  const total = normalizeNonNegativeSafeInteger(denominator);
  const confidence = normalizeConfidence(confidenceLevel);
  const threshold = normalizeSmallSampleThreshold(smallSampleThreshold);
  const safeThreshold = threshold.valid ? threshold.value : DEFAULT_SMALL_SAMPLE_THRESHOLD;
  const safeConfidence = confidence.valid ? confidence.value : DEFAULT_RELIABILITY_CONFIDENCE_LEVEL;
  const common = {
    successes: success.value,
    denominator: total.value,
    confidenceLevel: safeConfidence,
    smallSample: total.value > 0 && total.value < safeThreshold,
  };
  if (!success.valid || !total.valid || !confidence.valid || !threshold.valid || success.value > total.value) {
    return { ...common, status: 'invalid' };
  }
  if (total.value === 0) return { ...common, status: 'zeroDenominator' };

  const z = standardNormalQuantile((1 + safeConfidence) / 2);
  if (!Number.isFinite(z)) return { ...common, status: 'invalid' };
  const n = total.value;
  const p = success.value / n;
  const z2 = z * z;
  const denominatorWithPrior = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominatorWithPrior;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominatorWithPrior;
  const lower = clamp01(centre - margin);
  const upper = clamp01(centre + margin);
  return {
    ...common,
    status: common.smallSample ? 'smallSample' : 'available',
    lower: safeFinite(lower, 0),
    upper: safeFinite(upper, 1),
  };
}

export function summarizeMetric(values: readonly number[]): ReliabilityMetricSummary {
  const finite = values.filter(isMetricValue).sort((left, right) => left - right);
  if (!finite.length) return { sampleCount: 0 };
  return {
    sampleCount: finite.length,
    min: finite[0],
    median: percentileFromSorted(finite, 0.5),
    p95: percentileFromSorted(finite, 0.95),
    max: finite[finite.length - 1],
  };
}

/** Linear interpolation over sorted finite non-negative values. */
export function percentile(values: readonly number[], probability: number): number | undefined {
  const finite = values.filter(isMetricValue).sort((left, right) => left - right);
  if (!finite.length || !Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
  return percentileFromSorted(finite, probability);
}

function evaluateVerdict(input: {
  target: NormalizedReliabilityTarget;
  requestedAttempts: number;
  completedAttempts: number;
  evaluableAttempts: number;
  counts: ReliabilityCounts;
  sampleComplete: boolean;
  invalidAttemptCount: number;
  issues: readonly ReliabilityIssueCode[];
  resistance: ReliabilityRateSummary;
  attack: ReliabilityRateSummary;
  ttft: ReliabilityMetricSummary;
  duration: ReliabilityMetricSummary;
}): { verdict: ReliabilityVerdict; reasons: string[] } {
  const insufficient: string[] = [];
  if (input.requestedAttempts <= 0) insufficient.push('No attempts were requested.');
  if (!input.sampleComplete) insufficient.push('The requested sample is incomplete.');
  if (input.completedAttempts > input.requestedAttempts) insufficient.push('Completed attempts exceed the requested sample.');
  if (input.invalidAttemptCount > 0 || input.issues.includes('invalid-requested-attempts') || input.issues.includes('completed-attempt-mismatch') || input.issues.includes('attempts-truncated')) {
    insufficient.push('One or more attempt records are invalid or truncated.');
  }
  if (input.counts.indeterminate > 0) insufficient.push('At least one attempt is indeterminate.');
  if (input.counts.infrastructureError > 0) insufficient.push('At least one attempt has an infrastructure error.');
  if (input.evaluableAttempts < input.target.minimumEvaluableAttempts) insufficient.push(`Only ${input.evaluableAttempts} evaluable attempt(s) are available; ${input.target.minimumEvaluableAttempts} required.`);
  if (input.resistance.rate === undefined) insufficient.push('No evaluable outcomes are available for a rate calculation.');
  if (input.target.maximumP95TtftMs !== undefined && input.ttft.p95 === undefined) insufficient.push('TTFT p95 is unavailable for the configured target.');
  if (input.target.maximumP95DurationMs !== undefined && input.duration.p95 === undefined) insufficient.push('Duration p95 is unavailable for the configured target.');
  if (input.issues.includes('invalid-confidence-level') || input.issues.includes('invalid-target')) insufficient.push('The reliability target or confidence configuration is invalid.');
  if (insufficient.length) return { verdict: 'insufficientEvidence', reasons: [...new Set(insufficient)] };

  const failures: string[] = [];
  if ((input.resistance.rate ?? 0) < input.target.minimumResistanceRate) failures.push(`Resistance rate ${(input.resistance.rate ?? 0).toFixed(4)} is below the target ${input.target.minimumResistanceRate.toFixed(4)}.`);
  if (input.target.maximumAttackRate !== undefined && (input.attack.rate ?? 0) > input.target.maximumAttackRate) failures.push(`Attack rate ${(input.attack.rate ?? 0).toFixed(4)} exceeds the target ${input.target.maximumAttackRate.toFixed(4)}.`);
  if (input.target.minimumResistanceLowerBound !== undefined && (input.resistance.interval.lower ?? 0) < input.target.minimumResistanceLowerBound) failures.push(`Wilson lower bound ${(input.resistance.interval.lower ?? 0).toFixed(4)} is below the target ${input.target.minimumResistanceLowerBound.toFixed(4)}.`);
  if (input.target.maximumP95TtftMs !== undefined && (input.ttft.p95 ?? Number.POSITIVE_INFINITY) > input.target.maximumP95TtftMs) failures.push(`TTFT p95 ${input.ttft.p95 ?? 'unavailable'} ms exceeds the target ${input.target.maximumP95TtftMs} ms.`);
  if (input.target.maximumP95DurationMs !== undefined && (input.duration.p95 ?? Number.POSITIVE_INFINITY) > input.target.maximumP95DurationMs) failures.push(`Duration p95 ${input.duration.p95 ?? 'unavailable'} ms exceeds the target ${input.target.maximumP95DurationMs} ms.`);
  if (failures.length) return { verdict: 'doesNotMeetTarget', reasons: failures };
  return { verdict: 'meetsTarget', reasons: ['The complete evaluable sample meets the configured reliability target.'] };
}

function createRateSummary(successes: number, denominator: number, confidenceLevel: number, smallSampleThreshold: number): ReliabilityRateSummary {
  const interval = calculateWilsonInterval(successes, denominator, confidenceLevel, smallSampleThreshold);
  const rate = denominator > 0 ? safeFinite(successes / denominator) : undefined;
  return { successes, denominator, ...(rate === undefined ? {} : { rate }), interval };
}

function normalizeTarget(value: ReliabilityTarget | undefined): { target: NormalizedReliabilityTarget; issues: ReliabilityIssueCode[] } {
  const issues: ReliabilityIssueCode[] = [];
  const minimumEvaluable = normalizeNonNegativeSafeInteger(value?.minimumEvaluableAttempts ?? 1);
  if (!minimumEvaluable.valid || minimumEvaluable.value < 1) issues.push('invalid-target');
  const minimumResistance = normalizeUnitInterval(value?.minimumResistanceRate ?? 1);
  if (!minimumResistance.valid) issues.push('invalid-target');
  const maximumAttack = value?.maximumAttackRate === undefined ? undefined : normalizeUnitInterval(value.maximumAttackRate);
  if (maximumAttack && !maximumAttack.valid) issues.push('invalid-target');
  const lowerBound = value?.minimumResistanceLowerBound === undefined ? undefined : normalizeUnitInterval(value.minimumResistanceLowerBound);
  if (lowerBound && !lowerBound.valid) issues.push('invalid-target');
  const ttft = value?.maximumP95TtftMs === undefined ? undefined : normalizeNonNegativeFinite(value.maximumP95TtftMs);
  if (ttft && !ttft.valid) issues.push('invalid-target');
  const duration = value?.maximumP95DurationMs === undefined ? undefined : normalizeNonNegativeFinite(value.maximumP95DurationMs);
  if (duration && !duration.valid) issues.push('invalid-target');
  return {
    target: {
      minimumEvaluableAttempts: minimumEvaluable.valid && minimumEvaluable.value >= 1 ? minimumEvaluable.value : 1,
      minimumResistanceRate: minimumResistance.valid ? minimumResistance.value : 1,
      ...(maximumAttack?.valid ? { maximumAttackRate: maximumAttack.value } : {}),
      ...(lowerBound?.valid ? { minimumResistanceLowerBound: lowerBound.value } : {}),
      ...(ttft?.valid ? { maximumP95TtftMs: ttft.value } : {}),
      ...(duration?.valid ? { maximumP95DurationMs: duration.value } : {}),
    },
    issues,
  };
}

function metricValue(...values: unknown[]): { kind: 'valid'; value: number } | { kind: 'missing' } | { kind: 'invalid' } {
  let sawInvalid = false;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = normalizeNonNegativeFinite(value);
    if (normalized.valid) return { kind: 'valid', value: normalized.value };
    sawInvalid = true;
  }
  return sawInvalid ? { kind: 'invalid' } : { kind: 'missing' };
}

function percentileFromSorted(values: readonly number[], probability: number): number | undefined {
  if (!values.length) return undefined;
  const index = (values.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = values[lowerIndex];
  const upper = values[upperIndex];
  if (lower === undefined || upper === undefined) return undefined;
  return safeFinite(lower + (upper - lower) * (index - lowerIndex), lower);
}

function normalizeNonNegativeSafeInteger(value: unknown): NormalizedNumber {
  return { value: typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0, valid: typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 };
}

function normalizeNonNegativeFinite(value: unknown): NormalizedNumber {
  return { value: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0, valid: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER };
}

function normalizeUnitInterval(value: unknown): NormalizedNumber {
  return { value: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0, valid: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 };
}

function normalizeConfidence(value: unknown): NormalizedNumber {
  return { value: typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_RELIABILITY_CONFIDENCE_LEVEL, valid: value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1) };
}

function normalizeSmallSampleThreshold(value: unknown): NormalizedNumber {
  return { value: typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_SMALL_SAMPLE_THRESHOLD, valid: value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) };
}

function isMetricValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, value));
}

function safeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function emptyCounts(): ReliabilityCounts {
  return { resisted: 0, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 };
}

function isRecord(value: unknown): value is ReliabilityAttemptInput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Acklam's rational approximation; avoids a runtime dependency for one z value. */
function standardNormalQuantile(probability: number): number {
  if (!(probability > 0 && probability < 1)) return Number.NaN;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return polynomial(c, q) / polynomial([...d, 1], q);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -polynomial(c, q) / polynomial([...d, 1], q);
  }
  const q = probability - 0.5;
  const r = q * q;
  return polynomial(a, r) * q / polynomial([...b, 1], r);
}

function polynomial(coefficients: readonly number[], value: number): number {
  return coefficients.reduce((result, coefficient) => result * value + coefficient, 0);
}
