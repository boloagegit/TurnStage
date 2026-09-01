import type { MappingRule, NormalizedEvent, RawStreamEvent, StreamDefinition } from '../../shared/types';
import { getPath } from '../request/templateResolver';
import { localize } from '../l10n';
import { isSafeRegexPattern } from '../../shared/regexSafety';

interface CompiledRule { rule: MappingRule; regex?: RegExp; compileError?: string }

function match(compiled: CompiledRule, raw: RawStreamEvent): boolean {
  if (compiled.compileError) throw new Error(compiled.compileError);
  const rule = compiled.rule;
  const condition = rule.match;
  if (condition.event !== undefined && raw.sse?.event !== condition.event) return false;
  if (!condition.path) return condition.event !== undefined || Object.keys(condition).length === 0;
  const actual = getPath(raw.data, condition.path);
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
    case 'regex': return compiled.regex?.test(String(actual ?? '').slice(0, 4096)) ?? false;
  }
}

function extract(value: unknown, raw: RawStreamEvent): unknown {
  if (Array.isArray(value)) return value.map((item) => extract(item, raw));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.path === 'string' && Object.keys(object).length === 1) return getPath(raw.data, object.path);
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, extract(child, raw)]));
  }
  return value;
}

export interface MappingResult { events: NormalizedEvent[]; ruleIds: string[]; errors: Array<{ ruleId: string; message: string }> }

export class MappingEngine {
  private readonly rules: CompiledRule[];
  constructor(private readonly stream: StreamDefinition) {
    this.rules = stream.mappings.map((source) => {
      const rule = { ...source, match: { ...source.match }, emit: structuredClone(source.emit) };
      if (rule.match.operator !== 'regex') return { rule };
      if (!isSafeRegexPattern(rule.match.value)) return { rule, compileError: localize('Invalid or unsafe regular expression.') };
      try { return { rule, regex: new RegExp(rule.match.value, 'u') }; } catch { return { rule, compileError: localize('Invalid regular expression.') }; }
    });
  }
  map(raw: RawStreamEvent): MappingResult {
    const events: NormalizedEvent[] = []; const ruleIds: string[] = []; const errors: Array<{ ruleId: string; message: string }> = [];
    for (const compiled of this.rules) {
      const rule = compiled.rule;
      try {
        if (!match(compiled, raw)) continue;
        ruleIds.push(rule.id);
        const extracted = extract(rule.emit, raw) as Record<string, unknown>;
        events.push({
          version: 1,
          ...extracted,
          type: String(extracted.type),
          sequence: raw.sequence,
          ...(raw.turnId === undefined ? {} : { turnId: raw.turnId }),
          ...(raw.turnIndex === undefined ? {} : { turnIndex: raw.turnIndex }),
          ...(raw.turnSequence === undefined ? {} : { turnSequence: raw.turnSequence }),
          receivedAt: raw.receivedAt,
          rawSequence: raw.sequence,
          mappingRuleId: rule.id,
        });
        if (this.stream.mappingMode !== 'allMatches' && !rule.continue) break;
      } catch (error) { errors.push({ ruleId: rule.id, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { events, ruleIds, errors };
  }
}
