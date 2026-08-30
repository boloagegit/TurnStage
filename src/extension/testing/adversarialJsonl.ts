import type { AdversarialSuiteCaseDefinition, AdversarialSuiteDefinition, CampaignCaseResultV1, CampaignRunRecordV1 } from '../../shared/types';
import { sanitizeCampaignCase } from './campaign';
import { MAX_ADVERSARIAL_CASES_PER_SUITE, MAX_ADVERSARIAL_TURNS_PER_SUITE, validateAdversarialSuite } from './adversarialSuite';

export const ADVERSARIAL_JSONL_FORMAT = 'turnstage-adversarial-jsonl' as const;
export const CAMPAIGN_RESULTS_JSONL_FORMAT = 'turnstage-campaign-results-jsonl' as const;
export const JSONL_VERSION = 1 as const;
export const MAX_JSONL_BYTES = 5 * 1024 * 1024;
export const MAX_JSONL_LINES = 10_002;

export interface JsonlIssue { line: number; message: string }
export interface ParsedAdversarialJsonl { suite?: AdversarialSuiteDefinition; issues: JsonlIssue[] }
export interface ParsedCampaignResultsJsonl { run?: CampaignRunRecordV1; issues: JsonlIssue[] }

export function serializeAdversarialJsonl(suite: AdversarialSuiteDefinition): string {
  const issues = validateAdversarialSuite(suite);
  if (issues.length) throw new Error(issues.slice(0, 20).map((item) => `${item.path}: ${item.message}`).join('\n'));
  const { cases, ...metadata } = suite;
  return [
    JSON.stringify({ format: ADVERSARIAL_JSONL_FORMAT, version: JSONL_VERSION, type: 'suite', suite: metadata }),
    ...cases.map((testCase) => JSON.stringify({ type: 'case', case: testCase })),
  ].join('\n') + '\n';
}

export function parseAdversarialJsonl(text: string): ParsedAdversarialJsonl {
  const issues: JsonlIssue[] = [];
  if (new TextEncoder().encode(text).byteLength > MAX_JSONL_BYTES) return { issues: [{ line: 0, message: 'JSONL input exceeds the 5 MB safety limit.' }] };
  const lines = nonEmptyLines(text);
  if (lines.length > MAX_JSONL_LINES) return { issues: [{ line: 0, message: `JSONL input exceeds the ${MAX_JSONL_LINES} line safety limit.` }] };
  const header = parseLine(lines[0], issues);
  if (!record(header) || header.format !== ADVERSARIAL_JSONL_FORMAT || header.version !== JSONL_VERSION || header.type !== 'suite' || !record(header.suite)) {
    issues.push({ line: lines[0]?.number ?? 1, message: 'The first JSONL record must be a supported TurnStage suite header.' });
    return { issues };
  }
  const cases: AdversarialSuiteCaseDefinition[] = [];
  let turns = 0;
  for (const line of lines.slice(1)) {
    const value = parseLine(line, issues);
    if (!record(value) || value.type !== 'case' || !record(value.case)) { issues.push({ line: line.number, message: 'Expected a case record.' }); continue; }
    if (cases.length >= MAX_ADVERSARIAL_CASES_PER_SUITE) { issues.push({ line: line.number, message: `Suite exceeds the ${MAX_ADVERSARIAL_CASES_PER_SUITE} case safety limit.` }); break; }
    const testCase = value.case as unknown as AdversarialSuiteCaseDefinition;
    turns += Array.isArray(testCase.turns) ? testCase.turns.length : 0;
    if (turns > MAX_ADVERSARIAL_TURNS_PER_SUITE) { issues.push({ line: line.number, message: `Suite exceeds the ${MAX_ADVERSARIAL_TURNS_PER_SUITE} turn safety limit.` }); break; }
    cases.push(testCase);
  }
  const suite = { ...(header.suite as unknown as Omit<AdversarialSuiteDefinition, 'cases'>), cases } as AdversarialSuiteDefinition;
  for (const item of validateAdversarialSuite(suite)) issues.push({ line: 1, message: `${item.path}: ${item.message}` });
  return issues.length ? { issues } : { suite, issues: [] };
}

export function serializeCampaignResultsJsonl(run: CampaignRunRecordV1): string {
  const { cases, diff, ...metadata } = run;
  const header = { ...metadata, ...(diff ? { diff: { ...diff, entries: undefined } } : {}) };
  return [
    JSON.stringify({ format: CAMPAIGN_RESULTS_JSONL_FORMAT, version: JSONL_VERSION, type: 'campaign', run: header }),
    ...cases.map((result) => JSON.stringify({ type: 'result', result: sanitizeCampaignCase(result) })),
  ].join('\n') + '\n';
}

export function parseCampaignResultsJsonl(text: string): ParsedCampaignResultsJsonl {
  const issues: JsonlIssue[] = [];
  if (new TextEncoder().encode(text).byteLength > MAX_JSONL_BYTES) return { issues: [{ line: 0, message: 'JSONL input exceeds the 5 MB safety limit.' }] };
  const lines = nonEmptyLines(text);
  const header = parseLine(lines[0], issues);
  if (!record(header) || header.format !== CAMPAIGN_RESULTS_JSONL_FORMAT || header.version !== JSONL_VERSION || header.type !== 'campaign' || !record(header.run)) return { issues: [...issues, { line: lines[0]?.number ?? 1, message: 'The first JSONL record must be a supported campaign header.' }] };
  const cases: CampaignCaseResultV1[] = [];
  for (const line of lines.slice(1)) {
    const value = parseLine(line, issues);
    if (!record(value) || value.type !== 'result' || !isCampaignCase(value.result)) { issues.push({ line: line.number, message: 'Expected a valid, bounded result record.' }); continue; }
    if (cases.length >= MAX_ADVERSARIAL_CASES_PER_SUITE) { issues.push({ line: line.number, message: `Campaign exceeds the ${MAX_ADVERSARIAL_CASES_PER_SUITE} result safety limit.` }); break; }
    cases.push(sanitizeCampaignCase(value.result as unknown as CampaignCaseResultV1));
  }
  const run = { ...(header.run as unknown as Omit<CampaignRunRecordV1, 'cases'>), cases } as CampaignRunRecordV1;
  if (run.format !== 'turnstage-campaign-run' || run.version !== 1 || run.plan?.selectedCases !== cases.length) issues.push({ line: 1, message: 'Campaign header counts do not match the result records.' });
  return issues.length ? { issues } : { run, issues: [] };
}

function nonEmptyLines(text: string): Array<{ number: number; text: string }> {
  return text.split(/\r?\n/).flatMap((value, index) => value.trim() ? [{ number: index + 1, text: value }] : []);
}
function parseLine(line: { number: number; text: string } | undefined, issues: JsonlIssue[]): unknown {
  if (!line) return undefined;
  try { return JSON.parse(line.text); }
  catch { issues.push({ line: line.number, message: 'Record is not valid JSON.' }); return undefined; }
}
function record(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function isCampaignCase(value: unknown): value is CampaignCaseResultV1 {
  if (!record(value) || !boundedText(value.key, 512) || !boundedText(value.profileId, 256) || !boundedText(value.scenarioId, 256) || !boundedText(value.scenarioName, 512) || !Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some((tag) => !boundedText(tag, 64))) return false;
  if (!integer(value.requestedAttempts, 1, 10_000) || !integer(value.completedAttempts, 0, value.requestedAttempts) || !integer(value.plannedTurns, 0, 100_000) || typeof value.sampleComplete !== 'boolean' || value.sampleComplete !== (value.completedAttempts === value.requestedAttempts)) return false;
  if (value.suiteId !== undefined && !boundedText(value.suiteId, 256)) return false;
  if (value.outcome !== undefined && !['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError', 'passed', 'failed', 'error'].includes(String(value.outcome))) return false;
  if (value.stability !== undefined && !['stable-pass', 'stable-fail', 'unstable', 'inconclusive'].includes(String(value.stability))) return false;
  for (const numeric of ['durationMs', 'ttftP95Ms'] as const) if (value[numeric] !== undefined && (typeof value[numeric] !== 'number' || !Number.isFinite(value[numeric]) || value[numeric] < 0)) return false;
  return true;
}
function boundedText(value: unknown, maximum: number): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum; }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }
