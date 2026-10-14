import React from 'react';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './SettingsWorkspace';
import { formatNumber, t } from './i18n';
import { issuePathText, issueSection, type LocatedIssue } from './profileIssueLocation';

/**
 * Profile issues as a list that says what is wrong and where: each item names the settings section and the
 * Profile path, with a button that opens that section. `limit` keeps a banner short; the rest are counted.
 */
export function ProfileIssueList({ issues, limit = issues.length, onGoTo, hideSection = false, disabled = false, className = '' }: {
  issues: readonly LocatedIssue[];
  limit?: number;
  /** Opens a settings section; leave out where the section cannot fix the issue. */
  onGoTo?: (section: SettingsSectionId) => void;
  /** Inside the section itself, name only the Profile path. */
  hideSection?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  const shown = issues.slice(0, limit);
  return <ul className={`profile-issue-list ${className}`}>
    {shown.map((issue, index) => {
      const section = issueSection(issue.path);
      const sectionLabel = t(SETTINGS_SECTIONS.find((item) => item.id === section)!.label);
      const where = issuePathText(issue.path);
      return <li key={`${index}-${issue.message}`} className={`profile-issue-list__item is-${issue.severity}`}>
        <span className="profile-issue-list__message">{issue.message}</span>
        <span className="profile-issue-list__where">
          {onGoTo
            ? <button type="button" className="link-button" disabled={disabled} aria-label={t('Go to {section}: {message}', { section: sectionLabel, message: issue.message })} onClick={() => onGoTo(section)}>{t('Go to {section}', { section: sectionLabel })}</button>
            : !hideSection && <span>{sectionLabel}</span>}
          {where && <code>{where}</code>}
        </span>
      </li>;
    })}
    {issues.length > shown.length && <li className="profile-issue-list__more">{t('{count} more', { count: formatNumber(issues.length - shown.length) })}</li>}
  </ul>;
}
