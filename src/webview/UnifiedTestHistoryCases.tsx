import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { TestRunCaseRecord, TestRunComparison, TestRunDifference, TestRunHistoryRecord } from '../shared/testRunHistory';
import { formatNumber, t } from './i18n';

interface HistoryCaseRow { item: TestRunCaseRecord; comparison?: TestRunComparison; removed: boolean }

export type HistoryDifferenceFilter = 'all' | 'new-failure' | 'still-failing' | 'attention' | 'recovered' | 'changed' | 'not-in-run';

/** Order of differences when comparing with a baseline: what needs a decision first. */
const DIFFERENCE_ORDER: readonly TestRunDifference[] = ['new-failure', 'infrastructure-error', 'indeterminate', 'incomplete', 'still-failing', 'definition-changed', 'configuration-changed', 'recovered', 'new-case', 'unchanged', 'removed-case'];

export function matchesDifferenceFilter(comparison: TestRunComparison | undefined, filter: HistoryDifferenceFilter): boolean {
  if (filter === 'all') return true;
  const difference = comparison?.difference;
  if (filter === 'attention') return difference === 'infrastructure-error' || difference === 'indeterminate' || difference === 'incomplete';
  if (filter === 'changed') return difference === 'definition-changed' || difference === 'configuration-changed' || Boolean(comparison?.changed);
  if (filter === 'not-in-run') return difference === 'removed-case';
  return difference === filter;
}

export function UnifiedTestHistoryCases({ run, baseline, kind, differences, onOpenEvidence, outcomeLabel, differenceLabel }: {
  run: TestRunHistoryRecord;
  baseline?: TestRunHistoryRecord;
  kind: 'all' | 'contract' | 'adversarial';
  differences: ReadonlyMap<string, TestRunComparison>;
  onOpenEvidence: (evidenceId: string) => void;
  outcomeLabel: (outcome: TestRunCaseRecord['outcome']) => string;
  differenceLabel: (difference: TestRunDifference) => string;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryDifferenceFilter>('all');
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const rows = useMemo<HistoryCaseRow[]>(() => {
    const all = [
      ...run.cases.map((item) => ({ item, comparison: differences.get(item.key), removed: false })),
      ...(baseline?.cases.filter((item) => differences.get(item.key)?.difference === 'removed-case').map((item) => ({ item, comparison: differences.get(item.key), removed: true })) ?? []),
    ].filter(({ item }) => kind === 'all' || item.kind === kind);
    if (!differences.size) return all;
    const rank = (row: HistoryCaseRow) => { const index = DIFFERENCE_ORDER.indexOf(row.comparison?.difference ?? 'unchanged'); return index < 0 ? DIFFERENCE_ORDER.length : index; };
    return all.map((row, index) => ({ row, index })).sort((left, right) => rank(left.row) - rank(right.row) || left.index - right.index).map(({ row }) => row);
  }, [run, baseline, differences, kind]);
  const filterCounts = useMemo(() => {
    const ids: HistoryDifferenceFilter[] = ['new-failure', 'still-failing', 'attention', 'recovered', 'changed', 'not-in-run'];
    return new Map(ids.map((id) => [id, rows.filter((row) => matchesDifferenceFilter(row.comparison, id)).length]));
  }, [rows]);
  const filtered = useMemo(() => rows.filter(({ item, comparison }) => {
    if (!matchesDifferenceFilter(comparison, filter)) return false;
    if (!deferredQuery) return true;
    return [item.name, item.scenarioId, item.suiteId ?? '', item.kind].some((value) => value.toLocaleLowerCase().includes(deferredQuery));
  }), [rows, filter, deferredQuery]);
  useEffect(() => setPage(0), [run.id, kind, deferredQuery, filter]);
  useEffect(() => setFilter('all'), [run.id, baseline?.id]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const boundedPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(boundedPage * 25, (boundedPage + 1) * 25);
  const filterLabels: Record<Exclude<HistoryDifferenceFilter, 'all'>, string> = {
    'new-failure': t('New failures'),
    'still-failing': t('Still failing'),
    attention: t('Needs attention'),
    recovered: t('Recovered'),
    changed: t('Changed'),
    'not-in-run': t('Not in this run'),
  };
  const visibleFilters = (Object.keys(filterLabels) as Array<Exclude<HistoryDifferenceFilter, 'all'>>).filter((id) => (filterCounts.get(id) ?? 0) > 0 || filter === id);
  return <div className="unified-history-cases">
    {differences.size > 0 && visibleFilters.length > 0 && <div className="case-run-summary__filters unified-history-cases__filters" role="group" aria-label={t('Filter cases by difference from baseline')}>
      <button type="button" aria-pressed={filter === 'all'} aria-label={`${t('All')} (${formatNumber(rows.length)})`} onClick={() => setFilter('all')}>{t('All')}<span className="case-run-summary__count" aria-hidden="true">{formatNumber(rows.length)}</span></button>
      {visibleFilters.map((id) => <button key={id} type="button" aria-pressed={filter === id} aria-label={`${filterLabels[id]} (${formatNumber(filterCounts.get(id) ?? 0)})`} onClick={() => setFilter(id)}>{filterLabels[id]}<span className="case-run-summary__count" aria-hidden="true">{formatNumber(filterCounts.get(id) ?? 0)}</span></button>)}
    </div>}
    {(rows.length > 10 || query) && <label className="unified-history-cases__search"><span>{t('Search run cases')}</span><input type="search" value={query} placeholder={t('Case name, ID, or type')} onChange={(event) => setQuery(event.target.value)} /></label>}
    {!filtered.length ? <p className="unified-test-history__empty">{filter !== 'all' && !deferredQuery ? t('No cases have this difference.') : t('No cases match this search.')}</p> : <>
      <ul className="unified-test-history__cases">{visible.map(({ item, comparison, removed }) => <li key={`${removed ? 'removed:' : ''}${item.key}`}><div className="unified-history-cases__identity"><span className="unified-test-history__case-name" title={item.name}>{item.name}</span><small>{t(item.kind === 'contract' ? 'General' : 'Red Team')} · {item.scenarioId}{item.suiteId ? ` · ${item.suiteId}` : ''}</small></div><span>{removed ? '—' : outcomeLabel(item.outcome)}</span>{comparison && <span className={`unified-history-cases__difference unified-history-cases__difference--${comparison.difference}`}>{differenceLabel(comparison.difference)}</span>}{comparison?.changed && <small className="unified-history-cases__changed">{t(comparison.changed === 'definition' ? 'Case changed since baseline' : 'Settings changed since baseline')}</small>}{!removed && item.requestedAttempts > 1 && <span>{formatNumber(item.completedAttempts)}/{formatNumber(item.requestedAttempts)} {t('attempts')}</span>}{!removed && item.evidenceId && (item.evidenceAvailable ? <button type="button" onClick={() => onOpenEvidence(item.evidenceId!)}>{t('Open evidence')}</button> : <small>{t('Evidence expired')}</small>)}</li>)}</ul>
      {pageCount > 1 && <nav className="unified-history-cases__pagination" aria-label={t('Result pages')}><span>{t('Showing {start}–{end} of {total}', { start: formatNumber(boundedPage * 25 + 1), end: formatNumber(Math.min(filtered.length, (boundedPage + 1) * 25)), total: formatNumber(filtered.length) })}</span><button type="button" disabled={boundedPage === 0} onClick={() => setPage(boundedPage - 1)}>{t('Previous page')}</button><span>{formatNumber(boundedPage + 1)} / {formatNumber(pageCount)}</span><button type="button" disabled={boundedPage === pageCount - 1} onClick={() => setPage(boundedPage + 1)}>{t('Next page')}</button></nav>}
    </>}
  </div>;
}
