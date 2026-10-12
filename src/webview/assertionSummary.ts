import type { ScenarioAssertionDefinition } from '../shared/types';
import { t } from './i18n';

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/**
 * One plain sentence for a check, so a reviewer can read what a case verifies without decoding
 * paths and operators. Unknown combinations return undefined and the fields speak for themselves.
 */
export function describeAssertion(assertion: ScenarioAssertionDefinition): string | undefined {
  const { path, operator, value } = assertion;
  if (assertion.message?.trim() && path === 'assistant.text' && operator === 'regex' && value === '\\S') return t('The reply is not empty.');
  if (path === 'turn.state' && operator === 'equals' && value === 'completed') return t('The turn completes.');
  if (path === 'events.normalized[*].type' && operator === 'sequenceContains' && Array.isArray(value)) return t('These events occur in this order: {events}', { events: value.map(String).join(' → ') });
  if (path === 'events.normalized[*].type' && operator === 'contains') return t('The case produces a {value} event', { value: short(value) });
  if (path === 'events.normalized[*].name' && operator === 'contains') return t('The tool {value} is called', { value: short(value) });
  if (path === 'assistant.text' && operator === 'contains') return t('The final reply contains “{value}”', { value: short(value) });
  if (path === 'assistant.text' && operator === 'exists') return t('There is a reply.');
  if (path === 'metrics.parseErrorCount' && operator === 'equals' && value === 0) return t('No stream data fails to parse.');
  if (path === 'metrics.mappingErrorCount' && operator === 'equals' && value === 0) return t('No stream event fails its mapping.');
  if (path === 'metrics.unmatchedEventCount' && operator === 'equals' && value === 0) return t('Every stream event matches a mapping.');
  return undefined;
}
