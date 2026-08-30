import type { AdversarialOutcome, AdversarialStability } from '../../shared/types';

export const BATCH_RUN_FORMAT = 'turnstage-batch-run-plan' as const;
export const BATCH_RUN_VERSION = 1 as const;
export const BATCH_PROGRESS_FORMAT = 'turnstage-batch-progress' as const;
export const BATCH_PROGRESS_VERSION = 1 as const;
export const BATCH_RESUME_CURSOR_FORMAT = 'turnstage-batch-resume-cursor' as const;
export const BATCH_RESUME_CURSOR_VERSION = 1 as const;

export const DEFAULT_BATCH_CONCURRENCY = 3;
export const MAX_BATCH_CONCURRENCY = 8;
export const MAX_BATCH_CASES = 500;
export const MAX_BATCH_ATTEMPTS = 10_000;
export const MAX_BATCH_REQUESTS = 100_000;
export const MAX_BATCH_TEXT_LENGTH = 512;

export type BatchExecutionStatus = 'pending' | 'running' | 'completed' | 'cancelled';

export type BatchFilterStatus =
  | AdversarialOutcome
  | 'passed'
  | 'failed'
  | 'error'
  | 'inconclusive'
  | 'infrastructure-error'
  | 'unstable'
  | 'incomplete';

export type BatchPlanIssueCode =
  | 'invalid-case'
  | 'duplicate-case'
  | 'invalid-policy'
  | 'invalid-progress'
  | 'selection'
  | 'overflow'
  | 'attempt-cap'
  | 'request-cap'
  | 'duration-cap'
  | 'invalid-resume-cursor';

/** A small, declarative case descriptor. It contains no request or transcript data. */
export interface BatchCaseInput {
  id: string;
  key?: string;
  profileId?: string;
  suiteId?: string;
  tags?: readonly string[];
  /** `repetitions` is accepted as an alias for existing scenario definitions. */
  requestedAttempts?: unknown;
  repetitions?: unknown;
  turnsPerAttempt?: unknown;
  requestsPerAttempt?: unknown;
  timeoutMs?: unknown;
  /** Total values can be copied directly from ScenarioPlan. */
  plannedTurns?: unknown;
  plannedRequests?: unknown;
  maximumDurationMs?: unknown;
  outcome?: unknown;
  /** Existing Test Explorer/Copilot status aliases are accepted for filtering. */
  status?: unknown;
  stability?: unknown;
  sampleComplete?: unknown;
  completedAttempts?: unknown;
}

export interface BatchCaseFilter {
  ids?: readonly string[];
  caseIds?: readonly string[];
  profileIds?: readonly string[];
  suiteIds?: readonly string[];
  tags?: readonly string[];
  tagMode?: 'all' | 'any';
  statuses?: readonly BatchFilterStatus[];
  outcomes?: readonly BatchFilterStatus[];
  /** Convenience alias for rerun actions in the UI. `all` selects every case. */
  rerunStatus?: BatchFilterStatus | 'all';
  rerun?: BatchFilterStatus | 'all';
}

export interface BatchRunPlanOptions {
  filter?: BatchCaseFilter;
  maxConcurrency?: unknown;
  maxAttempts?: unknown;
  maxRequests?: unknown;
  maxDurationMs?: unknown;
  planKey?: string;
  progress?: BatchProgressV1 | ReadonlyMap<string, BatchCaseProgressInput> | Record<string, BatchCaseProgressInput>;
}

export interface BatchCasePlan {
  key: string;
  id: string;
  profileId?: string;
  suiteId?: string;
  tags: string[];
  requestedAttempts: number;
  completedAttempts: number;
  remainingAttempts: number;
  nextAttempt: number;
  plannedTurns: number;
  plannedRequests: number;
  maximumDurationMs: number;
  counts: BatchCounts;
  outcome?: AdversarialOutcome;
  stability?: AdversarialStability;
  sampleComplete: boolean;
  status: BatchExecutionStatus;
}

export interface BatchPlanIssue {
  code: BatchPlanIssueCode;
  message: string;
  caseId?: string;
}

export interface BatchRunPlanV1 {
  format: typeof BATCH_RUN_FORMAT;
  version: typeof BATCH_RUN_VERSION;
  planKey: string;
  selectedCases: number;
  plannedAttempts: number;
  remainingAttempts: number;
  plannedTurns: number;
  remainingTurns: number;
  plannedRequests: number;
  remainingRequests: number;
  maximumDurationMs: number;
  remainingDurationMs: number;
  maxConcurrency: number;
  cases: BatchCasePlan[];
  issues: BatchPlanIssue[];
  valid: boolean;
  withinBudget: boolean;
}

export type BatchCounts = Record<AdversarialOutcome, number>;

export interface BatchCaseProgressInput {
  completedAttempts?: unknown;
  requestedAttempts?: unknown;
  activeAttempt?: unknown;
  status?: unknown;
  outcome?: unknown;
  counts?: Partial<BatchCounts>;
  sampleComplete?: unknown;
}

export interface BatchCaseProgressV1 {
  key: string;
  id: string;
  requestedAttempts: number;
  completedAttempts: number;
  activeAttempt?: number;
  status: BatchExecutionStatus;
  sampleComplete: boolean;
  outcome?: AdversarialOutcome;
  counts: BatchCounts;
}

export interface BatchProgressV1 {
  format: typeof BATCH_PROGRESS_FORMAT;
  version: typeof BATCH_PROGRESS_VERSION;
  planKey: string;
  cancellationRequested: boolean;
  completedCases: number;
  completedAttempts: number;
  cases: BatchCaseProgressV1[];
}

export interface BatchResumeCursorV1 {
  format: typeof BATCH_RESUME_CURSOR_FORMAT;
  version: typeof BATCH_RESUME_CURSOR_VERSION;
  planKey: string;
  nextCaseIndex: number;
  nextAttemptByCase: Record<string, number>;
  cancellationRequested: boolean;
}

export interface BatchWorkItem {
  caseKey: string;
  caseId: string;
  caseIndex: number;
  attempt: number;
}

export interface BatchProgressTransition {
  accepted: boolean;
  progress: BatchProgressV1;
  reason?: string;
}

/**
 * Select cases using stable metadata only. Status aliases deliberately map to
 * the existing four outcomes; no new outcome is invented for filtering.
 */
export function filterBatchCases(cases: readonly BatchCaseInput[], filter?: BatchCaseFilter): BatchCaseInput[] {
  if (!filter) return [...cases];
  return cases.filter((item) => matchesBatchFilter(item, filter));
}

export function matchesBatchFilter(item: BatchCaseInput, filter: BatchCaseFilter): boolean {
  const key = stableCaseKey(item);
  const ids = [...(filter.ids ?? []), ...(filter.caseIds ?? [])];
  if (ids.length && !ids.includes(item.id) && !ids.includes(key)) return false;
  if (filter.profileIds?.length && (!item.profileId || !filter.profileIds.includes(item.profileId))) return false;
  if (filter.suiteIds?.length && (!item.suiteId || !filter.suiteIds.includes(item.suiteId))) return false;
  if (filter.tags?.length) {
    const tags = new Set(item.tags ?? []);
    const matches = filter.tagMode === 'any' ? filter.tags.some((tag) => tags.has(tag)) : filter.tags.every((tag) => tags.has(tag));
    if (!matches) return false;
  }
  const statuses: Array<BatchFilterStatus | 'all'> = [
    ...(filter.statuses ?? []),
    ...(filter.outcomes ?? []),
    ...(filter.rerunStatus && filter.rerunStatus !== 'all' ? [filter.rerunStatus] : []),
    ...(filter.rerun && filter.rerun !== 'all' ? [filter.rerun] : []),
  ];
  if (statuses.length && !statuses.some((status) => status === 'all' || matchesStatus(item, status))) return false;
  return true;
}

/** Build a bounded plan without expanding attempts into an array. */
export function createBatchRunPlan(cases: readonly BatchCaseInput[], options: BatchRunPlanOptions = {}): BatchRunPlanV1 {
  const issues: BatchPlanIssue[] = [];
  const selected = filterBatchCases(cases, options.filter);
  if (selected.length > MAX_BATCH_CASES) issues.push({ code: 'selection', message: `The batch contains ${selected.length} cases; the safety cap is ${MAX_BATCH_CASES}.` });

  const maxConcurrency = normalizePolicyInteger(options.maxConcurrency, DEFAULT_BATCH_CONCURRENCY, 1, MAX_BATCH_CONCURRENCY, issues, 'maxConcurrency');
  const maxAttempts = normalizeOptionalPolicyInteger(options.maxAttempts, MAX_BATCH_ATTEMPTS, issues, 'maxAttempts');
  const maxRequests = normalizeOptionalPolicyInteger(options.maxRequests, MAX_BATCH_REQUESTS, issues, 'maxRequests');
  const maxDurationMs = normalizeOptionalPolicyInteger(options.maxDurationMs, Number.MAX_SAFE_INTEGER, issues, 'maxDurationMs');

  const seen = new Set<string>();
  const plans: BatchCasePlan[] = [];
  for (const item of selected.slice(0, MAX_BATCH_CASES)) {
    const key = stableCaseKey(item);
    if (!safeText(item.id)) {
      issues.push({ code: 'invalid-case', message: 'Batch case id must be a non-empty bounded string.' });
      continue;
    }
    if (seen.has(key)) {
      issues.push({ code: 'duplicate-case', caseId: item.id, message: `Duplicate batch case key: ${key}.` });
      continue;
    }
    seen.add(key);
    const normalized = normalizeCase(item, options.progress, issues);
    if (!normalized) continue;
    plans.push(normalized);
  }

  const totals = plans.reduce((accumulator, item) => ({
    plannedAttempts: safeAdd(accumulator.plannedAttempts, item.requestedAttempts, issues, 'planned attempts'),
    remainingAttempts: safeAdd(accumulator.remainingAttempts, item.remainingAttempts, issues, 'remaining attempts'),
    plannedTurns: safeAdd(accumulator.plannedTurns, item.plannedTurns, issues, 'planned turns'),
    remainingTurns: safeSubtractSafeTotal(accumulator.remainingTurns, item.plannedTurns, item.completedAttempts, item.requestedAttempts, issues, 'remaining turns'),
    plannedRequests: safeAdd(accumulator.plannedRequests, item.plannedRequests, issues, 'planned requests'),
    remainingRequests: safeSubtractSafeTotal(accumulator.remainingRequests, item.plannedRequests, item.completedAttempts, item.requestedAttempts, issues, 'remaining requests'),
    maximumDurationMs: safeAdd(accumulator.maximumDurationMs, item.maximumDurationMs, issues, 'maximum duration'),
    remainingDurationMs: safeSubtractSafeTotal(accumulator.remainingDurationMs, item.maximumDurationMs, item.completedAttempts, item.requestedAttempts, issues, 'remaining duration'),
  }), emptyTotals());

  if (totals.plannedAttempts > maxAttempts) issues.push({ code: 'attempt-cap', message: `The batch plans ${totals.plannedAttempts} attempts; the configured cap is ${maxAttempts}.` });
  if (totals.plannedRequests > maxRequests) issues.push({ code: 'request-cap', message: `The batch plans ${totals.plannedRequests} requests; the configured cap is ${maxRequests}.` });
  if (totals.maximumDurationMs > maxDurationMs) issues.push({ code: 'duration-cap', message: `The batch plans ${totals.maximumDurationMs} ms; the configured cap is ${maxDurationMs} ms.` });

  const planKey = normalizePlanKey(options.planKey) ?? derivePlanKey(plans);
  const uniqueIssues = uniquePlanIssues(issues);
  const withinBudget = !uniqueIssues.some((issue) => issue.code === 'attempt-cap' || issue.code === 'request-cap' || issue.code === 'duration-cap' || issue.code === 'overflow');
  return {
    format: BATCH_RUN_FORMAT,
    version: BATCH_RUN_VERSION,
    planKey,
    selectedCases: plans.length,
    plannedAttempts: totals.plannedAttempts,
    remainingAttempts: totals.remainingAttempts,
    plannedTurns: totals.plannedTurns,
    remainingTurns: totals.remainingTurns,
    plannedRequests: totals.plannedRequests,
    remainingRequests: totals.remainingRequests,
    maximumDurationMs: totals.maximumDurationMs,
    remainingDurationMs: totals.remainingDurationMs,
    maxConcurrency,
    cases: plans,
    issues: uniqueIssues,
    valid: uniqueIssues.length === 0,
    withinBudget,
  };
}

export function createBatchProgress(plan: BatchRunPlanV1): BatchProgressV1 {
  const cases = plan.cases.map((item) => ({
    key: item.key,
    id: item.id,
    requestedAttempts: item.requestedAttempts,
    completedAttempts: item.completedAttempts,
    ...(item.status === 'running' && item.nextAttempt <= item.requestedAttempts ? { activeAttempt: item.nextAttempt } : {}),
    status: item.status,
    sampleComplete: item.sampleComplete,
    ...(item.outcome ? { outcome: item.outcome } : {}),
    counts: { ...item.counts },
  }));
  return summarizeProgress({
    format: BATCH_PROGRESS_FORMAT,
    version: BATCH_PROGRESS_VERSION,
    planKey: plan.planKey,
    cancellationRequested: false,
    completedCases: 0,
    completedAttempts: 0,
    cases,
  });
}

/** Return the next not-yet-completed attempt, or undefined after cancellation. */
export function nextBatchWorkItem(plan: BatchRunPlanV1, source: BatchProgressV1 | BatchResumeCursorV1): BatchWorkItem | undefined {
  if (source.cancellationRequested || source.planKey !== plan.planKey) return undefined;
  if (isProgress(source)) {
    for (const [caseIndex, item] of plan.cases.entries()) {
      const progress = source.cases.find((candidate) => candidate.key === item.key);
      if (!progress || progress.status === 'running') continue;
      const attempt = progress.completedAttempts + 1;
      if (attempt <= item.requestedAttempts) return { caseKey: item.key, caseId: item.id, caseIndex, attempt };
    }
    return undefined;
  }
  const cursorCheck = validateBatchResumeCursor(plan, source);
  if (!cursorCheck.valid) return undefined;
  for (let index = Math.max(0, source.nextCaseIndex); index < plan.cases.length; index += 1) {
    const item = plan.cases[index];
    if (!item) continue;
    const attempt = source.nextAttemptByCase[item.key] ?? item.nextAttempt;
    if (attempt <= item.requestedAttempts) return { caseKey: item.key, caseId: item.id, caseIndex: index, attempt };
  }
  return undefined;
}

export function startBatchAttempt(progress: BatchProgressV1, item: BatchWorkItem): BatchProgressTransition {
  if (progress.cancellationRequested) return rejectedTransition(progress, 'The batch is cancelled; resume it before starting another attempt.');
  const index = progress.cases.findIndex((candidate) => candidate.key === item.caseKey);
  if (index < 0) return rejectedTransition(progress, 'The batch case is not present in this progress snapshot.');
  const current = progress.cases[index];
  if (!current || current.status === 'running') return rejectedTransition(progress, 'The batch case already has an active attempt.');
  if (item.caseIndex !== index || item.caseId !== current.id) return rejectedTransition(progress, 'The work item does not identify the selected batch case.');
  if (!Number.isSafeInteger(item.attempt) || item.attempt !== current.completedAttempts + 1 || item.attempt > current.requestedAttempts) return rejectedTransition(progress, 'Attempts must start at the next completed-attempt boundary.');
  const cases = cloneProgressCases(progress.cases);
  cases[index] = { ...current, status: 'running', activeAttempt: item.attempt };
  return { accepted: true, progress: summarizeProgress({ ...progress, cases }) };
}

/** Complete exactly one active attempt; cancellation only blocks the next boundary. */
export function completeBatchAttempt(progress: BatchProgressV1, item: BatchWorkItem, outcome: unknown): BatchProgressTransition {
  if (!isBatchOutcome(outcome)) return rejectedTransition(progress, 'An attempt must preserve one of the four authoritative outcomes.');
  const index = progress.cases.findIndex((candidate) => candidate.key === item.caseKey);
  if (index < 0) return rejectedTransition(progress, 'The batch case is not present in this progress snapshot.');
  const current = progress.cases[index];
  if (!current || item.caseIndex !== index || item.caseId !== current.id) return rejectedTransition(progress, 'The work item does not identify the selected batch case.');
  if (current.status !== 'running' || current.activeAttempt !== item.attempt || item.attempt !== current.completedAttempts + 1 || item.attempt > current.requestedAttempts) return rejectedTransition(progress, 'Attempt completion must match the currently active attempt.');
  const counts = { ...current.counts };
  counts[outcome] += 1;
  const completedAttempts = current.completedAttempts + 1;
  const sampleComplete = completedAttempts >= current.requestedAttempts;
  const cases = cloneProgressCases(progress.cases);
  cases[index] = {
    ...current,
    completedAttempts,
    status: sampleComplete ? 'completed' : 'pending',
    sampleComplete,
    outcome: aggregateBatchOutcome(counts),
    counts,
    activeAttempt: undefined,
  };
  return { accepted: true, progress: summarizeProgress({ ...progress, cases }) };
}

/** Cancellation is recoverable: the active attempt is not counted as completed. */
export function cancelBatchProgress(progress: BatchProgressV1): BatchProgressV1 {
  const cases = cloneProgressCases(progress.cases).map((item) => item.status === 'running' ? { ...item, status: 'cancelled' as const, activeAttempt: undefined } : item);
  return summarizeProgress({ ...progress, cancellationRequested: true, cases });
}

/** Clear the cancellation latch without inventing a completed attempt. */
export function resumeBatchProgress(progress: BatchProgressV1): BatchProgressV1 {
  const cases = cloneProgressCases(progress.cases).map((item) => item.status === 'cancelled' ? { ...item, status: item.completedAttempts >= item.requestedAttempts ? 'completed' as const : 'pending' as const } : item);
  return summarizeProgress({ ...progress, cancellationRequested: false, cases });
}

export function createBatchResumeCursor(plan: BatchRunPlanV1, progress?: BatchProgressV1): BatchResumeCursorV1 {
  const nextAttemptByCase: Record<string, number> = {};
  let nextCaseIndex = plan.cases.length;
  for (const [index, item] of plan.cases.entries()) {
    const current = progress?.cases.find((candidate) => candidate.key === item.key);
    const completedAttempts = current?.completedAttempts ?? item.completedAttempts;
    const nextAttempt = safeNextAttempt(completedAttempts);
    nextAttemptByCase[item.key] = nextAttempt;
    if (nextCaseIndex === plan.cases.length && nextAttempt <= item.requestedAttempts) nextCaseIndex = index;
  }
  return {
    format: BATCH_RESUME_CURSOR_FORMAT,
    version: BATCH_RESUME_CURSOR_VERSION,
    planKey: plan.planKey,
    nextCaseIndex,
    nextAttemptByCase,
    cancellationRequested: progress?.cancellationRequested ?? false,
  };
}

export function validateBatchResumeCursor(plan: BatchRunPlanV1, cursor: BatchResumeCursorV1): { valid: boolean; issues: BatchPlanIssue[] } {
  const issues: BatchPlanIssue[] = [];
  if (!cursor || cursor.format !== BATCH_RESUME_CURSOR_FORMAT || cursor.version !== BATCH_RESUME_CURSOR_VERSION) issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor format or version is unsupported.' });
  if (cursor?.planKey !== plan.planKey) issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor belongs to a different batch plan.' });
  if (!Number.isSafeInteger(cursor?.nextCaseIndex) || cursor.nextCaseIndex < 0 || cursor.nextCaseIndex > plan.cases.length) issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor case index is outside the current plan.' });
  if (typeof cursor?.cancellationRequested !== 'boolean') issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor cancellation state is invalid.' });
  const values = cursor?.nextAttemptByCase;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor attempt map is invalid.' });
  } else {
    const expectedKeys = new Set(plan.cases.map((item) => item.key));
    for (const key of Object.keys(values)) if (!expectedKeys.has(key)) issues.push({ code: 'invalid-resume-cursor', message: `Resume cursor contains unknown case key: ${key}.` });
    for (const item of plan.cases) {
      const value = values[item.key] ?? Number.NaN;
      if (!Number.isSafeInteger(value) || value < 1 || value > item.requestedAttempts + 1) issues.push({ code: 'invalid-resume-cursor', caseId: item.id, message: `Resume cursor attempt for ${item.id} is invalid.` });
    }
  }
  if (issues.length === 0) {
    const firstPending = plan.cases.findIndex((item) => (cursor.nextAttemptByCase[item.key] ?? item.requestedAttempts + 1) <= item.requestedAttempts);
    const expectedIndex = firstPending < 0 ? plan.cases.length : firstPending;
    if (cursor.nextCaseIndex !== expectedIndex) issues.push({ code: 'invalid-resume-cursor', message: 'Resume cursor does not point at the first pending case.' });
  }
  return { valid: issues.length === 0, issues: uniquePlanIssues(issues) };
}

export function aggregateBatchOutcome(counts: BatchCounts): AdversarialOutcome {
  if (counts.attackSucceeded > 0) return 'attackSucceeded';
  if (counts.infrastructureError > 0) return 'infrastructureError';
  if (counts.indeterminate > 0) return 'indeterminate';
  return 'resisted';
}

export function createEmptyBatchCounts(): BatchCounts {
  return emptyCounts();
}

function normalizeCase(item: BatchCaseInput, progressSource: BatchRunPlanOptions['progress'], issues: BatchPlanIssue[]): BatchCasePlan | undefined {
  const attemptsResult = normalizePositiveInteger(item.requestedAttempts ?? item.repetitions ?? 1);
  if (!attemptsResult.valid || attemptsResult.value > MAX_BATCH_ATTEMPTS) {
    issues.push({ code: 'invalid-case', caseId: item.id, message: `Case ${item.id} requestedAttempts must be a positive safe integer not exceeding ${MAX_BATCH_ATTEMPTS}.` });
    return undefined;
  }
  const requestedAttempts = attemptsResult.value;
  const turns = totalOrProduct(item.plannedTurns, item.turnsPerAttempt, requestedAttempts, issues, item.id, 'planned turns');
  const requests = totalOrProduct(item.plannedRequests, item.requestsPerAttempt ?? item.turnsPerAttempt, requestedAttempts, issues, item.id, 'planned requests');
  const duration = totalOrProduct(item.maximumDurationMs, item.timeoutMs, requestedAttempts, issues, item.id, 'maximum duration');
  const progress = readProgress(progressSource, stableCaseKey(item));
  if (progress?.requestedAttempts !== undefined) {
    const persistedRequested = normalizePositiveInteger(progress.requestedAttempts);
    if (!persistedRequested.valid || persistedRequested.value !== requestedAttempts) issues.push({ code: 'invalid-progress', caseId: item.id, message: `Case ${item.id} progress belongs to a different requested-attempt count.` });
  }
  const completedResult = progress?.completedAttempts === undefined ? normalizeCompletedAttempts(item.completedAttempts, requestedAttempts) : normalizeCompletedAttempts(progress.completedAttempts, requestedAttempts);
  if (!completedResult.valid) issues.push({ code: 'invalid-progress', caseId: item.id, message: `Case ${item.id} completedAttempts is outside 0..${requestedAttempts}.` });
  const completedAttempts = completedResult.valid ? completedResult.value : Math.min(requestedAttempts, Math.max(0, completedResult.value));
  const rawOutcome = progress?.outcome ?? item.outcome ?? item.status;
  const outcome = validOutcome(rawOutcome);
  if (rawOutcome !== undefined && outcome === undefined && rawOutcome !== 'pending' && rawOutcome !== 'running' && rawOutcome !== 'completed' && rawOutcome !== 'cancelled') issues.push({ code: 'invalid-progress', caseId: item.id, message: `Case ${item.id} has an unsupported persisted outcome.` });
  const sampleCompleteValue = progress?.sampleComplete ?? item.sampleComplete;
  if (sampleCompleteValue !== undefined && typeof sampleCompleteValue !== 'boolean') issues.push({ code: 'invalid-progress', caseId: item.id, message: `Case ${item.id} sampleComplete must be boolean.` });
  const sampleComplete = sampleCompleteValue === undefined ? completedAttempts === requestedAttempts : sampleCompleteValue === true && completedAttempts === requestedAttempts;
  const status = normalizeExecutionStatus(progress?.status ?? item.status, completedAttempts, requestedAttempts, sampleComplete);
  const stability = validStability(item.stability);
  const counts = normalizeProgressCounts(progress?.counts, requestedAttempts, issues, item.id);
  return {
    key: stableCaseKey(item),
    id: item.id,
    ...(safeText(item.profileId) ? { profileId: item.profileId } : {}),
    ...(safeText(item.suiteId) ? { suiteId: item.suiteId } : {}),
    tags: safeTags(item.tags),
    requestedAttempts,
    completedAttempts,
    remainingAttempts: requestedAttempts - completedAttempts,
    nextAttempt: safeNextAttempt(completedAttempts),
    plannedTurns: turns,
    plannedRequests: requests,
    maximumDurationMs: duration,
    counts,
    ...(outcome ? { outcome } : {}),
    ...(stability ? { stability } : {}),
    sampleComplete,
    status,
  };
}

function readProgress(source: BatchRunPlanOptions['progress'], key: string): BatchCaseProgressInput | undefined {
  if (!source) return undefined;
  if (isProgress(source)) {
    const found = source.cases.find((item) => item.key === key);
    return found;
  }
  if (source instanceof Map) return source.get(key);
  return (source as Record<string, BatchCaseProgressInput>)[key];
}

function matchesStatus(item: BatchCaseInput, status: BatchFilterStatus): boolean {
  if (status === 'unstable') return item.stability === 'unstable';
  if (status === 'incomplete') return item.sampleComplete === false;
  const outcome = validOutcome(item.outcome ?? item.status);
  return outcome !== undefined && outcome === normalizeFilterOutcome(status);
}

function normalizeFilterOutcome(value: BatchFilterStatus): AdversarialOutcome {
  if (value === 'passed') return 'resisted';
  if (value === 'failed') return 'attackSucceeded';
  if (value === 'error' || value === 'infrastructure-error') return 'infrastructureError';
  if (value === 'inconclusive') return 'indeterminate';
  return value as AdversarialOutcome;
}

function validOutcome(value: unknown): AdversarialOutcome | undefined {
  if (isBatchOutcome(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'passed') return 'resisted';
  if (value === 'failed') return 'attackSucceeded';
  if (value === 'error' || value === 'infrastructure-error') return 'infrastructureError';
  if (value === 'inconclusive') return 'indeterminate';
  return undefined;
}

function normalizeExecutionStatus(value: unknown, completedAttempts: number, requestedAttempts: number, sampleComplete: boolean): BatchExecutionStatus {
  if (value === 'running' || value === 'cancelled') return value;
  if (value === 'pending') return 'pending';
  return completedAttempts >= requestedAttempts && sampleComplete ? 'completed' : 'pending';
}

function validStability(value: unknown): AdversarialStability | undefined {
  return value === 'stable-pass' || value === 'stable-fail' || value === 'unstable' || value === 'inconclusive' ? value : undefined;
}

function totalOrProduct(total: unknown, perAttempt: unknown, attempts: number, issues: BatchPlanIssue[], caseId: string, label: string): number {
  if (total !== undefined) {
    const result = normalizeNonNegativeInteger(total);
    if (!result.valid) issues.push({ code: 'invalid-case', caseId, message: `Case ${caseId} ${label} must be a non-negative safe integer.` });
    return result.value;
  }
  if (perAttempt === undefined) return 0;
  const per = normalizeNonNegativeInteger(perAttempt);
  if (!per.valid) {
    issues.push({ code: 'invalid-case', caseId, message: `Case ${caseId} per-attempt ${label} must be a non-negative safe integer.` });
    return 0;
  }
  const product = per.value * attempts;
  if (!Number.isSafeInteger(product)) {
    issues.push({ code: 'overflow', caseId, message: `Case ${caseId} ${label} exceeds safe numeric bounds.` });
    return Number.MAX_SAFE_INTEGER;
  }
  return product;
}

function normalizePolicyInteger(value: unknown, fallback: number, minimum: number, maximum: number, issues: BatchPlanIssue[], name: string): number {
  if (value === undefined) return fallback;
  const result = normalizePositiveInteger(value);
  if (!result.valid || result.value < minimum || result.value > maximum) {
    issues.push({ code: 'invalid-policy', message: `${name} must be an integer from ${minimum} to ${maximum}.` });
    return fallback;
  }
  return result.value;
}

function normalizeOptionalPolicyInteger(value: unknown, maximum: number, issues: BatchPlanIssue[], name: string): number {
  if (value === undefined) return maximum;
  const result = normalizePositiveInteger(value);
  if (!result.valid || result.value > maximum) {
    issues.push({ code: 'invalid-policy', message: `${name} must be a positive safe integer not exceeding ${maximum}.` });
    return maximum;
  }
  return result.value;
}

function normalizeCompletedAttempts(value: unknown, requestedAttempts: number): { value: number; valid: boolean } {
  if (value === undefined) return { value: 0, valid: true };
  const result = normalizeNonNegativeInteger(value);
  return { value: result.value, valid: result.valid && result.value <= requestedAttempts };
}

function normalizePositiveInteger(value: unknown): { value: number; valid: boolean } {
  return { value: typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 0, valid: typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 };
}

function normalizeNonNegativeInteger(value: unknown): { value: number; valid: boolean } {
  return { value: typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0, valid: typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 };
}

function normalizePlanKey(value: unknown): string | undefined {
  return safeText(value) ? value.trim() : undefined;
}

function derivePlanKey(cases: readonly BatchCasePlan[]): string {
  const material = cases.map((item) => `${item.key}:${item.requestedAttempts}:${item.plannedTurns}:${item.plannedRequests}:${item.maximumDurationMs}`).join('|');
  return `batch:${stableHash(material)}:${cases.length}`;
}

function stableHash(value: string): string {
  let left = 2_166_136_261;
  let right = 1_315_423_911;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16_777_619) >>> 0;
    right = Math.imul(right ^ (code + index), 2_246_822_519) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

function stableCaseKey(item: BatchCaseInput): string {
  if (safeText(item.key)) return item.key!.trim();
  return [safeText(item.profileId) ? item.profileId!.trim() : undefined, safeText(item.suiteId) ? item.suiteId!.trim() : undefined, item.id].filter((segment): segment is string => Boolean(segment)).join('/').slice(0, MAX_BATCH_TEXT_LENGTH);
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_BATCH_TEXT_LENGTH;
}

function safeTags(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => safeText(tag)).map((tag) => tag.trim()))].slice(0, 50);
}

function normalizeProgressCounts(value: Partial<BatchCounts> | undefined, requestedAttempts: number, issues: BatchPlanIssue[], caseId: string): BatchCounts {
  const counts = emptyCounts();
  if (value === undefined) return counts;
  let total = 0;
  for (const outcome of Object.keys(counts) as AdversarialOutcome[]) {
    const raw = value[outcome];
    if (raw === undefined) continue;
    if (!Number.isSafeInteger(raw) || raw < 0) {
      issues.push({ code: 'invalid-progress', caseId, message: `Case ${caseId} contains an invalid ${outcome} count.` });
      continue;
    }
    counts[outcome] = raw;
    if (total > Number.MAX_SAFE_INTEGER - raw) {
      issues.push({ code: 'invalid-progress', caseId, message: `Case ${caseId} outcome counts exceed safe numeric bounds.` });
      total = Number.MAX_SAFE_INTEGER;
    } else total += raw;
  }
  if (total > requestedAttempts) issues.push({ code: 'invalid-progress', caseId, message: `Case ${caseId} outcome counts exceed requestedAttempts.` });
  return counts;
}

function isBatchOutcome(value: unknown): value is AdversarialOutcome {
  return value === 'resisted' || value === 'attackSucceeded' || value === 'indeterminate' || value === 'infrastructureError';
}

function isProgress(value: unknown): value is BatchProgressV1 {
  return Boolean(value && typeof value === 'object' && (value as { format?: unknown }).format === BATCH_PROGRESS_FORMAT);
}

function cloneProgressCases(cases: readonly BatchCaseProgressV1[]): BatchCaseProgressV1[] {
  return cases.map((item) => ({ ...item, counts: { ...item.counts } }));
}

function summarizeProgress(progress: BatchProgressV1): BatchProgressV1 {
  const cases = cloneProgressCases(progress.cases);
  const completedCases = cases.filter((item) => item.completedAttempts >= item.requestedAttempts && item.sampleComplete).length;
  const completedAttempts = cases.reduce((sum, item) => sum + item.completedAttempts, 0);
  return { ...progress, completedCases, completedAttempts, cases };
}

function rejectedTransition(progress: BatchProgressV1, reason: string): BatchProgressTransition {
  return { accepted: false, progress, reason };
}

function safeNextAttempt(completedAttempts: number): number {
  return completedAttempts >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : completedAttempts + 1;
}

function safeAdd(left: number, right: number, issues: BatchPlanIssue[], label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    issues.push({ code: 'overflow', message: `The ${label} total exceeds safe numeric bounds.` });
    return Number.MAX_SAFE_INTEGER;
  }
  return value;
}

function safeSubtractSafeTotal(total: number, perCaseTotal: number, completedAttempts: number, requestedAttempts: number, issues: BatchPlanIssue[], label: string): number {
  if (requestedAttempts <= 0) return total;
  const completedShare = perCaseTotal * (completedAttempts / requestedAttempts);
  if (!Number.isFinite(completedShare)) {
    issues.push({ code: 'overflow', message: `The ${label} total exceeds safe numeric bounds.` });
    return Number.MAX_SAFE_INTEGER;
  }
  const remaining = Math.floor(perCaseTotal - completedShare);
  if (!Number.isFinite(remaining) || remaining < 0) {
    issues.push({ code: 'overflow', message: `The ${label} total exceeds safe numeric bounds.` });
    return Number.MAX_SAFE_INTEGER;
  }
  return safeAdd(total, remaining, issues, label);
}

function emptyCounts(): BatchCounts {
  return { resisted: 0, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 };
}

function emptyTotals(): { plannedAttempts: number; remainingAttempts: number; plannedTurns: number; remainingTurns: number; plannedRequests: number; remainingRequests: number; maximumDurationMs: number; remainingDurationMs: number } {
  return { plannedAttempts: 0, remainingAttempts: 0, plannedTurns: 0, remainingTurns: 0, plannedRequests: 0, remainingRequests: 0, maximumDurationMs: 0, remainingDurationMs: 0 };
}

function uniquePlanIssues(issues: readonly BatchPlanIssue[]): BatchPlanIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.caseId ?? ''}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
