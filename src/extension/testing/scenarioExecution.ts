import type {
  AdversarialAttemptSummary,
  AdversarialOutcome,
  AdversarialRepetitionSummary,
  AdversarialStability,
  AdversarialSuiteDefinition,
  ScenarioCheckResult,
  ScenarioDefinition,
  ScenarioRunGroupRecord,
  ScenarioRunResult,
} from '../../shared/types';
import { createSnapshot } from '../runtime/reducer';
import {
  DEFAULT_ADVERSARIAL_REPETITIONS,
  DEFAULT_ADVERSARIAL_TIMEOUT_MS,
  MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE,
  MAX_ADVERSARIAL_REPETITIONS,
  MAX_ADVERSARIAL_REQUESTS_PER_SUITE,
} from './adversarialSuite';
import { normalizeAdversarialSuite, resolveSuiteDefaultRepetitions } from './adversarialSuite';
import { runScenario, type ScenarioCancellation, type ScenarioSession } from './scenarioRunner';

export const MAX_RUN_PLAN_ATTEMPTS = MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE;
export const MAX_RUN_PLAN_REQUESTS = MAX_ADVERSARIAL_REQUESTS_PER_SUITE;

const OUTCOMES: readonly AdversarialOutcome[] = ['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'];
const OUTCOME_PRIORITY: readonly AdversarialOutcome[] = ['attackSucceeded', 'infrastructureError', 'indeterminate', 'resisted'];

export interface TestSelector {
  profileIds?: readonly string[];
  suiteIds?: readonly string[];
  caseIds?: readonly string[];
  tags?: readonly string[];
  statuses?: ReadonlyArray<AdversarialOutcome | 'failed' | 'inconclusive' | 'infrastructure-error'>;
}

export interface RunPolicy {
  defaultRepetitions: number;
  maxConcurrency: number;
  timeoutMs: number;
  maxRequests?: number;
  maxDurationMs?: number;
  maxAttempts?: number;
  failFast?: boolean;
}

export interface RunPlanContext {
  profileId?: string;
  suiteId?: string;
  /** Previous outcomes used when a selector filters by status. */
  statusByCase?: ReadonlyMap<string, AdversarialOutcome>;
}

export interface RunPlanOptions extends Partial<RunPolicy> {
  policy?: Partial<RunPolicy>;
  selector?: TestSelector;
  context?: RunPlanContext;
  /** One optional opening request per attempt can be included in the bound. */
  openingRequestsPerAttempt?: number;
}

export interface RunPlanIssue {
  code: 'invalid-policy' | 'invalid-repetitions' | 'attempt-cap' | 'request-cap' | 'duration-cap' | 'selection';
  message: string;
  scenarioId?: string;
}

export interface ScenarioPlan {
  scenarioId: string;
  repetitions: number;
  plannedTurns: number;
  maximumRequests: number;
  maximumDurationMs: number;
  timeoutMs: number;
  failFast: boolean;
}

export interface RunPlan {
  selectedCases: number;
  plannedAttempts: number;
  plannedTurns: number;
  maximumRequests: number;
  maximumDurationMs: number;
  maxConcurrency: number;
  cases: ScenarioPlan[];
  issues: RunPlanIssue[];
  valid: boolean;
  withinBudget: boolean;
}

export interface ScenarioAttemptExecution {
  summary: AdversarialAttemptSummary;
  result?: ScenarioRunResult;
}

export interface ScenarioRunGroupResult {
  runId: string;
  profileId: string;
  scenarioId: string;
  requestedAttempts: number;
  completedAttempts: number;
  skippedAttempts: number;
  sampleComplete: boolean;
  outcome: AdversarialOutcome;
  stability: AdversarialStability;
  counts: Record<AdversarialOutcome, number>;
  attempts: ScenarioAttemptExecution[];
  plan: RunPlan;
  result: ScenarioRunResult;
  record: ScenarioRunGroupRecord;
}

export interface ScenarioSessionHandle {
  session: ScenarioSession;
  /** SessionController uses disposeAndWait; tests and adapters may use dispose. */
  dispose?: () => Promise<void> | void;
}

export type ScenarioSessionFactory = (attempt: number) => Promise<ScenarioSession | ScenarioSessionHandle>;

export interface RunScenarioGroupOptions extends RunPlanOptions {
  runId?: string;
  cancellation?: ScenarioCancellation;
  existing?: ScenarioRunGroupRecord;
  onAttemptComplete?: (record: ScenarioRunGroupRecord, attempt: ScenarioAttemptExecution) => Promise<void> | void;
}

/**
 * Build a bounded, side-effect-free preview for Test Explorer and agent tools.
 * A planned request means one fixed user turn. Opening requests can be added
 * explicitly by an adapter because only the adapter knows whether a profile
 * has a request-backed opening.
 */
export function createScenarioRunPlan(scenarios: readonly ScenarioDefinition[], options: RunPlanOptions = {}): RunPlan {
  const policy = resolvePolicy(options);
  const issues: RunPlanIssue[] = [];
  validatePolicy(policy, issues);
  if (options.selector?.profileIds?.length && options.context?.profileId === undefined) issues.push({ code: 'selection', message: 'profileIds selector requires a profile context.' });
  if (options.selector?.suiteIds?.length && options.context?.suiteId === undefined) issues.push({ code: 'selection', message: 'suiteIds selector requires a suite context.' });
  const selected = scenarios.filter((scenario) => matchesSelector(scenario, options.selector, options.context));
  const openingRequests = normalizeNonNegativeInteger(options.openingRequestsPerAttempt, 0);
  const cases: ScenarioPlan[] = [];
  let plannedAttempts = 0;
  let plannedTurns = 0;
  let maximumRequests = 0;
  let maximumDurationMs = 0;

  for (const scenario of selected) {
    const repetitions = scenario.adversarial ? scenario.adversarial.repetitions ?? policy.defaultRepetitions : 1;
    const timeoutMs = scenario.adversarial?.timeoutMs ?? policy.timeoutMs;
    const failFast = scenario.adversarial?.failFast ?? policy.failFast ?? false;
    if (!isValidRepetitions(repetitions)) {
      issues.push({ code: 'invalid-repetitions', scenarioId: scenario.id, message: `Scenario ${scenario.id} repetitions must be an integer from 1 to ${MAX_ADVERSARIAL_REPETITIONS}.` });
      continue;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      issues.push({ code: 'invalid-policy', scenarioId: scenario.id, message: `Scenario ${scenario.id} timeout must be a positive safe integer.` });
      continue;
    }
    const turns = scenario.steps.length;
    const scenarioTurns = safeProduct(repetitions, turns);
    const scenarioRequests = safeProduct(repetitions, turns + openingRequests);
    const scenarioDuration = safeProduct(repetitions, timeoutMs);
    if (scenarioTurns === undefined || scenarioRequests === undefined || scenarioDuration === undefined) {
      issues.push({ code: 'request-cap', scenarioId: scenario.id, message: `Scenario ${scenario.id} exceeds safe planning bounds.` });
      continue;
    }
    cases.push({ scenarioId: scenario.id, repetitions, plannedTurns: scenarioTurns, maximumRequests: scenarioRequests, maximumDurationMs: scenarioDuration, timeoutMs, failFast });
    plannedAttempts = safeAdd(plannedAttempts, repetitions) ?? Number.MAX_SAFE_INTEGER;
    plannedTurns = safeAdd(plannedTurns, scenarioTurns) ?? Number.MAX_SAFE_INTEGER;
    maximumRequests = safeAdd(maximumRequests, scenarioRequests) ?? Number.MAX_SAFE_INTEGER;
    maximumDurationMs = safeAdd(maximumDurationMs, scenarioDuration) ?? Number.MAX_SAFE_INTEGER;
  }

  if (plannedAttempts > MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE) issues.push({ code: 'attempt-cap', message: `The run plans ${plannedAttempts} attempts; the safety cap is ${MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE}.` });
  if (maximumRequests > MAX_ADVERSARIAL_REQUESTS_PER_SUITE) issues.push({ code: 'request-cap', message: `The run plans ${maximumRequests} requests; the safety cap is ${MAX_ADVERSARIAL_REQUESTS_PER_SUITE}.` });
  const maxAttempts = policy.maxAttempts ?? MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE;
  if (Number.isSafeInteger(maxAttempts) && plannedAttempts > maxAttempts) issues.push({ code: 'attempt-cap', message: `The run plans ${plannedAttempts} attempts; the configured cap is ${maxAttempts}.` });
  if (policy.maxRequests !== undefined && maximumRequests > policy.maxRequests) issues.push({ code: 'request-cap', message: `The run plans ${maximumRequests} requests; the configured budget is ${policy.maxRequests}.` });
  if (policy.maxDurationMs !== undefined && maximumDurationMs > policy.maxDurationMs) issues.push({ code: 'duration-cap', message: `The run plans ${maximumDurationMs} ms; the configured budget is ${policy.maxDurationMs} ms.` });

  return {
    selectedCases: cases.length,
    plannedAttempts,
    plannedTurns,
    maximumRequests,
    maximumDurationMs,
    maxConcurrency: policy.maxConcurrency,
    cases,
    issues,
    valid: issues.length === 0,
    withinBudget: !issues.some((issue) => ['attempt-cap', 'request-cap', 'duration-cap'].includes(issue.code)),
  };
}

/** Semantic entry point for callers that have either normalized cases or a suite file model. */
export function createAdversarialRunPlan(input: readonly ScenarioDefinition[] | AdversarialSuiteDefinition, options: RunPlanOptions = {}): RunPlan {
  if (isScenarioList(input)) return createScenarioRunPlan(input, options);
  let scenarios: ScenarioDefinition[];
  try {
    scenarios = normalizeAdversarialSuite(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const plan = createScenarioRunPlan([], options);
    return { ...plan, valid: false, issues: [...plan.issues, { code: 'selection', message }] };
  }
  const suitePolicy = {
    ...(input.runPolicy ?? {}),
    defaultRepetitions: input.runPolicy?.defaultRepetitions ?? resolveSuiteDefaultRepetitions(input),
    ...(input.runPolicy?.maxRequests === undefined && input.defaults?.maxRequests !== undefined ? { maxRequests: input.defaults.maxRequests } : {}),
    ...(input.runPolicy?.maxDurationMs === undefined && input.defaults?.maxDurationMs !== undefined ? { maxDurationMs: input.defaults.maxDurationMs } : {}),
    ...(input.runPolicy?.failFast === undefined && input.defaults?.failFast !== undefined ? { failFast: input.defaults.failFast } : {}),
  };
  return createScenarioRunPlan(scenarios, { ...options, policy: { ...suitePolicy, ...(options.policy ?? {}) } });
}

export const planAdversarialSuite = createAdversarialRunPlan;

/**
 * Execute one case as a sequence of isolated attempts. The session factory is
 * called only at an attempt boundary, and its session is disposed before the
 * next factory call. A cancelled active attempt is recorded as indeterminate
 * by runScenario and no new attempt is started.
 */
export async function runScenarioGroup(profileId: string, scenario: ScenarioDefinition, createSession: ScenarioSessionFactory, options: RunScenarioGroupOptions = {}): Promise<ScenarioRunGroupResult> {
  const plan = createScenarioRunPlan([scenario], options);
  if (!plan.valid) throw new Error(plan.issues.map((issue) => issue.message).join('\n'));
  const casePlan = plan.cases[0];
  if (!casePlan) throw new Error(`Scenario ${scenario.id} was not selected for execution.`);
  const existing = options.existing;
  if (existing && (existing.profileId !== profileId || existing.scenarioId !== scenario.id || existing.requestedAttempts > casePlan.repetitions)) throw new Error('The saved run group does not match the current scenario plan.');

  const runId = existing?.id ?? options.runId ?? crypto.randomUUID();
  const attempts: ScenarioAttemptExecution[] = (existing?.attempts ?? []).map((attempt) => ({ summary: structuredClone(attempt) }));
  const alreadyCompleted = attempts.length;
  if (alreadyCompleted > casePlan.repetitions) throw new Error('The saved run group contains more attempts than the current plan.');
  if (attempts.some((attempt, index) => attempt.summary.attempt !== index + 1)) throw new Error('The saved run group contains non-contiguous attempt boundaries.');
  let sampleComplete = alreadyCompleted >= casePlan.repetitions && !options.cancellation?.isCancellationRequested;

  for (let attemptNumber = alreadyCompleted + 1; attemptNumber <= casePlan.repetitions; attemptNumber++) {
    if (options.cancellation?.isCancellationRequested) { sampleComplete = false; break; }
    const startedAt = Date.now();
    let handle: ScenarioSessionHandle | undefined;
    let result: ScenarioRunResult;
    try {
      const created = await createSession(attemptNumber);
      handle = isSessionHandle(created) ? created : { session: created };
      result = await runScenario(profileId, scenario, handle.session, options.cancellation);
    } catch (error) {
      result = infrastructureResult(profileId, scenario, error);
    } finally {
      await disposeHandle(handle);
    }
    const completedAt = Date.now();
    const outcome = outcomeOf(result);
    const summary: AdversarialAttemptSummary = {
      attempt: attemptNumber,
      outcome,
      durationMs: result.durationMs || Math.max(0, completedAt - startedAt),
      attemptedTurns: result.adversarial?.attemptedTurns ?? result.steps.length,
      completedTurns: result.adversarial?.completedTurns ?? result.steps.length,
      startedAt,
      completedAt,
    };
    const execution: ScenarioAttemptExecution = { summary, result };
    attempts.push(execution);
    const current = aggregateAttempts(attempts.map((item) => item.summary), casePlan.repetitions, attempts.length >= casePlan.repetitions);
    await options.onAttemptComplete?.(toRunGroupRecord(runId, profileId, scenario, casePlan, current, attempts, startedAt), execution);
    if (options.cancellation?.isCancellationRequested) { sampleComplete = false; break; }
    if (casePlan.failFast && outcome === 'attackSucceeded') { sampleComplete = false; break; }
  }

  sampleComplete = sampleComplete || attempts.length >= casePlan.repetitions;
  const aggregate = aggregateAttempts(attempts.map((item) => item.summary), casePlan.repetitions, sampleComplete);
  const representative = representativeResult(attempts) ?? projectionResult(profileId, scenario, aggregate.outcome);
  const aggregateCheck = repetitionCheck(aggregate);
  const result: ScenarioRunResult = {
    ...representative,
    passed: aggregate.outcome === 'resisted' && aggregate.sampleComplete,
    checks: [...representative.checks, aggregateCheck],
    repetitions: aggregate,
    ...(representative.adversarial ? { adversarial: { ...representative.adversarial, outcome: aggregate.outcome } } : {}),
  };
  const record = toRunGroupRecord(runId, profileId, scenario, casePlan, aggregate, attempts, Date.now());
  return {
    runId,
    profileId,
    scenarioId: scenario.id,
    requestedAttempts: aggregate.requestedAttempts,
    completedAttempts: aggregate.completedAttempts,
    skippedAttempts: aggregate.skippedAttempts,
    sampleComplete: aggregate.sampleComplete,
    outcome: aggregate.outcome,
    stability: aggregate.stability,
    counts: aggregate.counts,
    attempts,
    plan,
    result,
    record,
  };
}

export const executeScenarioGroup = runScenarioGroup;

export function aggregateAttempts(attempts: readonly AdversarialAttemptSummary[], requestedAttempts: number, sampleComplete: boolean): AdversarialRepetitionSummary {
  const counts = emptyCounts();
  for (const attempt of attempts) if (isOutcome(attempt.outcome)) counts[attempt.outcome] += 1;
  const outcome = counts.attackSucceeded > 0
    ? 'attackSucceeded'
    : counts.infrastructureError > 0
      ? 'infrastructureError'
      : counts.indeterminate > 0 || !sampleComplete || attempts.length < requestedAttempts
        ? 'indeterminate'
        : 'resisted';
  const complete = sampleComplete && attempts.length >= requestedAttempts;
  const stability = classifyStability(counts, requestedAttempts, complete);
  return {
    requestedAttempts,
    completedAttempts: attempts.length,
    skippedAttempts: Math.max(0, requestedAttempts - attempts.length),
    sampleComplete: complete,
    outcome,
    stability,
    counts,
    attempts: attempts.map((attempt) => structuredClone(attempt)),
  };
}

export function classifyStability(counts: Record<AdversarialOutcome, number>, requestedAttempts: number, sampleComplete: boolean): AdversarialStability {
  if (!sampleComplete || counts.infrastructureError > 0 || counts.indeterminate > 0) return 'inconclusive';
  if (counts.attackSucceeded === requestedAttempts) return 'stable-fail';
  if (counts.attackSucceeded > 0) return 'unstable';
  return 'stable-pass';
}

function resolvePolicy(options: RunPlanOptions): RunPolicy {
  const source = options.policy ?? options;
  return {
    defaultRepetitions: source.defaultRepetitions ?? DEFAULT_ADVERSARIAL_REPETITIONS,
    maxConcurrency: source.maxConcurrency ?? 3,
    timeoutMs: source.timeoutMs ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS,
    maxRequests: source.maxRequests,
    maxDurationMs: source.maxDurationMs,
    maxAttempts: source.maxAttempts,
    failFast: source.failFast,
  };
}

function validatePolicy(policy: RunPolicy, issues: RunPlanIssue[]): void {
  if (!isValidRepetitions(policy.defaultRepetitions)) issues.push({ code: 'invalid-policy', message: `defaultRepetitions must be an integer from 1 to ${MAX_ADVERSARIAL_REPETITIONS}.` });
  if (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency < 1 || policy.maxConcurrency > 8) issues.push({ code: 'invalid-policy', message: 'maxConcurrency must be an integer from 1 to 8.' });
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1) issues.push({ code: 'invalid-policy', message: 'timeoutMs must be a positive safe integer.' });
  for (const [name, value] of [['maxRequests', policy.maxRequests], ['maxDurationMs', policy.maxDurationMs], ['maxAttempts', policy.maxAttempts]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) issues.push({ code: 'invalid-policy', message: `${name} must be a positive safe integer.` });
  }
  if (policy.maxAttempts !== undefined && policy.maxAttempts > MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE) issues.push({ code: 'invalid-policy', message: `maxAttempts cannot exceed ${MAX_ADVERSARIAL_ATTEMPTS_PER_SUITE}.` });
  if (policy.maxRequests !== undefined && policy.maxRequests > MAX_ADVERSARIAL_REQUESTS_PER_SUITE) issues.push({ code: 'invalid-policy', message: `maxRequests cannot exceed ${MAX_ADVERSARIAL_REQUESTS_PER_SUITE}.` });
  if (policy.failFast !== undefined && typeof policy.failFast !== 'boolean') issues.push({ code: 'invalid-policy', message: 'failFast must be boolean.' });
}

function matchesSelector(scenario: ScenarioDefinition, selector: TestSelector | undefined, context: RunPlanContext | undefined): boolean {
  if (!selector) return true;
  if (selector.profileIds?.length && context?.profileId !== undefined && !selector.profileIds.includes(context.profileId)) return false;
  if (selector.profileIds?.length && context?.profileId === undefined) return false;
  if (selector.suiteIds?.length && context?.suiteId !== undefined && !selector.suiteIds.includes(context.suiteId)) return false;
  if (selector.suiteIds?.length && context?.suiteId === undefined) return false;
  if (selector.caseIds?.length && !selector.caseIds.includes(scenario.id)) return false;
  if (selector.tags?.length && !selector.tags.every((tag) => scenario.tags?.includes(tag))) return false;
  if (selector.statuses?.length) {
    const outcome = context?.statusByCase?.get(scenario.id);
    if (!outcome) return false;
    const statuses = selector.statuses.map(normalizeStatus);
    if (!statuses.includes(outcome)) return false;
  }
  return true;
}

function normalizeStatus(value: AdversarialOutcome | 'failed' | 'inconclusive' | 'infrastructure-error'): AdversarialOutcome {
  if (value === 'failed') return 'attackSucceeded';
  if (value === 'inconclusive') return 'indeterminate';
  if (value === 'infrastructure-error') return 'infrastructureError';
  return value as AdversarialOutcome;
}

function representativeResult(attempts: readonly ScenarioAttemptExecution[]): ScenarioRunResult | undefined {
  for (const outcome of OUTCOME_PRIORITY) {
    const selected = attempts.find((attempt) => attempt.summary.outcome === outcome && attempt.result);
    if (selected?.result) return selected.result;
  }
  return attempts.find((attempt) => attempt.result)?.result;
}

function outcomeOf(result: ScenarioRunResult): AdversarialOutcome {
  if (result.adversarial?.outcome) return result.adversarial.outcome;
  return result.passed ? 'resisted' : 'infrastructureError';
}

function infrastructureResult(profileId: string, scenario: ScenarioDefinition, error: unknown): ScenarioRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const snapshot = createSnapshot(false);
  snapshot.sessionState = 'failed';
  snapshot.turnState = 'failed';
  snapshot.errors.push({ type: 'InfrastructureError', message });
  const issue: ScenarioCheckResult = { id: 'infrastructure-execution', label: message, passed: false, kind: 'adversarial', actual: 'infrastructureError', expected: 'complete evidence', location: { kind: 'profile', path: 'tests.scenarios' } };
  return {
    scenarioId: scenario.id,
    passed: false,
    durationMs: 0,
    steps: [],
    checks: [issue],
    adversarial: { outcome: 'infrastructureError', attemptedTurns: 0, completedTurns: 0, plannedTurns: scenario.steps.length, maxTurns: scenario.adversarial?.maxTurns ?? scenario.steps.length, timeoutMs: scenario.adversarial?.timeoutMs ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS, findings: [], issues: [{ id: 'infrastructure-execution', kind: 'infrastructure', label: message, location: { kind: 'profile', path: 'tests.scenarios' } }] },
    evidence: { profileId, scenarioId: scenario.id, snapshot, networkEntries: [] },
  };
}

function projectionResult(profileId: string, scenario: ScenarioDefinition, outcome: AdversarialOutcome): ScenarioRunResult {
  const snapshot = createSnapshot(false);
  const issue = outcome === 'resisted' ? undefined : {
    id: 'adversarial-repetition-incomplete',
    kind: outcome === 'infrastructureError' ? 'infrastructure' as const : 'indeterminate' as const,
    label: 'No in-memory attempt evidence is available for this resumed run group.',
    location: { kind: 'profile' as const, path: 'tests.adversarial.repetitions' },
  };
  return {
    scenarioId: scenario.id,
    passed: outcome === 'resisted',
    durationMs: 0,
    steps: [],
    checks: issue ? [{ id: issue.id, label: issue.label, passed: false, kind: 'adversarial', actual: outcome, expected: 'complete evidence', location: issue.location }] : [],
    adversarial: { outcome, attemptedTurns: 0, completedTurns: 0, plannedTurns: scenario.steps.length, maxTurns: scenario.adversarial?.maxTurns ?? scenario.steps.length, timeoutMs: scenario.adversarial?.timeoutMs ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS, findings: [], issues: issue ? [issue] : [] },
    evidence: { profileId, scenarioId: scenario.id, snapshot, networkEntries: [] },
  };
}

function repetitionCheck(summary: AdversarialRepetitionSummary): ScenarioCheckResult {
  return {
    id: 'adversarial-repetition-aggregate',
    label: `Repeated adversarial attempts: ${summary.outcome} (${summary.completedAttempts}/${summary.requestedAttempts}; ${summary.stability}).`,
    passed: summary.outcome === 'resisted' && summary.sampleComplete,
    kind: 'adversarial',
    actual: { outcome: summary.outcome, stability: summary.stability, counts: summary.counts, sampleComplete: summary.sampleComplete },
    expected: 'all requested attempts resisted',
    location: { kind: 'profile', path: 'tests.adversarial.repetitions' },
  };
}

function toRunGroupRecord(runId: string, profileId: string, scenario: ScenarioDefinition, casePlan: ScenarioPlan, aggregate: AdversarialRepetitionSummary, attempts: readonly ScenarioAttemptExecution[], updatedAt: number): ScenarioRunGroupRecord {
  const createdAt = attempts[0]?.summary.startedAt ?? updatedAt;
  return {
    format: 'turnstage-run-group',
    version: 1,
    id: runId,
    profileId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    createdAt,
    updatedAt,
    requestedAttempts: aggregate.requestedAttempts,
    completedAttempts: aggregate.completedAttempts,
    plannedTurns: casePlan.plannedTurns,
    plannedRequests: casePlan.maximumRequests,
    maximumDurationMs: casePlan.maximumDurationMs,
    sampleComplete: aggregate.sampleComplete,
    outcome: aggregate.outcome,
    stability: aggregate.stability,
    counts: structuredClone(aggregate.counts),
    attempts: aggregate.attempts,
  };
}

function emptyCounts(): Record<AdversarialOutcome, number> { return { resisted: 0, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 }; }
function isOutcome(value: unknown): value is AdversarialOutcome { return typeof value === 'string' && OUTCOMES.includes(value as AdversarialOutcome); }
function isValidRepetitions(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_ADVERSARIAL_REPETITIONS; }
function normalizeNonNegativeInteger(value: unknown, fallback: number): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback; }
function safeAdd(left: number, right: number): number | undefined { const value = left + right; return Number.isSafeInteger(value) ? value : undefined; }
function safeProduct(left: number, right: number): number | undefined { const value = left * right; return Number.isSafeInteger(value) ? value : undefined; }
function isSessionHandle(value: ScenarioSession | ScenarioSessionHandle): value is ScenarioSessionHandle { return Boolean(value && typeof value === 'object' && 'session' in value); }
function isScenarioList(value: readonly ScenarioDefinition[] | AdversarialSuiteDefinition): value is readonly ScenarioDefinition[] { return Array.isArray(value); }
async function disposeHandle(handle: ScenarioSessionHandle | undefined): Promise<void> {
  if (!handle) return;
  if (handle.dispose) { await handle.dispose(); return; }
  const disposable = handle.session as ScenarioSession & { disposeAndWait?: () => Promise<void>; dispose?: () => void };
  if (disposable.disposeAndWait) await disposable.disposeAndWait();
  else disposable.dispose?.();
}

export type { ScenarioCancellation, ScenarioSession } from './scenarioRunner';
