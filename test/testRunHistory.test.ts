import { describe, expect, it } from 'vitest';
import { acceptTestBaseline, caseDefinitionDigest, clearTestRunHistoryKind, compareTestRuns, createTestRunHistoryRecord, MAX_RETAINED_TEST_RUNS, nonPassingCases, normalizeTestBaselines, selectRetainedTestRuns } from '../src/shared/testRunHistory';

const scenario = { id: 'same', name: 'Case', steps: [{ id: 'turn', input: 'private-token' }] };
const identity = { profileId: 'profile', scenarioId: 'same', kind: 'contract' as const };

function record(id: string, outcome: 'passed' | 'failed' | 'error' | 'indeterminate' | 'infrastructureError', input = scenario, environment: unknown = { target: 'sit', token: 'private-token' }) {
  return createTestRunHistoryRecord({
    id, profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web',
    profile: { id: 'profile', token: 'private-token' }, environment, secretValues: ['private-token'],
    cases: [{ ...identity, name: `Case private-token`, scenario: input }],
    completed: [{ ...identity, outcome, completedAttempts: 1, durationMs: 10 }],
  });
}

describe('test run history', () => {
  it('stores only metadata and digests, not prompts or secret values', () => {
    const value = record('one', 'passed');
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('target');
    expect(value.cases[0]).toMatchObject({ outcome: 'passed', completedAttempts: 1 });
  });

  it('classifies a regression and recovery only for comparable runs', () => {
    expect(compareTestRuns(record('base', 'passed'), record('new', 'failed'))[0]?.difference).toBe('new-failure');
    expect(compareTestRuns(record('base', 'failed'), record('new', 'passed'))[0]?.difference).toBe('recovered');
    expect(compareTestRuns(record('base', 'passed'), record('new', 'passed', scenario, { target: 'uat' }))[0]?.difference).toBe('configuration-changed');
    expect(compareTestRuns(record('base', 'passed'), record('new', 'passed', { ...scenario, steps: [{ id: 'turn', input: 'changed' }] }))[0]?.difference).toBe('definition-changed');
    expect(compareTestRuns(record('base', 'passed'), record('new', 'error'))[0]?.difference).toBe('infrastructure-error');
    expect(compareTestRuns(record('base', 'indeterminate'), record('new', 'passed'))[0]?.difference).toBe('indeterminate');
  });

  it('does not mistake unrelated case edits for a changed execution configuration', () => {
    const make = (otherName: string) => createTestRunHistoryRecord({
      id: otherName, profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web' as const,
      profile: { id: 'profile', conversation: { endpoint: '/chat' }, tests: { scenarios: [{ id: 'other', name: otherName }] } },
      environment: { id: 'sit' },
      cases: [{ ...identity, name: 'Case', scenario }],
      completed: [{ ...identity, outcome: 'passed' as const, completedAttempts: 1, durationMs: 10 }],
    });
    expect(compareTestRuns(make('Before'), make('After'))[0]?.difference).toBe('unchanged');
  });

  it('compares each case against the environments it actually used', () => {
    const make = (id: string, environment: unknown, includeOther: boolean) => createTestRunHistoryRecord({
      id, profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'vscode' as const,
      profile: { id: 'profile' }, environment: [environment, { id: 'unrelated' }],
      cases: [{ ...identity, name: 'Case', scenario, environment }, ...(includeOther ? [{ ...identity, scenarioId: 'other', name: 'Other', scenario: { ...scenario, id: 'other' }, environment: { id: 'unrelated' } }] : [])],
      completed: [{ ...identity, outcome: 'passed' as const, completedAttempts: 1, durationMs: 10 }, ...(includeOther ? [{ ...identity, scenarioId: 'other', outcome: 'passed' as const, completedAttempts: 1, durationMs: 10 }] : [])],
    });
    const baseline = make('baseline', { id: 'sit', variables: { revision: 'one' } }, true);
    const same = make('same', { id: 'sit', variables: { revision: 'one' } }, false);
    const changed = make('changed', { id: 'sit', variables: { revision: 'two' } }, false);
    expect(compareTestRuns(baseline, same).find((item) => item.key === baseline.cases[0]?.key)?.difference).toBe('unchanged');
    expect(compareTestRuns(baseline, changed).find((item) => item.key === baseline.cases[0]?.key)?.difference).toBe('configuration-changed');
    expect(compareTestRuns(baseline, same).some((item) => item.difference === 'removed-case')).toBe(true);
  });

  it('keeps a new failure visible when the case or its settings also changed', () => {
    expect(compareTestRuns(record('base', 'passed'), record('new', 'failed', scenario, { target: 'uat' }))[0]).toMatchObject({ difference: 'new-failure', changed: 'configuration' });
    expect(compareTestRuns(record('base', 'passed'), record('new', 'failed', { ...scenario, steps: [{ id: 'turn', input: 'changed' }] }))[0]).toMatchObject({ difference: 'new-failure', changed: 'definition' });
    expect(compareTestRuns(record('base', 'failed'), record('new', 'passed', scenario, { target: 'uat' }))[0]).toMatchObject({ difference: 'recovered', changed: 'configuration' });
  });

  it('ignores Profile name, description, and presentation edits when comparing settings', () => {
    const make = (id: string, extra: Record<string, unknown>) => createTestRunHistoryRecord({
      id, profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web' as const,
      profile: { id: 'profile', conversation: { endpoint: '/chat' }, ...extra }, environment: { id: 'sit' },
      cases: [{ ...identity, name: 'Case', scenario }],
      completed: [{ ...identity, outcome: 'failed' as const, completedAttempts: 1, durationMs: 10 }],
    });
    const base = { ...make('base', { name: 'Before', description: 'Old', ui: { theme: 'a' }, history: { localRuns: { maxRuns: 5 } } }), cases: make('base', {}).cases.map((item) => ({ ...item, outcome: 'passed' as const })) };
    expect(compareTestRuns(base, make('new', { name: 'After', description: 'New', ui: { theme: 'b' }, history: { localRuns: { maxRuns: 9 } } }))[0]).toEqual({ key: base.cases[0]!.key, difference: 'new-failure' });
    expect(compareTestRuns(base, make('new', { conversation: { endpoint: '/other' } }))[0]).toMatchObject({ difference: 'new-failure', changed: 'configuration' });
  });

  it('keeps a separate baseline for General tests and Red Team', () => {
    const general = { ...record('general', 'passed'), cases: record('general', 'passed').cases.map((item) => ({ ...item, kind: 'contract' as const })) };
    const red = { ...record('red', 'passed'), cases: record('red', 'passed').cases.map((item) => ({ ...item, kind: 'adversarial' as const })) };
    const accepted = acceptTestBaseline(acceptTestBaseline({}, general), red);
    expect(accepted).toEqual({ contract: 'general', adversarial: 'red' });
    expect(normalizeTestBaselines('general', [general, red])).toEqual({ contract: 'general' });
    expect(normalizeTestBaselines({ contract: 'general', adversarial: 'missing' }, [general, red])).toEqual({ contract: 'general' });
  });

  it('records the same case digest the case lists compute for out-of-date detection', () => {
    const value = createTestRunHistoryRecord({ id: 'run', profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'vscode', profile: {}, environment: {}, cases: [{ ...identity, name: 'Case', scenario }], completed: [] });
    expect(value.cases[0]?.definitionDigest).toBe(caseDefinitionDigest(scenario));
    expect(caseDefinitionDigest({ ...scenario, steps: [{ id: 'turn', input: 'edited' }] })).not.toBe(caseDefinitionDigest(scenario));
  });

  it('keeps each case\'s latest result when single cases are rerun many times', () => {
    const single = (id: string, scenarioId: string) => createTestRunHistoryRecord({
      id, profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web', profile: {}, environment: {},
      cases: [{ ...identity, scenarioId, name: scenarioId, scenario: { ...scenario, id: scenarioId } }],
      completed: [{ ...identity, scenarioId, outcome: 'passed', completedAttempts: 1, durationMs: 1 }],
    });
    const newestFirst = [...Array.from({ length: 30 }, (_, index) => single(`rerun-${index}`, 'hot')), single('only-other', 'other'), single('older-other', 'other')];
    const retained = selectRetainedTestRuns(newestFirst, {}).map((run) => run.id);
    expect(retained).toHaveLength(21);
    expect(retained).toContain('only-other');
    expect(retained).not.toContain('older-other');
    expect(selectRetainedTestRuns(newestFirst, { contract: 'older-other' }).map((run) => run.id)).toContain('older-other');
    const many = Array.from({ length: 100 }, (_, index) => single(`case-${index}`, `case-${index}`));
    expect(selectRetainedTestRuns(many, {})).toHaveLength(MAX_RETAINED_TEST_RUNS);
  });

  it('rejects duplicate case identities', () => {
    expect(() => createTestRunHistoryRecord({
      id: 'bad', profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web', profile: {}, environment: {},
      cases: [{ ...identity, name: 'One', scenario }, { ...identity, name: 'Two', scenario }], completed: [],
    })).toThrow(/duplicate/u);
  });

  it('keeps general and red-team results distinct when suite and case IDs coincide', () => {
    const cases = [{ ...identity, suiteId: 'shared', name: 'General', scenario }, { ...identity, suiteId: 'shared', kind: 'adversarial' as const, name: 'Red Team', scenario }];
    const completed = cases.map((item) => ({ ...item, outcome: item.kind === 'contract' ? 'passed' as const : 'resisted' as const, completedAttempts: 1, durationMs: 10 }));
    const value = createTestRunHistoryRecord({ id: 'mixed', profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'vscode', profile: {}, environment: {}, cases, completed });
    expect(value.cases.map((item) => item.outcome)).toEqual(['passed', 'resisted']);
    const red = { ...value, id: 'red', cases: value.cases.filter((item) => item.kind === 'adversarial') };
    expect(clearTestRunHistoryKind([value, red], 'adversarial', { adversarial: 'red', contract: value.id })).toEqual({ runs: [{ ...value, cases: value.cases.filter((item) => item.kind === 'contract') }], baselines: { contract: value.id } });
    expect(clearTestRunHistoryKind([value], 'contract', { contract: value.id, adversarial: value.id })).toEqual({ runs: [{ ...value, cases: value.cases.filter((item) => item.kind === 'adversarial') }], baselines: { adversarial: value.id } });
  });

  it('selects only non-passing cases from a specific run and retains the source reference', () => {
    const passed = { ...identity, scenarioId: 'passed' };
    const failed = { ...identity, scenarioId: 'failed' };
    const value = createTestRunHistoryRecord({
      id: 'rerun', profileId: 'profile', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web', profile: {}, environment: {}, sourceRunId: 'original',
      cases: [{ ...passed, name: 'Passed', scenario: { ...scenario, id: 'passed' } }, { ...failed, name: 'Failed', scenario: { ...scenario, id: 'failed' } }],
      completed: [{ ...passed, outcome: 'passed', completedAttempts: 1, durationMs: 10 }, { ...failed, outcome: 'failed', completedAttempts: 1, durationMs: 10 }],
    });
    expect(nonPassingCases(value)).toEqual([failed]);
    expect(value.sourceRunId).toBe('original');
  });
});
