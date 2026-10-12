// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { compareTestRuns, createTestRunHistoryRecord } from '../src/shared/testRunHistory';
import { UnifiedTestHistoryCases } from '../src/webview/UnifiedTestHistoryCases';

afterEach(cleanup);

function run(id: string, outcomes: Record<string, 'passed' | 'failed'>) {
  const cases = Object.keys(outcomes).map((scenarioId) => ({ profileId: 'p', scenarioId, kind: 'contract' as const, name: `Case ${scenarioId}`, scenario: { id: scenarioId, name: scenarioId, steps: [{ id: 'turn', input: 'Hi' }] } }));
  return createTestRunHistoryRecord({ id, profileId: 'p', startedAt: 1, finishedAt: 2, status: 'completed', runner: 'web', profile: {}, environment: {}, cases, completed: cases.map((item) => ({ ...item, outcome: outcomes[item.scenarioId]!, completedAttempts: 1, durationMs: 1 })) });
}

describe('run history case list', () => {
  it('lists new failures first and filters by difference from the baseline', () => {
    const baseline = run('base', { a: 'passed', b: 'passed', c: 'failed', gone: 'passed' });
    const current = run('now', { a: 'passed', b: 'failed', c: 'failed' });
    const differences = new Map(compareTestRuns(baseline, current).map((item) => [item.key, item]));
    render(<UnifiedTestHistoryCases run={current} baseline={baseline} kind="contract" differences={differences} onOpenEvidence={() => undefined} outcomeLabel={(outcome) => String(outcome)} differenceLabel={(difference) => difference} />);
    const names = () => screen.getAllByRole('listitem').map((item) => item.querySelector('.unified-test-history__case-name')?.textContent);
    expect(names()).toEqual(['Case b', 'Case c', 'Case a', 'Case gone']);
    const filters = screen.getByRole('group', { name: 'Filter cases by difference from baseline' });
    expect(within(filters).getByRole('button', { name: 'New failures (1)' })).toBeTruthy();
    fireEvent.click(within(filters).getByRole('button', { name: 'Not in this run (1)' }));
    expect(names()).toEqual(['Case gone']);
    fireEvent.click(within(filters).getByRole('button', { name: 'Still failing (1)' }));
    expect(names()).toEqual(['Case c']);
  });

  it('shows no difference filters without a baseline', () => {
    const current = run('now', { a: 'passed' });
    render(<UnifiedTestHistoryCases run={current} kind="contract" differences={new Map()} onOpenEvidence={() => undefined} outcomeLabel={(outcome) => String(outcome)} differenceLabel={(difference) => difference} />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});
