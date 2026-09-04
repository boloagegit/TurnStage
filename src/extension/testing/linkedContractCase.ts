import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { applyEdits, modify } from 'jsonc-parser';
import type { ContractSuiteCaseDefinition, ContractSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { parseCsvRows } from './adversarialCsv';
import { CONTRACT_CSV_COLUMNS, parseContractCsv, serializeContractCsv } from './contractCsv';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';
import { createContractSuite, isSafeContractSuitePath, validateContractSuite } from './contractSuite';
import { MAX_CONTRACT_SUITE_BYTES } from './contractSuiteRepository';
import { parseContractSource } from './contractSource';

const REVISION_PATTERN = /^[0-9a-f]{64}$/u;
export type LinkedContractSourceFormat = 'csv' | 'jsonc';
export interface EditableLinkedContractCase { sourcePath: string; sourceFormat: LinkedContractSourceFormat; revision: string; scenario: ScenarioDefinition }
export interface SaveLinkedContractCaseInput { profileUri: vscode.Uri; sourcePath: string; scenarioId: string; expectedRevision: string; scenario: ScenarioDefinition; resolveExternal?: (reference: string) => vscode.Uri | undefined }
export type AppendLinkedContractCaseInput = Omit<SaveLinkedContractCaseInput, 'scenarioId' | 'expectedRevision'>;

export class LinkedContractCaseConflictError extends Error {
  constructor() { super('The linked test suite changed after this editor loaded it. Reload the case before saving.'); this.name = 'LinkedContractCaseConflictError'; }
}

export async function loadEditableLinkedContractCase(profileUri: vscode.Uri, sourcePath: string, scenarioId: string, resolveExternal?: (reference: string) => vscode.Uri | undefined): Promise<EditableLinkedContractCase> {
  const uri = resolveSuiteUri(profileUri, sourcePath, resolveExternal);
  return editableCaseFromText(sourcePath, await readBoundedSource(uri, sourcePath), scenarioId);
}

export async function saveEditableLinkedContractCase(input: SaveLinkedContractCaseInput): Promise<EditableLinkedContractCase> {
  if (!REVISION_PATTERN.test(input.expectedRevision)) throw new Error('The linked suite revision is invalid. Reload the case before saving.');
  if (input.scenario.adversarial) throw new Error('Functional test suites cannot contain adversarial settings.');
  const uri = resolveSuiteUri(input.profileUri, input.sourcePath, input.resolveExternal);
  const source = await readBoundedSource(uri, input.sourcePath);
  if (digest(source) !== input.expectedRevision) throw new LinkedContractCaseConflictError();
  const updated = updateLinkedContractCaseSource(input.sourcePath, source, input.scenarioId, input.scenario);
  const bytes = new TextEncoder().encode(updated.text);
  if (bytes.byteLength > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${input.sourcePath} exceeds the 5 MB limit after editing.`);
  if (updated.text !== source) await vscode.workspace.fs.writeFile(uri, bytes);
  const persisted = await readBoundedSource(uri, input.sourcePath);
  const saved = editableCaseFromText(input.sourcePath, persisted, input.scenario.id);
  if (saved.revision !== updated.revision) throw new LinkedContractCaseConflictError();
  return saved;
}

export async function appendLinkedContractCase(input: AppendLinkedContractCaseInput): Promise<EditableLinkedContractCase> {
  if (input.scenario.adversarial) throw new Error('Functional test suites cannot contain adversarial settings.');
  const uri = resolveSuiteUri(input.profileUri, input.sourcePath, input.resolveExternal);
  const source = await readBoundedSource(uri, input.sourcePath);
  const updated = appendLinkedContractCaseSource(input.sourcePath, source, input.scenario);
  const bytes = new TextEncoder().encode(updated.text);
  if (bytes.byteLength > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${input.sourcePath} exceeds the 5 MB limit after appending.`);
  if (digest(await readBoundedSource(uri, input.sourcePath)) !== digest(source)) throw new LinkedContractCaseConflictError();
  await vscode.workspace.fs.writeFile(uri, bytes);
  const saved = editableCaseFromText(input.sourcePath, await readBoundedSource(uri, input.sourcePath), input.scenario.id);
  if (saved.revision !== updated.revision) throw new LinkedContractCaseConflictError();
  return saved;
}

export function appendLinkedContractCaseSource(path: string, text: string, scenario: ScenarioDefinition): { text: string; revision: string } {
  if (scenario.adversarial) throw new Error('Functional test suites cannot contain adversarial settings.');
  const parsed = parseContractSource(path, text);
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Test suite ${path} is empty.`);
  if (parsed.suite.cases.some((candidate) => candidate.id === scenario.id)) throw new Error(`Test case ${scenario.id} already exists in ${path}.`);
  const updatedText = /\.csv$/iu.test(path) ? appendCsvCase(text, scenario) : appendJsoncCase(text, parsed.suite, scenario);
  const verified = parseContractSource(path, updatedText);
  if (!verified.suite || verified.issues.length || !verified.scenarios.some((candidate) => candidate.id === scenario.id)) throw new Error(verified.issues.join('\n') || `The appended case ${scenario.id} could not be verified.`);
  return { text: updatedText, revision: digest(updatedText) };
}

export function updateLinkedContractCaseSource(path: string, text: string, scenarioId: string, scenario: ScenarioDefinition): { text: string; revision: string } {
  if (scenario.adversarial) throw new Error('Functional test suites cannot contain adversarial settings.');
  const parsed = parseContractSource(path, text);
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Test suite ${path} is empty.`);
  const updatedText = /\.csv$/iu.test(path) ? updateCsvCase(text, scenarioId, scenario) : updateJsoncCase(text, parsed.suite, scenarioId, scenario);
  const verified = parseContractSource(path, updatedText);
  if (!verified.suite || verified.issues.length) throw new Error(verified.issues.join('\n') || 'The edited test suite is invalid.');
  if (!verified.scenarios.some((candidate) => candidate.id === scenario.id)) throw new Error(`The edited case ${scenario.id} could not be verified.`);
  return { text: updatedText, revision: digest(updatedText) };
}

function editableCaseFromText(path: string, text: string, scenarioId: string): EditableLinkedContractCase {
  const parsed = parseContractSource(path, text);
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Test suite ${path} is empty.`);
  const sourceFormat: LinkedContractSourceFormat = /\.csv$/iu.test(path) ? 'csv' : 'jsonc';
  const scenario = sourceFormat === 'csv'
    ? parsed.scenarios.find((candidate) => candidate.id === scenarioId)
    : caseToScenario(parsed.suite.cases.find((candidate) => candidate.id === scenarioId && candidate.enabled !== false));
  if (!scenario) throw new Error(`Linked test case ${scenarioId} was not found.`);
  return { sourcePath: path, sourceFormat, revision: digest(text), scenario };
}

function caseToScenario(testCase: ContractSuiteCaseDefinition | undefined): ScenarioDefinition | undefined {
  if (!testCase) return undefined;
  const scenario = structuredClone(testCase) as ScenarioDefinition & { enabled?: boolean };
  delete scenario.enabled;
  return scenario;
}

function updateJsoncCase(text: string, suite: ContractSuiteDefinition, scenarioId: string, scenario: ScenarioDefinition): string {
  const caseIndex = suite.cases.findIndex((candidate) => candidate.id === scenarioId && candidate.enabled !== false);
  if (caseIndex < 0) throw new Error(`Linked test case ${scenarioId} was not found.`);
  const existing = suite.cases[caseIndex]!;
  const functionalScenario = structuredClone(scenario);
  delete functionalScenario.adversarial;
  const updated = { ...functionalScenario, ...(existing.enabled === undefined ? {} : { enabled: existing.enabled }) } as ContractSuiteCaseDefinition;
  const nextSuite = { ...suite, cases: suite.cases.map((candidate, index) => index === caseIndex ? updated : candidate) };
  const issues = validateContractSuite(nextSuite);
  if (issues.length) throw new Error(issues.map((entry) => `${entry.path}: ${entry.message}`).join('\n'));
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  let result = text;
  for (const key of ['id', 'name', 'description', 'tags', 'capture', 'sourceBinding', 'controls', 'steps', 'assertions', 'comparison', 'performance', 'faults'] as const) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(updated[key])) result = applyEdits(result, modify(result, ['cases', caseIndex, key], updated[key], { formattingOptions }));
  }
  return result;
}

function appendJsoncCase(text: string, suite: ContractSuiteDefinition, scenario: ScenarioDefinition): string {
  const appended = createContractSuite('captured-case', 'Captured case', [scenario]).cases[0];
  if (!appended) throw new Error('The captured test case could not be serialized.');
  const nextSuite = { ...suite, cases: [...suite.cases, appended] };
  const issues = validateContractSuite(nextSuite);
  if (issues.length) throw new Error(issues.map((entry) => `${entry.path}: ${entry.message}`).join('\n'));
  return applyEdits(text, modify(text, ['cases', suite.cases.length], appended, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
}

function updateCsvCase(text: string, scenarioId: string, scenario: ScenarioDefinition): string {
  const hasBom = text.startsWith('\uFEFF');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = parseCsvRows(hasBom ? text.slice(1) : text);
  const header = rows[0];
  if (!header) throw new Error('CSV is empty.');
  const normalizedHeader = header.map((cell) => cell.trim().toLocaleLowerCase());
  const caseIdIndex = normalizedHeader.indexOf('case_id');
  const turnIdIndex = normalizedHeader.indexOf('turn_id');
  if (caseIdIndex < 0 || turnIdIndex < 0) throw new Error('CSV is missing case_id or turn_id.');
  const matching = rows.slice(1).map((row, index) => ({ row, index: index + 1 })).filter(({ row }) => spreadsheetText(row[caseIdIndex] ?? '') === scenarioId);
  if (!matching.length) throw new Error(`Linked test case ${scenarioId} was not found.`);
  for (const column of CONTRACT_CSV_COLUMNS) if (!normalizedHeader.includes(column)) { header.push(column); normalizedHeader.push(column); for (const row of rows.slice(1)) row.push(''); }
  const generated = parseCsvRows(serializeContractCsv([scenario]).slice(1));
  const generatedHeader = generated[0]!.map((cell) => cell.trim().toLocaleLowerCase());
  const originalsByTurn = new Map(matching.map(({ row }) => [spreadsheetText(row[turnIdIndex] ?? ''), row]));
  const replacement = generated.slice(1).map((generatedRow) => {
    const generatedTurnId = spreadsheetText(generatedRow[generatedHeader.indexOf('turn_id')] ?? '');
    const original = originalsByTurn.get(generatedTurnId);
    return normalizedHeader.map((column, index) => { const generatedIndex = generatedHeader.indexOf(column); return generatedIndex >= 0 ? generatedRow[generatedIndex] ?? '' : original?.[index] ?? ''; });
  });
  const matchingIndexes = new Set(matching.map(({ index }) => index));
  const output: string[][] = [header];
  for (let index = 1; index < rows.length; index++) { if (index === matching[0]!.index) output.push(...replacement); if (!matchingIndexes.has(index)) output.push(rows[index]!); }
  const updated = `${hasBom ? '\uFEFF' : ''}${output.map((row) => row.map(csvCell).join(',')).join(newline)}${newline}`;
  if (parseContractCsv(updated).issues.length) throw new Error('The edited CSV test suite is invalid.');
  return updated;
}

function appendCsvCase(text: string, scenario: ScenarioDefinition): string {
  const hasBom = text.startsWith('\uFEFF');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = parseCsvRows(hasBom ? text.slice(1) : text);
  const header = rows[0];
  if (!header) throw new Error('CSV is empty.');
  const normalizedHeader = header.map((cell) => cell.trim().toLocaleLowerCase());
  const generated = parseCsvRows(serializeContractCsv([scenario]).slice(1));
  const generatedHeader = generated[0]!.map((cell) => cell.trim().toLocaleLowerCase());
  for (const column of generatedHeader) if (!normalizedHeader.includes(column)) { header.push(column); normalizedHeader.push(column); for (const row of rows.slice(1)) row.push(''); }
  const additions = generated.slice(1).map((generatedRow) => normalizedHeader.map((column) => {
    const index = generatedHeader.indexOf(column);
    return index >= 0 ? generatedRow[index] ?? '' : '';
  }));
  const updated = `${hasBom ? '\uFEFF' : ''}${[...rows, ...additions].map((row) => row.map(csvCell).join(',')).join(newline)}${newline}`;
  if (parseContractCsv(updated).issues.length) throw new Error('The appended CSV test suite is invalid.');
  return updated;
}

function resolveSuiteUri(profileUri: vscode.Uri, path: string, resolveExternal?: (reference: string) => vscode.Uri | undefined): vscode.Uri {
  if (!isSafeContractSuitePath(path)) throw new Error(`Test suite path is not safe: ${path}`);
  const external: boolean = isExternalAdversarialSuiteReference(path);
  if (external) { const uri = resolveExternal?.(path); if (!uri) throw new Error('External test suite access is not authorized on this machine. Link the file again from the Profile editor.'); return uri; }
  const folder = vscode.workspace.getWorkspaceFolder(profileUri);
  if (!folder) throw new Error(`Test suite ${path} cannot be resolved because the profile is not inside a workspace folder.`);
  return vscode.Uri.joinPath(folder.uri, ...path.split('/'));
}
async function readBoundedSource(uri: vscode.Uri, path: string): Promise<string> { if ((await vscode.workspace.fs.stat(uri)).size > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${path} exceeds the 5 MB limit.`); const bytes = await vscode.workspace.fs.readFile(uri); if (bytes.byteLength > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${path} exceeds the 5 MB limit.`); return new TextDecoder().decode(bytes); }
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function spreadsheetText(value: string): string { return /^'[=+\-@]/u.test(value) ? value.slice(1) : value; }
function csvCell(value: string): string { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
export function isLinkedContractRevision(value: unknown): value is string { return typeof value === 'string' && REVISION_PATTERN.test(value); }
