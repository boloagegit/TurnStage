/**
 * Public, host-side contracts for deterministic Copilot diagnostics.
 *
 * These types deliberately describe only bounded metadata.  A diagnostic
 * capsule is not a transcript: prompts, message content, request bodies,
 * headers and URLs have no representation in this module.
 */

export const DIAGNOSTIC_CAPSULE_VERSION = 'DiagnosticCapsuleV1' as const;
export const DIAGNOSIS_RESULT_VERSION = 'DiagnosisResultV1' as const;

export const TIMING_STAGES = [
  'request',
  'headers',
  'firstChunk',
  'firstRawEvent',
  'firstNormalizedContent',
  'firstVisibleText',
  'terminal',
] as const;

export type TimingStage = typeof TIMING_STAGES[number];

export const ROOT_CAUSE_CATEGORIES = [
  'backend',
  'network',
  'proxy',
  'auth',
  'parser',
  'mapping',
  'variant',
  'assertion',
  'timeout',
  'incomplete',
  'cancel',
  'config',
] as const;

export type RootCauseCategory = typeof ROOT_CAUSE_CATEGORIES[number];
export type EvidenceLevel = 'strong' | 'moderate' | 'limited';

export const DIAGNOSTIC_OUTCOMES = [
  'resisted',
  'attackSucceeded',
  'indeterminate',
  'infrastructureError',
  'passed',
  'failed',
  'error',
  'cancelled',
] as const;

export type DiagnosticOutcome = typeof DIAGNOSTIC_OUTCOMES[number];

export const DIAGNOSTIC_FOCUSES = ['failure', 'performance', 'stability', 'comparison', 'configuration'] as const;
export type DiagnosticFocus = typeof DIAGNOSTIC_FOCUSES[number];

export type DiagnosticSource = 'metrics' | 'network' | 'rawEvent' | 'normalizedEvent' | 'message' | 'transport' | 'result';

export interface TimingStageObservationV1 {
  stage: TimingStage;
  observed: boolean;
  elapsedMs?: number;
  source?: DiagnosticSource;
  note?: 'missing' | 'invalid' | 'observed';
}

export interface TimingLadderV1 {
  stages: readonly TimingStageObservationV1[];
  missingStages: readonly TimingStage[];
  orderingValid: boolean;
  anomalies: readonly string[];
}

export interface DiagnosticMetricsV1 {
  headersLatencyMs?: number;
  firstChunkLatencyMs?: number;
  firstRawEventLatencyMs?: number;
  firstNormalizedContentLatencyMs?: number;
  firstVisibleTextLatencyMs?: number;
  terminalLatencyMs?: number;
  streamDurationMs?: number;
  eventCount?: number;
  byteCount?: number;
  parseErrorCount?: number;
  mappingErrorCount?: number;
  unmatchedEventCount?: number;
  reconnectCount?: number;
  droppedEventCount?: number;
}

export interface DiagnosticTransportV1 {
  protocol?: 'http' | 'sse' | 'websocket' | 'json' | 'unknown';
  status?: number;
  state?: 'pending' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'unknown';
  terminalState?: 'completed' | 'failed' | 'aborted' | 'timeout' | 'pending' | 'unknown';
  openingState?: 'pending' | 'completed' | 'failed' | 'aborted' | 'unknown';
  proxyBuffered?: boolean;
  idleTimeout?: boolean;
  timeout?: boolean;
  retryCount?: number;
  variantId?: string;
}

export interface DiagnosticErrorSummaryV1 {
  category: RootCauseCategory | 'unknown';
  code?: string;
  status?: number;
  retrySafe?: boolean;
}

export interface DiagnosticEvidenceRefV1 {
  kind: 'chat' | 'network' | 'event' | 'profile' | 'metric';
  id: string;
  stage?: TimingStage;
  path?: string;
}

export interface DiagnosticAssertionSummaryV1 {
  total: number;
  passed: number;
  failed: number;
  failedIds: readonly string[];
}

export interface DiagnosticVariantSummaryV1 {
  expectedId?: string;
  actualId?: string;
  changed: boolean;
}

export interface DiagnosticRepeatAttemptInput {
  attempt?: unknown;
  outcome?: unknown;
  completed?: unknown;
  durationMs?: unknown;
}

export interface DiagnosticRepetitionInput {
  requestedAttempts?: unknown;
  sampleComplete?: unknown;
  attempts?: readonly DiagnosticRepeatAttemptInput[];
}

export interface RepeatAnalysisV1 {
  requestedAttempts: number;
  completedAttempts: number;
  skippedAttempts: number;
  sampleComplete: boolean;
  counts: Readonly<Record<DiagnosticOutcome, number>>;
  status: 'stable' | 'flaky' | 'inconclusive';
  dominantOutcome?: DiagnosticOutcome;
  evidenceLevel: EvidenceLevel;
  explanation: string;
}

export const COMPARISON_METRICS = [
  'headersLatencyMs',
  'firstChunkLatencyMs',
  'firstRawEventLatencyMs',
  'firstNormalizedContentLatencyMs',
  'firstVisibleTextLatencyMs',
  'terminalLatencyMs',
  'streamDurationMs',
] as const;

export type ComparisonMetric = typeof COMPARISON_METRICS[number];

export interface BaselineCandidateInput {
  outcome?: unknown;
  metrics?: Partial<Record<ComparisonMetric, unknown>>;
  variantId?: unknown;
  findings?: readonly unknown[];
}

export interface MetricComparisonV1 {
  metric: ComparisonMetric;
  baselineMs?: number;
  candidateMs?: number;
  deltaMs?: number;
  direction: 'improved' | 'regressed' | 'unchanged' | 'unknown';
  evidenceLevel: EvidenceLevel;
}

export interface BaselineCandidateExplanationV1 {
  outcomeChanged: boolean;
  baselineOutcome?: DiagnosticOutcome;
  candidateOutcome?: DiagnosticOutcome;
  variantChanged: boolean;
  differences: readonly MetricComparisonV1[];
  evidenceLevel: EvidenceLevel;
  summary: string;
}

export interface DiagnosticCapsuleV1 {
  version: typeof DIAGNOSTIC_CAPSULE_VERSION;
  sanitized: true;
  runId: string;
  caseId?: string;
  profileId?: string;
  attempt?: number;
  outcome: DiagnosticOutcome;
  timing: TimingLadderV1;
  metrics: DiagnosticMetricsV1;
  transport: DiagnosticTransportV1;
  errors: readonly DiagnosticErrorSummaryV1[];
  evidence: readonly DiagnosticEvidenceRefV1[];
  configIssues: readonly string[];
  assertions?: DiagnosticAssertionSummaryV1;
  variant?: DiagnosticVariantSummaryV1;
  repetition?: RepeatAnalysisV1;
}

export interface DiagnosticFindingV1 {
  category: RootCauseCategory;
  evidenceLevel: EvidenceLevel;
  label: string;
  reason: string;
  evidence: readonly DiagnosticEvidenceRefV1[];
}

export interface DiagnosticNextActionV1 {
  id: 'inspect-network' | 'inspect-events' | 'inspect-failure' | 'inspect-timeout' | 'review-profile' | 'compare-variant' | 'rerun' | 'open-evidence';
  label: string;
  requiresApproval: boolean;
}

export interface DiagnosisResultV1 {
  version: typeof DIAGNOSIS_RESULT_VERSION;
  sanitized: true;
  runId: string;
  focus: DiagnosticFocus;
  status: 'complete' | 'partial' | 'insufficientEvidence';
  evidenceLevel: EvidenceLevel;
  summary: string;
  capsule: DiagnosticCapsuleV1;
  findings: readonly DiagnosticFindingV1[];
  primaryFinding?: DiagnosticFindingV1;
  nextActions: readonly DiagnosticNextActionV1[];
  repetition?: RepeatAnalysisV1;
  comparison?: BaselineCandidateExplanationV1;
}

export interface DiagnosticTimingInput {
  request?: unknown;
  headers?: unknown;
  firstChunk?: unknown;
  firstRawEvent?: unknown;
  firstNormalizedContent?: unknown;
  firstVisibleText?: unknown;
  terminal?: unknown;
}

export interface DiagnosticMetricsInput {
  requestStartedAt?: unknown;
  headersLatency?: unknown;
  firstChunkLatency?: unknown;
  firstEventLatency?: unknown;
  firstNormalizedContentLatency?: unknown;
  firstVisibleTextLatency?: unknown;
  ttft?: unknown;
  totalDuration?: unknown;
  streamDuration?: unknown;
  eventCount?: unknown;
  byteCount?: unknown;
  parseErrorCount?: unknown;
  mappingErrorCount?: unknown;
  unmatchedEventCount?: unknown;
  reconnectCount?: unknown;
  droppedEventCount?: unknown;
}

export interface DiagnosticTransportInput {
  protocol?: unknown;
  status?: unknown;
  state?: unknown;
  terminalState?: unknown;
  openingState?: unknown;
  proxyBuffered?: unknown;
  idleTimeout?: unknown;
  timeout?: unknown;
  retryCount?: unknown;
  variantId?: unknown;
  errorType?: unknown;
  errorCode?: unknown;
  /** Optional transport-level timing fallbacks when runtime metrics are absent. */
  headersLatency?: unknown;
  firstChunkLatency?: unknown;
  terminalLatency?: unknown;
}

export interface DiagnosticErrorInput {
  type?: unknown;
  code?: unknown;
  status?: unknown;
  retrySafe?: unknown;
  message?: unknown;
}

export interface DiagnosticEvidenceInput {
  kind?: unknown;
  id?: unknown;
  stage?: unknown;
  path?: unknown;
}

export interface DiagnosticAssertionInput {
  id?: unknown;
  passed?: unknown;
}

export interface DiagnosticVariantInput {
  expectedId?: unknown;
  actualId?: unknown;
  changed?: unknown;
}

export interface DiagnosticInput {
  runId: unknown;
  focus?: unknown;
  caseId?: unknown;
  profileId?: unknown;
  attempt?: unknown;
  outcome?: unknown;
  timeoutMs?: unknown;
  timing?: DiagnosticTimingInput;
  metrics?: DiagnosticMetricsInput;
  transport?: DiagnosticTransportInput;
  errors?: readonly DiagnosticErrorInput[];
  evidence?: readonly DiagnosticEvidenceInput[];
  configIssues?: readonly unknown[];
  assertions?: readonly DiagnosticAssertionInput[];
  variant?: DiagnosticVariantInput;
  repetition?: DiagnosticRepetitionInput;
  baseline?: BaselineCandidateInput;
  candidate?: BaselineCandidateInput;
}
