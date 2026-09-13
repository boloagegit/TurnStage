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
  if (!input.cases.length || input.cases.length > 500) throw new Error('A recorded test run must contain between 1 and 500 cases.');
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

export function nonPassingCases(run: TestRunHistoryRecord): TestCaseIdentity[] {
  return run.cases.filter((item) => !['passed', 'resisted'].includes(item.outcome ?? '') || item.completedAttempts < item.requestedAttempts)
    .map(({ profileId, suiteId, scenarioId, kind }) => ({ profileId, suiteId, scenarioId, kind }));
}

/** Clear one test type without removing the other type from mixed history records. */
export function clearTestRunHistoryKind(runs: readonly TestRunHistoryRecord[], kind: TestCaseIdentity['kind'], baselineRunId?: string): { runs: TestRunHistoryRecord[]; baselineRunId?: string } {
  const retained = runs.flatMap((run) => {
    const cases = run.cases.filter((item) => item.kind !== kind);
    return cases.length ? [{ ...run, cases }] : [];
  });
  return { runs: retained, ...(baselineRunId && retained.some((run) => run.id === baselineRunId) ? { baselineRunId } : {}) };
}

function comparisonConfiguration(profile: unknown): unknown {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
  const value = profile as Record<string, unknown>;
  const tests = value.tests;
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) return profile;
  const settings = Object.fromEntries(Object.entries(tests as Record<string, unknown>).filter(([key]) => !['scenarios', 'contractSuites', 'adversarialSuites', 'campaigns'].includes(key)));
  return { ...value, tests: settings };
}

export type TestRunDifference = 'new-failure' | 'recovered' | 'still-failing' | 'new-case' | 'removed-case' | 'definition-changed' | 'configuration-changed' | 'infrastructure-error' | 'indeterminate' | 'incomplete' | 'unchanged';

export function compareTestRuns(baseline: TestRunHistoryRecord, current: TestRunHistoryRecord): Array<{ key: string; difference: TestRunDifference }> {
  const before = new Map(baseline.cases.map((item) => [item.key, item]));
  const after = new Map(current.cases.map((item) => [item.key, item]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((key) => {
    const oldCase = before.get(key);
    const newCase = after.get(key);
    if (!oldCase) return { key, difference: 'new-case' };
    if (!newCase) return { key, difference: 'removed-case' };
    if (oldCase.definitionDigest !== newCase.definitionDigest || baseline.evaluatorVersion !== current.evaluatorVersion) return { key, difference: 'definition-changed' };
    if (baseline.profileDigest !== current.profileDigest || (oldCase.environmentDigest ?? baseline.environmentDigest) !== (newCase.environmentDigest ?? current.environmentDigest)) return { key, difference: 'configuration-changed' };
    if (!oldCase.outcome || !newCase.outcome || oldCase.completedAttempts !== oldCase.requestedAttempts || newCase.completedAttempts !== newCase.requestedAttempts) return { key, difference: 'incomplete' };
    if (oldCase.outcome === 'error' || newCase.outcome === 'error' || oldCase.outcome === 'infrastructureError' || newCase.outcome === 'infrastructureError') return { key, difference: 'infrastructure-error' };
    if (oldCase.outcome === 'indeterminate' || newCase.outcome === 'indeterminate') return { key, difference: 'indeterminate' };
    const oldPass = oldCase.outcome === 'passed' || oldCase.outcome === 'resisted';
    const newPass = newCase.outcome === 'passed' || newCase.outcome === 'resisted';
    if (oldPass && !newPass) return { key, difference: 'new-failure' };
    if (!oldPass && newPass) return { key, difference: 'recovered' };
    if (!oldPass && !newPass) return { key, difference: 'still-failing' };
    return { key, difference: 'unchanged' };
  });
}
