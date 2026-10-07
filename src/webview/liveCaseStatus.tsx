import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { TestOperationSnapshot } from '../shared/protocol';
import type { TestRunHistoryRecord, TestRunOutcome } from '../shared/testRunHistory';
import { formatDateTime, formatDuration, t } from './i18n';

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
 * terminal operations yield to the recorded history, which includes precise
 * outcomes and durations.
 */
export function useLiveCaseStatuses(operation: TestOperationSnapshot | undefined): ReadonlyMap<string, LiveCaseState> {
  const finished = useRef(new Map<string, LiveCaseState>());
  const applied = useRef<TestOperationSnapshot | undefined>(undefined);
  return useMemo(() => {
    if (!operation || !['running', 'pausing', 'paused', 'cancelling'].includes(operation.state)) return EMPTY_STATUSES;
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

export type CaseOutcomeTone = 'passed' | 'failed' | 'attention';
export type CaseOutcomeFilter = 'all' | 'failed' | 'notRun';
export interface CaseOutcomeInfo { outcome: TestRunOutcome; tone: CaseOutcomeTone; durationMs?: number; at: number }
export interface CaseResultState { outcomes: ReadonlyMap<string, CaseOutcomeInfo>; filter: CaseOutcomeFilter; hasHistory: boolean }

const EMPTY_OUTCOMES: ReadonlyMap<string, CaseOutcomeInfo> = new Map();
/** Each case's most recent recorded result plus the list filter, so case rows double as the result list. */
export const CaseResultContext = createContext<CaseResultState>({ outcomes: EMPTY_OUTCOMES, filter: 'all', hasHistory: false });

export function outcomeTone(outcome: TestRunOutcome): CaseOutcomeTone {
  if (outcome === 'passed' || outcome === 'resisted') return 'passed';
  if (outcome === 'failed' || outcome === 'attackSucceeded') return 'failed';
  return 'attention';
}

const OUTCOME_LABELS: Record<TestRunOutcome, string> = { passed: 'Passed', failed: 'Failed', error: 'Error', resisted: 'Resisted', attackSucceeded: 'Attack succeeded', indeterminate: 'Indeterminate', infrastructureError: 'Infrastructure error' };
export function outcomeLabel(outcome: TestRunOutcome): string { return t(OUTCOME_LABELS[outcome]); }

/** Latest finished outcome per case across recorded runs of one test kind. */
export function latestCaseOutcomes(runs: readonly TestRunHistoryRecord[], kind: 'contract' | 'adversarial'): ReadonlyMap<string, CaseOutcomeInfo> {
  const latest = new Map<string, CaseOutcomeInfo>();
  for (const run of runs) {
    for (const item of run.cases) {
      if (item.kind !== kind || !item.outcome) continue;
      const key = liveCaseKey(item.suiteId, item.scenarioId);
      const previous = latest.get(key);
      if (previous && previous.at >= run.startedAt) continue;
      latest.set(key, { outcome: item.outcome, tone: outcomeTone(item.outcome), ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }), at: run.startedAt });
    }
  }
  return latest.size ? latest : EMPTY_OUTCOMES;
}

export function matchesOutcomeFilter(info: CaseOutcomeInfo | undefined, filter: CaseOutcomeFilter): boolean {
  if (filter === 'failed') return info !== undefined && info.tone !== 'passed';
  if (filter === 'notRun') return info === undefined;
  return true;
}

/** Row predicate for the active result filter; stable while the filter and results are unchanged. */
export function useCaseOutcomeFilter(): { filter: CaseOutcomeFilter; matches: (row: { suiteId?: string; scenarioId: string }) => boolean } {
  const { outcomes, filter } = useContext(CaseResultContext);
  return useMemo(() => ({ filter, matches: (row) => matchesOutcomeFilter(outcomes.get(liveCaseKey(row.suiteId, row.scenarioId)), filter) }), [filter, outcomes]);
}

/**
 * Status for one case row: the live state while a run touches the case, otherwise
 * its last recorded result. Shape and text carry the meaning, never color alone.
 */
export function LiveCaseStatusBadge({ suiteId, scenarioId }: { suiteId?: string; scenarioId: string }): React.JSX.Element | null {
  const key = liveCaseKey(suiteId, scenarioId);
  const state = useContext(LiveCaseStatusContext).get(key);
  const { outcomes, hasHistory } = useContext(CaseResultContext);
  if (state) {
    const label = state === 'running' ? t('Running') : state === 'passed' ? t('Passed') : t('Failed');
    return <span className={`live-case-status live-case-status--${state}`}><span className="live-case-status__mark" aria-hidden="true" />{label}</span>;
  }
  const last = outcomes.get(key);
  if (!last) return hasHistory ? <span className="live-case-status live-case-status--last live-case-status--not-run"><span className="live-case-status__mark" aria-hidden="true" />{t('Not run')}</span> : null;
  const label = outcomeLabel(last.outcome);
  return <span className={`live-case-status live-case-status--last live-case-status--${last.tone}`} title={t('Last result: {outcome}, {date}', { outcome: label, date: formatDateTime(last.at) })}>
    <span className="live-case-status__mark" aria-hidden="true" />{label}{last.durationMs !== undefined && <small className="live-case-status__metric">{formatDuration(last.durationMs)}</small>}
  </span>;
}
