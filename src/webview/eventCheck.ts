import type { ContractCaseCatalog } from '../shared/protocol';
import type { ScenarioAssertionDefinition, TurnStageProfile } from '../shared/types';

/** Longest reply excerpt turned into a "reply contains" check; longer text is cut at a word boundary. */
export const MAX_CHECK_TEXT = 120;

export type EventCheckKind = 'event-type' | 'reply-contains' | 'tool-called';
export interface EventCheckOption { kind: EventCheckKind; value: string; assertion: ScenarioAssertionDefinition }

/**
 * Checks that can be built from one normalized event. Each is evaluated once the case finishes,
 * so it holds no matter which turn produced the event.
 */
export function eventCheckOptions(event: Record<string, unknown>): EventCheckOption[] {
  const options: EventCheckOption[] = [];
  const type = typeof event.type === 'string' ? event.type.trim() : '';
  if (type) options.push({ kind: 'event-type', value: type, assertion: { path: 'events.normalized[*].type', operator: 'contains', value: type } });
  const text = typeof event.text === 'string' ? excerpt(event.text) : '';
  if (text && /^content\.(?:text|markdown)\./u.test(type)) options.push({ kind: 'reply-contains', value: text, assertion: { path: 'assistant.text', operator: 'contains', value: text } });
  const tool = typeof event.name === 'string' ? event.name.trim() : '';
  if (tool && type.startsWith('tool.')) options.push({ kind: 'tool-called', value: tool, assertion: { path: 'events.normalized[*].name', operator: 'contains', value: tool } });
  return options;
}

function excerpt(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length <= MAX_CHECK_TEXT) return text;
  const cut = text.slice(0, MAX_CHECK_TEXT);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > MAX_CHECK_TEXT / 2 ? cut.slice(0, boundary) : cut).trim();
}

export type CheckTarget =
  | { kind: 'inline'; key: string; name: string; index: number }
  | { kind: 'linked'; key: string; name: string; sourcePath: string; scenarioId: string; suiteName?: string };

/** General cases a check can be added to: cases stored in the Profile, then cases in linked suites. */
export function checkTargets(profile: TurnStageProfile, catalog: ContractCaseCatalog | undefined): CheckTarget[] {
  const inline = (profile.tests?.scenarios ?? []).flatMap((scenario, index) => scenario.adversarial ? [] : [{ kind: 'inline' as const, key: `inline:${scenario.id}`, name: scenario.name?.trim() || scenario.id, index }]);
  const linked = (catalog?.entries ?? []).map((entry) => ({ kind: 'linked' as const, key: `linked:${entry.sourcePath}:${entry.scenarioId}`, name: entry.scenarioName?.trim() || entry.scenarioId, sourcePath: entry.sourcePath, scenarioId: entry.scenarioId, ...(entry.suiteName ? { suiteName: entry.suiteName } : {}) }));
  return [...inline, ...linked];
}

/** True when the case already has an identical scenario-level check, so adding it again would do nothing. */
export function hasAssertion(existing: readonly ScenarioAssertionDefinition[] | undefined, assertion: ScenarioAssertionDefinition): boolean {
  return (existing ?? []).some((item) => item.path === assertion.path && item.operator === assertion.operator && JSON.stringify(item.value) === JSON.stringify(assertion.value));
}
