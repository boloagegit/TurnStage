import * as vscode from 'vscode';
import { findNodeAtLocation } from 'jsonc-parser';
import type {
  ScenarioCheckResult,
  ScenarioDefinition,
  ScenarioEvidenceLocation,
  ScenarioReportFormat,
  ScenarioReportingDefinition,
  ScenarioRunEvidence,
  ScenarioRunResult,
  TurnStageEnvironment,
  TurnStageProfile,
} from '../../shared/types';
import { ProfileCodec } from '../config/profileCodec';
import { builtInEnvironment } from '../config/defaultEnvironment';
import { EnvironmentRepository, ProfileRepository } from '../config/profileRepository';
import { ProfileValidator } from '../config/profileValidator';
import { LocalRunRepository } from '../history/localRunRepository';
import { localize } from '../l10n';
import { SessionController } from '../runtime/sessionController';
import { SecretService } from '../security/security';
import { compareScenarioEvidence } from './scenarioComparison';
import { evaluatePerformance } from './performanceEvaluator';
import type { ScenarioExecutionRecord } from './scenarioReport';
import { ScenarioReportService, type ConfiguredReportGroup } from './scenarioReportService';
import { runScenario } from './scenarioRunner';
import type { VisualRegressionService } from './visualRegression';

type TestData =
  | { type: 'profile'; uri: vscode.Uri }
  | { type: 'scenario'; uri: vscode.Uri; scenarioId: string }
  | { type: 'step'; uri: vscode.Uri; scenarioId: string; stepIndex: number };

export interface TestEvidenceReference {
  evidence: ScenarioRunEvidence;
  location: ScenarioEvidenceLocation;
  uri: vscode.Uri;
}

interface ScenarioJob {
  item: vscode.TestItem;
  uri: vscode.Uri;
  scenarioId: string;
  stepIndex?: number;
}

interface CompletedScenario {
  record: ScenarioExecutionRecord;
  profileUri: vscode.Uri;
  reporting?: ScenarioReportingDefinition;
}

const MAX_EVIDENCE_ENTRIES = 100;
const MAX_MESSAGE_EVIDENCE_ENTRIES = 500;
const MESSAGE_EVIDENCE_PREFIX = 'turnstage.evidence.';

export class ScenarioTestController implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();
  private readonly metadata = new WeakMap<vscode.TestItem, TestData>();
  private readonly messageEvidence = new WeakMap<vscode.TestMessage, { evidenceId: string; location: ScenarioEvidenceLocation }>();
  private readonly messageEvidenceByContext = new Map<string, { evidenceId: string; location: ScenarioEvidenceLocation }>();
  private readonly evidence = new Map<string, TestEvidenceReference>();
  private readonly reports: ScenarioReportService;
  private refreshing?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly profiles: ProfileRepository,
    private readonly environments: EnvironmentRepository,
    private readonly output: vscode.OutputChannel,
    visualRegression?: VisualRegressionService,
  ) {
    this.reports = new ScenarioReportService(output, visualRegression);
    this.controller = vscode.tests.createTestController('turnstage.contracts', localize('TurnStage Conversation Contracts'));
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.createRunProfile(localize('Run Conversation Contracts'), vscode.TestRunProfileKind.Run, async (request, token) => this.run(request, token), true);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.turnstage.jsonc');
    const refresh = () => { void this.refresh(); };
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    context.subscriptions.push(this.controller, watcher, vscode.workspace.onDidSaveTextDocument((document) => { if (document.uri.path.endsWith('.turnstage.jsonc')) refresh(); }));
  }

  dispose(): void { this.controller.dispose(); }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.discover().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  getEvidence(id: string): TestEvidenceReference | undefined { return this.evidence.get(id); }
  hasReport(): boolean { return this.reports.hasRecords(); }
  exportLastReport(format: ScenarioReportFormat): Promise<vscode.Uri | undefined> { return this.reports.exportLast(format); }
  exportEvidenceBundle(): Promise<vscode.Uri | undefined> { return this.reports.exportEvidenceBundle(); }
  async runAll(): Promise<void> {
    const cancellation = new vscode.CancellationTokenSource();
    try { await this.run(new vscode.TestRunRequest(), cancellation.token); }
    finally { cancellation.dispose(); }
  }

  getMessageEvidence(argument: unknown): TestEvidenceReference | undefined {
    if (!argument || typeof argument !== 'object') return undefined;
    const message = (argument as { message?: unknown }).message;
    if (!message || typeof message !== 'object') return undefined;
    const contextValue = typeof (message as { contextValue?: unknown }).contextValue === 'string' ? (message as { contextValue: string }).contextValue : undefined;
    const contextId = contextValue?.startsWith(MESSAGE_EVIDENCE_PREFIX) ? contextValue.slice(MESSAGE_EVIDENCE_PREFIX.length) : undefined;
    const target = this.messageEvidence.get(message as vscode.TestMessage) ?? (contextId ? this.messageEvidenceByContext.get(contextId) : undefined);
    const reference = target ? this.evidence.get(target.evidenceId) : undefined;
    return reference ? { ...reference, location: target!.location } : undefined;
  }

  private async discover(): Promise<void> {
    const entries = (await this.profiles.discover()).filter((entry) => !entry.overridden && entry.profile?.tests?.scenarios?.length);
    const roots: vscode.TestItem[] = [];
    for (const entry of entries) {
      if (!entry.profile) continue;
      const document = await vscode.workspace.openTextDocument(entry.uri);
      const parsed = this.codec.parse(document.getText());
      const profileItem = this.controller.createTestItem(entry.uri.toString(), entry.profile.name, entry.uri);
      profileItem.description = entry.scope === 'workspace' ? localize('Workspace profile') : localize('User profile');
      this.metadata.set(profileItem, { type: 'profile', uri: entry.uri });
      for (const [scenarioIndex, scenario] of (entry.profile.tests?.scenarios ?? []).entries()) {
        const scenarioItem = this.controller.createTestItem(`${entry.uri.toString()}::scenario::${scenario.id}`, scenario.name || scenario.id, entry.uri);
        scenarioItem.description = scenario.id;
        scenarioItem.range = nodeRange(document, parsed.tree, ['tests', 'scenarios', scenarioIndex]);
        this.metadata.set(scenarioItem, { type: 'scenario', uri: entry.uri, scenarioId: scenario.id });
        for (const [stepIndex, step] of scenario.steps.entries()) {
          const stepItem = this.controller.createTestItem(`${scenarioItem.id}::step::${step.id}`, step.name?.trim() || step.id, entry.uri);
          stepItem.description = step.input.length > 80 ? `${step.input.slice(0, 77)}…` : step.input;
          stepItem.range = nodeRange(document, parsed.tree, ['tests', 'scenarios', scenarioIndex, 'steps', stepIndex]);
          this.metadata.set(stepItem, { type: 'step', uri: entry.uri, scenarioId: scenario.id, stepIndex });
          scenarioItem.children.add(stepItem);
        }
        profileItem.children.add(scenarioItem);
      }
      roots.push(profileItem);
    }
    this.controller.items.replace(roots);
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    await this.refresh();
    const run = this.controller.createTestRun(request);
    const completed: CompletedScenario[] = [];
    try {
      const jobs = this.collectJobs(request);
      for (const job of jobs) {
        if (token.isCancellationRequested) break;
        if (!vscode.workspace.isTrusted) {
          run.skipped(job.item);
          run.appendOutput(`${localize('Skipped {name}: conversation contract tests require a trusted workspace.', { name: job.item.label })}\r\n`, undefined, job.item);
          continue;
        }
        const result = await this.runJob(job, run, token);
        if (result) completed.push(result);
      }
      this.reports.record(completed.map((item) => item.record));
      await this.reports.writeConfigured(reportGroups(completed));
    } finally {
      run.end();
    }
  }

  private collectJobs(request: vscode.TestRunRequest): ScenarioJob[] {
    const selected = request.include?.length ? [...request.include] : collectionValues(this.controller.items);
    const jobs = new Map<string, ScenarioJob>();
    const visit = (item: vscode.TestItem): void => {
      if (isExcluded(item, request.exclude)) return;
      const data = this.metadata.get(item);
      if (!data) return;
      if (data.type === 'profile') { item.children.forEach(visit); return; }
      if (data.type === 'scenario') { jobs.set(item.id, { item, uri: data.uri, scenarioId: data.scenarioId }); return; }
      jobs.set(item.id, { item, uri: data.uri, scenarioId: data.scenarioId, stepIndex: data.stepIndex });
    };
    selected.forEach(visit);
    return [...jobs.values()];
  }

  private async runJob(job: ScenarioJob, run: vscode.TestRun, token: vscode.CancellationToken): Promise<CompletedScenario | undefined> {
    const startedAt = Date.now();
    run.started(job.item);
    let session: SessionController | undefined;
    try {
      const loaded = await this.loadScenario(job.uri, job.scenarioId);
      const scenario = job.stepIndex === undefined ? loaded.scenario : { ...loaded.scenario, steps: loaded.scenario.steps.slice(0, job.stepIndex + 1), assertions: [] };
      let result: ScenarioRunResult;
      if (scenario.comparison) {
        const baselineScenario = withoutAssertions(withTargetControls(scenario, scenario.comparison.baseline.controls));
        const baselineSession = await this.createSession(job.uri, loaded.profile, selectEnvironment(loaded.environments, scenario.comparison.baseline.environment ?? loaded.profile.environment));
        let baseline: ScenarioRunResult;
        try { baseline = await runScenario(loaded.profile.id, baselineScenario, baselineSession, token); }
        finally { await baselineSession.disposeAndWait(); }
        if (token.isCancellationRequested) { run.skipped(job.item); return undefined; }
        const candidateScenario = withTargetControls(scenario, scenario.comparison.candidate.controls);
        session = await this.createSession(job.uri, loaded.profile, selectEnvironment(loaded.environments, scenario.comparison.candidate.environment ?? loaded.profile.environment), scenario.faults);
        const candidate = await runScenario(loaded.profile.id, candidateScenario, session, token);
        const comparison = compareScenarioEvidence(baseline.evidence, candidate.evidence, scenario.comparison);
        const baselineCheck: ScenarioCheckResult = {
          id: 'comparison.baseline-valid',
          label: localize('Baseline completed with valid TurnStage state invariants'),
          passed: baseline.passed,
          kind: 'comparison',
          actual: baseline.passed ? 'valid' : 'invalid',
          expected: 'valid',
          location: { kind: 'profile', path: 'tests.comparison.baseline' },
        };
        const performance = evaluatePerformance(scenario.performance, candidate, baseline);
        const checks = [...candidate.checks, baselineCheck, ...comparison.checks, ...performance];
        result = {
          ...candidate,
          checks,
          passed: candidate.passed && checks.every((check) => check.passed),
          comparison: {
            baselineLabel: scenario.comparison.baseline.label?.trim() || localize('Baseline'),
            candidateLabel: scenario.comparison.candidate.label?.trim() || localize('Candidate'),
            baselineDurationMs: baseline.durationMs,
            candidateDurationMs: candidate.durationMs,
            differenceCount: comparison.differenceCount,
            differencePaths: comparison.differencePaths,
          },
        };
      } else {
        session = await this.createSession(job.uri, loaded.profile, loaded.environment, scenario.faults);
        const single = await runScenario(loaded.profile.id, scenario, session, token);
        const checks = [...single.checks, ...evaluatePerformance(scenario.performance, single)];
        result = { ...single, checks, passed: single.passed && checks.every((check) => check.passed) };
      }
      if (token.isCancellationRequested) { run.skipped(job.item); return; }
      const evidenceId = this.storeEvidence({ evidence: result.evidence, location: { kind: 'profile', path: 'tests' }, uri: job.uri });
      const targetSteps = job.stepIndex === undefined ? result.steps : result.steps.slice(job.stepIndex, job.stepIndex + 1);
      for (const stepResult of targetSteps) {
        const stepItem = job.stepIndex === undefined ? findStepItem(job.item, stepResult.stepId) : job.item;
        if (!stepItem) continue;
        const failures = stepResult.checks.filter((check) => !check.passed);
        if (failures.length) run.failed(stepItem, failures.map((check) => this.testMessage(check, evidenceId, stepItem)), stepResult.durationMs);
        else run.passed(stepItem, stepResult.durationMs);
        this.appendChecks(run, stepItem, stepResult.checks);
      }
      const scenarioFailures = result.checks.filter((check) => !check.passed);
      const stepFailed = targetSteps.some((step) => step.checks.some((check) => !check.passed));
      if (job.stepIndex === undefined) {
        if (scenarioFailures.length) run.failed(job.item, scenarioFailures.map((check) => this.testMessage(check, evidenceId, job.item)), result.durationMs);
        else if (stepFailed || !result.passed) run.failed(job.item, new vscode.TestMessage(localize('One or more scenario steps failed.')), result.durationMs);
        else run.passed(job.item, result.durationMs);
      }
      run.appendOutput(`${result.passed ? 'PASS' : 'FAIL'} ${loaded.profile.name} / ${loaded.scenario.name} (${result.durationMs} ms)\r\n`, undefined, job.item);
      return {
        record: { profileId: loaded.profile.id, profileName: loaded.profile.name, scenarioId: loaded.scenario.id, scenarioName: loaded.scenario.name, result, status: result.passed ? 'passed' : 'failed' },
        profileUri: job.uri,
        reporting: loaded.profile.tests?.reporting,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.errored(job.item, new vscode.TestMessage(message), Date.now() - startedAt);
      run.appendOutput(`ERROR ${job.item.label}: ${message}\r\n`, undefined, job.item);
      return { record: { profileId: 'profile-error', profileName: 'profile', scenarioId: job.scenarioId, scenarioName: job.item.label, status: 'error' }, profileUri: job.uri };
    } finally {
      await session?.disposeAndWait();
    }
  }

  private async loadScenario(uri: vscode.Uri, scenarioId: string): Promise<{ profile: TurnStageProfile; scenario: ScenarioDefinition; environment: TurnStageEnvironment; environments: TurnStageEnvironment[] }> {
    const document = await vscode.workspace.openTextDocument(uri);
    const parsed = this.codec.parse(document.getText());
    const environments = await this.environments.discover(uri);
    const issues = this.validator.validate(parsed.profile, parsed.tree, environments.map((entry) => entry.environment));
    const firstError = issues.find((issue) => issue.severity === 'error');
    if (!parsed.profile || firstError) throw new Error(firstError?.message ?? localize('Profile could not be parsed.'));
    const scenario = parsed.profile.tests?.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(localize('Scenario {id} was not found.', { id: scenarioId }));
    const available = environments.map((entry) => entry.environment);
    return { profile: parsed.profile, scenario, environment: selectEnvironment(available, parsed.profile.environment), environments: available };
  }

  private async createSession(uri: vscode.Uri, sourceProfile: TurnStageProfile, environment: TurnStageEnvironment, faults?: ScenarioDefinition['faults']): Promise<SessionController> {
    const profile: TurnStageProfile = structuredClone(sourceProfile);
    profile.history = { ...profile.history, localRuns: { ...profile.history?.localRuns, enabled: false } };
    const session = new SessionController(profile, uri, environment, this.context, new SecretService(this.context), new LocalRunRepository(this.context), () => undefined, this.output, { faults });
    await session.loadRuns();
    return session;
  }

  private testMessage(check: ScenarioCheckResult, evidenceId: string, item: vscode.TestItem): vscode.TestMessage {
    const args = encodeURIComponent(JSON.stringify([{ evidenceId, location: check.location }]));
    const markdown = new vscode.MarkdownString(`${escapeMarkdown(check.label)}\n\n[${escapeMarkdown(localize('Open related Network or Event evidence'))}](command:turnstage.openTestEvidence?${args})`);
    markdown.isTrusted = { enabledCommands: ['turnstage.openTestEvidence'] };
    const message = new vscode.TestMessage(markdown);
    const contextId = crypto.randomUUID();
    const target = { evidenceId, location: check.location };
    message.contextValue = `${MESSAGE_EVIDENCE_PREFIX}${contextId}`;
    this.messageEvidence.set(message, target);
    this.messageEvidenceByContext.set(contextId, target);
    while (this.messageEvidenceByContext.size > MAX_MESSAGE_EVIDENCE_ENTRIES) this.messageEvidenceByContext.delete(this.messageEvidenceByContext.keys().next().value!);
    message.actualOutput = printable(check.actual);
    message.expectedOutput = printable(check.expected);
    if (item.uri && item.range) message.location = new vscode.Location(item.uri, item.range);
    return message;
  }

  private appendChecks(run: vscode.TestRun, item: vscode.TestItem, checks: ScenarioCheckResult[]): void {
    for (const check of checks) run.appendOutput(`  ${check.passed ? 'PASS' : 'FAIL'} ${check.kind}: ${check.label}\r\n`, undefined, item);
  }

  private storeEvidence(reference: TestEvidenceReference): string {
    const id = crypto.randomUUID();
    this.evidence.set(id, reference);
    while (this.evidence.size > MAX_EVIDENCE_ENTRIES) this.evidence.delete(this.evidence.keys().next().value!);
    return id;
  }
}

function collectionValues(collection: vscode.TestItemCollection): vscode.TestItem[] { const values: vscode.TestItem[] = []; collection.forEach((item) => values.push(item)); return values; }
function withTargetControls(scenario: ScenarioDefinition, controls: Record<string, unknown> | undefined): ScenarioDefinition { return { ...scenario, controls: { ...(scenario.controls ?? {}), ...(controls ?? {}) } }; }
function withoutAssertions(scenario: ScenarioDefinition): ScenarioDefinition { return { ...scenario, assertions: [], steps: scenario.steps.map((step) => ({ ...step, assertions: [] })) }; }
function selectEnvironment(environments: readonly TurnStageEnvironment[], id: string | undefined): TurnStageEnvironment {
  const builtIn = builtInEnvironment();
  if (!id) return builtIn;
  const environment = environments.find((candidate) => candidate.id === id);
  if (environment) return environment;
  if (id === builtIn.id) return builtIn;
  throw new Error(localize('Environment "{environment}" was not found.', { environment: id }));
}
function reportGroups(completed: readonly CompletedScenario[]): ConfiguredReportGroup[] {
  const groups = new Map<string, ConfiguredReportGroup>();
  for (const item of completed) {
    if (!item.reporting) continue;
    const key = `${item.profileUri.toString()}::${item.record.profileId}`;
    const group = groups.get(key) ?? { profileId: item.record.profileId, profileUri: item.profileUri, reporting: item.reporting, records: [] };
    group.records.push(item.record);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function isExcluded(item: vscode.TestItem, excluded: readonly vscode.TestItem[] | undefined): boolean { return excluded?.some((candidate) => candidate.id === item.id) ?? false; }
function findStepItem(scenario: vscode.TestItem, stepId: string): vscode.TestItem | undefined { let found: vscode.TestItem | undefined; scenario.children.forEach((item) => { if (item.id.endsWith(`::step::${stepId}`)) found = item; }); return found; }
function nodeRange(document: vscode.TextDocument, tree: ReturnType<ProfileCodec['parse']>['tree'], path: Array<string | number>): vscode.Range | undefined { const node = tree ? findNodeAtLocation(tree, path) : undefined; return node ? new vscode.Range(document.positionAt(node.offset), document.positionAt(node.offset + node.length)) : undefined; }
function printable(value: unknown): string { try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); } }
function escapeMarkdown(value: string): string {
  let escaped = value;
  for (const character of ['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '.', '!', '|', '>', '-']) escaped = escaped.replaceAll(character, `\\${character}`);
  return escaped;
}
