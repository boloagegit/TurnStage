import React from 'react';
import type { TurnStageProfile } from '../shared/types';
import { SETTINGS_SECTIONS } from './SettingsWorkspace';
import { formatNumber, t } from './i18n';
import { issuePathText, issueTarget, type IssueTarget, type LocatedIssue } from './profileIssueLocation';

/** The place an issue is fixed, as its tab or section is labelled. */
export function issueTargetLabel(target: IssueTarget): string {
  if (target.kind === 'cases') return t(target.pane === 'tests' ? 'General tests' : 'Red Team');
  return t(SETTINGS_SECTIONS.find((item) => item.id === target.section)!.label);
}

/**
 * Profile issues as a list that says what is wrong and where: each item names the settings section or test pane
 * and the Profile path, with a button that opens it when the caller can. `limit` keeps the list short; the rest
 * are counted.
 */
export function ProfileIssueList({ issues, profile, limit = issues.length, onGoTo, canGoTo = (target) => target.kind === 'settings', hideSection = false, disabled = false, className = '' }: {
  issues: readonly LocatedIssue[];
  /** Tells red-team cases from general test cases. */
  profile?: TurnStageProfile;
  limit?: number;
  /** Opens where an issue is fixed. */
  onGoTo?: (target: IssueTarget) => void;
  /** Which targets `onGoTo` can open; settings sections by default. Others are named without a button. */
  canGoTo?: (target: IssueTarget) => boolean;
  /** Inside the section itself, name only the Profile path. */
  hideSection?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const shown = issues.slice(0, limit);
  return <ul className={`profile-issue-list ${className}`}>
    {shown.map((issue, index) => {
      const target = issueTarget(issue.path, profile);
      const label = issueTargetLabel(target);
      const where = issuePathText(issue.path);
      return <li key={`${index}-${issue.message}`} className={`profile-issue-list__item is-${issue.severity}`}>
        <span className="profile-issue-list__message">{issue.message}</span>
        <span className="profile-issue-list__where">
          {onGoTo && canGoTo(target)
            ? <button type="button" className="link-button" disabled={disabled} aria-label={t('Go to {section}: {message}', { section: label, message: issue.message })} onClick={() => onGoTo(target)}>{t('Go to {section}', { section: label })}</button>
            : !hideSection && <span>{label}</span>}
          {where && <code>{where}</code>}
        </span>
      </li>;
    })}
    {issues.length > shown.length && <li className="profile-issue-list__more">{t('{count} more', { count: formatNumber(issues.length - shown.length) })}</li>}
  </ul>;
}
