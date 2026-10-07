import React, { memo, useMemo } from 'react';
import type { CaseOutcomeFilter, CaseOutcomeInfo } from './liveCaseStatus';
import { formatDateTime, formatNumber, t } from './i18n';

export interface CaseResultCounts { passed: number; failed: number; attention: number; notRun: number }

/** Counts the last recorded result of every case currently in the suite; deleted cases are ignored. */
export function caseResultCounts(caseKeys: readonly string[], outcomes: ReadonlyMap<string, CaseOutcomeInfo>): CaseResultCounts {
  const counts: CaseResultCounts = { passed: 0, failed: 0, attention: 0, notRun: 0 };
  for (const key of caseKeys) {
    const tone = outcomes.get(key)?.tone;
    if (tone === 'passed') counts.passed += 1;
    else if (tone === 'failed') counts.failed += 1;
    else if (tone === 'attention') counts.attention += 1;
    else counts.notRun += 1;
  }
  return counts;
}

/**
 * The case list's header when results exist: when the suite last ran, how it went,
 * and filters that turn the case list into the failure list. One list, not two.
 */
export const CaseRunSummary = memo(function CaseRunSummary({ caseKeys, outcomes, lastRunAt, filter, onFilterChange, rerunCount, rerunDisabled, onRerun, onViewHistory }: {
  caseKeys: readonly string[];
  outcomes: ReadonlyMap<string, CaseOutcomeInfo>;
  lastRunAt: number;
  filter: CaseOutcomeFilter;
  onFilterChange: (filter: CaseOutcomeFilter) => void;
  rerunCount: number;
  rerunDisabled: boolean;
  onRerun: () => void;
  onViewHistory: () => void;
}): React.JSX.Element {
  const counts = useMemo(() => caseResultCounts(caseKeys, outcomes), [caseKeys, outcomes]);
  const failing = counts.failed + counts.attention;
  const filters: Array<{ id: CaseOutcomeFilter; label: string; count: number }> = [
    { id: 'all', label: t('All'), count: caseKeys.length },
    { id: 'failed', label: t('Failed'), count: failing },
    { id: 'notRun', label: t('Not run'), count: counts.notRun },
  ];
  return <section className="case-run-summary" aria-label={t('Last results')}>
    <div className="case-run-summary__head">
      <div className="case-run-summary__text">
        <strong>{t('Last run {date}', { date: formatDateTime(lastRunAt) })}</strong>
        <span className="case-run-summary__tally">{t('{passed} passed · {failed} failed · {notRun} not run', { passed: formatNumber(counts.passed), failed: formatNumber(failing), notRun: formatNumber(counts.notRun) })}</span>
      </div>
      <div className="case-run-summary__actions">
        {rerunCount > 0 && <button type="button" disabled={rerunDisabled} onClick={onRerun}>{t('Rerun failed ({count})', { count: formatNumber(rerunCount) })}</button>}
        <button type="button" className="case-run-summary__history" onClick={onViewHistory}>{t('Run history')}</button>
      </div>
    </div>
    <div className="test-run-meter case-run-summary__meter" aria-hidden="true">
      {counts.passed > 0 && <span className="test-run-meter__passed" style={{ flex: `${counts.passed} 1 0` }} />}
      {counts.failed > 0 && <span className="test-run-meter__failed" style={{ flex: `${counts.failed} 1 0` }} />}
      {counts.attention > 0 && <span className="test-run-meter__attention" style={{ flex: `${counts.attention} 1 0` }} />}
      {counts.notRun > 0 && <span className="test-run-meter__queued" style={{ flex: `${counts.notRun} 1 0` }} />}
    </div>
    <div className="case-run-summary__filters" role="group" aria-label={t('Filter cases by last result')}>
      {filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} aria-label={`${item.label} (${formatNumber(item.count)})`} onClick={() => onFilterChange(item.id)}>{item.label}<span className="case-run-summary__count" aria-hidden="true">{formatNumber(item.count)}</span></button>)}
    </div>
  </section>;
});
