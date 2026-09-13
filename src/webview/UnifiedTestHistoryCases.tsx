import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { TestRunCaseRecord, TestRunDifference, TestRunHistoryRecord } from '../shared/testRunHistory';
import { formatNumber, t } from './i18n';

interface HistoryCaseRow { item: TestRunCaseRecord; difference?: TestRunDifference; removed: boolean }

export function UnifiedTestHistoryCases({ run, baseline, kind, differences, onOpenEvidence, outcomeLabel, differenceLabel }: {
  run: TestRunHistoryRecord;
  baseline?: TestRunHistoryRecord;
  kind: 'all' | 'contract' | 'adversarial';
  differences: ReadonlyMap<string, TestRunDifference>;
  onOpenEvidence: (evidenceId: string) => void;
  outcomeLabel: (outcome: TestRunCaseRecord['outcome']) => string;
  differenceLabel: (difference: TestRunDifference) => string;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const rows = useMemo<HistoryCaseRow[]>(() => [
    ...run.cases.map((item) => ({ item, difference: differences.get(item.key), removed: false })),
    ...(baseline?.cases.filter((item) => differences.get(item.key) === 'removed-case').map((item) => ({ item, difference: 'removed-case' as const, removed: true })) ?? []),
  ], [run, baseline, differences]);
  const filtered = useMemo(() => rows.filter(({ item }) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (!deferredQuery) return true;
    return [item.name, item.scenarioId, item.suiteId ?? '', item.kind].some((value) => value.toLocaleLowerCase().includes(deferredQuery));
  }), [rows, kind, deferredQuery]);
  useEffect(() => setPage(0), [run.id, kind, deferredQuery]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const boundedPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(boundedPage * 25, (boundedPage + 1) * 25);
  return <div className="unified-history-cases">
    <label className="unified-history-cases__search"><span>{t('Search run cases')}</span><input type="search" value={query} placeholder={t('Case name, ID, or type')} onChange={(event) => setQuery(event.target.value)} /></label>
    {!filtered.length ? <p className="unified-test-history__empty">{t('No cases match this search.')}</p> : <>
      <ul className="unified-test-history__cases">{visible.map(({ item, difference, removed }) => <li key={`${removed ? 'removed:' : ''}${item.key}`}><div className="unified-history-cases__identity"><span className="unified-test-history__case-name" title={item.name}>{item.name}</span><small>{t(item.kind === 'contract' ? 'General' : 'Red Team')} · {item.scenarioId}{item.suiteId ? ` · ${item.suiteId}` : ''}</small></div><span>{removed ? '—' : outcomeLabel(item.outcome)}</span>{difference && <span>{differenceLabel(difference)}</span>}{!removed && item.requestedAttempts > 1 && <span>{formatNumber(item.completedAttempts)}/{formatNumber(item.requestedAttempts)} {t('attempts')}</span>}{!removed && item.evidenceId && (item.evidenceAvailable ? <button type="button" onClick={() => onOpenEvidence(item.evidenceId!)}>{t('Open evidence')}</button> : <small>{t('Evidence expired')}</small>)}</li>)}</ul>
      <nav className="unified-history-cases__pagination" aria-label={t('Result pages')}><span>{t('Showing {start}–{end} of {total}', { start: formatNumber(boundedPage * 25 + 1), end: formatNumber(Math.min(filtered.length, (boundedPage + 1) * 25)), total: formatNumber(filtered.length) })}</span><button type="button" disabled={boundedPage === 0} onClick={() => setPage(boundedPage - 1)}>{t('Previous page')}</button><span>{formatNumber(boundedPage + 1)} / {formatNumber(pageCount)}</span><button type="button" disabled={boundedPage === pageCount - 1} onClick={() => setPage(boundedPage + 1)}>{t('Next page')}</button></nav>
    </>}
  </div>;
}
