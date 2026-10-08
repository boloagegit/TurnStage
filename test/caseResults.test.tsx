// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageProfile } from '../src/shared/types';
import type { TestRunHistoryRecord } from '../src/shared/testRunHistory';
import { AdversarialWorkspace, AutomationWorkspace } from '../src/webview/SettingsWorkspace';
import { CaseResultContext, LiveCaseStatusContext, LiveCaseStatusBadge, latestCaseOutcomes, liveCaseKey, matchesOutcomeFilter, useLiveCaseStatuses, type CaseResultState } from '../src/webview/liveCaseStatus';
import { CaseRunSummary, caseResultCounts } from '../src/webview/CaseRunSummary';
import { setLocale } from '../src/webview/i18n';

afterEach(() => { cleanup(); setLocale('en', 'ltr'); });

function run(id: string, startedAt: number, cases: Array<[string, TestRunHistoryRecord['cases'][number]['kind'], TestRunHistoryRecord['cases'][number]['outcome'], number?, string?]>): TestRunHistoryRecord {
  return {
    format: 'turnstage-test-run-history', version: 1, id, profileId: 'profile', startedAt, finishedAt: startedAt + 1000, status: 'completed', runner: 'vscode', evaluatorVersion: 1, profileDigest: 'a', environmentDigest: 'b',
    cases: cases.map(([scenarioId, kind, outcome, durationMs, suiteId]) => ({ key: `${suiteId ?? 'inline'}/${scenarioId}`, name: scenarioId, definitionDigest: 'c', environmentDigest: 'd', requestedAttempts: 1, completedAttempts: outcome ? 1 : 0, ...(outcome ? { outcome } : {}), ...(durationMs === undefined ? {} : { durationMs }), profileId: 'profile', scenarioId, kind, ...(suiteId ? { suiteId } : {}) })),
  };
}

describe('last result per case', () => {
  const runs = [
    run('old', 1_000, [['a', 'contract', 'failed', 900], ['b', 'contract', 'passed', 100], ['red', 'adversarial', 'attackSucceeded']]),
    run('new', 2_000, [['a', 'contract', 'passed', 212], ['c', 'contract', undefined], ['d', 'contract', 'error', 50, 'suite']]),
  ];

  it('keeps the newest finished outcome per case and ignores other kinds and unfinished cases', () => {
    const outcomes = latestCaseOutcomes(runs, 'contract');
    expect(outcomes.get(liveCaseKey(undefined, 'a'))).toEqual({ outcome: 'passed', tone: 'passed', durationMs: 212, at: 2_000 });
    expect(outcomes.get(liveCaseKey(undefined, 'b'))?.at).toBe(1_000);
    expect(outcomes.has(liveCaseKey(undefined, 'c'))).toBe(false);
    expect(outcomes.get(liveCaseKey('suite', 'd'))?.tone).toBe('attention');
    expect(outcomes.has(liveCaseKey(undefined, 'red'))).toBe(false);
    expect(latestCaseOutcomes(runs, 'adversarial').get(liveCaseKey(undefined, 'red'))?.tone).toBe('failed');
  });

  it('filters failed (including errors) and never-run cases, and counts only cases still in the suite', () => {
    const outcomes = latestCaseOutcomes(runs, 'contract');
    expect(matchesOutcomeFilter(outcomes.get(liveCaseKey('suite', 'd')), 'failed')).toBe(true);
    expect(matchesOutcomeFilter(outcomes.get(liveCaseKey(undefined, 'a')), 'failed')).toBe(false);
    expect(matchesOutcomeFilter(undefined, 'notRun')).toBe(true);
    expect(caseResultCounts([liveCaseKey(undefined, 'a'), liveCaseKey('suite', 'd'), liveCaseKey(undefined, 'new-case')], outcomes)).toEqual({ passed: 1, failed: 0, attention: 1, notRun: 1 });
  });

  it('hands completed progress to the recorded outcome and duration', () => {
    function Harness({ state }: { state: 'running' | 'completed' }) {
      const statuses = useLiveCaseStatuses({ action: 'runSelection', state, progress: { totalCases: 1, completedCases: 1, totalAttempts: 1, completedAttempts: 1, maxConcurrency: 1, passedCases: 0, failedCases: 1, completedOutcomes: [{ scenarioId: 'red', outcome: 'failed' }] } });
      return <LiveCaseStatusContext.Provider value={statuses}><CaseResultContext.Provider value={{ outcomes: latestCaseOutcomes([run('r', 1000, [['red', 'adversarial', 'infrastructureError', 212]])], 'adversarial'), filter: 'all', hasHistory: true }}><LiveCaseStatusBadge scenarioId="red" /></CaseResultContext.Provider></LiveCaseStatusContext.Provider>;
    }
    const { container, rerender } = render(<Harness state="running" />);
    expect(container.querySelector('.live-case-status')?.textContent).toBe('Failed');
    rerender(<Harness state="completed" />);
    expect(container.querySelector('.live-case-status--last')?.textContent).toBe('Infrastructure error212 ms');
    expect(container.querySelector('.live-case-status')?.getAttribute('title')).toMatch(/^Last result: Infrastructure error, /u);
  });

  it('shows the live state while running, otherwise the last result with its duration', () => {
    const outcomes = latestCaseOutcomes(runs, 'contract');
    const state: CaseResultState = { outcomes, filter: 'all', hasHistory: true };
    const { container, rerender } = render(<CaseResultContext.Provider value={state}><LiveCaseStatusBadge scenarioId="a" /><LiveCaseStatusBadge scenarioId="never" /></CaseResultContext.Provider>);
    const [last, never] = container.querySelectorAll('.live-case-status');
    expect(last?.className).toContain('live-case-status--last');
    expect(last?.textContent).toBe('Passed212 ms');
    expect(last?.getAttribute('title')).toMatch(/^Last result: Passed, /u);
    expect(never?.textContent).toBe('Not run');
    rerender(<LiveCaseStatusContext.Provider value={new Map([[liveCaseKey(undefined, 'a'), 'running']])}><CaseResultContext.Provider value={state}><LiveCaseStatusBadge scenarioId="a" /></CaseResultContext.Provider></LiveCaseStatusContext.Provider>);
    expect(container.querySelector('.live-case-status')?.className).toContain('live-case-status--running');
    rerender(<LiveCaseStatusBadge scenarioId="never" />);
    expect(container.querySelector('.live-case-status')).toBeNull();
  });
});

describe('one list for cases and results', () => {
  const profile: TurnStageProfile = { version: 1, id: 'profile', name: 'Profile', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [
    { id: 'pass', name: 'Passing case', steps: [{ id: 's', input: 'Hi' }] },
    { id: 'fail', name: 'Failing case', steps: [{ id: 's', input: 'Hi' }] },
    { id: 'fresh', name: 'Fresh case', steps: [{ id: 's', input: 'Hi' }] },
    { id: 'red-pass', name: 'Red resisted', steps: [{ id: 't', input: 'Probe' }], adversarial: { forbid: { urls: true } } },
    { id: 'red-fail', name: 'Red breached', steps: [{ id: 't', input: 'Probe' }], adversarial: { forbid: { urls: true } } },
  ] } };
  const runs = [run('r', 1_000, [['pass', 'contract', 'passed', 120], ['fail', 'contract', 'failed', 1808], ['red-pass', 'adversarial', 'resisted'], ['red-fail', 'adversarial', 'attackSucceeded']])];

  function names(): string[] { return within(screen.getByRole('list')).getAllByRole('button', { name: /case|Red/u }).map((button) => button.getAttribute('aria-label') ?? '').filter((name) => !name.startsWith('Run') && !name.startsWith('Delete')); }

  it.each([
    ['General Cases', 'contract', 'scenarios'],
    ['General Results', 'contract', 'results'],
    ['Red Team Cases', 'adversarial', 'cases'],
    ['Red Team Results', 'adversarial', 'results'],
  ] as const)('does not repeat a completed operation in %s, including after history is cleared', (_label, kind, section) => {
    for (const hasHistory of [true, false]) {
      const operation = { action: 'runSelection', state: 'completed' } as const;
      const { unmount } = render(<CaseResultContext.Provider value={{ outcomes: latestCaseOutcomes(hasHistory ? runs : [], kind), filter: 'all', hasHistory }}>
        {kind === 'contract'
          ? <AutomationWorkspace profile={profile} post={vi.fn()} activeSection={section === 'scenarios' ? 'scenarios' : 'results'} testOperation={operation} unified />
          : <AdversarialWorkspace profile={profile} post={vi.fn()} activeSection={section === 'cases' ? 'cases' : 'results'} testOperation={operation} unified />}
      </CaseResultContext.Provider>);
      expect(screen.queryByText('Test run completed')).toBeNull();
      unmount();
    }
  });

  it('keeps live run feedback in unified Results and completion feedback in the standalone workspace', () => {
    const { rerender } = render(<AutomationWorkspace profile={profile} post={vi.fn()} activeSection="results" testOperation={{ action: 'runSelection', state: 'running' }} unified />);
    expect(screen.getByText('Running selected cases…')).toBeTruthy();
    rerender(<AutomationWorkspace profile={profile} post={vi.fn()} activeSection="results" testOperation={{ action: 'runSelection', state: 'completed' }} />);
    expect(screen.getByText('Test run completed')).toBeTruthy();
  });

  it('narrows General test cases to failures or cases that never ran', () => {
    const outcomes = latestCaseOutcomes(runs, 'contract');
    const { rerender } = render(<CaseResultContext.Provider value={{ outcomes, filter: 'failed', hasHistory: true }}><AutomationWorkspace profile={profile} post={vi.fn()} activeSection="scenarios" unified /></CaseResultContext.Provider>);
    expect(names()).toEqual(['Failing case']);
    expect(screen.getByText('Failed')).toBeTruthy();
    rerender(<CaseResultContext.Provider value={{ outcomes, filter: 'notRun', hasHistory: true }}><AutomationWorkspace profile={profile} post={vi.fn()} activeSection="scenarios" unified /></CaseResultContext.Provider>);
    expect(names()).toEqual(['Fresh case']);
    rerender(<CaseResultContext.Provider value={{ outcomes, filter: 'all', hasHistory: true }}><AutomationWorkspace profile={profile} post={vi.fn()} activeSection="scenarios" unified /></CaseResultContext.Provider>);
    expect(names()).toEqual(['Passing case', 'Failing case', 'Fresh case']);
  });

  it('applies the same filter to Red Team cases', () => {
    render(<CaseResultContext.Provider value={{ outcomes: latestCaseOutcomes(runs, 'adversarial'), filter: 'failed', hasHistory: true }}><AdversarialWorkspace profile={profile} post={vi.fn()} activeSection="cases" unified /></CaseResultContext.Provider>);
    expect(screen.getByText('1 of 2 cases')).toBeTruthy();
    expect(screen.getByText('Attack succeeded')).toBeTruthy();
  });

  it('does not nest tab panels inside the unified test workspace', () => {
    const { container } = render(<AdversarialWorkspace profile={profile} post={vi.fn()} activeSection="cases" unified />);
    const section = container.querySelector('#red-team-cases');
    expect(section?.getAttribute('role')).toBeNull();
    expect(section?.getAttribute('aria-labelledby')).toBe('adversarial-tests-heading');
    expect(container.querySelector('#adversarial-tests-heading')).not.toBeNull();
    cleanup();
    const standalone = render(<AdversarialWorkspace profile={profile} post={vi.fn()} activeSection="cases" />);
    expect(standalone.container.querySelector('#red-team-cases')?.getAttribute('role')).toBe('tabpanel');
  });

  it('summarizes the last run and switches filters, rerun, and history from one header', () => {
    const onFilterChange = vi.fn();
    const onRerun = vi.fn();
    const onViewHistory = vi.fn();
    const keys = ['pass', 'fail', 'fresh'].map((id) => liveCaseKey(undefined, id));
    const { container } = render(<CaseRunSummary caseKeys={keys} outcomes={latestCaseOutcomes(runs, 'contract')} lastRunAt={1_000} filter="all" onFilterChange={onFilterChange} rerunCount={1} rerunDisabled={false} onRerun={onRerun} onViewHistory={onViewHistory} />);
    expect(container.querySelector('.case-run-summary__tally')?.textContent).toBe('1 passed · 1 failed · 1 not run');
    expect(container.querySelectorAll('.case-run-summary__meter > span')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'All (3)' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Failed (1)' }));
    expect(onFilterChange).toHaveBeenCalledWith('failed');
    fireEvent.click(screen.getByRole('button', { name: 'Rerun failed (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'View results' }));
    expect(onRerun).toHaveBeenCalledOnce();
    expect(onViewHistory).toHaveBeenCalledOnce();
    expect(container.querySelector('.case-run-summary strong')?.textContent).toMatch(/^Latest results/u);
  });

  it('speaks Red Team outcomes in the same words as the case badges', () => {
    const keys = ['red-pass', 'red-fail'].map((id) => liveCaseKey(undefined, id));
    const { container } = render(<CaseRunSummary kind="adversarial" caseKeys={keys} outcomes={latestCaseOutcomes(runs, 'adversarial')} lastRunAt={1_000} filter="all" onFilterChange={vi.fn()} rerunCount={1} rerunDisabled={false} onRerun={vi.fn()} onViewHistory={vi.fn()} />);
    expect(container.querySelector('.case-run-summary__tally')?.textContent).toBe('1 resisted · 1 not resisted · 0 not run');
    expect(screen.getByRole('button', { name: 'Not resisted (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rerun not resisted (1)' })).toBeTruthy();
  });

  it('never strands a result filter: the empty list and Red Team clear actions return to All', () => {
    const onFilterChange = vi.fn();
    const outcomes = latestCaseOutcomes(runs, 'contract');
    const { unmount } = render(<CaseResultContext.Provider value={{ outcomes, filter: 'failed', hasHistory: true, onFilterChange }}><AutomationWorkspace profile={{ ...profile, tests: { scenarios: profile.tests!.scenarios!.filter((item) => item.id === 'pass') } }} post={vi.fn()} activeSection="scenarios" unified /></CaseResultContext.Provider>);
    expect(screen.getByText('No cases match this result filter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all cases' }));
    expect(onFilterChange).toHaveBeenLastCalledWith('all');
    unmount();
    const onCollectionChange = vi.fn();
    render(<CaseResultContext.Provider value={{ outcomes: latestCaseOutcomes(runs, 'adversarial'), filter: 'notRun', hasHistory: true, onFilterChange }}><AdversarialWorkspace profile={profile} post={vi.fn()} activeSection="cases" unified onCaseCollectionChange={onCollectionChange} /></CaseResultContext.Provider>);
    const clear = screen.getByRole('button', { name: 'Clear (1)' });
    expect(clear.hasAttribute('disabled')).toBe(false);
    onFilterChange.mockClear();
    fireEvent.click(clear);
    expect(onFilterChange).toHaveBeenCalledWith('all');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onFilterChange).toHaveBeenCalledTimes(2);
  });
});
