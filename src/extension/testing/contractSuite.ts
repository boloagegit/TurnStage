import { parse, type ParseError } from 'jsonc-parser';
import type { ContractSuiteCaseDefinition, ContractSuiteDefinition, ScenarioAssertionDefinition, ScenarioDefinition, ScenarioSourceBinding } from '../../shared/types';
import { isSafeReportDirectory } from './scenarioConfig';
import { validateSourceBinding } from './impactMapping';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';

export const MAX_CONTRACT_CASES_PER_SUITE = 500;
export const MAX_CONTRACT_STEPS_PER_CASE = 100;
export const MAX_CONTRACT_STEPS_PER_SUITE = 10_000;
const MAX_ASSERTIONS = 100;
const ASSERTION_OPERATORS = new Set<ScenarioAssertionDefinition['operator']>(['equals', 'notEquals', 'exists', 'notExists', 'contains', 'regex', 'oneOf', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'sequenceEquals', 'sequenceContains']);
const ASSERTIONS_WITHOUT_VALUE = new Set<ScenarioAssertionDefinition['operator']>(['exists', 'notExists']);

export interface ContractSuiteIssue { path: string; message: string }
export interface ParsedContractSuite { suite?: ContractSuiteDefinition; parseErrors: ParseError[]; issues: ContractSuiteIssue[] }

export function parseContractSuite(text: string): ParsedContractSuite {
  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  const suite = !parseErrors.length && isRecord(value) ? value as unknown as ContractSuiteDefinition : undefined;
  return { suite, parseErrors, issues: suite ? validateContractSuite(suite) : [] };
}

export function validateContractSuite(suite: ContractSuiteDefinition): ContractSuiteIssue[] {
  const issues: ContractSuiteIssue[] = [];
  rejectUnknown(suite, ['$schema', 'format', 'version', 'id', 'name', 'description', 'sourceBinding', 'cases'], '', issues);
  if (suite.format !== 'turnstage-contract-suite') issues.push(issue('format', 'Suite format must be turnstage-contract-suite.'));
  if (suite.version !== 1) issues.push(issue('version', 'Suite version must be 1.'));
  if (!slug(suite.id)) issues.push(issue('id', 'Suite id must use lowercase letters, numbers, and hyphens.'));
  if (typeof suite.name !== 'string' || !suite.name.trim()) issues.push(issue('name', 'Suite name is required.'));
  if (suite.description !== undefined && (typeof suite.description !== 'string' || suite.description.length > 10_000)) issues.push(issue('description', 'Suite description must be a string of at most 10000 characters.'));
  validateBinding(suite.sourceBinding, 'sourceBinding', issues);
  if (!Array.isArray(suite.cases)) return [...issues, issue('cases', 'Suite cases must be an array.')];
  if (suite.cases.length > MAX_CONTRACT_CASES_PER_SUITE) issues.push(issue('cases', `A suite can contain at most ${MAX_CONTRACT_CASES_PER_SUITE} cases.`));
  const caseIds = new Set<string>();
  let totalSteps = 0;
  suite.cases.forEach((testCase, caseIndex) => {
    const path = `cases[${caseIndex}]`;
    if (!isRecord(testCase)) { issues.push(issue(path, 'Case must be an object.')); return; }
    rejectUnknown(testCase, ['id', 'name', 'description', 'tags', 'capture', 'sourceBinding', 'enabled', 'controls', 'steps', 'assertions', 'comparison', 'performance', 'faults'], path, issues);
    if (!slug(testCase.id)) issues.push(issue(`${path}.id`, 'Case id must use lowercase letters, numbers, and hyphens.'));
    else if (caseIds.has(testCase.id)) issues.push(issue(`${path}.id`, `Duplicate case id: ${testCase.id}.`));
    else caseIds.add(testCase.id);
    if (typeof testCase.name !== 'string' || !testCase.name.trim()) issues.push(issue(`${path}.name`, 'Case name is required.'));
    if (testCase.description !== undefined && (typeof testCase.description !== 'string' || testCase.description.length > 10_000)) issues.push(issue(`${path}.description`, 'Case description must be a string of at most 10000 characters.'));
    if (testCase.enabled !== undefined && typeof testCase.enabled !== 'boolean') issues.push(issue(`${path}.enabled`, 'enabled must be boolean.'));
    if (testCase.tags !== undefined && (!Array.isArray(testCase.tags) || testCase.tags.length > 20 || testCase.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64) || new Set(testCase.tags).size !== testCase.tags.length)) issues.push(issue(`${path}.tags`, 'Tags must contain at most 20 unique non-empty values of up to 64 characters.'));
    validateCapture(testCase.capture, `${path}.capture`, issues);
    validateBinding(testCase.sourceBinding, `${path}.sourceBinding`, issues);
    if (testCase.controls !== undefined && !isRecord(testCase.controls)) issues.push(issue(`${path}.controls`, 'Case controls must be an object.'));
    if (!Array.isArray(testCase.steps) || !testCase.steps.length) { issues.push(issue(`${path}.steps`, 'Case requires at least one step.')); return; }
    if (testCase.steps.length > MAX_CONTRACT_STEPS_PER_CASE) issues.push(issue(`${path}.steps`, `A case can contain at most ${MAX_CONTRACT_STEPS_PER_CASE} steps.`));
    if (testCase.enabled !== false) totalSteps += testCase.steps.length;
    const stepIds = new Set<string>();
    testCase.steps.forEach((step, stepIndex) => {
      const stepPath = `${path}.steps[${stepIndex}]`;
      if (!isRecord(step)) { issues.push(issue(stepPath, 'Step must be an object.')); return; }
      rejectUnknown(step, ['id', 'name', 'input', 'assertions'], stepPath, issues);
      if (!slug(step.id)) issues.push(issue(`${stepPath}.id`, 'Step id must use lowercase letters, numbers, and hyphens.'));
      else if (stepIds.has(step.id)) issues.push(issue(`${stepPath}.id`, `Duplicate step id: ${step.id}.`));
      else stepIds.add(step.id);
      if (typeof step.input !== 'string' || !step.input.trim()) issues.push(issue(`${stepPath}.input`, 'Step input is required.'));
      validateAssertions(step.assertions, `${stepPath}.assertions`, issues);
    });
    validateAssertions(testCase.assertions, `${path}.assertions`, issues);
  });
  if (totalSteps > MAX_CONTRACT_STEPS_PER_SUITE) issues.push(issue('cases', `A suite can contain at most ${MAX_CONTRACT_STEPS_PER_SUITE} enabled steps.`));
  return issues;
}

export function normalizeContractSuite(suite: ContractSuiteDefinition): ScenarioDefinition[] {
  const issues = validateContractSuite(suite);
  if (issues.length) throw new Error(issues.map((value) => `${value.path}: ${value.message}`).join('\n'));
  return suite.cases.filter((testCase) => testCase.enabled !== false).map((testCase) => {
    const scenario = structuredClone(testCase) as ScenarioDefinition & { enabled?: boolean };
    delete scenario.enabled;
    scenario.sourceBinding = mergeSourceBindings(suite.sourceBinding, testCase.sourceBinding);
    return scenario;
  });
}

export function createContractSuite(id: string, name: string, scenarios: readonly ScenarioDefinition[]): ContractSuiteDefinition {
  return { format: 'turnstage-contract-suite', version: 1, id, name, cases: scenarios.filter((scenario) => !scenario.adversarial).map((scenario) => { const testCase = structuredClone(scenario); delete testCase.adversarial; return testCase as ContractSuiteCaseDefinition; }) };
}

export function serializeContractSuite(suite: ContractSuiteDefinition): string { return `${JSON.stringify(suite, null, 2)}\n`; }

export function isSafeContractSuitePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('external:')) return isExternalAdversarialSuiteReference(value);
  return /(?:\.tests\.(?:jsonc|json)|\.csv)$/iu.test(value) && isSafeReportDirectory(value);
}

function validateAssertions(value: unknown, path: string, issues: ContractSuiteIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) { issues.push(issue(path, 'Assertions must be an array.')); return; }
  if (value.length > MAX_ASSERTIONS) issues.push(issue(path, `Assertions can contain at most ${MAX_ASSERTIONS} entries.`));
  value.forEach((candidate, index) => {
    const assertionPath = `${path}[${index}]`;
    if (!isRecord(candidate)) { issues.push(issue(assertionPath, 'Assertion must be an object.')); return; }
    rejectUnknown(candidate, ['id', 'path', 'operator', 'value', 'message'], assertionPath, issues);
    if (candidate.id !== undefined && (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 100)) issues.push(issue(`${assertionPath}.id`, 'Assertion id must contain 1 to 100 characters.'));
    if (typeof candidate.path !== 'string' || !candidate.path.trim() || candidate.path.length > 512) issues.push(issue(`${assertionPath}.path`, 'Assertion path must contain 1 to 512 characters.'));
    if (!ASSERTION_OPERATORS.has(candidate.operator as ScenarioAssertionDefinition['operator'])) issues.push(issue(`${assertionPath}.operator`, 'Assertion operator is unsupported.'));
    if (!ASSERTIONS_WITHOUT_VALUE.has(candidate.operator as ScenarioAssertionDefinition['operator']) && !Object.prototype.hasOwnProperty.call(candidate, 'value')) issues.push(issue(`${assertionPath}.value`, 'This assertion operator requires a value.'));
  });
}

function validateBinding(value: ScenarioSourceBinding | undefined, path: string, issues: ContractSuiteIssue[]): void {
  if (value === undefined) return;
  issues.push(...validateSourceBinding(value).map((entry) => issue(`${path}.${entry.scope.replace(/^sourceBinding\.?/u, '')}`, entry.message)));
}

function validateCapture(value: unknown, path: string, issues: ContractSuiteIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) { issues.push(issue(path, 'Capture metadata must be an object.')); return; }
  const allowed = new Set(['status', 'source', 'capturedAt', 'profileId', 'profileDigest', 'runId', 'evidenceId']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, `Unsupported capture field: ${key}.`));
  if (!['needsReview', 'ready'].includes(String(value.status))) issues.push(issue(`${path}.status`, 'Capture status must be needsReview or ready.'));
  if (!['conversation', 'run', 'evidence'].includes(String(value.source))) issues.push(issue(`${path}.source`, 'Capture source must be conversation, run, or evidence.'));
  if (typeof value.capturedAt !== 'string' || value.capturedAt.length > 64 || Number.isNaN(Date.parse(value.capturedAt))) issues.push(issue(`${path}.capturedAt`, 'Capture time must be a valid bounded timestamp.'));
  if (typeof value.profileId !== 'string' || !value.profileId.trim() || value.profileId.length > 256) issues.push(issue(`${path}.profileId`, 'Capture profileId must contain 1 to 256 characters.'));
  if (typeof value.profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.profileDigest)) issues.push(issue(`${path}.profileDigest`, 'Capture profileDigest must be a SHA-256 digest.'));
  if (value.source === 'run' && (typeof value.runId !== 'string' || !value.runId.trim() || value.runId.length > 256)) issues.push(issue(`${path}.runId`, 'A run capture requires a bounded runId.'));
  if (value.source === 'evidence' && (typeof value.evidenceId !== 'string' || !value.evidenceId.trim() || value.evidenceId.length > 256)) issues.push(issue(`${path}.evidenceId`, 'An evidence capture requires a bounded evidenceId.'));
  if (value.source !== 'run' && value.runId !== undefined) issues.push(issue(`${path}.runId`, 'Only a run capture can define runId.'));
  if (value.source !== 'evidence' && value.evidenceId !== undefined) issues.push(issue(`${path}.evidenceId`, 'Only an evidence capture can define evidenceId.'));
}

function mergeSourceBindings(suite: ScenarioSourceBinding | undefined, local: ScenarioSourceBinding | undefined): ScenarioSourceBinding | undefined {
  if (!suite && !local) return undefined;
  const merge = (left?: string[], right?: string[]) => [...new Set([...(left ?? []), ...(right ?? [])])];
  return { sourceGlobs: merge(suite?.sourceGlobs, local?.sourceGlobs), components: merge(suite?.components, local?.components), endpoints: merge(suite?.endpoints, local?.endpoints), riskTags: merge(suite?.riskTags, local?.riskTags) };
}

function rejectUnknown(value: object, allowed: readonly string[], path: string, issues: ContractSuiteIssue[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) issues.push(issue(path ? `${path}.${key}` : key, `Unsupported field: ${key}.`));
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function slug(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value); }
function issue(path: string, message: string): ContractSuiteIssue { return { path, message }; }
