import type { ScenarioDefinition } from './types';
import type { TestCaseIdentity } from './testSelection';
import { testCaseKey } from './testSelection';
import { digestValue } from '../extension/testing/provenance';
import { redactKnownSecrets } from './redaction';

export const TEST_RUN_HISTORY_FORMAT = 'turnstage-test-run-history' as const;
export const TEST_RUN_HISTORY_VERSION = 1 as const;
export const TEST_EVALUATOR_VERSION = 1 as const;
export type TestRunOutcome = 'passed' | 'failed' | 'error' | 'resisted' | 'attackSucceeded' | 'indeterminate' | 'infrastructureError';

export interface TestRunCaseRecord extends TestCaseIdentity {
  key: string;
  name: string;
  definitionDigest: string;
  environmentDigest: string;
  requestedAttempts: number;
  completedAttempts: number;
  outcome?: TestRunOutcome;
  durationMs?: number;
  /** Evidence may expire independently of this metadata-only record. */
  evidenceId?: string;
  /** Transient host availability; never required in stored history. */
  evidenceAvailable?: boolean;
}

export interface TestRunHistoryRecord {
  format: typeof TEST_RUN_HISTORY_FORMAT;
  version: typeof TEST_RUN_HISTORY_VERSION;
  id: string;
  profileId: string;
  startedAt: number;
  finishedAt: number;
  status: 'completed' | 'cancelled' | 'failed';
  runner: 'web' | 'vscode' | 'cli';
  evaluatorVersion: typeof TEST_EVALUATOR_VERSION;
  profileDigest: string;
  environmentDigest: string;
  sourceRunId?: string;
  cases: TestRunCaseRecord[];
}

export interface PlannedTestRunCase extends TestCaseIdentity {
  name: string;
  scenario: ScenarioDefinition;
  environment?: unknown;
}

export interface CompletedTestRunCase extends TestCaseIdentity {
  outcome: TestRunOutcome;
  completedAttempts: number;
  durationMs: number;
  evidenceId?: string;
}

export function createTestRunHistoryRecord(input: {
  id: string;
  profileId: string;
  startedAt: number;
  finishedAt: number;
  status: TestRunHistoryRecord['status'];
  runner: TestRunHistoryRecord['runner'];
  profile: unknown;
  environment: unknown;
  cases: readonly PlannedTestRunCase[];
  completed: readonly CompletedTestRunCase[];
  sourceRunId?: string;
  secretValues?: readonly unknown[];
}): TestRunHistoryRecord {
  if (!input.cases.length) throw new Error('A recorded test run must contain at least one case.');
  const completed = new Map(input.completed.map((item) => [testCaseKey(item), item]));
  if (completed.size !== input.completed.length) throw new Error('The completed results contain duplicate case identities.');
  const cases = input.cases.map((item): TestRunCaseRecord => {
    const key = testCaseKey(item);
    const result = completed.get(key);
    return {
      profileId: item.profileId,
      suiteId: item.suiteId,
      scenarioId: item.scenarioId,
      kind: item.kind,
      key,
      name: String(redactKnownSecrets(item.name, input.secretValues ?? [])).slice(0, 512),
      definitionDigest: digestValue(item.scenario, { secretValues: input.secretValues, redactPayloads: true }),
      environmentDigest: digestValue(item.environment ?? input.environment, { secretValues: input.secretValues, redactPayloads: true }),
      requestedAttempts: item.scenario.adversarial?.repetitions ?? 1,
      completedAttempts: result?.completedAttempts ?? 0,
      ...(result ? { outcome: result.outcome, durationMs: result.durationMs, ...(result.evidenceId ? { evidenceId: result.evidenceId } : {}) } : {}),
    };
  });
  if (new Set(cases.map((item) => item.key)).size !== cases.length) throw new Error('The run selection contains duplicate case identities.');
  const complete = cases.every((item) => item.outcome !== undefined && item.completedAttempts === item.requestedAttempts);
  return {
    format: TEST_RUN_HISTORY_FORMAT,
    version: TEST_RUN_HISTORY_VERSION,
    id: input.id,
    profileId: input.profileId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status === 'completed' && !complete ? 'cancelled' : input.status,
    runner: input.runner,
    evaluatorVersion: TEST_EVALUATOR_VERSION,
    profileDigest: digestValue(comparisonConfiguration(input.profile), { secretValues: input.secretValues, redactPayloads: true }),
    environmentDigest: digestValue(input.environment, { secretValues: input.secretValues, redactPayloads: true }),
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    cases,
  };
}

/**
 * Digest of a case definition as recorded in run history. Hosts that know secret values also scrub them first;
 * a case that embeds a secret then reads as changed, which only prompts a rerun.
 */
export function caseDefinitionDigest(scenario: unknown): string { return digestValue(scenario, { redactPayloads: true }); }

export function nonPassingCases(run: TestRunHistoryRecord): TestCaseIdentity[] {
  return run.cases.filter((item) => !['passed', 'resisted'].includes(item.outcome ?? '') || item.completedAttempts < item.requestedAttempts)
    .map(({ profileId, suiteId, scenarioId, kind }) => ({ profileId, suiteId, scenarioId, kind }));
}

export function unfinishedCases(run: TestRunHistoryRecord): TestCaseIdentity[] {
  return run.cases.filter((item) => item.outcome === undefined || item.completedAttempts < item.requestedAttempts)
    .map(({ profileId, suiteId, scenarioId, kind }) => ({ profileId, suiteId, scenarioId, kind }));
}

/** Accepted baseline run per test type. General tests and Red Team are compared with their own baseline. */
export type TestBaselineIds = Partial<Record<TestCaseIdentity['kind'], string>>;

/** Accepting a run replaces the baseline only for the test types it contains. */
export function acceptTestBaseline(current: TestBaselineIds, run: TestRunHistoryRecord): TestBaselineIds {
  const next = { ...current };
  for (const item of run.cases) next[item.kind] = run.id;
  return next;
}

/**
 * Reads stored baselines, including the single run ID earlier versions kept for both test types, and keeps only
 * baselines whose run is still retained and still contains cases of that type.
 */
export function normalizeTestBaselines(value: unknown, runs: readonly TestRunHistoryRecord[]): TestBaselineIds {
  const result: TestBaselineIds = {};
  for (const kind of ['contract', 'adversarial'] as const) {
    const runId = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>)[kind] : undefined;
    if (typeof runId === 'string' && runs.some((run) => run.id === runId && run.cases.some((item) => item.kind === kind))) result[kind] = runId;
  }
  return result;
}

/** Most recent runs kept in history, plus older runs that still hold a baseline or a case's latest result. */
export const RECENT_TEST_RUNS = 20;
export const MAX_RETAINED_TEST_RUNS = 60;

/**
 * Chooses which runs to keep. Rerunning single cases creates one run each, so trimming by recency alone would
 * drop every other case's latest result after 20 reruns; runs that hold a case's latest result are kept too,
 * up to a fixed bound. `runs` must be newest first.
 */
export function selectRetainedTestRuns(runs: readonly TestRunHistoryRecord[], baselines: TestBaselineIds): TestRunHistoryRecord[] {
  const keep = new Set(runs.slice(0, RECENT_TEST_RUNS).map((run) => run.id));
  for (const id of baselineRunIdList(baselines)) keep.add(id);
  const seen = new Set<string>();
  for (const run of runs) {
    let holdsLatest = false;
    for (const item of run.cases) {
      if (!item.outcome || seen.has(item.key)) continue;
      seen.add(item.key);
      holdsLatest = true;
    }
    if (holdsLatest && keep.size < MAX_RETAINED_TEST_RUNS) keep.add(run.id);
  }
  return runs.filter((run) => keep.has(run.id));
}

export function baselineRunIdList(baselines: TestBaselineIds): string[] { return [...new Set(Object.values(baselines).filter((value): value is string => Boolean(value)))]; }

/** Clear one test type without removing the other type from mixed history records. */
export function clearTestRunHistoryKind(runs: readonly TestRunHistoryRecord[], kind: TestCaseIdentity['kind'], baselines: TestBaselineIds = {}): { runs: TestRunHistoryRecord[]; baselines: TestBaselineIds } {
  const retained = runs.flatMap((run) => {
    const cases = run.cases.filter((item) => item.kind !== kind);
    return cases.length ? [{ ...run, cases }] : [];
  });
  return { runs: retained, baselines: normalizeTestBaselines({ ...baselines, [kind]: undefined }, retained) };
}

/** Profile fields that do not change how a case executes; editing them must not mark every result as settings-changed. */
const PRESENTATION_ONLY_PROFILE_FIELDS = new Set(['name', 'description', 'ui', 'history']);

function comparisonConfiguration(profile: unknown): unknown {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
  const value = Object.fromEntries(Object.entries(profile as Record<string, unknown>).filter(([key]) => !PRESENTATION_ONLY_PROFILE_FIELDS.has(key)));
  const tests = value.tests;
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) return value;
  const settings = Object.fromEntries(Object.entries(tests as Record<string, unknown>).filter(([key]) => !['scenarios', 'contractSuites', 'adversarialSuites', 'campaigns'].includes(key)));
  return { ...value, tests: settings };
}

export type TestRunDifference = 'new-failure' | 'recovered' | 'still-failing' | 'new-case' | 'removed-case' | 'definition-changed' | 'configuration-changed' | 'infrastructure-error' | 'indeterminate' | 'incomplete' | 'unchanged';

export interface TestRunComparison {
  key: string;
  difference: TestRunDifference;
  /** Set when the case definition or its settings changed; shown beside an outcome difference instead of hiding it. */
  changed?: 'definition' | 'configuration';
}

export function compareTestRuns(baseline: TestRunHistoryRecord, current: TestRunHistoryRecord): TestRunComparison[] {
  const before = new Map(baseline.cases.map((item) => [item.key, item]));
  const after = new Map(current.cases.map((item) => [item.key, item]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((key): TestRunComparison => {
    const oldCase = before.get(key);
    const newCase = after.get(key);
    if (!oldCase) return { key, difference: 'new-case' };
    if (!newCase) return { key, difference: 'removed-case' };
    const changed = oldCase.definitionDigest !== newCase.definitionDigest || baseline.evaluatorVersion !== current.evaluatorVersion
      ? 'definition'
      : baseline.profileDigest !== current.profileDigest || (oldCase.environmentDigest ?? baseline.environmentDigest) !== (newCase.environmentDigest ?? current.environmentDigest) ? 'configuration' : undefined;
    const difference = outcomeDifference(oldCase, newCase);
    if (difference === 'unchanged' && changed) return { key, difference: changed === 'definition' ? 'definition-changed' : 'configuration-changed' };
    return changed ? { key, difference, changed } : { key, difference };
  });
}

function outcomeDifference(oldCase: TestRunCaseRecord, newCase: TestRunCaseRecord): TestRunDifference {
  if (!oldCase.outcome || !newCase.outcome || oldCase.completedAttempts !== oldCase.requestedAttempts || newCase.completedAttempts !== newCase.requestedAttempts) return 'incomplete';
  if (oldCase.outcome === 'error' || newCase.outcome === 'error' || oldCase.outcome === 'infrastructureError' || newCase.outcome === 'infrastructureError') return 'infrastructure-error';
  if (oldCase.outcome === 'indeterminate' || newCase.outcome === 'indeterminate') return 'indeterminate';
  const oldPass = oldCase.outcome === 'passed' || oldCase.outcome === 'resisted';
  const newPass = newCase.outcome === 'passed' || newCase.outcome === 'resisted';
  if (oldPass && !newPass) return 'new-failure';
  if (!oldPass && newPass) return 'recovered';
  if (!oldPass && !newPass) return 'still-failing';
  return 'unchanged';
}
