import type { TurnStageProfile } from '../shared/types';
import type { SettingsSectionId } from './SettingsWorkspace';

export interface LocatedIssue { severity: 'error' | 'warning'; message: string; path?: ReadonlyArray<string | number> }

/** Where a Profile issue is fixed: a settings section, or the General tests or Red Team pane that edits test cases. */
export type IssueTarget =
  | { kind: 'settings'; section: SettingsSectionId }
  | { kind: 'cases'; pane: 'tests'; section: 'scenarios' }
  | { kind: 'cases'; pane: 'adversarial'; section: 'cases' | 'campaigns' };

/**
 * Where the Profile value at `path` is edited. Request variants and the stop request are edited with the opening
 * flow; inline cases, linked suites, and campaigns in the test panes; values outside any section (identity,
 * environment, secret references) in General. `profile` tells a red-team case from a general test case.
 */
export function issueTarget(path: ReadonlyArray<string | number> | undefined, profile?: TurnStageProfile): IssueTarget {
  const [first, second, third] = path ?? [];
  if (first === 'tests') {
    if (second === 'scenarios') return typeof third === 'number' && profile?.tests?.scenarios?.[third]?.adversarial ? { kind: 'cases', pane: 'adversarial', section: 'cases' } : { kind: 'cases', pane: 'tests', section: 'scenarios' };
    if (second === 'contractSuites') return { kind: 'cases', pane: 'tests', section: 'scenarios' };
    if (second === 'adversarialSuites') return { kind: 'cases', pane: 'adversarial', section: 'cases' };
    if (second === 'campaigns') return { kind: 'cases', pane: 'adversarial', section: 'campaigns' };
    return { kind: 'settings', section: 'scenario-tests' };
  }
  return { kind: 'settings', section: settingsSection(first, second, third) };
}

function settingsSection(first: unknown, second: unknown, third: unknown): SettingsSectionId {
  if (first === 'opening') return 'opening-flow';
  if (first === 'conversation') return second === 'stop' || third === 'variants' ? 'opening-flow' : 'request';
  if (first === 'stream') return 'stream-mapping';
  if (first === 'ui') return 'chat-ui';
  if (first === 'history' || first === 'errorPolicy' || first === 'metrics') return 'history-errors';
  if (first === 'security') return 'security';
  return 'general';
}

/** The settings section that fixes an issue, or undefined when it is fixed in a test pane. */
export function issueSection(path: ReadonlyArray<string | number> | undefined): SettingsSectionId | undefined {
  const target = issueTarget(path);
  return target.kind === 'settings' ? target.section : undefined;
}

/** A Profile path as people read it, such as `opening.starters[2]`; empty for the Profile root. */
export function issuePathText(path: ReadonlyArray<string | number> | undefined): string {
  return (path ?? []).reduce<string>((text, part) => typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${part}` : part, '');
}
