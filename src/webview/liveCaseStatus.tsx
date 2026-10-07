import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { TestOperationSnapshot } from '../shared/protocol';
import { t } from './i18n';

export type LiveCaseState = 'running' | 'passed' | 'failed';

const EMPTY_STATUSES: ReadonlyMap<string, LiveCaseState> = new Map();

/** Live per-case run status for case lists, provided by the test workspace. */
export const LiveCaseStatusContext = createContext<ReadonlyMap<string, LiveCaseState>>(EMPTY_STATUSES);

export function liveCaseKey(suiteId: string | undefined, scenarioId: string): string {
  return `${suiteId ?? ''}\u001f${scenarioId}`;
}

/**
 * Accumulates the bounded per-message outcomes a run reports into one map for
 * the current run. A new run (running with nothing completed yet) starts over;
 * finished statuses stay visible after the run until the next one starts.
 */
export function useLiveCaseStatuses(operation: TestOperationSnapshot | undefined): ReadonlyMap<string, LiveCaseState> {
  const finished = useRef(new Map<string, LiveCaseState>());
  const applied = useRef<TestOperationSnapshot | undefined>(undefined);
  return useMemo(() => {
    if (!operation) return EMPTY_STATUSES;
    if (operation !== applied.current) {
      applied.current = operation;
      const progress = operation.progress;
      if (operation.state === 'running' && (!progress || progress.completedCases === 0)) finished.current = new Map();
      if (progress?.completedOutcomes?.length) {
        const next = new Map(finished.current);
        for (const entry of progress.completedOutcomes) next.set(liveCaseKey(entry.suiteId, entry.scenarioId), entry.outcome);
        finished.current = next;
      }
    }
    const running = ['running', 'pausing', 'paused', 'cancelling'].includes(operation.state) ? operation.progress?.activeCases ?? [] : [];
    if (!running.length) return finished.current.size ? finished.current : EMPTY_STATUSES;
    const merged = new Map(finished.current);
    for (const entry of running) merged.set(liveCaseKey(entry.suiteId, entry.scenarioId), 'running');
    return merged;
  }, [operation]);
}

/** Compact status for one case row; renders nothing when the case has no live status. */
export function LiveCaseStatusBadge({ suiteId, scenarioId }: { suiteId?: string; scenarioId: string }): React.JSX.Element | null {
  const state = useContext(LiveCaseStatusContext).get(liveCaseKey(suiteId, scenarioId));
  if (!state) return null;
  const label = state === 'running' ? t('Running') : state === 'passed' ? t('Passed') : t('Failed');
  return <span className={`live-case-status live-case-status--${state}`}><span className="live-case-status__mark" aria-hidden="true" />{label}</span>;
}
