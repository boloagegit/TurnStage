import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { applyEdits, modify } from 'jsonc-parser';
import type { AdversarialSuiteCaseDefinition, AdversarialSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { ADVERSARIAL_CSV_OPTIONAL_COLUMNS, parseCsvRows, serializeAdversarialCsv } from './adversarialCsv';
import { parseAdversarialSource } from './adversarialSource';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';
import { isSafeAdversarialSuitePath, validateAdversarialSuite } from './adversarialSuite';

const MAX_SUITE_BYTES = 5 * 1024 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export type LinkedAdversarialSourceFormat = 'csv' | 'jsonc';

export interface EditableLinkedAdversarialCase {
  sourcePath: string;
  sourceFormat: LinkedAdversarialSourceFormat;
  revision: string;
  scenario: ScenarioDefinition;
}

export interface SaveLinkedAdversarialCaseInput {
  profileUri: vscode.Uri;
  sourcePath: string;
  scenarioId: string;
  expectedRevision: string;
  scenario: ScenarioDefinition;
  resolveExternal?: (reference: string) => vscode.Uri | undefined;
}

export class LinkedAdversarialCaseConflictError extends Error {
  constructor() {
    super('The linked suite changed after this editor loaded it. Reload the case before saving.');
    this.name = 'LinkedAdversarialCaseConflictError';
  }
}

export async function loadEditableLinkedAdversarialCase(
  profileUri: vscode.Uri,
  sourcePath: string,
  scenarioId: string,
  resolveExternal?: (reference: string) => vscode.Uri | undefined,
): Promise<EditableLinkedAdversarialCase> {
  const uri = resolveSuiteUri(profileUri, sourcePath, resolveExternal);
  const text = await readBoundedSource(uri, sourcePath);
  return editableCaseFromText(sourcePath, text, scenarioId);
}

export async function saveEditableLinkedAdversarialCase(input: SaveLinkedAdversarialCaseInput): Promise<EditableLinkedAdversarialCase> {
  if (!REVISION_PATTERN.test(input.expectedRevision)) throw new Error('The linked suite revision is invalid. Reload the case before saving.');
  const uri = resolveSuiteUri(input.profileUri, input.sourcePath, input.resolveExternal);
  const source = await readBoundedSource(uri, input.sourcePath);
  if (digest(source) !== input.expectedRevision) throw new LinkedAdversarialCaseConflictError();
  const updated = updateLinkedAdversarialCaseSource(input.sourcePath, source, input.scenarioId, input.scenario);
  const bytes = new TextEncoder().encode(updated.text);
  if (bytes.byteLength > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${input.sourcePath} exceeds the 5 MB limit after editing.`);
  if (updated.text !== source) await vscode.workspace.fs.writeFile(uri, bytes);
  const persisted = await readBoundedSource(uri, input.sourcePath);
  const saved = editableCaseFromText(input.sourcePath, persisted, input.scenario.id);
  if (saved.revision !== updated.revision) throw new LinkedAdversarialCaseConflictError();
  return saved;
}

export function updateLinkedAdversarialCaseSource(path: string, text: string, scenarioId: string, scenario: ScenarioDefinition): { text: string; revision: string } {
  if (!scenario.adversarial) throw new Error('The linked case must contain an adversarial definition.');
  const parsed = parseAdversarialSource(path, text);
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Adversarial suite ${path} is empty.`);
  const sourceFormat: LinkedAdversarialSourceFormat = /\.csv$/iu.test(path) ? 'csv' : 'jsonc';
  const updatedText = sourceFormat === 'csv'
    ? updateCsvCase(text, scenarioId, scenario)
    : updateJsoncCase(text, parsed.suite, scenarioId, scenario);
  const verified = parseAdversarialSource(path, updatedText);
  if (!verified.suite || verified.issues.length) throw new Error(verified.issues.join('\n') || 'The edited linked suite is invalid.');
  if (!verified.scenarios.some((candidate) => candidate.id === scenario.id)) throw new Error(`The edited case ${scenario.id} could not be verified.`);
  return { text: updatedText, revision: digest(updatedText) };
}

function editableCaseFromText(path: string, text: string, scenarioId: string): EditableLinkedAdversarialCase {
  const parsed = parseAdversarialSource(path, text);
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Adversarial suite ${path} is empty.`);
  const sourceFormat: LinkedAdversarialSourceFormat = /\.csv$/iu.test(path) ? 'csv' : 'jsonc';
  let scenario: ScenarioDefinition | undefined;
  if (sourceFormat === 'csv') scenario = parsed.scenarios.find((candidate) => candidate.id === scenarioId);
  else {
    const testCase = parsed.suite.cases.find((candidate) => candidate.id === scenarioId && candidate.enabled !== false);
    if (testCase) scenario = caseToEditableScenario(testCase);
  }
  if (!scenario) throw new Error(`Linked adversarial case ${scenarioId} was not found.`);
  return { sourcePath: path, sourceFormat, revision: digest(text), scenario };
}

function caseToEditableScenario(testCase: AdversarialSuiteCaseDefinition): ScenarioDefinition {
  return {
    id: testCase.id,
    name: testCase.name,
    description: testCase.description,
    tags: structuredClone(testCase.tags),
    controls: structuredClone(testCase.controls),
    steps: structuredClone(testCase.turns),
    adversarial: {
      mode: testCase.mode,
      maxTurns: testCase.maxTurns,
      timeoutMs: testCase.timeoutMs,
      stopOnAttackSucceeded: testCase.stopOnAttackSucceeded,
      repetitions: testCase.runPolicy?.repetitions ?? testCase.repetitions,
      failFast: testCase.runPolicy?.failFast ?? testCase.failFast,
      forbid: structuredClone(testCase.forbid ?? {}),
    },
  };
}

function scenarioToCase(existing: AdversarialSuiteCaseDefinition, scenario: ScenarioDefinition): AdversarialSuiteCaseDefinition {
  const definition = scenario.adversarial!;
  const runPolicy = existing.runPolicy ? { ...existing.runPolicy } : undefined;
  let repetitions = existing.repetitions;
  let failFast = existing.failFast;
  if (runPolicy?.repetitions !== undefined) runPolicy.repetitions = definition.repetitions;
  else repetitions = definition.repetitions;
  if (runPolicy?.failFast !== undefined) runPolicy.failFast = definition.failFast;
  else failFast = definition.failFast;
  return compact({
    ...existing,
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    tags: structuredClone(scenario.tags),
    controls: structuredClone(scenario.controls),
    mode: definition.mode,
    maxTurns: definition.maxTurns,
    timeoutMs: definition.timeoutMs,
    stopOnAttackSucceeded: definition.stopOnAttackSucceeded,
    repetitions,
    failFast,
    runPolicy: runPolicy && Object.keys(compact(runPolicy)).length ? compact(runPolicy) : undefined,
    forbid: structuredClone(definition.forbid),
    turns: scenario.steps.map((step) => compact({ id: step.id, name: step.name, input: step.input, additionalForbid: structuredClone(step.additionalForbid) })),
  }) as AdversarialSuiteCaseDefinition;
}

function updateJsoncCase(text: string, suite: AdversarialSuiteDefinition, scenarioId: string, scenario: ScenarioDefinition): string {
  const caseIndex = suite.cases.findIndex((candidate) => candidate.id === scenarioId && candidate.enabled !== false);
  if (caseIndex < 0) throw new Error(`Linked adversarial case ${scenarioId} was not found.`);
  const existing = suite.cases[caseIndex]!;
  const updated = scenarioToCase(existing, scenario);
  const nextSuite = { ...suite, cases: suite.cases.map((candidate, index) => index === caseIndex ? updated : candidate) };
  const issues = validateAdversarialSuite(nextSuite);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  let result = text;
  const scalarKeys: Array<keyof AdversarialSuiteCaseDefinition> = ['id', 'name', 'description', 'tags', 'controls', 'mode', 'maxTurns', 'timeoutMs', 'stopOnAttackSucceeded', 'repetitions', 'failFast', 'runPolicy'];
  for (const key of scalarKeys) if (!sameValue(existing[key], updated[key])) result = setJsoncValue(result, ['cases', caseIndex, key], updated[key], formattingOptions);
  for (const key of ['content', 'urls', 'ctas', 'tools', 'events'] as const) if (!sameValue(existing.forbid?.[key], updated.forbid?.[key])) result = setJsoncValue(result, ['cases', caseIndex, 'forbid', key], updated.forbid?.[key], formattingOptions);
  const sameTurnShape = existing.turns.length === updated.turns.length && existing.turns.every((turn, index) => turn.id === updated.turns[index]?.id);
  if (!sameTurnShape) result = setJsoncValue(result, ['cases', caseIndex, 'turns'], updated.turns, formattingOptions);
  else for (let turnIndex = 0; turnIndex < updated.turns.length; turnIndex++) {
    const previous = existing.turns[turnIndex]!;
    const turn = updated.turns[turnIndex]!;
    for (const key of ['id', 'name', 'input'] as const) if (!sameValue(previous[key], turn[key])) result = setJsoncValue(result, ['cases', caseIndex, 'turns', turnIndex, key], turn[key], formattingOptions);
    for (const key of ['content', 'urls', 'ctas', 'tools', 'events'] as const) if (!sameValue(previous.additionalForbid?.[key], turn.additionalForbid?.[key])) result = setJsoncValue(result, ['cases', caseIndex, 'turns', turnIndex, 'additionalForbid', key], turn.additionalForbid?.[key], formattingOptions);
  }
  return result;
}

function setJsoncValue(text: string, path: Array<string | number>, value: unknown, formattingOptions: { insertSpaces: boolean; tabSize: number; eol: string }): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions }));
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
  if (!matching.length) throw new Error(`Linked adversarial case ${scenarioId} was not found.`);
  for (const column of ADVERSARIAL_CSV_OPTIONAL_COLUMNS) if (!normalizedHeader.includes(column)) { header.push(column); normalizedHeader.push(column); for (const row of rows.slice(1)) row.push(''); }
  const generated = parseCsvRows(serializeAdversarialCsv([scenario]).slice(1));
  const generatedHeader = generated[0]!.map((cell) => cell.trim().toLocaleLowerCase());
  const generatedRows = generated.slice(1);
  const originalsByTurn = new Map(matching.map(({ row }) => [spreadsheetText(row[turnIdIndex] ?? ''), row]));
  const replacement = generatedRows.map((generatedRow) => {
    const generatedTurnId = spreadsheetText(generatedRow[generatedHeader.indexOf('turn_id')] ?? '');
    const original = originalsByTurn.get(generatedTurnId);
    return normalizedHeader.map((column, index) => {
      const generatedIndex = generatedHeader.indexOf(column);
      return generatedIndex >= 0 ? generatedRow[generatedIndex] ?? '' : original?.[index] ?? '';
    });
  });
  const matchingIndexes = new Set(matching.map(({ index }) => index));
  const firstIndex = matching[0]!.index;
  const output: string[][] = [header];
  for (let index = 1; index < rows.length; index++) {
    if (index === firstIndex) output.push(...replacement);
    if (!matchingIndexes.has(index)) output.push(rows[index]!);
  }
  return `${hasBom ? '\uFEFF' : ''}${output.map((row) => row.map(csvCell).join(',')).join(newline)}${newline}`;
}

function resolveSuiteUri(profileUri: vscode.Uri, path: string, resolveExternal?: (reference: string) => vscode.Uri | undefined): vscode.Uri {
  if (!isSafeAdversarialSuitePath(path)) throw new Error(`Adversarial suite path is not a safe workspace-relative JSONC or CSV path: ${path}`);
  const external: boolean = isExternalAdversarialSuiteReference(path);
  if (external) {
    const uri = resolveExternal?.(path);
    if (!uri) throw new Error('External adversarial suite access is not authorized on this machine. Link the file again from the Profile editor.');
    return uri;
  }
  const folder = vscode.workspace.getWorkspaceFolder(profileUri);
  if (!folder) throw new Error(`Adversarial suite ${path} cannot be resolved because the profile is not inside a workspace folder.`);
  return vscode.Uri.joinPath(folder.uri, ...path.split('/'));
}

async function readBoundedSource(uri: vscode.Uri, path: string): Promise<string> {
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  return new TextDecoder().decode(bytes);
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function spreadsheetText(value: string): string { return /^'[=+\-@]/u.test(value) ? value.slice(1) : value; }
function csvCell(value: string): string { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T; }

export function isLinkedAdversarialRevision(value: unknown): value is string { return typeof value === 'string' && REVISION_PATTERN.test(value); }
