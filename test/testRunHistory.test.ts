import { describe, expect, it } from 'vitest';
import { clearTestRunHistoryKind, compareTestRuns, createTestRunHistoryRecord, nonPassingCases } from '../src/shared/testRunHistory';

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
    expect(compareTestRuns(record('base', 'passed'), record('new', 'failed', scenario, { target: 'uat' }))[0]?.difference).toBe('configuration-changed');
    expect(compareTestRuns(record('base', 'passed'), record('new', 'failed', { ...scenario, steps: [{ id: 'turn', input: 'changed' }] }))[0]?.difference).toBe('definition-changed');
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
    expect(clearTestRunHistoryKind([value, red], 'adversarial', 'red')).toEqual({ runs: [{ ...value, cases: value.cases.filter((item) => item.kind === 'contract') }] });
    expect(clearTestRunHistoryKind([value], 'contract', value.id)).toEqual({ runs: [{ ...value, cases: value.cases.filter((item) => item.kind === 'adversarial') }], baselineRunId: value.id });
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
