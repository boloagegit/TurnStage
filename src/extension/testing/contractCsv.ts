import type { ScenarioDefinition } from '../../shared/types';
import { parseCsvRows } from './adversarialCsv';
import { createContractSuite, MAX_CONTRACT_CASES_PER_SUITE, MAX_CONTRACT_STEPS_PER_SUITE, validateContractSuite } from './contractSuite';

export const CONTRACT_CSV_COLUMNS = ['case_id', 'case_name', 'description', 'tags', 'enabled', 'turn_index', 'turn_id', 'turn_name', 'user_message', 'step_assertions_json', 'case_assertions_json', 'source_binding_json', 'controls_json', 'comparison_json', 'performance_json', 'faults_json'] as const;
const REQUIRED = ['case_id', 'case_name', 'enabled', 'turn_index', 'turn_id', 'user_message'] as const;
export interface ContractCsvIssue { row: number; column?: string; message: string }
export interface ParsedContractCsv { scenarios: ScenarioDefinition[]; issues: ContractCsvIssue[]; rowCount: number }

export function parseContractCsv(text: string): ParsedContractCsv {
  const rows = parseCsvRows(text.replace(/^\uFEFF/u, ''));
  if (!rows.length) return { scenarios: [], issues: [{ row: 1, message: 'CSV is empty.' }], rowCount: 0 };
  const header = rows[0]!.map((cell) => cell.trim().toLocaleLowerCase());
  const missing = REQUIRED.filter((column) => !header.includes(column));
  if (missing.length) return { scenarios: [], issues: missing.map((column) => ({ row: 1, column, message: `Missing required column: ${column}.` })), rowCount: Math.max(0, rows.length - 1) };
  if (new Set(header).size !== header.length) return { scenarios: [], issues: [{ row: 1, message: 'CSV column names must be unique.' }], rowCount: Math.max(0, rows.length - 1) };
  const records = rows.slice(1).filter((row) => row.some((cell) => cell.trim())).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ''])) as Record<string, string>);
  if (records.length > MAX_CONTRACT_STEPS_PER_SUITE) return { scenarios: [], issues: [{ row: 1, message: `CSV can contain at most ${MAX_CONTRACT_STEPS_PER_SUITE} turn rows.` }], rowCount: records.length };
  const issues: ContractCsvIssue[] = [];
  const groups = new Map<string, Array<{ row: number; value: Record<string, string> }>>();
  records.forEach((value, index) => {
    const row = index + 2;
    const caseId = field(value, 'case_id').trim();
    if (!caseId) { issues.push({ row, column: 'case_id', message: 'case_id is required.' }); return; }
    const entries = groups.get(caseId) ?? [];
    entries.push({ row, value }); groups.set(caseId, entries);
  });
  if (groups.size > MAX_CONTRACT_CASES_PER_SUITE) return { scenarios: [], issues: [{ row: 1, message: `CSV can contain at most ${MAX_CONTRACT_CASES_PER_SUITE} cases.` }], rowCount: records.length };
  const scenarios: ScenarioDefinition[] = [];
  for (const [caseId, entries] of groups) {
    const first = entries[0]!;
    validateConsistent(entries, ['case_name', 'description', 'tags', 'enabled', 'case_assertions_json', 'source_binding_json', 'controls_json', 'comparison_json', 'performance_json', 'faults_json'], issues);
    const turns = entries.map(({ row, value }) => ({
      row,
      index: integer(field(value, 'turn_index'), row, 'turn_index', issues),
      step: {
        id: field(value, 'turn_id').trim(),
        name: field(value, 'turn_name').trim() || undefined,
        input: field(value, 'user_message'),
        assertions: json(value, 'step_assertions_json', row, issues, undefined),
      },
    })).sort((left, right) => left.index - right.index);
    turns.forEach((turn, index) => { if (turn.index !== index + 1) issues.push({ row: turn.row, column: 'turn_index', message: `turn_index must form the sequence 1 through ${turns.length}.` }); });
    const name = field(first.value, 'case_name').trim();
    if (!name) issues.push({ row: first.row, column: 'case_name', message: 'case_name is required.' });
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(caseId)) issues.push({ row: first.row, column: 'case_id', message: 'case_id must use lowercase letters, numbers, and hyphens.' });
    if (!boolean(field(first.value, 'enabled'), true, first.row, 'enabled', issues)) continue;
    scenarios.push(compact({
      id: caseId,
      name,
      description: field(first.value, 'description').trim() || undefined,
      tags: json(first.value, 'tags', first.row, issues, undefined),
      sourceBinding: json(first.value, 'source_binding_json', first.row, issues, undefined),
      controls: json(first.value, 'controls_json', first.row, issues, undefined),
      steps: turns.map((turn) => compact(turn.step)),
      assertions: json(first.value, 'case_assertions_json', first.row, issues, undefined),
      comparison: json(first.value, 'comparison_json', first.row, issues, undefined),
      performance: json(first.value, 'performance_json', first.row, issues, undefined),
      faults: json(first.value, 'faults_json', first.row, issues, undefined),
    }) as ScenarioDefinition);
  }
  if (!issues.length) for (const suiteIssue of validateContractSuite(createContractSuite('csv-import', 'CSV import', scenarios))) issues.push({ row: 1, message: `${suiteIssue.path}: ${suiteIssue.message}` });
  return { scenarios: issues.length ? [] : scenarios, issues, rowCount: records.length };
}

export function serializeContractCsv(scenarios: readonly ScenarioDefinition[]): string {
  const rows: string[][] = [[...CONTRACT_CSV_COLUMNS]];
  for (const scenario of scenarios.filter((value) => !value.adversarial)) scenario.steps.forEach((step, index) => rows.push([
    scenario.id, scenario.name, scenario.description ?? '', JSON.stringify(scenario.tags ?? []), 'true', String(index + 1), step.id, step.name ?? '', step.input,
    optionalJson(step.assertions), optionalJson(scenario.assertions), optionalJson(scenario.sourceBinding), optionalJson(scenario.controls), optionalJson(scenario.comparison), optionalJson(scenario.performance), optionalJson(scenario.faults),
  ]));
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function contractCsvTemplate(): string {
  return serializeContractCsv([{ id: 'sample-conversation', name: 'Sample conversation', steps: [{ id: 'ask', input: 'Summarize the current state.', assertions: [{ path: 'assistant.text', operator: 'exists' }] }], assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }]);
}

function json(value: Record<string, string>, column: string, row: number, issues: ContractCsvIssue[], fallback: undefined): unknown {
  const source = field(value, column).trim();
  if (!source) return fallback;
  try { return JSON.parse(source) as unknown; } catch { issues.push({ row, column, message: `${column} must contain valid JSON.` }); return fallback; }
}
function optionalJson(value: unknown): string { return value === undefined ? '' : JSON.stringify(value); }
function integer(value: string, row: number, column: string, issues: ContractCsvIssue[]): number { const parsed = Number(value); if (!Number.isInteger(parsed)) issues.push({ row, column, message: `${column} must be an integer.` }); return Number.isInteger(parsed) ? parsed : 0; }
function boolean(value: string, fallback: boolean, row: number, column: string, issues: ContractCsvIssue[]): boolean { const normalized = value.trim().toLocaleLowerCase(); if (!normalized) return fallback; if (['true', 'yes', '1'].includes(normalized)) return true; if (['false', 'no', '0'].includes(normalized)) return false; issues.push({ row, column, message: `${column} must be true or false.` }); return fallback; }
function validateConsistent(entries: Array<{ row: number; value: Record<string, string> }>, columns: string[], issues: ContractCsvIssue[]): void { const first = entries[0]!; for (const column of columns) for (const entry of entries.slice(1)) if (field(entry.value, column).trim() !== field(first.value, column).trim()) issues.push({ row: entry.row, column, message: `${column} must be identical for every row in the same case.` }); }
function field(value: Record<string, string>, key: string): string { const entry = value[key] ?? ''; return /^'[=+\-@]/u.test(entry) ? entry.slice(1) : entry; }
function csvCell(value: string): string { const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value; return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T; }
