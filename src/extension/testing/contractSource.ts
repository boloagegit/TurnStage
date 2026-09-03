import type { ContractSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { parseContractCsv } from './contractCsv';
import { createContractSuite, normalizeContractSuite, parseContractSuite } from './contractSuite';

export interface ParsedContractSource { suite?: ContractSuiteDefinition; scenarios: ScenarioDefinition[]; issues: string[] }

export function parseContractSource(path: string, text: string): ParsedContractSource {
  if (/\.csv$/iu.test(path)) {
    const parsed = parseContractCsv(text);
    const issues = parsed.issues.map((entry) => `${path}:${entry.row}${entry.column ? `:${entry.column}` : ''}: ${entry.message}`);
    if (issues.length) return { scenarios: [], issues };
    const suite = createContractSuite(csvSuiteId(path), csvSuiteName(path), parsed.scenarios);
    return { suite, scenarios: parsed.scenarios, issues: [] };
  }
  const parsed = parseContractSuite(text);
  if (parsed.parseErrors.length) return { scenarios: [], issues: [`${path}: The source is not valid JSONC.`] };
  if (!parsed.suite) return { scenarios: [], issues: [`${path}: The source is empty.`] };
  const issues = parsed.issues.map((entry) => `${path}:${entry.path}: ${entry.message}`);
  return { suite: issues.length ? undefined : parsed.suite, scenarios: issues.length ? [] : normalizeContractSuite(parsed.suite), issues };
}

function csvSuiteId(path: string): string { const base = path.split('/').at(-1)?.replace(/(?:\.tests)?\.csv$/iu, '') ?? 'csv'; const slug = base.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'csv'; return `${slug}-${stableHash(path.toLocaleLowerCase())}`; }
function csvSuiteName(path: string): string { const file = path.split('/').at(-1) ?? path; return file.replace(/(?:\.tests)?\.csv$/iu, '').replace(/[-_]+/gu, ' ').trim() || file; }
function stableHash(value: string): string { let hash = 0x811c9dc5; for (const character of value) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 0x01000193) >>> 0; } return hash.toString(36).padStart(7, '0').slice(-7); }
