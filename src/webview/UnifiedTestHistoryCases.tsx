import React, { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import type { TestRunCaseRecord, TestRunComparison, TestRunDifference, TestRunHistoryRecord } from '../shared/testRunHistory';
import { dateTimeAttribute, formatDateTime, formatDuration, formatNumber, t } from './i18n';

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
  const [comparedKey, setComparedKey] = useState<string>();
  const compareIdPrefix = useId();
  const baselineCases = useMemo(() => new Map((baseline?.cases ?? []).map((item) => [item.key, item])), [baseline]);
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
  useEffect(() => { setFilter('all'); setComparedKey(undefined); }, [run.id, baseline?.id]);
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
      <ul className="unified-test-history__cases">{visible.map(({ item, comparison, removed }, index) => <li key={`${removed ? 'removed:' : ''}${item.key}`}><div className="unified-history-cases__identity"><span className="unified-test-history__case-name" title={item.name}>{item.name}</span><small>{t(item.kind === 'contract' ? 'General' : 'Red Team')} · {item.scenarioId}{item.suiteId ? ` · ${item.suiteId}` : ''}</small></div><span>{removed ? '—' : outcomeLabel(item.outcome)}</span>{comparison && <span className={`unified-history-cases__difference unified-history-cases__difference--${comparison.difference}`}>{differenceLabel(comparison.difference)}</span>}{comparison?.changed && <small className="unified-history-cases__changed">{t(comparison.changed === 'definition' ? 'Case changed since baseline' : 'Settings changed since baseline')}</small>}{!removed && item.requestedAttempts > 1 && <span>{formatNumber(item.completedAttempts)}/{formatNumber(item.requestedAttempts)} {t('attempts')}</span>}{!removed && item.evidenceId && (item.evidenceAvailable ? <button type="button" onClick={() => onOpenEvidence(item.evidenceId!)}>{t('Open evidence')}</button> : <small>{t('Evidence expired')}</small>)}{!removed && baseline && baselineCases.has(item.key) && <button type="button" className="unified-history-cases__compare-toggle" aria-expanded={comparedKey === item.key} aria-controls={`${compareIdPrefix}-${index}`} onClick={() => setComparedKey(comparedKey === item.key ? undefined : item.key)}>{t('Compare with baseline')}</button>}{!removed && baseline && comparedKey === item.key && baselineCases.get(item.key) && <CaseBaselineComparison id={`${compareIdPrefix}-${index}`} current={item} currentRun={run} previous={baselineCases.get(item.key)!} baseline={baseline} changed={comparison?.changed} onOpenEvidence={onOpenEvidence} outcomeLabel={outcomeLabel} />}</li>)}</ul>
      {pageCount > 1 && <nav className="unified-history-cases__pagination" aria-label={t('Result pages')}><span>{t('Showing {start}–{end} of {total}', { start: formatNumber(boundedPage * 25 + 1), end: formatNumber(Math.min(filtered.length, (boundedPage + 1) * 25)), total: formatNumber(filtered.length) })}</span><button type="button" disabled={boundedPage === 0} onClick={() => setPage(boundedPage - 1)}>{t('Previous page')}</button><span>{formatNumber(boundedPage + 1)} / {formatNumber(pageCount)}</span><button type="button" disabled={boundedPage === pageCount - 1} onClick={() => setPage(boundedPage + 1)}>{t('Next page')}</button></nav>}
    </>}
  </div>;
}

/** Signed duration change, e.g. "+120 ms (+15%)"; percentages are skipped when the baseline took no time. */
export function durationDelta(current: number | undefined, previous: number | undefined): string | undefined {
  if (current === undefined || previous === undefined) return undefined;
  const difference = current - previous;
  if (difference === 0) return t('No change');
  const sign = difference > 0 ? '+' : '−';
  const percent = previous > 0 ? ` (${sign}${formatNumber(Math.round((Math.abs(difference) / previous) * 100))}%)` : '';
  return `${sign}${formatDuration(Math.abs(difference))}${percent}`;
}

/** The baseline's and this run's record of one case, side by side, with the evidence for each. */
function CaseBaselineComparison({ id, current, currentRun, previous, baseline, changed, onOpenEvidence, outcomeLabel }: {
  id: string;
  current: TestRunCaseRecord;
  currentRun: TestRunHistoryRecord;
  previous: TestRunCaseRecord;
  baseline: TestRunHistoryRecord;
  changed?: TestRunComparison['changed'];
  onOpenEvidence: (evidenceId: string) => void;
  outcomeLabel: (outcome: TestRunCaseRecord['outcome']) => string;
}): React.JSX.Element {
  const delta = durationDelta(current.durationMs, previous.durationMs);
  const column = (heading: string, record: TestRunCaseRecord, source: TestRunHistoryRecord) => <section className="case-compare__column" aria-label={heading}>
    <h4>{heading}</h4>
    <dl>
      <div><dt>{t('Result')}</dt><dd>{outcomeLabel(record.outcome)}</dd></div>
      <div><dt>{t('Duration')}</dt><dd>{record.durationMs === undefined ? '—' : formatDuration(record.durationMs)}</dd></div>
      {(record.requestedAttempts > 1 || record.completedAttempts !== record.requestedAttempts) && <div><dt>{t('Attempts')}</dt><dd>{formatNumber(record.completedAttempts)}/{formatNumber(record.requestedAttempts)}</dd></div>}
      <div><dt>{t('Run started')}</dt><dd><time dateTime={dateTimeAttribute(source.startedAt)}>{formatDateTime(source.startedAt)}</time></dd></div>
    </dl>
    {record.evidenceId && (record.evidenceAvailable ? <button type="button" onClick={() => onOpenEvidence(record.evidenceId!)}>{t('Open evidence')}</button> : <small>{t('Evidence expired')}</small>)}
  </section>;
  return <div id={id} className="case-compare">
    {column(t('Baseline'), previous, baseline)}
    {column(t('This run'), current, currentRun)}
    {(delta || changed) && <p className="case-compare__note">{delta && <span>{t('Duration change: {delta}', { delta })}</span>}{changed && <span>{t(changed === 'definition' ? 'The case definition differs, so results may not be comparable.' : 'Settings differ, so results may not be comparable.')}</span>}</p>}
  </div>;
}
