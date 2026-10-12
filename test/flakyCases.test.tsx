// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { caseResultCounts, CaseRunSummary } from '../src/webview/CaseRunSummary';
import { caseStability, CaseResultContext, latestCaseOutcomes, LiveCaseStatusBadge, liveCaseKey, matchesOutcomeFilter } from '../src/webview/liveCaseStatus';
import type { TestRunHistoryRecord, TestRunOutcome } from '../src/shared/testRunHistory';

afterEach(cleanup);

const digest = 'a'.repeat(64);
function run(index: number, outcome: TestRunOutcome, definitionDigest = digest): TestRunHistoryRecord {
  return { format: 'turnstage-test-run-history', version: 1, id: `run-${index}`, profileId: 'p', startedAt: index * 1000, finishedAt: index * 1000 + 10, status: 'completed', runner: 'web', evaluatorVersion: 1, profileDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64),
    cases: [{ profileId: 'p', scenarioId: 'case', kind: 'contract', key: 'case', name: 'Case', definitionDigest, environmentDigest: 'c'.repeat(64), requestedAttempts: 1, completedAttempts: 1, outcome }] } as TestRunHistoryRecord;
}

describe('flaky cases', () => {
  it('needs both results and at least two changes on the same definition', () => {
    const point = (at: number, tone: 'passed' | 'failed' | 'attention', definitionDigest = digest) => ({ at, tone, definitionDigest, environmentDigest: 'c' });
    expect(caseStability([point(1, 'passed'), point(2, 'failed'), point(3, 'passed')])).toEqual({ passes: 2, failures: 1, runs: 3 });
    // One change is a regression, not flakiness.
    expect(caseStability([point(1, 'passed'), point(2, 'passed'), point(3, 'failed')])).toBeUndefined();
    // Errors are skipped rather than counted as changes.
    expect(caseStability([point(1, 'passed'), point(2, 'attention'), point(3, 'passed')])).toBeUndefined();
    // Runs of an older definition do not count against the edited case.
    expect(caseStability([point(1, 'failed', 'x'), point(2, 'passed', 'x'), point(3, 'failed'), point(4, 'failed')])).toBeUndefined();
  });

  it('marks the latest result, counts it, and filters to it', () => {
    const outcomes = latestCaseOutcomes([run(1, 'passed'), run(2, 'failed'), run(3, 'passed'), run(4, 'passed')], 'contract');
    const info = outcomes.get(liveCaseKey(undefined, 'case'));
    expect(info?.flaky).toEqual({ passes: 3, failures: 1, runs: 4 });
    expect(matchesOutcomeFilter(info, 'flaky')).toBe(true);
    expect(matchesOutcomeFilter({ ...info!, stale: true }, 'flaky')).toBe(false);
    expect(caseResultCounts([liveCaseKey(undefined, 'case')], outcomes).flaky).toBe(1);
    expect(latestCaseOutcomes([run(1, 'passed'), run(2, 'failed')], 'contract').get(liveCaseKey(undefined, 'case'))?.flaky).toBeUndefined();

    render(<CaseResultContext.Provider value={{ outcomes, filter: 'all', hasHistory: true }}><LiveCaseStatusBadge scenarioId="case" /></CaseResultContext.Provider>);
    expect(screen.getByText('Flaky').getAttribute('title')).toBe('Passed 3 and failed 1 of the last 4 runs of this definition');
    cleanup();
    render(<CaseRunSummary caseKeys={[liveCaseKey(undefined, 'case')]} outcomes={outcomes} lastRunAt={4000} filter="all" onFilterChange={() => undefined} rerunCount={0} rerunDisabled={false} onRerun={() => undefined} onViewHistory={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Flaky (1)' })).toBeTruthy();
  });
});
