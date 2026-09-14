// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalRunSummary, NetworkExchange, SessionSnapshot } from '../src/shared/types';
import { Inspector, inspectorTabCounts } from '../src/webview/main';

afterEach(cleanup);

const snapshot = { rawEvents: [{}, {}], normalizedEvents: [{}], errors: [{ type: 'network', message: 'Failed' }] } as SessionSnapshot;
const networkEntries = [{ id: 'request-1' }] as NetworkExchange[];
const runs = [{ id: 'run-1' }, { id: 'run-2' }] as LocalRunSummary[];

describe('Inspector tab badges', () => {
  it('counts only items represented by each evidence view', () => {
    expect(inspectorTabCounts(snapshot, networkEntries, runs)).toEqual({ Network: 1, 'Raw Events': 2, Normalized: 1, Metrics: 0, Errors: 1, Runs: 2 });
    expect(inspectorTabCounts(undefined, [], []).Errors).toBe(0);
  });

  it('shows a visible count and accessible exact count, without an empty or metrics badge', () => {
    render(<Inspector snapshot={snapshot} networkEntries={networkEntries} runs={runs} tab="Errors" setTab={() => undefined} requestPreview={undefined} />);
    expect(screen.getByRole('tab', { name: /Errors \(1\)/ }).querySelector('.inspector-tab-count')?.textContent).toBe('1');
    expect(screen.getByRole('tab', { name: /Raw Events \(2\)/ }).querySelector('.inspector-tab-count')?.textContent).toBe('2');
    expect(screen.getByRole('tab', { name: 'Metrics' }).querySelector('.inspector-tab-count')).toBeNull();
  });
});
