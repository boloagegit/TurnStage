import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { TestOperationSnapshot } from '../shared/protocol';
import type { TestRunHistoryRecord, TestRunOutcome } from '../shared/testRunHistory';
import { formatDateTime, formatDuration, formatNumber, t } from './i18n';

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
export type CaseOutcomeFilter = 'all' | 'failed' | 'notRun' | 'flaky';
export interface CaseOutcomeInfo {
  outcome: TestRunOutcome;
  tone: CaseOutcomeTone;
  durationMs?: number;
  at: number;
  definitionDigest?: string;
  /** The case was edited after this result, so the result no longer describes the current definition. */
  stale?: boolean;
  /** Recent runs of this exact definition and settings both passed and failed, flipping more than once. */
  flaky?: CaseStability;
}
export interface CaseStability { passes: number; failures: number; runs: number }

/** How many recent same-definition runs are weighed when deciding whether a case is flaky. */
export const FLAKY_WINDOW = 10;

interface CaseHistoryPoint { at: number; tone: CaseOutcomeTone; definitionDigest?: string; environmentDigest?: string }

/**
 * A case is flaky when, among its most recent runs with the same definition and settings as the
 * latest one, it both passed and failed and the result changed at least twice (pass→fail→pass or
 * the reverse). A single change is a regression or a fix, not flakiness. Errors and indeterminate
 * results say nothing about the case itself and are skipped.
 */
export function caseStability(points: readonly CaseHistoryPoint[]): CaseStability | undefined {
  const ordered = [...points].sort((left, right) => right.at - left.at);
  const latest = ordered[0];
  if (!latest) return undefined;
  const comparable = ordered.filter((point) => point.tone !== 'attention' && point.definitionDigest === latest.definitionDigest && point.environmentDigest === latest.environmentDigest).slice(0, FLAKY_WINDOW);
  let flips = 0;
  for (let index = 1; index < comparable.length; index += 1) if (comparable[index]!.tone !== comparable[index - 1]!.tone) flips += 1;
  const passes = comparable.filter((point) => point.tone === 'passed').length;
  const failures = comparable.length - passes;
  return flips >= 2 && passes > 0 && failures > 0 ? { passes, failures, runs: comparable.length } : undefined;
}
export interface CaseResultState { outcomes: ReadonlyMap<string, CaseOutcomeInfo>; filter: CaseOutcomeFilter; hasHistory: boolean; onFilterChange?: (filter: CaseOutcomeFilter) => void }

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
  const history = new Map<string, CaseHistoryPoint[]>();
  for (const run of runs) {
    for (const item of run.cases) {
      if (item.kind !== kind || !item.outcome) continue;
      const key = liveCaseKey(item.suiteId, item.scenarioId);
      const tone = outcomeTone(item.outcome);
      const points = history.get(key) ?? [];
      points.push({ at: run.startedAt, tone, definitionDigest: item.definitionDigest, environmentDigest: item.environmentDigest });
      history.set(key, points);
      const previous = latest.get(key);
      if (previous && previous.at >= run.startedAt) continue;
      latest.set(key, { outcome: item.outcome, tone, ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }), at: run.startedAt, definitionDigest: item.definitionDigest });
    }
  }
  for (const [key, points] of history) {
    const flaky = points.length > 2 ? caseStability(points) : undefined;
    const info = latest.get(key);
    if (flaky && info) latest.set(key, { ...info, flaky });
  }
  return latest.size ? latest : EMPTY_OUTCOMES;
}

/** Marks results recorded before the case's current definition; cases without a known digest are left as they are. */
export function markStaleOutcomes(outcomes: ReadonlyMap<string, CaseOutcomeInfo>, currentDigests: ReadonlyMap<string, string>): ReadonlyMap<string, CaseOutcomeInfo> {
  let changed = false;
  const result = new Map(outcomes);
  for (const [key, info] of outcomes) {
    const current = currentDigests.get(key);
    if (!current || !info.definitionDigest || current === info.definitionDigest) continue;
    result.set(key, { ...info, stale: true });
    changed = true;
  }
  return changed ? result : outcomes;
}

/** A stale result counts as not run: the current definition has never been executed. */
export function matchesOutcomeFilter(info: CaseOutcomeInfo | undefined, filter: CaseOutcomeFilter): boolean {
  if (filter === 'failed') return info !== undefined && !info.stale && info.tone !== 'passed';
  if (filter === 'notRun') return info === undefined || info.stale === true;
  if (filter === 'flaky') return info !== undefined && !info.stale && info.flaky !== undefined;
  return true;
}

/** Row predicate for the active result filter; stable while the filter and results are unchanged. */
export function useCaseOutcomeFilter(): { filter: CaseOutcomeFilter; matches: (row: { suiteId?: string; scenarioId: string }) => boolean; reset: () => void } {
  const { outcomes, filter, onFilterChange } = useContext(CaseResultContext);
  return useMemo(() => ({ filter, matches: (row) => matchesOutcomeFilter(outcomes.get(liveCaseKey(row.suiteId, row.scenarioId)), filter), reset: () => onFilterChange?.('all') }), [filter, onFilterChange, outcomes]);
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
  if (last.stale) return <span className="live-case-status live-case-status--last live-case-status--stale" title={t('Last result before this case was edited: {outcome}, {date}', { outcome: label, date: formatDateTime(last.at) })}>
    <span className="live-case-status__mark" aria-hidden="true" />{t('Changed since last run')}
  </span>;
  return <span className={`live-case-status live-case-status--last live-case-status--${last.tone}`} title={t('Last result: {outcome}, {date}', { outcome: label, date: formatDateTime(last.at) })}>
    <span className="live-case-status__mark" aria-hidden="true" />{label}{last.durationMs !== undefined && <small className="live-case-status__metric">{formatDuration(last.durationMs)}</small>}
    {last.flaky && <small className="live-case-status__flaky" title={t('Passed {passes} and failed {failures} of the last {runs} runs of this definition', { passes: formatNumber(last.flaky.passes), failures: formatNumber(last.flaky.failures), runs: formatNumber(last.flaky.runs) })}><span className="sr-only">, </span>{t('Flaky')}</small>}
  </span>;
}
