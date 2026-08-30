import type { MatchCondition, OpeningDefinition } from '../../shared/types';
import { getPath } from '../request/templateResolver';
import { isSafeRegexPattern } from '../../shared/regexSafety';

export function selectOpeningFallback(opening: OpeningDefinition, data: unknown, metadata: { status?: number; missingMessage?: boolean; errorType?: string }): NonNullable<OpeningDefinition['fallbacks']>[number] | undefined {
  return opening.fallbacks?.find((fallback) => {
    if (!fallback.match) return true;
    const condition = fallback.match; const root = { response: { status: metadata.status, missingMessage: metadata.missingMessage }, error: { type: metadata.errorType } };
    const actual = condition.path?.startsWith('response.') || condition.path?.startsWith('error.') ? getPath(root, condition.path) : getPath(data, condition.path ?? '$');
    return conditionMatches(condition, actual);
  });
}

function conditionMatches(condition: MatchCondition, actual: unknown): boolean {
  const expected = condition.value;
  switch (condition.operator ?? 'equals') {
    case 'equals': return actual === expected;
    case 'notEquals': return actual !== expected;
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'oneOf': return Array.isArray(expected) && expected.includes(actual);
    case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected));
    case 'startsWith': return String(actual ?? '').startsWith(String(expected));
    case 'endsWith': return String(actual ?? '').endsWith(String(expected));
    case 'regex': return isSafeRegexPattern(expected) && new RegExp(expected, 'u').test(String(actual ?? '').slice(0, 4096));
  }
}
