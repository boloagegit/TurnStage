// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { compareTestRuns, createTestRunHistoryRecord } from '../src/shared/testRunHistory';
import { durationDelta, UnifiedTestHistoryCases } from '../src/webview/UnifiedTestHistoryCases';

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

  it('compares one case with its baseline side by side, with evidence for each', () => {
    const baseline = run('base', { a: 'passed' });
    const current = run('now', { a: 'failed' });
    baseline.cases[0] = { ...baseline.cases[0]!, durationMs: 400, evidenceId: 'old-evidence', evidenceAvailable: true };
    current.cases[0] = { ...current.cases[0]!, durationMs: 500, evidenceId: 'new-evidence', evidenceAvailable: true };
    const opened: string[] = [];
    const differences = new Map(compareTestRuns(baseline, current).map((item) => [item.key, item]));
    render(<UnifiedTestHistoryCases run={current} baseline={baseline} kind="contract" differences={differences} onOpenEvidence={(id) => opened.push(id)} outcomeLabel={(outcome) => String(outcome)} differenceLabel={(difference) => difference} />);
    const toggle = screen.getByRole('button', { name: 'Compare with baseline' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const before = within(panel).getByRole('region', { name: 'Baseline' });
    const after = within(panel).getByRole('region', { name: 'This run' });
    expect(within(before).getByText('passed')).toBeTruthy();
    expect(within(after).getByText('failed')).toBeTruthy();
    expect(within(panel).getByText('Duration change: +100 ms (+25%)')).toBeTruthy();
    fireEvent.click(within(before).getByRole('button', { name: 'Open evidence' }));
    fireEvent.click(within(after).getByRole('button', { name: 'Open evidence' }));
    expect(opened).toEqual(['old-evidence', 'new-evidence']);
    fireEvent.click(toggle);
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeNull();
  });

  it('describes duration changes in both directions', () => {
    expect(durationDelta(300, 400)).toBe('−100 ms (−25%)');
    expect(durationDelta(5, 5)).toBe('No change');
    expect(durationDelta(5, 0)).toBe('+5 ms');
    expect(durationDelta(undefined, 5)).toBeUndefined();
  });
});
