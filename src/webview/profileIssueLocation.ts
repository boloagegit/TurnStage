import type { SettingsSectionId } from './SettingsWorkspace';

export interface LocatedIssue { severity: 'error' | 'warning'; message: string; path?: ReadonlyArray<string | number> }

/**
 * The settings section that edits the Profile value at `path`. Request variants and the stop request are edited
 * with the opening flow; values outside any section (identity, environment, secret references) belong to General.
 */
export function issueSection(path: ReadonlyArray<string | number> | undefined): SettingsSectionId {
  const [first, second] = path ?? [];
  if (first === 'opening') return 'opening-flow';
  if (first === 'conversation') return second === 'stop' || path?.[2] === 'variants' ? 'opening-flow' : 'request';
  if (first === 'stream') return 'stream-mapping';
  if (first === 'ui') return 'chat-ui';
  if (first === 'tests') return 'scenario-tests';
  if (first === 'history' || first === 'errorPolicy' || first === 'metrics') return 'history-errors';
  if (first === 'security') return 'security';
  return 'general';
}

/** A Profile path as people read it, such as `opening.starters[2]`; empty for the Profile root. */
export function issuePathText(path: ReadonlyArray<string | number> | undefined): string {
  return (path ?? []).reduce<string>((text, part) => typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${part}` : part, '');
}
