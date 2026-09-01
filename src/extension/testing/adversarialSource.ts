import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { parseAdversarialCsv } from './adversarialCsv';
import { createAdversarialSuite, normalizeAdversarialSuite, parseAdversarialSuite } from './adversarialSuite';

export interface ParsedAdversarialSource {
  suite?: AdversarialSuiteDefinition;
  scenarios: ScenarioDefinition[];
  issues: string[];
}

/** Parse a linked adversarial source without rewriting or converting its file. */
export function parseAdversarialSource(path: string, text: string): ParsedAdversarialSource {
  if (/\.csv$/iu.test(path)) {
    const parsed = parseAdversarialCsv(text);
    const issues = parsed.issues.map((issue) => `${path}:${issue.row}${issue.column ? `:${issue.column}` : ''}: ${issue.message}`);
    if (issues.length) return { scenarios: [], issues };
    const suite = createAdversarialSuite(csvSuiteId(path), csvSuiteName(path), parsed.scenarios);
    return { suite, scenarios: parsed.scenarios, issues: [] };
  }

  const parsed = parseAdversarialSuite(text);
  if (parsed.parseErrors.length) return { scenarios: [], issues: [`${path}: The source is not valid JSONC.`] };
  if (!parsed.suite) return { scenarios: [], issues: [`${path}: The source is empty.`] };
  const issues = parsed.issues.map((issue) => `${path}:${issue.path}: ${issue.message}`);
  return { suite: issues.length ? undefined : parsed.suite, scenarios: issues.length ? [] : normalizeAdversarialSuite(parsed.suite), issues };
}

function csvSuiteId(path: string): string {
  const base = path.split('/').at(-1)?.replace(/(?:\.adversarial)?\.csv$/iu, '') ?? 'csv';
  const slug = base.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'csv';
  return `${slug}-${stableHash(path.toLocaleLowerCase())}`;
}

function csvSuiteName(path: string): string {
  const file = path.split('/').at(-1) ?? path;
  const name = file.replace(/(?:\.adversarial)?\.csv$/iu, '').replace(/[-_]+/gu, ' ').trim();
  return name || file;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-7);
}
