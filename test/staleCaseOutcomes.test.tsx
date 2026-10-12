// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { caseResultCounts } from '../src/webview/CaseRunSummary';
import { CaseResultContext, LiveCaseStatusBadge, liveCaseKey, markStaleOutcomes, matchesOutcomeFilter, type CaseOutcomeInfo } from '../src/webview/liveCaseStatus';

afterEach(cleanup);

const passed: CaseOutcomeInfo = { outcome: 'passed', tone: 'passed', at: 1, definitionDigest: 'a'.repeat(64) };

describe('results recorded before a case was edited', () => {
  it('are marked as changed, counted as not run, and left out of Rerun failed', () => {
    const outcomes = new Map([['edited', passed], ['same', passed], ['unknown', passed]]);
    const marked = markStaleOutcomes(outcomes, new Map([['edited', 'b'.repeat(64)], ['same', 'a'.repeat(64)]]));
    expect(marked.get('edited')?.stale).toBe(true);
    expect(marked.get('same')?.stale).toBeUndefined();
    expect(marked.get('unknown')?.stale).toBeUndefined();
    expect(caseResultCounts(['edited', 'same', 'unknown'], marked)).toEqual({ passed: 2, failed: 0, attention: 0, notRun: 1 });
    expect(matchesOutcomeFilter(marked.get('edited'), 'notRun')).toBe(true);
    expect(matchesOutcomeFilter({ ...passed, tone: 'failed', outcome: 'failed', stale: true }, 'failed')).toBe(false);
    expect(markStaleOutcomes(outcomes, new Map())).toBe(outcomes);
  });

  it('show a changed badge instead of the old result', () => {
    render(<CaseResultContext.Provider value={{ outcomes: new Map([[liveCaseKey(undefined, 'case'), { ...passed, stale: true }]]), filter: 'all', hasHistory: true }}><LiveCaseStatusBadge scenarioId="case" /></CaseResultContext.Provider>);
    expect(screen.getByText('Changed since last run')).toBeTruthy();
    expect(screen.queryByText('Passed')).toBeNull();
  });
});
