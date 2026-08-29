import { parse, type ParseError } from 'jsonc-parser';
import type {
  AdversarialForbidDefinition,
  AdversarialSuiteCaseDefinition,
  AdversarialSuiteDefinition,
  ScenarioAdversarialDefinition,
  ScenarioDefinition,
} from '../../shared/types';
import { isSafeReportDirectory } from './scenarioConfig';
import { isSafeAssertionRegex } from './assertionEvaluator';

export const MAX_ADVERSARIAL_CASES_PER_SUITE = 500;
export const MAX_ADVERSARIAL_TURNS_PER_CASE = 10;
export const MAX_ADVERSARIAL_TURNS_PER_SUITE = 2_000;
export const MAX_ADVERSARIAL_RULES = 50;
export const DEFAULT_ADVERSARIAL_TIMEOUT_MS = 60_000;

export interface AdversarialSuiteIssue {
  path: string;
  message: string;
}

export interface ParsedAdversarialSuite {
  suite?: AdversarialSuiteDefinition;
  parseErrors: ParseError[];
  issues: AdversarialSuiteIssue[];
}

export function parseAdversarialSuite(text: string): ParsedAdversarialSuite {
  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  const suite = !parseErrors.length && value && typeof value === 'object' && !Array.isArray(value) ? value as AdversarialSuiteDefinition : undefined;
  return { suite, parseErrors, issues: suite ? validateAdversarialSuite(suite) : [] };
}

export function validateAdversarialSuite(suite: AdversarialSuiteDefinition): AdversarialSuiteIssue[] {
  const issues: AdversarialSuiteIssue[] = [];
  for (const key of Object.keys(suite)) if (!new Set(['$schema', 'format', 'version', 'id', 'name', 'description', 'defaults', 'cases']).has(key)) issues.push(issue(key, `Unsupported suite field: ${key}.`));
  if (suite.format !== 'turnstage-adversarial-suite') issues.push(issue('format', 'Suite format must be turnstage-adversarial-suite.'));
  if (suite.version !== 1) issues.push(issue('version', 'Suite version must be 1.'));
  if (!slug(suite.id)) issues.push(issue('id', 'Suite id must use lowercase letters, numbers, and hyphens.'));
  if (typeof suite.name !== 'string' || !suite.name.trim()) issues.push(issue('name', 'Suite name is required.'));
  if (suite.defaults !== undefined) {
    if (!suite.defaults || typeof suite.defaults !== 'object' || Array.isArray(suite.defaults)) issues.push(issue('defaults', 'Suite defaults must be an object.'));
    else {
      for (const key of Object.keys(suite.defaults)) if (!new Set(['maxTurns', 'timeoutMs', 'stopOnAttackSucceeded', 'forbid']).has(key)) issues.push(issue(`defaults.${key}`, `Unsupported suite default: ${key}.`));
      if (suite.defaults.maxTurns !== undefined && (!Number.isInteger(suite.defaults.maxTurns) || suite.defaults.maxTurns < 1 || suite.defaults.maxTurns > MAX_ADVERSARIAL_TURNS_PER_CASE)) issues.push(issue('defaults.maxTurns', `maxTurns must be an integer from 1 to ${MAX_ADVERSARIAL_TURNS_PER_CASE}.`));
      if (suite.defaults.timeoutMs !== undefined && (!Number.isInteger(suite.defaults.timeoutMs) || suite.defaults.timeoutMs < 1_000 || suite.defaults.timeoutMs > 300_000)) issues.push(issue('defaults.timeoutMs', 'timeoutMs must be an integer from 1000 to 300000.'));
      if (suite.defaults.stopOnAttackSucceeded !== undefined && typeof suite.defaults.stopOnAttackSucceeded !== 'boolean') issues.push(issue('defaults.stopOnAttackSucceeded', 'stopOnAttackSucceeded must be boolean.'));
      if (suite.defaults.forbid !== undefined) validateForbid(suite.defaults.forbid, 'defaults.forbid', issues, true);
    }
  }
  if (!Array.isArray(suite.cases)) return [...issues, issue('cases', 'Suite cases must be an array.')];
  if (suite.cases.length > MAX_ADVERSARIAL_CASES_PER_SUITE) issues.push(issue('cases', `A suite can contain at most ${MAX_ADVERSARIAL_CASES_PER_SUITE} cases.`));
  const caseIds = new Set<string>();
  let totalTurns = 0;
  suite.cases.forEach((testCase, caseIndex) => {
    const path = `cases[${caseIndex}]`;
    if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) { issues.push(issue(path, 'Case must be an object.')); return; }
    for (const key of Object.keys(testCase)) if (!new Set(['id', 'name', 'description', 'tags', 'enabled', 'controls', 'mode', 'maxTurns', 'timeoutMs', 'stopOnAttackSucceeded', 'forbid', 'turns']).has(key)) issues.push(issue(`${path}.${key}`, `Unsupported case field: ${key}.`));
    if (!slug(testCase.id)) issues.push(issue(`${path}.id`, 'Case id must use lowercase letters, numbers, and hyphens.'));
    else if (caseIds.has(testCase.id)) issues.push(issue(`${path}.id`, `Duplicate case id: ${testCase.id}.`));
    else caseIds.add(testCase.id);
    if (typeof testCase.name !== 'string' || !testCase.name.trim()) issues.push(issue(`${path}.name`, 'Case name is required.'));
    if (testCase.enabled !== undefined && typeof testCase.enabled !== 'boolean') issues.push(issue(`${path}.enabled`, 'enabled must be boolean.'));
    if (testCase.tags !== undefined && (!Array.isArray(testCase.tags) || testCase.tags.length > 20 || testCase.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64) || new Set(testCase.tags).size !== testCase.tags.length)) issues.push(issue(`${path}.tags`, 'Tags must contain at most 20 unique non-empty values of up to 64 characters.'));
    if (testCase.controls !== undefined && (!testCase.controls || typeof testCase.controls !== 'object' || Array.isArray(testCase.controls))) issues.push(issue(`${path}.controls`, 'Case controls must be an object.'));
    if (testCase.stopOnAttackSucceeded !== undefined && typeof testCase.stopOnAttackSucceeded !== 'boolean') issues.push(issue(`${path}.stopOnAttackSucceeded`, 'stopOnAttackSucceeded must be boolean.'));
    if (!Array.isArray(testCase.turns) || !testCase.turns.length) { issues.push(issue(`${path}.turns`, 'Case requires at least one turn.')); return; }
    totalTurns += testCase.turns.length;
    const mode = testCase.mode ?? (testCase.turns.length > 1 ? 'multiTurn' : 'singleTurn');
    const maxTurns = testCase.maxTurns ?? suite.defaults?.maxTurns ?? (mode === 'multiTurn' ? testCase.turns.length : 1);
    if (mode === 'singleTurn' && testCase.turns.length !== 1) issues.push(issue(`${path}.turns`, 'Single-turn cases must contain exactly one turn.'));
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_ADVERSARIAL_TURNS_PER_CASE) issues.push(issue(`${path}.maxTurns`, `maxTurns must be an integer from 1 to ${MAX_ADVERSARIAL_TURNS_PER_CASE}.`));
    if (testCase.turns.length > maxTurns) issues.push(issue(`${path}.turns`, 'Case turns exceed maxTurns and will not be truncated.'));
    const timeoutMs = testCase.timeoutMs ?? suite.defaults?.timeoutMs ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) issues.push(issue(`${path}.timeoutMs`, 'timeoutMs must be an integer from 1000 to 300000.'));
    const forbid = mergeSuiteForbid(suite.defaults?.forbid, testCase.forbid);
    validateForbid(forbid, `${path}.forbid`, issues);
    if (!hasForbid(forbid)) issues.push(issue(`${path}.forbid`, 'Case requires at least one prohibited effect.'));
    const turnIds = new Set<string>();
    testCase.turns.forEach((turn, turnIndex) => {
      const turnPath = `${path}.turns[${turnIndex}]`;
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) { issues.push(issue(turnPath, 'Turn must be an object.')); return; }
      for (const key of Object.keys(turn)) if (!new Set(['id', 'name', 'input', 'additionalForbid']).has(key)) issues.push(issue(`${turnPath}.${key}`, `Unsupported turn field: ${key}.`));
      if (!slug(turn.id)) issues.push(issue(`${turnPath}.id`, 'Turn id must use lowercase letters, numbers, and hyphens.'));
      else if (turnIds.has(turn.id)) issues.push(issue(`${turnPath}.id`, `Duplicate turn id: ${turn.id}.`));
      else turnIds.add(turn.id);
      if (typeof turn.input !== 'string' || !turn.input.trim()) issues.push(issue(`${turnPath}.input`, 'Turn input is required.'));
      validateForbid(turn.additionalForbid ?? {}, `${turnPath}.additionalForbid`, issues, true);
    });
  });
  if (totalTurns > MAX_ADVERSARIAL_TURNS_PER_SUITE) issues.push(issue('cases', `A suite can contain at most ${MAX_ADVERSARIAL_TURNS_PER_SUITE} turns.`));
  return issues;
}

export function normalizeAdversarialSuite(suite: AdversarialSuiteDefinition): ScenarioDefinition[] {
  const issues = validateAdversarialSuite(suite);
  if (issues.length) throw new Error(issues.map((value) => `${value.path}: ${value.message}`).join('\n'));
  return suite.cases.filter((testCase) => testCase.enabled !== false).map((testCase) => normalizeCase(suite, testCase));
}

export function createAdversarialSuite(id: string, name: string, scenarios: readonly ScenarioDefinition[]): AdversarialSuiteDefinition {
  return {
    format: 'turnstage-adversarial-suite',
    version: 1,
    id,
    name,
    cases: scenarios.filter((scenario) => scenario.adversarial).map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      tags: scenario.tags,
      controls: scenario.controls,
      mode: scenario.adversarial!.mode ?? (scenario.steps.length > 1 ? 'multiTurn' : 'singleTurn'),
      maxTurns: scenario.adversarial!.maxTurns,
      timeoutMs: scenario.adversarial!.timeoutMs,
      stopOnAttackSucceeded: scenario.adversarial!.stopOnAttackSucceeded,
      forbid: structuredClone(scenario.adversarial!.forbid),
      turns: scenario.steps.map((step) => ({ id: step.id, name: step.name, input: step.input, additionalForbid: structuredClone(step.additionalForbid) })),
    })),
  };
}

export function serializeAdversarialSuite(suite: AdversarialSuiteDefinition): string { return `${JSON.stringify(suite, null, 2)}\n`; }

export function isSafeAdversarialSuitePath(value: unknown): value is string {
  return typeof value === 'string' && /\.adversarial\.(?:jsonc|json)$/i.test(value) && isSafeReportDirectory(value);
}

function normalizeCase(suite: AdversarialSuiteDefinition, testCase: AdversarialSuiteCaseDefinition): ScenarioDefinition {
  const mode = testCase.mode ?? (testCase.turns.length > 1 ? 'multiTurn' : 'singleTurn');
  const adversarial: ScenarioAdversarialDefinition = {
    mode,
    maxTurns: testCase.maxTurns ?? suite.defaults?.maxTurns ?? (mode === 'multiTurn' ? testCase.turns.length : 1),
    timeoutMs: testCase.timeoutMs ?? suite.defaults?.timeoutMs ?? DEFAULT_ADVERSARIAL_TIMEOUT_MS,
    stopOnAttackSucceeded: testCase.stopOnAttackSucceeded ?? suite.defaults?.stopOnAttackSucceeded ?? true,
    forbid: mergeSuiteForbid(suite.defaults?.forbid, testCase.forbid),
  };
  return { id: testCase.id, name: testCase.name, description: testCase.description, tags: structuredClone(testCase.tags), controls: structuredClone(testCase.controls), steps: structuredClone(testCase.turns), adversarial };
}

function validateForbid(value: AdversarialForbidDefinition, path: string, issues: AdversarialSuiteIssue[], allowEmpty = false): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(issue(path, 'Prohibited effects must be an object.')); return; }
  const allowed = new Set(['content', 'urls', 'ctas', 'tools', 'events']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, `Unsupported prohibited effect: ${key}.`));
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || value.content.length > MAX_ADVERSARIAL_RULES) issues.push(issue(`${path}.content`, `Forbidden content must contain at most ${MAX_ADVERSARIAL_RULES} rules.`));
    else value.content.forEach((rule, index) => {
      if (typeof rule === 'string') { if (!rule.length || rule.length > 256) issues.push(issue(`${path}.content[${index}]`, 'Content text must contain 1 to 256 characters.')); return; }
      if (!rule || typeof rule !== 'object' || !['contains', 'regex'].includes(rule.match) || typeof rule.value !== 'string' || !rule.value.length || rule.value.length > 256) { issues.push(issue(`${path}.content[${index}]`, 'Content rule requires contains or regex and a value from 1 to 256 characters.')); return; }
      for (const key of Object.keys(rule)) if (!new Set(['id', 'match', 'value', 'caseSensitive']).has(key)) issues.push(issue(`${path}.content[${index}].${key}`, `Unsupported content rule field: ${key}.`));
      if (rule.id !== undefined && (typeof rule.id !== 'string' || !rule.id.trim() || rule.id.length > 100)) issues.push(issue(`${path}.content[${index}].id`, 'Content rule id must contain 1 to 100 characters.'));
      if (rule.caseSensitive !== undefined && typeof rule.caseSensitive !== 'boolean') issues.push(issue(`${path}.content[${index}].caseSensitive`, 'caseSensitive must be boolean.'));
      if (rule.match === 'regex' && !isSafeAssertionRegex(rule.value)) issues.push(issue(`${path}.content[${index}].value`, 'Content regex must be valid, safe, and no longer than 256 characters.'));
    });
  }
  for (const key of ['urls', 'ctas', 'tools'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') issues.push(issue(`${path}.${key}`, `${key} must be boolean.`));
  if (value.events !== undefined && (!Array.isArray(value.events) || value.events.length > MAX_ADVERSARIAL_RULES || value.events.some((event) => typeof event !== 'string' || !event.trim() || event.length > 256))) issues.push(issue(`${path}.events`, `Forbidden events must contain at most ${MAX_ADVERSARIAL_RULES} event names.`));
  else if (value.events && new Set(value.events).size !== value.events.length) issues.push(issue(`${path}.events`, 'Forbidden events must be unique.'));
  if (!allowEmpty && !hasForbid(value)) issues.push(issue(path, 'At least one prohibited effect is required.'));
}

function mergeSuiteForbid(defaults?: AdversarialForbidDefinition, local?: AdversarialForbidDefinition): AdversarialForbidDefinition {
  return {
    content: [...(defaults?.content ?? []), ...(local?.content ?? [])],
    urls: Boolean(defaults?.urls || local?.urls),
    ctas: Boolean(defaults?.ctas || local?.ctas),
    tools: Boolean(defaults?.tools || local?.tools),
    events: [...new Set([...(defaults?.events ?? []), ...(local?.events ?? [])])],
  };
}

function hasForbid(value: AdversarialForbidDefinition): boolean { return Boolean(value.urls || value.ctas || value.tools || value.content?.length || value.events?.length); }
function slug(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value); }
function issue(path: string, message: string): AdversarialSuiteIssue { return { path, message }; }
