import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse, parseTree } from 'jsonc-parser';
import type { ScenarioCheckResult, ScenarioDefinition, ScenarioRunResult, TurnStageEnvironment, TurnStageProfile } from '../shared/types';
import type { CliExecutionResult, CliExecutionRuntime, CliRunRequest, CliVerifyRequest } from './contracts';
import { ProfileValidator, validateAdversarialScenariosAgainstProfile } from '../extension/config/profileValidator';
import { builtInEnvironment } from '../extension/config/defaultEnvironment';
import { normalizeAdversarialSuite, parseAdversarialSuite } from '../extension/testing/adversarialSuite';
import { compareScenarioEvidence } from '../extension/testing/scenarioComparison';
import { evaluatePerformance } from '../extension/testing/performanceEvaluator';
import { mapChangedFilesToTests } from '../extension/testing/impactMapping';
import { createProvenanceManifest, verifyProvenanceManifest, type ProvenanceFileInput, type ProvenanceManifest } from '../extension/testing/provenance';
import { runScenarioGroup } from '../extension/testing/scenarioExecution';
import { runScenario } from '../extension/testing/scenarioRunner';
import { NodeScenarioSession } from './nodeSession';

interface LoadedCase {
  key: string;
  profile: TurnStageProfile;
  scenario: ScenarioDefinition;
  suiteId?: string;
  suite?: unknown;
  environments: TurnStageEnvironment[];
}

const MAX_PROFILE_BYTES = 5 * 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_SUITE_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 100 * 1024 * 1024;
const MAX_CLI_CASES = 500;
const DEFAULT_MAX_REQUESTS = 10_000;

export class NodeCliRuntime implements CliExecutionRuntime {
  constructor(private readonly version: string, private readonly cwd = process.cwd()) {}

  async execute(request: CliRunRequest, signal?: AbortSignal): Promise<CliExecutionResult> {
    const workspaceRoot = resolve(request.impact.workspaceRoot ?? this.cwd);
    try {
      const loaded = await loadCases(workspaceRoot, request.configFiles);
      let selected = loaded.filter((item) => matchesSelectors(item, request));
      if (request.selectors.changedFiles.length) {
        const impact = mapChangedFilesToTests(request.selectors.changedFiles, selected.map((item) => ({ id: item.key, name: item.scenario.name, tags: item.scenario.tags, sourceBinding: item.scenario.sourceBinding })), { workspaceRoot, includeUnbound: request.impact.includeUnbound });
        const ids = new Set(impact.selected.map((item) => item.id));
        selected = selected.filter((item) => ids.has(item.key));
      }
      if (!selected.length) return { records: [{ id: 'selection', outcome: 'policy' }] };
      if (selected.length > MAX_CLI_CASES) return { records: [{ id: 'selection-cap', outcome: 'policy' }] };

      const repetitions = request.policy.repetitions;
      const selectedWithPolicy = selected.map((item) => ({ ...item, scenario: applyPolicy(item.scenario, repetitions, request.policy.timeoutMs, request.policy.failFast) }));
      const plannedRequests = selectedWithPolicy.reduce((sum, item) => {
        const executions = item.scenario.comparison ? 2 : item.scenario.adversarial?.repetitions ?? 1;
        const turns = Math.max(1, Math.min(item.scenario.steps.length, item.scenario.adversarial?.maxTurns ?? item.scenario.steps.length));
        const opening = item.profile.opening?.mode === 'request' ? 1 : 0;
        return sum + (turns + opening) * executions;
      }, 0);
      if (plannedRequests > (request.policy.maxRequests ?? DEFAULT_MAX_REQUESTS)) return { records: [{ id: 'request-budget', outcome: 'policy' }] };

      const records = await runPool(selectedWithPolicy, request.policy.concurrency ?? 3, signal, (item) => runCase(item, workspaceRoot, signal));
      const runId = crypto.randomUUID();
      const provenance = createProvenanceManifest({
        runId,
        runnerKind: 'cli',
        runnerVersion: this.version,
        selectedTestIds: selectedWithPolicy.map((item) => item.key),
        policy: request.policy,
        suite: selectedWithPolicy.flatMap((item) => item.suite ? [item.suite] : []),
        profile: [...new Map(selectedWithPolicy.map((item) => [item.profile.id, item.profile])).values()],
        result: records,
      });
      return { runId, records, manifestDigest: provenance.manifestDigest, provenance };
    } catch {
      return { records: [{ id: 'configuration', outcome: 'configuration' }] };
    }
  }

  async verify(request: CliVerifyRequest): Promise<CliExecutionResult> {
    try {
      const path = resolve(this.cwd, request.manifestPath);
      const manifest = JSON.parse(await readBoundedUtf8(path, MAX_MANIFEST_BYTES)) as ProvenanceManifest;
      const files: ProvenanceFileInput[] = [];
      let totalEvidenceBytes = 0;
      for (const file of manifest.files ?? []) {
        const target = resolveSafe(dirname(path), file.path);
        const contents = new Uint8Array(await readBoundedBytes(target, MAX_EVIDENCE_FILE_BYTES));
        totalEvidenceBytes += contents.byteLength;
        if (totalEvidenceBytes > MAX_TOTAL_EVIDENCE_BYTES) throw new Error('Evidence files exceed the total safety limit.');
        files.push({ path: file.path, contents });
      }
      const verification = verifyProvenanceManifest(manifest, { evidenceFiles: files });
      return { manifestDigest: manifest.manifestDigest, verification: { valid: verification.valid, manifestValid: verification.manifestValid, errors: verification.errors } };
    } catch {
      return { verification: { valid: false, manifestValid: false, errors: ['The provenance manifest or one of its evidence files could not be read safely.'] } };
    }
  }
}

async function loadCases(workspaceRoot: string, configured: readonly string[]): Promise<LoadedCase[]> {
  const profileFiles = configured.length ? configured.map((value) => resolveSafe(workspaceRoot, value)) : await discoverFiles(resolve(workspaceRoot, '.vscode/turnstage/profiles'), /\.turnstage\.jsonc?$/i);
  if (!profileFiles.length) throw new Error('No TurnStage profiles were found.');
  if (profileFiles.length > MAX_CLI_CASES) throw new Error('Too many profile files were selected.');
  const environments = [builtInEnvironment(), ...(await Promise.all((await discoverFiles(resolve(workspaceRoot, '.vscode/turnstage/environments'), /\.environment\.jsonc?$/i)).map((path) => readJsonc<TurnStageEnvironment>(path, MAX_ENVIRONMENT_BYTES))))];
  const uniqueEnvironments = [...new Map(environments.map((item) => [item.id, item])).values()];
  const result: LoadedCase[] = [];
  for (const profilePath of profileFiles) {
    const text = await readBoundedUtf8(profilePath, MAX_PROFILE_BYTES);
    const profile = parse(text, [], { allowTrailingComma: true, disallowComments: false }) as TurnStageProfile;
    const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    const issues = new ProfileValidator().validate(profile, tree, uniqueEnvironments);
    if (issues.some((issue) => issue.severity === 'error')) throw new Error('Profile validation failed.');
    for (const scenario of profile.tests?.scenarios ?? []) {
      if (result.length >= MAX_CLI_CASES) throw new Error('The selected profiles contain too many test cases.');
      result.push({ key: `${profile.id}/inline/${scenario.id}`, profile, scenario, environments: uniqueEnvironments });
    }
    for (const suitePath of profile.tests?.adversarialSuites ?? []) {
      const path = resolveSafe(workspaceRoot, suitePath);
      const parsed = parseAdversarialSuite(await readBoundedUtf8(path, MAX_SUITE_BYTES));
      if (!parsed.suite || parsed.parseErrors.length || parsed.issues.length) throw new Error('Adversarial suite validation failed.');
      const scenarios = normalizeAdversarialSuite(parsed.suite);
      if (validateAdversarialScenariosAgainstProfile(profile, scenarios, uniqueEnvironments).length) throw new Error('Adversarial suite is incompatible with its profile.');
      for (const scenario of scenarios) {
        if (result.length >= MAX_CLI_CASES) throw new Error('The selected profiles contain too many test cases.');
        result.push({ key: `${profile.id}/${parsed.suite.id}/${scenario.id}`, profile, scenario, suiteId: parsed.suite.id, suite: parsed.suite, environments: uniqueEnvironments });
      }
    }
  }
  return result;
}

function matchesSelectors(item: LoadedCase, request: CliRunRequest): boolean {
  const selectors = request.selectors;
  if (selectors.profiles.length && !selectors.profiles.includes(item.profile.id)) return false;
  if (selectors.suites.length && (!item.suiteId || !selectors.suites.includes(item.suiteId))) return false;
  if (selectors.cases.length && !selectors.cases.includes(item.scenario.id) && !selectors.cases.includes(item.key)) return false;
  if (selectors.tags.length && !selectors.tags.every((tag) => item.scenario.tags?.includes(tag))) return false;
  return true;
}

async function runCase(item: LoadedCase, workspaceRoot: string, signal?: AbortSignal) {
  const cancellation = abortCancellation(signal);
  let result: ScenarioRunResult;
  if (item.scenario.adversarial) {
    result = (await runScenarioGroup(item.profile.id, item.scenario, async () => new NodeScenarioSession(item.profile, selectEnvironment(item.environments, item.profile.environment), item.scenario, workspaceRoot), { cancellation })).result;
  } else if (item.scenario.comparison) {
    const baselineScenario = { ...item.scenario, assertions: [], steps: item.scenario.steps.map((step) => ({ ...step, assertions: [] })), controls: { ...(item.scenario.controls ?? {}), ...(item.scenario.comparison.baseline.controls ?? {}) } };
    const baseline = await runScenario(item.profile.id, baselineScenario, new NodeScenarioSession(item.profile, selectEnvironment(item.environments, item.scenario.comparison.baseline.environment ?? item.profile.environment), baselineScenario, workspaceRoot), cancellation);
    const candidateScenario = { ...item.scenario, controls: { ...(item.scenario.controls ?? {}), ...(item.scenario.comparison.candidate.controls ?? {}) } };
    const candidate = await runScenario(item.profile.id, candidateScenario, new NodeScenarioSession(item.profile, selectEnvironment(item.environments, item.scenario.comparison.candidate.environment ?? item.profile.environment), candidateScenario, workspaceRoot), cancellation);
    const comparison = compareScenarioEvidence(baseline.evidence, candidate.evidence, item.scenario.comparison);
    const baselineCheck: ScenarioCheckResult = { id: 'comparison.baseline-valid', label: 'Baseline completed with valid state invariants', passed: baseline.passed, kind: 'comparison', actual: baseline.passed ? 'valid' : 'invalid', expected: 'valid', location: { kind: 'profile', path: 'tests.comparison.baseline' } };
    const checks = [...candidate.checks, baselineCheck, ...comparison.checks, ...evaluatePerformance(item.scenario.performance, candidate, baseline)];
    result = { ...candidate, checks, passed: candidate.passed && checks.every((check) => check.passed), comparison: { baselineLabel: item.scenario.comparison.baseline.label ?? 'Baseline', candidateLabel: item.scenario.comparison.candidate.label ?? 'Candidate', baselineDurationMs: baseline.durationMs, candidateDurationMs: candidate.durationMs, differenceCount: comparison.differenceCount, differencePaths: comparison.differencePaths } };
  } else {
    const candidate = await runScenario(item.profile.id, item.scenario, new NodeScenarioSession(item.profile, selectEnvironment(item.environments, item.profile.environment), item.scenario, workspaceRoot), cancellation);
    const checks = [...candidate.checks, ...evaluatePerformance(item.scenario.performance, candidate)];
    result = { ...candidate, checks, passed: candidate.passed && checks.every((check) => check.passed) };
  }
  const outcome = result.adversarial?.outcome ?? (result.passed ? 'passed' : 'failed');
  const failureId = [...result.steps.flatMap((step) => step.checks), ...result.checks].find((check) => !check.passed)?.id;
  return { id: item.key, outcome, durationMs: result.durationMs, failureId };
}

function applyPolicy(scenario: ScenarioDefinition, repetitions: number | undefined, timeoutMs: number | undefined, failFast: boolean): ScenarioDefinition {
  if (!scenario.adversarial) return scenario;
  return { ...scenario, adversarial: { ...scenario.adversarial, ...(repetitions === undefined ? {} : { repetitions }), ...(timeoutMs === undefined ? {} : { timeoutMs }), failFast: failFast || scenario.adversarial.failFast } };
}

function selectEnvironment(values: readonly TurnStageEnvironment[], id: string | undefined): TurnStageEnvironment {
  const selected = values.find((item) => item.id === (id ?? 'local'));
  if (!selected) throw new Error('Configured environment was not found.');
  return selected;
}

function abortCancellation(signal?: AbortSignal) {
  return signal ? { get isCancellationRequested() { return signal.aborted; }, onCancellationRequested(listener: () => void) { signal.addEventListener('abort', listener, { once: true }); return { dispose: () => signal.removeEventListener('abort', listener) }; } } : undefined;
}

async function runPool<T, R>(items: readonly T[], concurrency: number, signal: AbortSignal | undefined, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (!signal?.aborted) {
      const index = cursor++;
      const item = items[index];
      if (!item) return;
      results.push({ index, value: await worker(item) });
    }
  }));
  return results.sort((a, b) => a.index - b.index).map((item) => item.value);
}

async function discoverFiles(directory: string, pattern: RegExp): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter((item) => item.isFile() && pattern.test(item.name)).map((item) => resolve(directory, item.name)).sort().slice(0, MAX_CLI_CASES); }
  catch { return []; }
}

async function readJsonc<T>(path: string, maxBytes: number): Promise<T> { return parse(await readBoundedUtf8(path, maxBytes), [], { allowTrailingComma: true, disallowComments: false }) as T; }

async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> { return new TextDecoder().decode(await readBoundedBytes(path, maxBytes)); }
async function readBoundedBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  if ((await stat(path)).size > maxBytes) throw new Error('File exceeds the safety limit.');
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength > maxBytes) throw new Error('File exceeds the safety limit.');
  return bytes;
}

function resolveSafe(root: string, value: string): string {
  const target = resolve(root, value);
  const path = relative(root, target);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Path leaves the workspace root.');
  return target;
}
