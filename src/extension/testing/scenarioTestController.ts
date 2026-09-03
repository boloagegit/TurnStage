import * as vscode from 'vscode';
import { findNodeAtLocation } from 'jsonc-parser';
import type {
  AdversarialResultSummary,
  AutomationResultSummary,
  CampaignBaselineV1,
  CampaignDashboardV1,
  CampaignRunRecordV1,
  ScenarioCheckResult,
  ScenarioDefinition,
  ScenarioEvidenceLocation,
  ScenarioReportFormat,
  ScenarioReportingDefinition,
  ScenarioRunEvidence,
  ScenarioRunResult,
  ScenarioRunGroupRecord,
  TestCampaignDefinition,
  TurnStageEnvironment,
  TurnStageProfile,
} from '../../shared/types';
import { ProfileCodec } from '../config/profileCodec';
import { builtInEnvironment } from '../config/defaultEnvironment';
import { EnvironmentRepository, ProfileRepository } from '../config/profileRepository';
import { ProfileValidator, validateAdversarialScenariosAgainstProfile, validateContractScenariosAgainstProfile } from '../config/profileValidator';
import { LocalRunRepository } from '../history/localRunRepository';
import { localize } from '../l10n';
import { SessionController } from '../runtime/sessionController';
import { SecretService } from '../security/security';
import { compareScenarioEvidence } from './scenarioComparison';
import { evaluatePerformance } from './performanceEvaluator';
import type { ScenarioExecutionRecord } from './scenarioReport';
import { ScenarioReportService, type ConfiguredReportGroup, type CopilotArtifactProvider } from './scenarioReportService';
import { runScenario } from './scenarioRunner';
import { MAX_COPILOT_RUN_ATTEMPTS, MAX_COPILOT_RUN_REQUESTS, MAX_RUN_PLAN_ATTEMPTS, MAX_RUN_PLAN_REQUESTS, runScenarioGroup } from './scenarioExecution';
import { loadAdversarialSuite } from './adversarialSuiteRepository';
import { loadContractSuite } from './contractSuiteRepository';
import { ScenarioRunGroupRepository } from './scenarioRunGroupRepository';
import type { VisualRegressionService } from './visualRegression';
import { createTrustAwareCancellation } from './trustCancellation';
import { createReliabilitySummary } from './reliabilityStatistics';
import { createBatchRunPlan } from './batchRun';
import { attachCampaignBaseline, createCampaignPlan, createCampaignRunRecord, type CampaignCaseInput, type CampaignPlanV1 } from './campaign';
import { CampaignRepository } from './campaignRepository';
import { digestValue } from './provenance';
import { logAt, startLogOperation } from '../logging';
import type { TestOperationProgress } from '../../shared/protocol';
import { ExternalAdversarialSuiteRepository } from './externalAdversarialSuite';

type TestData =
  | { type: 'profile'; uri: vscode.Uri; profileId: string }
  | { type: 'suite'; uri: vscode.Uri; profileId: string; suiteId?: string; suitePath: string; suiteKind: 'adversarial' | 'contract' }
  | { type: 'scenario'; uri: vscode.Uri; profileId: string; suiteId?: string; scenarioId: string; suitePath?: string; suiteKind?: 'adversarial' | 'contract'; tags?: string[]; sourceBinding?: ScenarioDefinition['sourceBinding']; adversarial: boolean; repetitions?: number; plannedTurns: number }
  | { type: 'step'; uri: vscode.Uri; profileId: string; suiteId?: string; scenarioId: string; stepIndex: number; suitePath?: string; suiteKind?: 'adversarial' | 'contract' };

export interface TestEvidenceReference {
  evidence: ScenarioRunEvidence;
  /** In-memory only; exports remain sanitized by the report service. */
  result?: ScenarioRunResult;
  location: ScenarioEvidenceLocation;
  uri: vscode.Uri;
}

interface ScenarioJob {
  item: vscode.TestItem;
  uri: vscode.Uri;
  profileId: string;
  scenarioId: string;
  suiteId?: string;
  stepIndex?: number;
  suitePath?: string;
  suiteKind?: 'adversarial' | 'contract';
}

type LoadedScenario = {
  profile: TurnStageProfile;
  scenario: ScenarioDefinition;
  environment: TurnStageEnvironment;
  environments: TurnStageEnvironment[];
};

type LoadedProfileContext = Omit<LoadedScenario, 'scenario'>;

interface PreparedScenarioJob {
  job: ScenarioJob;
  loaded: LoadedScenario;
}

interface ScenarioRunScope {
  runId?: string;
  campaign?: {
    runId: string;
    onAttemptComplete: (job: ScenarioJob, record: import('../../shared/types').ScenarioRunGroupRecord) => Promise<void>;
  };
  /** Throws when the final immutable execution snapshot is stale. */
  validateIntegrity?: (material: ScenarioIntegrityMaterial) => void;
  progress?: (progress: TestOperationProgress) => void;
}

interface CompletedScenario {
  record: ScenarioExecutionRecord;
  profileUri: vscode.Uri;
  suiteId?: string;
  reporting?: ScenarioReportingDefinition;
  evidenceId?: string;
}

export interface ScenarioRunSelection {
  itemIds?: readonly string[];
  repetitions?: number;
  failFast?: boolean;
  maxConcurrency?: number;
  maxRequests?: number;
  maxDurationMs?: number;
}

export interface ScenarioRunPreview {
  selectedCount: number;
  plannedAttempts: number;
  plannedTurns: number;
  maximumRequests: number;
  maximumDurationMs: number;
  maximumRepetitions: number;
  environments: string[];
  warnings: string[];
}

export interface CampaignProgressEvent {
  runId: string;
  campaignId: string;
  completedCases: number;
  totalCases: number;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
}

/**
 * Immutable result returned to the Copilot adapter for one invocation. The
 * controller still maintains latest results for Test Explorer, but callers
 * that need correctness across concurrent runs must consume this snapshot.
 */
export interface ScenarioRunSnapshot {
  summaries: readonly ScenarioControllerRunSummary[];
  results: readonly AdversarialResultSummary[];
  cancelled?: boolean;
}

export interface ScenarioControllerRunSummary {
  profileId: string;
  suiteId?: string;
  scenarioId: string;
  scenarioName: string;
  outcome: AdversarialResultSummary['outcome'] | 'passed' | 'failed' | 'error';
  stability?: NonNullable<AdversarialResultSummary['repetitions']>['stability'];
  counts?: NonNullable<AdversarialResultSummary['repetitions']>['counts'];
  sampleComplete?: boolean;
  evidenceId?: string;
}

export interface ScenarioControllerTestDescriptor {
  id: string;
  uri: string;
  label: string;
  kind: 'profile' | 'suite' | 'case' | 'step';
  profileId: string;
  suiteId?: string;
  caseId?: string;
  tags?: string[];
  plannedTurns?: number;
  repetitions?: number;
  adversarial?: boolean;
  sourceBinding?: ScenarioDefinition['sourceBinding'];
}

export interface ScenarioIntegrityMaterial {
  profile: unknown;
  suite?: unknown;
  cases: Record<string, unknown>;
}

// An adversarial run stores one attempt capsule plus one aggregate capsule per
// selected case. Keep retention aligned with the aggregate attempt cap so a
// legal run can still be inspected after it completes.
// Enough for the largest Copilot run plus one aggregate record per attempt,
// without retaining the much larger manual-suite ceiling in memory.
const MAX_EVIDENCE_ENTRIES = MAX_COPILOT_RUN_ATTEMPTS * 2;
const MAX_PROTECTED_EVIDENCE_ENTRIES = MAX_COPILOT_RUN_ATTEMPTS;
const MAX_MESSAGE_EVIDENCE_ENTRIES = 500;
const MESSAGE_EVIDENCE_PREFIX = 'turnstage.evidence.';
const MANUAL_BATCH_CONFIRM_REQUESTS = 250;

export class ScenarioTestController implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();
  private readonly metadata = new WeakMap<vscode.TestItem, TestData>();
  private readonly messageEvidence = new WeakMap<vscode.TestMessage, { evidenceId: string; location: ScenarioEvidenceLocation }>();
  private readonly messageEvidenceByContext = new Map<string, { evidenceId: string; location: ScenarioEvidenceLocation }>();
  private readonly evidence = new Map<string, TestEvidenceReference>();
  /** Evidence for the latest bounded Copilot run is pinned against manual-run eviction. */
  private readonly protectedCopilotEvidence = new Set<string>();
  private readonly reports: ScenarioReportService;
  private readonly runGroups: ScenarioRunGroupRepository;
  private readonly campaigns: CampaignRepository;
  private readonly externalAdversarialSuites: ExternalAdversarialSuiteRepository;
  private readonly resultsEmitter = new vscode.EventEmitter<{ uri: vscode.Uri; results: AdversarialResultSummary[]; automationResults: AutomationResultSummary[] }>();
  readonly onDidChangeResults = this.resultsEmitter.event;
  private readonly campaignEmitter = new vscode.EventEmitter<{ uri: vscode.Uri; dashboard: CampaignDashboardV1 }>();
  readonly onDidChangeCampaigns = this.campaignEmitter.event;
  private readonly campaignProgressEmitter = new vscode.EventEmitter<CampaignProgressEvent>();
  readonly onDidChangeCampaignProgress = this.campaignProgressEmitter.event;
  private readonly latestResults = new Map<string, AdversarialResultSummary[]>();
  private readonly latestAutomationResults = new Map<string, AutomationResultSummary[]>();
  private latestRunSummaries: ScenarioControllerRunSummary[] = [];
  private refreshing?: Promise<void>;
  private activeManualRun?: vscode.CancellationTokenSource;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly profiles: ProfileRepository,
    private readonly environments: EnvironmentRepository,
    private readonly output: vscode.OutputChannel,
    visualRegression?: VisualRegressionService,
    copilotArtifacts?: CopilotArtifactProvider,
  ) {
    this.reports = new ScenarioReportService(output, visualRegression, String(context.extension.packageJSON.version ?? 'unknown'), copilotArtifacts);
    this.runGroups = new ScenarioRunGroupRepository(context, output);
    this.campaigns = new CampaignRepository(context, output);
    this.externalAdversarialSuites = new ExternalAdversarialSuiteRepository(context);
    this.controller = vscode.tests.createTestController('turnstage.contracts', localize('TurnStage Conversation Contracts'));
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.createRunProfile(localize('Run Conversation Contracts'), vscode.TestRunProfileKind.Run, async (request, token) => { await this.run(request, token); }, true);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{turnstage,adversarial}.{json,jsonc,csv}');
    const refresh = () => { void this.refresh().catch((error) => logAt(this.output, 'error', () => `[tests] refresh failed type=${error instanceof Error ? error.name : 'Error'}`)); };
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    context.subscriptions.push(watcher, vscode.workspace.onDidSaveTextDocument((document) => { if (/\.(?:turnstage\.(?:json|jsonc)|adversarial\.(?:json|jsonc|csv))$/iu.test(document.uri.path)) refresh(); }));
  }

  dispose(): void { this.activeManualRun?.cancel(); this.resultsEmitter.dispose(); this.campaignEmitter.dispose(); this.campaignProgressEmitter.dispose(); this.controller.dispose(); }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.discover().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  getEvidence(id: string): TestEvidenceReference | undefined { return this.evidence.get(id); }
  hasReport(): boolean { return this.reports.hasRecords(); }
  exportLastReport(format: ScenarioReportFormat): Promise<vscode.Uri | undefined> { return this.reports.exportLast(format); }
  exportEvidenceReport(evidenceId: string, format: ScenarioReportFormat): Promise<vscode.Uri | undefined> {
    const reference = this.evidence.get(evidenceId);
    if (!reference?.result?.adversarial) throw new Error(localize('This test evidence is no longer available. Run the scenario again.'));
    const summary = [...this.latestResults.values()].flat().find((candidate) => candidate.evidenceId === evidenceId || candidate.repetitions?.attempts?.some((attempt) => attempt.evidenceId === evidenceId));
    if (!summary) throw new Error(localize('This test result is no longer available. Run the scenario again.'));
    const record: ScenarioExecutionRecord = {
      profileId: summary.profileId,
      profileName: summary.profileId,
      scenarioId: summary.scenarioId,
      scenarioName: summary.scenarioName,
      result: reference.result,
      status: adversarialRecordStatus(reference.result.adversarial.outcome),
    };
    return this.reports.exportRecords(format, [record], `turnstage-${summary.scenarioId}-result`);
  }
  exportEvidenceBundle(): Promise<vscode.Uri | undefined> { return this.reports.exportEvidenceBundle(); }
  getLatestResults(uri: vscode.Uri): AdversarialResultSummary[] { return this.latestResults.get(uri.toString()) ?? []; }
  getLatestAutomationResults(uri: vscode.Uri): AutomationResultSummary[] { return this.latestAutomationResults.get(uri.toString()) ?? []; }
  async getCampaignDashboard(uri: vscode.Uri): Promise<CampaignDashboardV1> {
    const entry = await this.profiles.read(uri);
    if (!entry.profile) throw new Error(entry.error ?? 'Profile could not be parsed.');
    const campaigns: CampaignDashboardV1['campaigns'] = [];
    for (const definition of entry.profile.tests?.campaigns ?? []) {
      const latest = (await this.campaigns.listRuns(entry.profile.id, definition.id))[0];
      const accepted = await this.campaigns.getAcceptedBaseline(entry.profile.id, definition.id);
      campaigns.push({
        definition: structuredClone(definition),
        ...(latest ? { latest: accepted && latest.id !== accepted.run.id ? attachCampaignBaseline(latest, accepted.run) : latest } : {}),
        ...(accepted ? { baseline: accepted.baseline } : {}),
      });
    }
    return { profileId: entry.profile.id, campaigns };
  }

  async previewCampaign(uri: vscode.Uri, campaignId: string): Promise<CampaignPlanV1> {
    return (await this.prepareCampaign(uri, campaignId)).plan;
  }

  async runCampaign(uri: vscode.Uri, campaignId: string, token: vscode.CancellationToken, resumeRunId?: string): Promise<CampaignRunRecordV1> {
    const operation = startLogOperation(this.output, 'campaign', resumeRunId ? 'resume' : 'run', { campaign: campaignId });
    if (!vscode.workspace.isTrusted) {
      operation.fail({ reason: 'workspace-untrusted' });
      throw new Error('Test campaigns require a trusted workspace.');
    }
    let prepared: Awaited<ReturnType<ScenarioTestController['prepareCampaign']>>;
    try { prepared = await this.prepareCampaign(uri, campaignId); }
    catch (error) { operation.fail({ reason: error instanceof Error ? error.name : 'prepare-failed' }); throw error; }
    if (!prepared.plan.batch.valid || !prepared.plan.batch.withinBudget) {
      operation.fail({ reason: 'budget-rejected', issues: prepared.plan.batch.issues.length });
      throw new Error(prepared.plan.batch.issues.map((item) => item.message).join('\n'));
    }
    let record = resumeRunId ? await this.campaigns.getRun(prepared.profile.id, resumeRunId) : undefined;
    if (resumeRunId && !record) { operation.fail({ reason: 'resume-not-found' }); throw new Error('The campaign run to resume was not found.'); }
    if (record && (record.campaignId !== campaignId || record.sourceDigest !== prepared.plan.sourceDigest)) { operation.fail({ reason: 'resume-integrity-mismatch' }); throw new Error('The saved campaign does not match the current profile, selectors, or run policy. Start a new run.'); }
    if (record?.status === 'completed') { operation.fail({ reason: 'already-completed' }); throw new Error('The selected campaign run is already complete.'); }
    record = record ?? createCampaignRunRecord(prepared.plan, prepared.profile.id, { id: crypto.randomUUID() });
    record = { ...record, status: 'running', updatedAt: Date.now() };
    try {
      await this.campaigns.saveRun(record);
      this.campaignEmitter.fire({ uri, dashboard: await this.getCampaignDashboard(uri) });
    } catch (error) {
      operation.fail({ reason: error instanceof Error ? error.name : 'storage-failed' });
      throw error;
    }
    const runId = record.id;
    let progressBucket = -1;
    this.campaignProgressEmitter.fire({ runId, campaignId, completedCases: record.cases.filter((item) => item.sampleComplete).length, totalCases: record.cases.length, state: 'running' });
    const checkpoint = async (job: ScenarioJob, group: ScenarioRunGroupRecord): Promise<void> => {
      const key = campaignCaseKey(group.profileId, job.suiteId, group.scenarioId);
      record = {
        ...record!,
        updatedAt: Date.now(),
        cases: record!.cases.map((item) => item.key !== key ? item : {
          ...item,
          requestedAttempts: group.requestedAttempts,
          completedAttempts: group.completedAttempts,
          outcome: group.outcome,
          stability: group.stability,
          sampleComplete: group.sampleComplete,
          counts: { ...group.counts },
          durationMs: group.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
          ttftP95Ms: percentile95(group.attempts.flatMap((attempt) => attempt.ttftMs === undefined ? [] : [attempt.ttftMs])),
        }),
      };
      await this.campaigns.saveRun(record!);
      const completedCases = record!.cases.filter((item) => item.sampleComplete).length;
      const nextBucket = record!.cases.length ? Math.floor((completedCases * 10) / record!.cases.length) : 10;
      if (nextBucket > progressBucket) {
        progressBucket = nextBucket;
        operation.progress({ completedCases, totalCases: record!.cases.length });
        this.campaignProgressEmitter.fire({ runId, campaignId, completedCases, totalCases: record!.cases.length, state: 'running' });
      }
    };
    try {
      const snapshot = await this.runSelection({
        itemIds: prepared.plan.selected.map((item) => item.itemId),
        repetitions: prepared.definition.runPolicy?.repetitions,
        failFast: prepared.definition.runPolicy?.failFast,
        maxConcurrency: prepared.definition.runPolicy?.maxConcurrency,
        maxRequests: prepared.definition.runPolicy?.maxRequests,
        maxDurationMs: prepared.definition.runPolicy?.maxDurationMs,
      }, token, { campaign: { runId, onAttemptComplete: checkpoint } });
      const summaries = new Map(snapshot.summaries.map((item) => [campaignCaseKey(item.profileId, item.suiteId, item.scenarioId), item]));
      record = {
        ...record,
        updatedAt: Date.now(),
        status: token.isCancellationRequested ? 'cancelled' : 'completed',
        cases: record.cases.map((item) => {
          const summary = summaries.get(item.key);
          if (!summary) return item;
          const completedAttempts = summary.counts ? Object.values(summary.counts).reduce((sum, count) => sum + count, 0) : 1;
          return { ...item, completedAttempts, outcome: summary.outcome, stability: summary.stability, sampleComplete: summary.sampleComplete ?? true, ...(summary.counts ? { counts: { ...summary.counts } } : {}) };
        }),
      };
      if (!token.isCancellationRequested && record.cases.some((item) => !item.sampleComplete)) record = { ...record, status: 'cancelled' };
      const accepted = await this.campaigns.getAcceptedBaseline(record.profileId, record.campaignId);
      if (accepted && accepted.run.id !== record.id) record = attachCampaignBaseline(record, accepted.run);
      await this.campaigns.saveRun(record);
      this.reports.attachCampaign(record);
      const dashboard = await this.getCampaignDashboard(uri);
      this.campaignEmitter.fire({ uri, dashboard });
      const completedCases = record.cases.filter((item) => item.sampleComplete).length;
      const counts = campaignOutcomeCounts(record);
      if (record.status === 'cancelled') operation.cancel({ completedCases, totalCases: record.cases.length, ...counts });
      else operation.complete({ completedCases, totalCases: record.cases.length, ...counts });
      this.campaignProgressEmitter.fire({ runId, campaignId, completedCases, totalCases: record.cases.length, state: record.status === 'cancelled' ? 'cancelled' : 'completed' });
      return record;
    } catch (error) {
      record = { ...record, status: 'cancelled', updatedAt: Date.now() };
      await this.campaigns.saveRun(record);
      if (this.reports.hasRecords()) this.reports.attachCampaign(record);
      this.campaignEmitter.fire({ uri, dashboard: await this.getCampaignDashboard(uri) });
      const completedCases = record.cases.filter((item) => item.sampleComplete).length;
      if (token.isCancellationRequested) {
        operation.cancel({ completedCases, totalCases: record.cases.length });
        this.campaignProgressEmitter.fire({ runId, campaignId, completedCases, totalCases: record.cases.length, state: 'cancelled' });
        return record;
      }
      operation.fail({ reason: error instanceof Error ? error.name : 'Error', completedCases, totalCases: record.cases.length });
      this.campaignProgressEmitter.fire({ runId, campaignId, completedCases, totalCases: record.cases.length, state: 'failed' });
      throw error;
    }
  }

  async acceptCampaignBaseline(uri: vscode.Uri, campaignId: string, runId: string): Promise<CampaignBaselineV1> {
    const entry = await this.profiles.read(uri);
    if (!entry.profile) throw new Error(entry.error ?? 'Profile could not be parsed.');
    const baseline = await this.campaigns.acceptBaseline(entry.profile.id, campaignId, runId);
    logAt(this.output, 'info', () => `[campaign] baseline accepted campaign=${campaignId}`);
    this.campaignEmitter.fire({ uri, dashboard: await this.getCampaignDashboard(uri) });
    return baseline;
  }

  async getCampaignRun(uri: vscode.Uri, runId: string): Promise<CampaignRunRecordV1 | undefined> {
    const entry = await this.profiles.read(uri);
    if (!entry.profile) throw new Error(entry.error ?? 'Profile could not be parsed.');
    return this.campaigns.getRun(entry.profile.id, runId);
  }
  getLatestRunSummaries(): readonly ScenarioControllerRunSummary[] { return this.latestRunSummaries.map((summary) => ({ ...summary, counts: summary.counts ? { ...summary.counts } : undefined })); }
  async runAll(): Promise<'completed' | 'cancelled'>;
  async runAll(onProgress: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'>;
  async runAll(onProgress?: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const cancellation = new vscode.CancellationTokenSource();
    this.activeManualRun = cancellation;
    try {
      const snapshot = await this.run(new vscode.TestRunRequest(), cancellation.token, {}, { progress: onProgress });
      return snapshot.cancelled ? 'cancelled' : 'completed';
    } finally {
      if (this.activeManualRun === cancellation) this.activeManualRun = undefined;
      cancellation.dispose();
    }
  }

  async runAdversarial(uri: vscode.Uri, onProgress?: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const uriKey = uri.toString();
    const matches = (await this.describeTests(false)).filter((item) => item.kind === 'case' && item.uri === uriKey && item.adversarial === true);
    if (!matches.length) throw new Error(localize('No adversarial cases are available for this profile.'));
    return this.runManualSelection(matches.map((item) => item.id), onProgress);
  }

  async runContracts(uri: vscode.Uri, onProgress?: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const uriKey = uri.toString();
    const matches = (await this.describeTests(false)).filter((item) => item.kind === 'case' && item.uri === uriKey && item.adversarial !== true);
    if (!matches.length) throw new Error(localize('No conversation contract scenarios are available for this profile.'));
    return this.runManualSelection(matches.map((item) => item.id), onProgress);
  }

  async runCase(uri: vscode.Uri, scenarioId: string, suiteId?: string, onProgress?: (progress: TestOperationProgress) => void, kind: 'adversarial' | 'contract' = 'adversarial'): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const uriKey = uri.toString();
    const matches = (await this.describeTests(false)).filter((item) => item.kind === 'case'
      && item.uri === uriKey
      && item.caseId === scenarioId
      && (kind === 'adversarial' ? item.adversarial === true : item.adversarial !== true)
      && item.suiteId === suiteId);
    if (!matches.length) throw new Error(localize(kind === 'adversarial' ? 'This adversarial case is no longer available. Refresh the cases and try again.' : 'This conversation contract is no longer available. Refresh the scenarios and try again.'));
    if (matches.length > 1) throw new Error(localize('More than one adversarial case matches this selection. Use Test Explorer to choose the exact case.'));
    return this.runManualSelection([matches[0]!.id], onProgress);
  }

  async rerunLatest(uri: vscode.Uri, status: 'failed' | 'unstable' | 'incomplete', onProgress?: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const latest = this.getLatestResults(uri).filter((result) => status === 'failed'
      ? result.outcome !== 'resisted'
      : status === 'unstable'
        ? result.repetitions?.stability === 'unstable'
        : result.repetitions?.sampleComplete === false);
    if (!latest.length) throw new Error(`No latest ${status} TurnStage results are available for this profile.`);
    const wanted = new Set(latest.map((result) => result.scenarioId));
    const itemIds: string[] = [];
    const visit = (item: vscode.TestItem): void => {
      const data = this.metadata.get(item);
      if (data?.type === 'scenario' && data.uri.toString() === uri.toString() && wanted.has(data.scenarioId)) itemIds.push(item.id);
      item.children.forEach(visit);
    };
    this.controller.items.forEach(visit);
    if (!itemIds.length) throw new Error('The matching Test Explorer items are no longer available. Refresh the tests and try again.');
    const cancellation = new vscode.CancellationTokenSource();
    this.activeManualRun = cancellation;
    try {
      const snapshot = await this.runSelection({ itemIds }, cancellation.token, { progress: onProgress });
      return snapshot.cancelled ? 'cancelled' : 'completed';
    } finally {
      if (this.activeManualRun === cancellation) this.activeManualRun = undefined;
      cancellation.dispose();
    }
  }

  cancelActiveManualRun(): boolean {
    if (!this.activeManualRun || this.activeManualRun.token.isCancellationRequested) return false;
    this.activeManualRun.cancel();
    return true;
  }

  private async runManualSelection(itemIds: readonly string[], onProgress?: (progress: TestOperationProgress) => void): Promise<'completed' | 'cancelled'> {
    if (this.activeManualRun) throw new Error(localize('A TurnStage test run is already active.'));
    const cancellation = new vscode.CancellationTokenSource();
    this.activeManualRun = cancellation;
    try {
      const snapshot = await this.runSelection({ itemIds }, cancellation.token, { progress: onProgress });
      return snapshot.cancelled ? 'cancelled' : 'completed';
    } finally {
      if (this.activeManualRun === cancellation) this.activeManualRun = undefined;
      cancellation.dispose();
    }
  }

  async runSelection(selection: ScenarioRunSelection, token: vscode.CancellationToken, scope: ScenarioRunScope = {}): Promise<ScenarioRunSnapshot> {
    if (scope.runId) this.releaseProtectedCopilotEvidence();
    await this.refresh();
    const include = selection.itemIds?.length ? this.findItems(selection.itemIds) : undefined;
    if (selection.itemIds?.length && include?.length !== new Set(selection.itemIds).size) throw new Error('One or more selected TurnStage test ids were not found.');
    const request = new vscode.TestRunRequest(include);
    const prepared = await this.prepareJobs(this.collectJobs(request));
    const preview = this.previewPrepared(prepared, selection);
    const attemptCap = scope.runId ? MAX_COPILOT_RUN_ATTEMPTS : MAX_RUN_PLAN_ATTEMPTS;
    const requestCap = scope.runId ? MAX_COPILOT_RUN_REQUESTS : MAX_RUN_PLAN_REQUESTS;
    if (preview.plannedAttempts > attemptCap || preview.maximumRequests > requestCap) {
      throw new Error(`The selected TurnStage tests exceed the safety budget of ${attemptCap} attempts and ${requestCap} requests.`);
    }
    scope.validateIntegrity?.(integrityMaterialFromPrepared(prepared));
    return this.run(request, token, selection, scope, prepared);
  }

  async previewSelection(selection: ScenarioRunSelection): Promise<ScenarioRunPreview> {
    await this.refresh();
    const include = selection.itemIds?.length ? this.findItems(selection.itemIds) : undefined;
    if (selection.itemIds?.length && include?.length !== new Set(selection.itemIds).size) throw new Error('One or more selected TurnStage test ids were not found.');
    const prepared = await this.prepareJobs(this.collectJobs(new vscode.TestRunRequest(include)));
    return this.previewPrepared(prepared, selection);
  }

  private previewPrepared(prepared: readonly PreparedScenarioJob[], selection: ScenarioRunSelection): ScenarioRunPreview {
    let plannedAttempts = 0;
    let plannedTurns = 0;
    let maximumRequests = 0;
    let maximumDurationMs = 0;
    let maximumRepetitions = 1;
    const environments = new Set<string>();
    const warnings: string[] = [];
    for (const { job, loaded } of prepared) {
      const base = job.stepIndex === undefined ? loaded.scenario : { ...loaded.scenario, steps: loaded.scenario.steps.slice(0, job.stepIndex + 1), assertions: [] };
      const scenario = withRunSelection(base, selection);
      const repetitions = scenario.adversarial?.repetitions ?? 1;
      const executions = scenario.comparison ? 2 : repetitions;
      const turns = scenario.steps.length;
      const openingRequests = loaded.profile.opening?.mode === 'request' ? 1 : 0;
      plannedAttempts += executions;
      plannedTurns += turns * executions;
      maximumRequests += (turns + openingRequests) * executions;
      maximumDurationMs += (scenario.adversarial?.timeoutMs ?? loaded.profile.conversation.send.timeoutMs ?? 60_000) * executions;
      maximumRepetitions = Math.max(maximumRepetitions, scenario.comparison ? 1 : repetitions);
      environments.add(loaded.environment.id);
    }
    if (plannedAttempts > MAX_RUN_PLAN_ATTEMPTS) warnings.push(`The selection plans ${plannedAttempts} attempts, above the safety cap of ${MAX_RUN_PLAN_ATTEMPTS}.`);
    if (maximumRequests > MAX_RUN_PLAN_REQUESTS) warnings.push(`The selection plans ${maximumRequests} requests, above the safety cap of ${MAX_RUN_PLAN_REQUESTS}.`);
    const jobs = prepared.map((item) => item.job);
    if (new Set(jobs.map((job) => job.scenarioId)).size !== jobs.length) warnings.push('The selection contains step-level runs; repeated scenario ids are counted separately.');
    if (maximumRepetitions > 1 && jobs.some((job) => job.stepIndex !== undefined)) warnings.push('A repetition override also repeats selected partial scenarios.');
    return { selectedCount: jobs.length, plannedAttempts, plannedTurns, maximumRequests, maximumDurationMs, maximumRepetitions, environments: [...environments].sort(), warnings };
  }

  async describeTests(includeSteps = false): Promise<ScenarioControllerTestDescriptor[]> {
    await this.refresh();
    const result: ScenarioControllerTestDescriptor[] = [];
    const visit = (item: vscode.TestItem): void => {
      const data = this.metadata.get(item);
      if (data && (includeSteps || data.type !== 'step')) {
        result.push({
          id: item.id,
          uri: data.uri.toString(),
          label: String(item.label),
          kind: data.type === 'scenario' ? 'case' : data.type,
          profileId: data.profileId,
          suiteId: 'suiteId' in data ? data.suiteId : undefined,
          caseId: data.type === 'scenario' || data.type === 'step' ? data.scenarioId : undefined,
          tags: data.type === 'scenario' ? structuredClone(data.tags) : undefined,
          plannedTurns: data.type === 'scenario' ? data.plannedTurns : undefined,
          repetitions: data.type === 'scenario' ? data.repetitions : undefined,
          adversarial: data.type === 'scenario' ? data.adversarial : undefined,
          sourceBinding: data.type === 'scenario' ? structuredClone(data.sourceBinding) : undefined,
        });
      }
      item.children.forEach(visit);
    };
    this.controller.items.forEach(visit);
    return result;
  }

  async getIntegrityMaterial(selection: ScenarioRunSelection & { profileId?: string; suiteId?: string; caseId?: string } = {}): Promise<ScenarioIntegrityMaterial> {
    await this.refresh();
    const descriptors = (await this.describeTests(false)).filter((item) => item.kind === 'case'
      && (!selection.profileId || item.profileId === selection.profileId)
      && (!selection.suiteId || item.suiteId === selection.suiteId)
      && (!selection.caseId || item.caseId === selection.caseId));
    const include = selection.itemIds?.length ? this.findItems(selection.itemIds) : this.findItems(descriptors.map((item) => item.id));
    if (selection.itemIds?.length && include.length !== new Set(selection.itemIds).size) throw new Error('One or more selected TurnStage test ids were not found.');
    const jobs = this.collectJobs(new vscode.TestRunRequest(include));
    const profiles = new Map<string, TurnStageProfile>();
    const suites = new Map<string, { id: string; profileId: string; cases: ScenarioDefinition[] }>();
    const cases: Record<string, unknown> = {};
    for (const job of jobs) {
      const loaded = await this.loadScenario(job.uri, job.scenarioId, job.suitePath, job.suiteKind);
      profiles.set(loaded.profile.id, structuredClone(loaded.profile));
      const data = this.metadata.get(job.item);
      const suiteId = data && 'suiteId' in data ? data.suiteId : undefined;
      const caseKey = `${loaded.profile.id}/${suiteId ?? 'inline'}/${loaded.scenario.id}`;
      cases[caseKey] = structuredClone(loaded.scenario);
      if (suiteId) {
        const suiteKey = `${loaded.profile.id}/${suiteId}`;
        const group = suites.get(suiteKey) ?? { id: suiteId, profileId: loaded.profile.id, cases: [] };
        if (!group.cases.some((item) => item.id === loaded.scenario.id)) group.cases.push(structuredClone(loaded.scenario));
        suites.set(suiteKey, group);
      }
    }
    const profile = [...profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
    const suite = [...suites.values()]
      .map((item) => ({ ...item, cases: [...item.cases].sort((a, b) => a.id.localeCompare(b.id)) }))
      .sort((a, b) => `${a.profileId}/${a.id}`.localeCompare(`${b.profileId}/${b.id}`));
    return { profile, ...(suite.length ? { suite } : {}), cases: Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b))) };
  }

  getMessageEvidence(argument: unknown): (TestEvidenceReference & { evidenceId: string }) | undefined {
    if (!argument || typeof argument !== 'object') return undefined;
    const message = (argument as { message?: unknown }).message;
    if (!message || typeof message !== 'object') return undefined;
    const contextValue = typeof (message as { contextValue?: unknown }).contextValue === 'string' ? (message as { contextValue: string }).contextValue : undefined;
    const contextId = contextValue?.startsWith(MESSAGE_EVIDENCE_PREFIX) ? contextValue.slice(MESSAGE_EVIDENCE_PREFIX.length) : undefined;
    const target = this.messageEvidence.get(message as vscode.TestMessage) ?? (contextId ? this.messageEvidenceByContext.get(contextId) : undefined);
    const reference = target ? this.evidence.get(target.evidenceId) : undefined;
    return reference ? { ...reference, evidenceId: target!.evidenceId, location: target!.location } : undefined;
  }

  private async discover(): Promise<void> {
    const entries = (await this.profiles.discover()).filter((entry) => !entry.overridden && ((entry.profile?.tests?.scenarios?.length ?? 0) > 0 || (entry.profile?.tests?.contractSuites?.length ?? 0) > 0 || (entry.profile?.tests?.adversarialSuites?.length ?? 0) > 0));
    const roots: vscode.TestItem[] = [];
    for (const entry of entries) {
      if (!entry.profile) continue;
      const document = await vscode.workspace.openTextDocument(entry.uri);
      const parsed = this.codec.parse(document.getText());
      const profileItem = this.controller.createTestItem(entry.uri.toString(), entry.profile.name, entry.uri);
      profileItem.description = entry.scope === 'workspace' ? localize('Workspace profile') : localize('User profile');
      this.metadata.set(profileItem, { type: 'profile', uri: entry.uri, profileId: entry.profile.id });
      for (const [scenarioIndex, scenario] of (entry.profile.tests?.scenarios ?? []).entries()) {
        const scenarioItem = this.controller.createTestItem(`${entry.uri.toString()}::scenario::${scenario.id}`, scenario.name || scenario.id, entry.uri);
        scenarioItem.description = scenario.id;
        scenarioItem.range = nodeRange(document, parsed.tree, ['tests', 'scenarios', scenarioIndex]);
        this.metadata.set(scenarioItem, { type: 'scenario', uri: entry.uri, profileId: entry.profile.id, scenarioId: scenario.id, tags: scenario.tags, sourceBinding: scenario.sourceBinding, adversarial: Boolean(scenario.adversarial), repetitions: scenario.adversarial?.repetitions, plannedTurns: scenario.steps.length });
        for (const [stepIndex, step] of scenario.steps.entries()) {
          const stepItem = this.controller.createTestItem(`${scenarioItem.id}::step::${step.id}`, step.name?.trim() || step.id, entry.uri);
          stepItem.description = step.input.length > 80 ? `${step.input.slice(0, 77)}…` : step.input;
          stepItem.range = nodeRange(document, parsed.tree, ['tests', 'scenarios', scenarioIndex, 'steps', stepIndex]);
          this.metadata.set(stepItem, { type: 'step', uri: entry.uri, profileId: entry.profile.id, scenarioId: scenario.id, stepIndex });
          scenarioItem.children.add(stepItem);
        }
        profileItem.children.add(scenarioItem);
      }
      for (const suitePath of entry.profile.tests?.adversarialSuites ?? []) {
        try {
          const loaded = await loadAdversarialSuite(entry.uri, suitePath, (reference) => this.externalAdversarialSuites.resolve(entry.uri, reference));
          const compatibilityError = validateAdversarialScenariosAgainstProfile(entry.profile, loaded.scenarios)[0];
          if (compatibilityError) throw new Error(localize('Adversarial case {id} is incompatible with this Profile: {message}', { id: compatibilityError.scenarioId, message: compatibilityError.message }));
          const suiteItem = this.controller.createTestItem(`${entry.uri.toString()}::suite::${loaded.suite.id}`, loaded.suite.name, loaded.uri);
          suiteItem.description = `${loaded.scenarios.length} ${localize('adversarial cases')}`;
          this.metadata.set(suiteItem, { type: 'suite', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, suitePath, suiteKind: 'adversarial' });
          for (const scenario of loaded.scenarios) {
            const scenarioItem = this.controller.createTestItem(`${suiteItem.id}::scenario::${scenario.id}`, scenario.name || scenario.id, loaded.uri);
            scenarioItem.description = scenario.id;
            this.metadata.set(scenarioItem, { type: 'scenario', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, scenarioId: scenario.id, suitePath, suiteKind: 'adversarial', tags: scenario.tags, sourceBinding: scenario.sourceBinding, adversarial: Boolean(scenario.adversarial), repetitions: scenario.adversarial?.repetitions, plannedTurns: scenario.steps.length });
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const stepItem = this.controller.createTestItem(`${scenarioItem.id}::step::${step.id}`, step.name?.trim() || step.id, loaded.uri);
              stepItem.description = step.input.length > 80 ? `${step.input.slice(0, 77)}…` : step.input;
              this.metadata.set(stepItem, { type: 'step', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, scenarioId: scenario.id, stepIndex, suitePath, suiteKind: 'adversarial' });
              scenarioItem.children.add(stepItem);
            }
            suiteItem.children.add(scenarioItem);
          }
          profileItem.children.add(suiteItem);
        } catch (error) {
          const suiteItem = this.controller.createTestItem(`${entry.uri.toString()}::suite-error::${suitePath}`, suitePath, entry.uri);
          suiteItem.description = error instanceof Error ? error.message.split('\n')[0] : String(error);
          this.metadata.set(suiteItem, { type: 'suite', uri: entry.uri, profileId: entry.profile.id, suitePath, suiteKind: 'adversarial' });
          profileItem.children.add(suiteItem);
        }
      }
      for (const suitePath of entry.profile.tests?.contractSuites ?? []) {
        try {
          const loaded = await loadContractSuite(entry.uri, suitePath, (reference) => this.externalAdversarialSuites.resolve(entry.uri, reference));
          const compatibilityError = validateContractScenariosAgainstProfile(entry.profile, loaded.scenarios)[0];
          if (compatibilityError) throw new Error(localize('Test case {id} is incompatible with this Profile: {message}', { id: compatibilityError.scenarioId, message: compatibilityError.message }));
          const suiteItem = this.controller.createTestItem(`${entry.uri.toString()}::contract-suite::${loaded.suite.id}`, loaded.suite.name, loaded.uri);
          suiteItem.description = `${loaded.scenarios.length} ${localize('conversation contracts')}`;
          this.metadata.set(suiteItem, { type: 'suite', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, suitePath, suiteKind: 'contract' });
          for (const scenario of loaded.scenarios) {
            const scenarioItem = this.controller.createTestItem(`${suiteItem.id}::scenario::${scenario.id}`, scenario.name || scenario.id, loaded.uri);
            scenarioItem.description = scenario.id;
            this.metadata.set(scenarioItem, { type: 'scenario', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, scenarioId: scenario.id, suitePath, suiteKind: 'contract', tags: scenario.tags, sourceBinding: scenario.sourceBinding, adversarial: false, plannedTurns: scenario.steps.length });
            for (const [stepIndex, step] of scenario.steps.entries()) {
              const stepItem = this.controller.createTestItem(`${scenarioItem.id}::step::${step.id}`, step.name?.trim() || step.id, loaded.uri);
              stepItem.description = step.input.length > 80 ? `${step.input.slice(0, 77)}…` : step.input;
              this.metadata.set(stepItem, { type: 'step', uri: entry.uri, profileId: entry.profile.id, suiteId: loaded.suite.id, scenarioId: scenario.id, stepIndex, suitePath, suiteKind: 'contract' });
              scenarioItem.children.add(stepItem);
            }
            suiteItem.children.add(scenarioItem);
          }
          profileItem.children.add(suiteItem);
        } catch (error) {
          const suiteItem = this.controller.createTestItem(`${entry.uri.toString()}::contract-suite-error::${suitePath}`, suitePath, entry.uri);
          suiteItem.description = error instanceof Error ? error.message.split('\n')[0] : String(error);
          this.metadata.set(suiteItem, { type: 'suite', uri: entry.uri, profileId: entry.profile.id, suitePath, suiteKind: 'contract' });
          profileItem.children.add(suiteItem);
        }
      }
      roots.push(profileItem);
    }
    this.controller.items.replace(roots);
  }

  private async prepareCampaign(uri: vscode.Uri, campaignId: string): Promise<{ profile: TurnStageProfile; definition: TestCampaignDefinition; plan: CampaignPlanV1 }> {
    const entry = await this.profiles.read(uri);
    if (!entry.profile) throw new Error(entry.error ?? 'Profile could not be parsed.');
    const definition = entry.profile.tests?.campaigns?.find((item) => item.id === campaignId);
    if (!definition) throw new Error(`Campaign ${campaignId} was not found in this profile.`);
    const issues = this.validator.validate(entry.profile);
    const firstError = issues.find((item) => item.severity === 'error');
    if (firstError) throw new Error(firstError.message);
    const openingRequests = entry.profile.opening?.mode === 'request' ? 1 : 0;
    const targetUri = uri.toString();
    const descriptors = (await this.describeTests(false)).filter((item) => item.kind === 'case'
      && item.profileId === entry.profile!.id
      && item.uri === targetUri);
    const cases: CampaignCaseInput[] = descriptors.flatMap((item) => item.caseId ? [{
      key: campaignCaseKey(item.profileId, item.suiteId, item.caseId),
      itemId: item.id,
      profileId: item.profileId,
      ...(item.suiteId ? { suiteId: item.suiteId } : {}),
      scenarioId: item.caseId,
      scenarioName: item.label,
      tags: item.tags,
      riskTags: item.sourceBinding?.riskTags,
      adversarial: item.adversarial,
      repetitions: item.repetitions,
      plannedTurns: item.plannedTurns ?? 1,
      requestsPerAttempt: (item.plannedTurns ?? 1) + openingRequests,
    }] : []);
    return { profile: entry.profile, definition, plan: createCampaignPlan(definition, cases) };
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, selection: ScenarioRunSelection = {}, scope: ScenarioRunScope = {}, preparedInput?: readonly PreparedScenarioJob[]): Promise<ScenarioRunSnapshot> {
    if (!preparedInput) await this.refresh();
    const run = this.controller.createTestRun(request);
    const completed: CompletedScenario[] = [];
    const snapshotResults: AdversarialResultSummary[] = [];
    const runEvidenceIds: string[] = [];
    const persistedGroups: Array<{ profileId: string; id: string; retention: number }> = [];
    let retainCopilotEvidence = false;
    const operation = startLogOperation(this.output, 'test', scope.campaign ? 'campaign-batch' : scope.runId ? 'copilot-batch' : 'batch');
    let cancelProgressTimer: (() => void) | undefined;
    const trustCancellation = scope.runId ? createTrustAwareCancellation(token) : undefined;
    const effectiveToken = trustCancellation?.token ?? token;
    try {
      const prepared = preparedInput ?? await this.prepareJobs(this.collectJobs(request));
      const jobs = prepared.map((item) => item.job);
      const batchPlan = createBatchRunPlan(prepared.map(({ job, loaded }) => {
        const scenario = withRunSelection(loaded.scenario, selection);
        const attempts = scenario.comparison ? 2 : scenario.adversarial?.repetitions ?? 1;
        const turns = Math.max(1, Math.min(scenario.steps.length, scenario.adversarial?.maxTurns ?? scenario.steps.length));
        return {
          id: job.item.id,
          key: job.item.id,
          profileId: loaded.profile.id,
          suiteId: job.suiteId,
          tags: scenario.tags,
          requestedAttempts: attempts,
          turnsPerAttempt: turns,
          requestsPerAttempt: turns + (loaded.profile.opening?.mode === 'request' ? 1 : 0),
          timeoutMs: scenario.adversarial?.timeoutMs ?? loaded.profile.conversation.send.timeoutMs ?? 120_000,
        };
      }), {
        maxConcurrency: selection.maxConcurrency ?? vscode.workspace.getConfiguration('turnstage').get<number>('adversarialConcurrency', 3),
        maxAttempts: scope.runId ? MAX_COPILOT_RUN_ATTEMPTS : MAX_RUN_PLAN_ATTEMPTS,
        maxRequests: selection.maxRequests ?? (scope.runId ? MAX_COPILOT_RUN_REQUESTS : MAX_RUN_PLAN_REQUESTS),
        maxDurationMs: selection.maxDurationMs,
      });
      const concurrency = Math.max(1, Math.min(8, batchPlan.maxConcurrency));
      operation.progress({
        cases: jobs.length,
        attempts: batchPlan.plannedAttempts,
        requests: batchPlan.plannedRequests,
        concurrency,
      });
      const plannedAttemptsByJob = new Map(batchPlan.cases.map((item) => [item.key, item.requestedAttempts]));
      let completedCases = 0;
      let completedAttempts = 0;
      const completedAttemptsByJob = new Map<string, number>();
      const activeCases = new Map<string, string>();
      let lastProgressAt = 0;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      cancelProgressTimer = () => { if (progressTimer) clearTimeout(progressTimer); progressTimer = undefined; };
      const publishProgress = (force = false): void => {
        if (!scope.progress) return;
        const now = Date.now();
        const emit = () => {
          lastProgressAt = Date.now();
          progressTimer = undefined;
          scope.progress?.({
            totalCases: jobs.length,
            completedCases: Math.min(jobs.length, completedCases),
            totalAttempts: batchPlan.plannedAttempts,
            completedAttempts: Math.min(batchPlan.plannedAttempts, completedAttempts),
            maxConcurrency: concurrency,
            activeCaseNames: [...activeCases.values()].slice(0, 8),
          });
        };
        if (force || now - lastProgressAt >= 100) {
          if (progressTimer) clearTimeout(progressTimer);
          emit();
        } else if (!progressTimer) progressTimer = setTimeout(emit, Math.max(1, 100 - (now - lastProgressAt)));
      };
      const markAttemptComplete = (job: ScenarioJob): void => {
        const planned = plannedAttemptsByJob.get(job.item.id) ?? 1;
        const current = completedAttemptsByJob.get(job.item.id) ?? 0;
        if (current >= planned) return;
        completedAttemptsByJob.set(job.item.id, current + 1);
        completedAttempts += 1;
        publishProgress();
      };
      publishProgress(true);
      if (!batchPlan.valid || !batchPlan.withinBudget) {
        operation.fail({ reason: 'budget-rejected', issues: batchPlan.issues.length });
        throw new Error(batchPlan.issues.map((issue) => issue.message).join('\n'));
      }
      if (!scope.runId && vscode.workspace.isTrusted && batchPlan.plannedRequests > MANUAL_BATCH_CONFIRM_REQUESTS) {
        const confirm = localize('Run batch');
        const selected = await vscode.window.showWarningMessage(
          localize('This batch can send up to {requests} requests across {attempts} attempts. Continue?', { requests: batchPlan.plannedRequests, attempts: batchPlan.plannedAttempts }),
          { modal: true },
          confirm,
        );
        if (selected !== confirm) {
          for (const job of jobs) run.skipped(job.item);
          run.appendOutput(`${localize('Batch run cancelled before any requests were sent.')}\r\n`);
          operation.cancel({ reason: 'user-declined', completedCases: 0 });
          this.latestRunSummaries = [];
          return { summaries: [], results: [], cancelled: true };
        }
      }
      for (const uriKey of new Set(jobs.map((job) => job.uri.toString()))) {
        const uri = vscode.Uri.parse(uriKey);
        const profileJobs = jobs.filter((job) => job.uri.toString() === uriKey);
        const hasAdversarial = profileJobs.some((job) => { const data = this.metadata.get(job.item); return data?.type === 'scenario' && data.adversarial === true; });
        const hasContracts = profileJobs.some((job) => { const data = this.metadata.get(job.item); return data?.type === 'scenario' && data.adversarial !== true; });
        if (hasAdversarial) this.latestResults.set(uriKey, []);
        if (hasContracts) this.latestAutomationResults.set(uriKey, []);
        this.resultsEmitter.fire({ uri, results: this.latestResults.get(uriKey) ?? [], automationResults: this.latestAutomationResults.get(uriKey) ?? [] });
      }
      if (!vscode.workspace.isTrusted) {
        for (const job of jobs) {
          run.skipped(job.item);
          run.appendOutput(`${localize('Skipped {name}: conversation contract tests require a trusted workspace.', { name: job.item.label })}\r\n`, undefined, job.item);
        }
      } else {
        run.appendOutput(`${localize('Running {count} scenarios with concurrency {concurrency}.', { count: String(jobs.length), concurrency: String(concurrency) })} ${batchPlan.plannedAttempts} attempt(s), ${batchPlan.plannedRequests} request(s) maximum.\r\n`);
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
          while (!effectiveToken.isCancellationRequested) {
            const index = cursor++;
            const preparedJob = prepared[index];
            if (!preparedJob) return;
            activeCases.set(preparedJob.job.item.id, String(preparedJob.job.item.label));
            publishProgress(true);
            let result: CompletedScenario | undefined;
            try { result = await this.runJob(preparedJob.job, run, effectiveToken, selection, preparedJob.loaded, runEvidenceIds, persistedGroups, Boolean(scope.runId), scope.campaign, () => markAttemptComplete(preparedJob.job)); }
            finally { activeCases.delete(preparedJob.job.item.id); }
            if (result) { completed.push(result); completedCases += 1; }
            publishProgress(true);
          }
        }));
      }
      if (scope.runId && !vscode.workspace.isTrusted) {
        for (const evidenceId of runEvidenceIds) {
          this.evidence.delete(evidenceId);
          this.protectedCopilotEvidence.delete(evidenceId);
        }
        for (const group of persistedGroups) await this.runGroups.remove(group.profileId, group.id, group.retention);
        throw new Error('Workspace Trust changed while the Copilot run was active. TurnStage discarded its in-memory evidence and did not write reports.');
      }
      completed.sort((a, b) => `${a.record.profileId}/${a.record.scenarioId}`.localeCompare(`${b.record.profileId}/${b.record.scenarioId}`));
      const snapshotSummaries: ScenarioControllerRunSummary[] = completed.map((item) => ({
        profileId: item.record.profileId,
        suiteId: item.suiteId,
        scenarioId: item.record.scenarioId,
        scenarioName: item.record.scenarioName,
        outcome: item.record.result?.adversarial?.outcome ?? (item.record.status === 'passed' ? 'passed' : item.record.status === 'failed' ? 'failed' : 'error'),
        stability: item.record.result?.repetitions?.stability,
        counts: item.record.result?.repetitions?.counts,
        sampleComplete: item.record.result?.repetitions?.sampleComplete,
        evidenceId: item.evidenceId,
      }));
      this.latestRunSummaries = snapshotSummaries;
      this.reports.record(completed.map((item) => item.record), {
        runId: scope.runId ?? scope.campaign?.runId,
        profileIds: [...new Set(completed.map((item) => item.record.profileId))],
      });
      // A Copilot-triggered run is advisory and must not create configured
      // workspace reports as a side effect. Manual Test Explorer runs retain
      // the existing configured-report behavior.
      if (!scope.runId) await this.reports.writeConfigured(reportGroups(completed));
      const completedByProfile = new Map<string, CompletedScenario[]>();
      for (const item of completed) {
        const key = item.profileUri.toString();
        const items = completedByProfile.get(key) ?? [];
        items.push(item);
        completedByProfile.set(key, items);
      }
      for (const [uriKey, items] of completedByProfile) {
        const results = items.flatMap((item): AdversarialResultSummary[] => {
          const evaluation = item.record.result?.adversarial;
          if (!evaluation || !item.evidenceId) return [];
          const repetitions = item.record.result?.repetitions;
          const reliability = repetitions ? createReliabilitySummary({
            requestedAttempts: repetitions.requestedAttempts,
            completedAttempts: repetitions.completedAttempts,
            sampleComplete: repetitions.sampleComplete,
            attempts: repetitions.attempts.map((attempt) => ({ outcome: attempt.outcome, durationMs: attempt.durationMs, ttftMs: attempt.ttftMs })),
          }) : undefined;
          const availableLocations = uniqueEvidenceLocations([
            ...evaluation.findings.flatMap((finding) => finding.locations),
            ...evaluation.issues.map((issue) => issue.location),
          ]);
          const attemptNavigation = repetitions?.attempts.slice(0, 100).map((attempt) => {
            const retained = attempt.evidenceId ? this.evidence.get(attempt.evidenceId) : undefined;
            const retainedEvaluation = retained?.result?.adversarial;
            const retainedLocations = retainedEvaluation ? uniqueEvidenceLocations([
              ...retainedEvaluation.findings.flatMap((finding) => finding.locations),
              ...retainedEvaluation.issues.map((issue) => issue.location),
            ]) : [];
            return {
              attempt: attempt.attempt,
              outcome: attempt.outcome,
              durationMs: attempt.durationMs,
              attemptedTurns: attempt.attemptedTurns,
              completedTurns: attempt.completedTurns,
              ...(retained && attempt.evidenceId ? { evidenceId: attempt.evidenceId } : {}),
              ...(retained ? { primaryLocation: retainedLocations[0] ?? retained.location, availableLocations: retainedLocations } : {}),
            };
          });
          return [{
            profileId: item.record.profileId,
            suiteId: item.suiteId,
            scenarioId: item.record.scenarioId,
            scenarioName: item.record.scenarioName,
            outcome: evaluation.outcome,
            durationMs: item.record.result!.durationMs,
            attemptedTurns: evaluation.attemptedTurns,
            completedTurns: evaluation.completedTurns,
            plannedTurns: evaluation.plannedTurns,
            findingCount: evaluation.findings.length,
            issueCount: evaluation.issues.length,
            primaryFinding: evaluation.findings[0] ? {
              category: evaluation.findings[0].category,
              turnId: evaluation.findings[0].turnId,
              turnIndex: evaluation.findings[0].turnIndex,
              ruleId: evaluation.findings[0].ruleId,
              label: evaluation.findings[0].label,
            } : undefined,
            primaryIssue: evaluation.issues[0] ? {
              kind: evaluation.issues[0].kind,
              turnId: evaluation.issues[0].turnId,
              turnIndex: evaluation.issues[0].turnIndex,
              label: evaluation.issues[0].label,
            } : undefined,
            evidenceId: item.evidenceId,
            primaryLocation: evaluation.findings[0]?.locations[0] ?? evaluation.issues[0]?.location ?? { kind: 'profile', path: 'tests.scenarios' },
            availableLocations,
            ...(reliability ? { reliability: {
              requestedAttempts: reliability.requestedAttempts,
              completedAttempts: reliability.completedAttempts,
              evaluableAttempts: reliability.evaluableAttempts,
              coveragePercent: reliability.coverage.percent,
              resistanceRate: reliability.resistanceRate,
              attackRate: reliability.attackRate,
              resistanceInterval: {
                confidenceLevel: reliability.resistance.interval.confidenceLevel,
                status: reliability.resistance.interval.status,
                lower: reliability.resistance.interval.lower,
                upper: reliability.resistance.interval.upper,
              },
              ttftP95Ms: reliability.ttft.p95,
              durationP95Ms: reliability.duration.p95,
              verdict: reliability.verdict,
              reasons: reliability.verdictReasons.slice(0, 8),
            } } : {}),
            ...(item.record.result?.repetitions ? { repetitions: {
              requestedAttempts: item.record.result.repetitions.requestedAttempts,
              completedAttempts: item.record.result.repetitions.completedAttempts,
              skippedAttempts: item.record.result.repetitions.skippedAttempts,
              sampleComplete: item.record.result.repetitions.sampleComplete,
              stability: item.record.result.repetitions.stability,
              counts: item.record.result.repetitions.counts,
              attempts: attemptNavigation,
            } } : {}),
          }];
        });
        snapshotResults.push(...results);
        const uri = vscode.Uri.parse(uriKey);
        const automationResults = items.flatMap((item): AutomationResultSummary[] => {
          const result = item.record.result;
          if (result?.adversarial) return [];
          const checks = result ? [...result.steps.flatMap((step) => step.checks), ...result.checks] : [];
          const firstFailure = checks.find((check) => !check.passed);
          return [{
            profileId: item.record.profileId,
            suiteId: item.suiteId,
            scenarioId: item.record.scenarioId,
            scenarioName: item.record.scenarioName,
            outcome: item.record.status === 'passed' ? 'passed' : item.record.status === 'failed' ? 'failed' : 'error',
            durationMs: result?.durationMs ?? 0,
            passedChecks: checks.filter((check) => check.passed).length,
            failedChecks: checks.filter((check) => !check.passed).length,
            completedSteps: result?.steps.length ?? 0,
            evidenceId: item.evidenceId,
            primaryLocation: firstFailure?.location ?? { kind: 'profile', path: 'tests.scenarios' },
            comparison: Boolean(result?.comparison),
            performance: checks.some((check) => check.kind === 'performance'),
          }];
        });
        if (results.length) this.latestResults.set(uriKey, results);
        if (automationResults.length) this.latestAutomationResults.set(uriKey, automationResults);
        this.resultsEmitter.fire({ uri, results: this.latestResults.get(uriKey) ?? [], automationResults: this.latestAutomationResults.get(uriKey) ?? [] });
      }
      retainCopilotEvidence = Boolean(scope.runId) && !effectiveToken.isCancellationRequested;
      const failures = completed.filter((item) => item.record.status !== 'passed').length;
      if (effectiveToken.isCancellationRequested) operation.cancel({ completedCases: completed.length, failedCases: failures });
      else operation.complete({ completedCases: completed.length, failedCases: failures });
      cancelProgressTimer();
      publishProgress(true);
      return {
        summaries: snapshotSummaries.map((summary) => ({ ...summary, counts: summary.counts ? { ...summary.counts } : undefined })),
        results: snapshotResults,
        ...(effectiveToken.isCancellationRequested ? { cancelled: true } : {}),
      };
    } catch (error) {
      operation.fail({ reason: error instanceof Error ? error.name : 'Error', completedCases: completed.length });
      throw error;
    } finally {
      if (scope.runId && !retainCopilotEvidence) {
        for (const evidenceId of runEvidenceIds) {
          this.evidence.delete(evidenceId);
          this.protectedCopilotEvidence.delete(evidenceId);
        }
      }
      trustCancellation?.dispose();
      cancelProgressTimer?.();
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
      if (data.type === 'profile' || data.type === 'suite') { item.children.forEach(visit); return; }
      if (data.type === 'scenario') { jobs.set(item.id, { item, uri: data.uri, profileId: data.profileId, scenarioId: data.scenarioId, suiteId: data.suiteId, suitePath: data.suitePath, suiteKind: data.suiteKind }); return; }
      jobs.set(item.id, { item, uri: data.uri, profileId: data.profileId, scenarioId: data.scenarioId, suiteId: data.suiteId, stepIndex: data.stepIndex, suitePath: data.suitePath, suiteKind: data.suiteKind });
    };
    selected.forEach(visit);
    return [...jobs.values()];
  }

  private findItems(ids: readonly string[]): vscode.TestItem[] {
    const wanted = new Set(ids);
    const found = new Map<string, vscode.TestItem>();
    const visit = (item: vscode.TestItem): void => {
      if (wanted.has(item.id)) found.set(item.id, item);
      item.children.forEach(visit);
    };
    this.controller.items.forEach(visit);
    return [...new Set(ids)].flatMap((id) => found.get(id) ? [found.get(id)!] : []);
  }

  private async runJob(job: ScenarioJob, run: vscode.TestRun, token: vscode.CancellationToken, selection: ScenarioRunSelection, loaded: LoadedScenario, runEvidenceIds: string[], persistedGroups: Array<{ profileId: string; id: string; retention: number }>, protectEvidence: boolean, campaign?: NonNullable<ScenarioRunScope['campaign']>, onAttemptComplete?: () => void): Promise<CompletedScenario | undefined> {
    const startedAt = Date.now();
    run.started(job.item);
    let session: SessionController | undefined;
    try {
      const baseScenario = job.stepIndex === undefined ? loaded.scenario : { ...loaded.scenario, steps: loaded.scenario.steps.slice(0, job.stepIndex + 1), assertions: [] };
      const scenario = withRunSelection(baseScenario, selection);
      let result: ScenarioRunResult;
      if (scenario.comparison) {
        const baselineScenario = withoutAssertions(withTargetControls(scenario, scenario.comparison.baseline.controls));
        const baselineSession = await this.createSession(job.uri, loaded.profile, selectEnvironment(loaded.environments, scenario.comparison.baseline.environment ?? loaded.profile.environment));
        let baseline: ScenarioRunResult;
        try { baseline = await runScenario(loaded.profile.id, baselineScenario, baselineSession, token); onAttemptComplete?.(); }
        finally { await baselineSession.disposeAndWait(); }
        if (token.isCancellationRequested) { run.skipped(job.item); return undefined; }
        const candidateScenario = withTargetControls(scenario, scenario.comparison.candidate.controls);
        session = await this.createSession(job.uri, loaded.profile, selectEnvironment(loaded.environments, scenario.comparison.candidate.environment ?? loaded.profile.environment), scenario.faults);
        const candidate = await runScenario(loaded.profile.id, candidateScenario, session, token);
        onAttemptComplete?.();
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
        if (scenario.adversarial) {
          const group = await runScenarioGroup(loaded.profile.id, scenario, async () => ({
            session: await this.createSession(job.uri, loaded.profile, loaded.environment, scenario.faults),
          }), {
            ...(campaign ? {
              runId: campaignGroupId(campaign.runId, job),
              existing: await this.runGroups.get(loaded.profile.id, campaignGroupId(campaign.runId, job)),
            } : {}),
            cancellation: token,
            openingRequestsPerAttempt: loaded.profile.opening?.mode === 'request' ? 1 : 0,
            onAttemptComplete: async (record, attempt) => {
              onAttemptComplete?.();
              if (attempt.result) {
                // Attempt capsules remain bounded and evictable. The aggregate
                // case capsule below contains the complete repetition result
                // and is the evidence a Copilot diagnosis must retain.
                const evidenceId = this.storeEvidence({ evidence: attempt.result.evidence, result: attempt.result, location: { kind: 'profile', path: 'tests' }, uri: job.uri });
                runEvidenceIds.push(evidenceId);
                attempt.summary.evidenceId = evidenceId;
                record.attempts = record.attempts.map((item) => item.attempt === attempt.summary.attempt ? { ...item, evidenceId } : item);
              }
              const retention = loaded.profile.history?.localRuns?.maxRuns ?? vscode.workspace.getConfiguration('turnstage').get('runRetention', 20);
              if (!vscode.workspace.isTrusted || protectEvidence) return;
              await this.runGroups.save(record, retention);
              persistedGroups.push({ profileId: record.profileId, id: record.id, retention });
              if (campaign) await campaign.onAttemptComplete(job, record);
            },
          });
          result = group.result;
          const retention = loaded.profile.history?.localRuns?.maxRuns ?? vscode.workspace.getConfiguration('turnstage').get('runRetention', 20);
          if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust changed while the test was active.');
          if (!protectEvidence) {
            await this.runGroups.save(group.record, retention);
            persistedGroups.push({ profileId: group.record.profileId, id: group.record.id, retention });
          }
        } else {
          session = await this.createSession(job.uri, loaded.profile, loaded.environment, scenario.faults);
          const single = await runScenario(loaded.profile.id, scenario, session, token);
          onAttemptComplete?.();
          const checks = [...single.checks, ...evaluatePerformance(scenario.performance, single)];
          result = { ...single, checks, passed: single.passed && checks.every((check) => check.passed) };
        }
      }
      if (token.isCancellationRequested) { run.skipped(job.item); return; }
      // Attempt evidence IDs remain attached to the repetition summary, while the
      // case-level ID must retain the aggregate result so stability diagnostics
      // can see the requested and completed sample instead of one attempt only.
      const evidenceId = this.storeEvidence({ evidence: result.evidence, result, location: { kind: 'profile', path: 'tests' }, uri: job.uri }, protectEvidence);
      runEvidenceIds.push(evidenceId);
      const targetSteps = job.stepIndex === undefined ? result.steps : result.steps.slice(job.stepIndex, job.stepIndex + 1);
      for (const stepResult of targetSteps) {
        const stepItem = job.stepIndex === undefined ? findStepItem(job.item, stepResult.stepId) : job.item;
        if (!stepItem) continue;
        const failures = stepResult.checks.filter((check) => !check.passed);
        if (failures.length && result.adversarial?.issues.some((issue) => issue.turnId === stepResult.stepId)) run.errored(stepItem, failures.map((check) => this.testMessage(check, evidenceId, stepItem)), stepResult.durationMs);
        else if (failures.length) run.failed(stepItem, failures.map((check) => this.testMessage(check, evidenceId, stepItem)), stepResult.durationMs);
        else run.passed(stepItem, stepResult.durationMs);
        this.appendChecks(run, stepItem, stepResult.checks);
      }
      const scenarioFailures = result.checks.filter((check) => !check.passed);
      const stepFailed = targetSteps.some((step) => step.checks.some((check) => !check.passed));
      if (job.stepIndex === undefined) {
        if (result.adversarial?.outcome === 'infrastructureError' || result.adversarial?.outcome === 'indeterminate') run.errored(job.item, scenarioFailures.map((check) => this.testMessage(check, evidenceId, job.item)), result.durationMs);
        else if (scenarioFailures.length) run.failed(job.item, scenarioFailures.map((check) => this.testMessage(check, evidenceId, job.item)), result.durationMs);
        else if (stepFailed || !result.passed) run.failed(job.item, new vscode.TestMessage(localize('One or more scenario steps failed.')), result.durationMs);
        else run.passed(job.item, result.durationMs);
      }
      const resultLabel = result.adversarial ? adversarialOutcomeLabel(result.adversarial.outcome) : result.passed ? 'PASS' : 'FAIL';
      run.appendOutput(`${resultLabel} ${loaded.profile.name} / ${loaded.scenario.name} (${result.durationMs} ms)\r\n`, undefined, job.item);
      return {
        record: { profileId: loaded.profile.id, profileName: loaded.profile.name, scenarioId: loaded.scenario.id, scenarioName: loaded.scenario.name, scenarioTags: loaded.scenario.tags, result, status: result.adversarial ? adversarialRecordStatus(result.adversarial.outcome) : result.passed ? 'passed' : 'failed' },
        profileUri: job.uri,
        suiteId: job.suiteId,
        reporting: loaded.profile.tests?.reporting,
        evidenceId,
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

  private async prepareJobs(jobs: readonly ScenarioJob[]): Promise<PreparedScenarioJob[]> {
    const profileLoads = new Map<string, Promise<LoadedProfileContext>>();
    const adversarialSuiteLoads = new Map<string, ReturnType<typeof loadAdversarialSuite>>();
    const contractSuiteLoads = new Map<string, ReturnType<typeof loadContractSuite>>();
    const prepared = new Array<PreparedScenarioJob>(jobs.length);
    let cursor = 0;
    const prepare = async (job: ScenarioJob): Promise<LoadedScenario> => {
      const profileKey = job.uri.toString();
      let profileLoad = profileLoads.get(profileKey);
      if (!profileLoad) { profileLoad = this.loadProfileContext(job.uri); profileLoads.set(profileKey, profileLoad); }
      const context = await profileLoad;
      const scenario = job.suitePath
        ? await (async () => {
          const suiteKey = `${profileKey}\u001f${job.suitePath}`;
          if (job.suiteKind === 'contract') {
            let suiteLoad = contractSuiteLoads.get(suiteKey);
            if (!suiteLoad) { suiteLoad = loadContractSuite(job.uri, job.suitePath!, (reference) => this.externalAdversarialSuites.resolve(job.uri, reference)); contractSuiteLoads.set(suiteKey, suiteLoad); }
            return (await suiteLoad).scenarios.find((candidate) => candidate.id === job.scenarioId);
          }
          let suiteLoad = adversarialSuiteLoads.get(suiteKey);
          if (!suiteLoad) { suiteLoad = loadAdversarialSuite(job.uri, job.suitePath!, (reference) => this.externalAdversarialSuites.resolve(job.uri, reference)); adversarialSuiteLoads.set(suiteKey, suiteLoad); }
          return (await suiteLoad).scenarios.find((candidate) => candidate.id === job.scenarioId);
        })()
        : context.profile.tests?.scenarios.find((candidate) => candidate.id === job.scenarioId);
      if (!scenario) throw new Error(localize('Scenario {id} was not found.', { id: job.scenarioId }));
      if (job.suitePath) {
        const compatibilityError = (job.suiteKind === 'contract' ? validateContractScenariosAgainstProfile : validateAdversarialScenariosAgainstProfile)(context.profile, [scenario], context.environments)[0];
        if (compatibilityError) throw new Error(localize('{kind} case {id} is incompatible with this Profile: {message}', { kind: job.suiteKind === 'contract' ? 'Test' : 'Adversarial', id: compatibilityError.scenarioId, message: compatibilityError.message }));
      }
      return { ...context, scenario };
    };
    const worker = async () => {
      while (cursor < jobs.length) {
        const index = cursor;
        cursor += 1;
        const job = jobs[index]!;
        prepared[index] = { job, loaded: await prepare(job) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
    return prepared;
  }

  private async loadScenario(uri: vscode.Uri, scenarioId: string, suitePath?: string, suiteKind?: 'adversarial' | 'contract'): Promise<LoadedScenario> {
    const context = await this.loadProfileContext(uri);
    const scenario = suitePath
      ? (suiteKind === 'contract'
        ? (await loadContractSuite(uri, suitePath, (reference) => this.externalAdversarialSuites.resolve(uri, reference))).scenarios.find((candidate) => candidate.id === scenarioId)
        : (await loadAdversarialSuite(uri, suitePath, (reference) => this.externalAdversarialSuites.resolve(uri, reference))).scenarios.find((candidate) => candidate.id === scenarioId))
      : context.profile.tests?.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(localize('Scenario {id} was not found.', { id: scenarioId }));
    if (suitePath) {
      const compatibilityError = (suiteKind === 'contract' ? validateContractScenariosAgainstProfile : validateAdversarialScenariosAgainstProfile)(context.profile, [scenario], context.environments)[0];
      if (compatibilityError) throw new Error(localize('{kind} case {id} is incompatible with this Profile: {message}', { kind: suiteKind === 'contract' ? 'Test' : 'Adversarial', id: compatibilityError.scenarioId, message: compatibilityError.message }));
    }
    return { ...context, scenario };
  }

  private async loadProfileContext(uri: vscode.Uri): Promise<LoadedProfileContext> {
    const document = await vscode.workspace.openTextDocument(uri);
    const parsed = this.codec.parse(document.getText());
    const environments = await this.environments.discover(uri);
    const issues = this.validator.validate(parsed.profile, parsed.tree, environments.map((entry) => entry.environment));
    const firstError = issues.find((issue) => issue.severity === 'error');
    if (!parsed.profile || firstError) throw new Error(firstError?.message ?? localize('Profile could not be parsed.'));
    const available = environments.map((entry) => entry.environment);
    return { profile: parsed.profile, environment: selectEnvironment(available, parsed.profile.environment), environments: available };
  }

  private async createSession(uri: vscode.Uri, sourceProfile: TurnStageProfile, environment: TurnStageEnvironment, faults?: ScenarioDefinition['faults']): Promise<SessionController> {
    const profile: TurnStageProfile = structuredClone(sourceProfile);
    profile.history = { ...profile.history, localRuns: { ...profile.history?.localRuns, enabled: false } };
    const session = new SessionController(profile, uri, environment, this.context, new SecretService(this.context), new LocalRunRepository(this.context, this.output), () => undefined, this.output, { faults });
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

  private storeEvidence(reference: TestEvidenceReference, protect = false): string {
    const id = crypto.randomUUID();
    this.evidence.set(id, reference);
    if (protect) {
      if (this.protectedCopilotEvidence.size >= MAX_PROTECTED_EVIDENCE_ENTRIES) {
        this.evidence.delete(id);
        throw new Error('The Copilot evidence retention budget was exhausted.');
      }
      this.protectedCopilotEvidence.add(id);
    }
    while (this.evidence.size > MAX_EVIDENCE_ENTRIES) {
      const evictable = [...this.evidence.keys()].find((candidate) => !this.protectedCopilotEvidence.has(candidate));
      if (!evictable) {
        this.evidence.delete(id);
        this.protectedCopilotEvidence.delete(id);
        throw new Error('The TurnStage evidence retention budget was exhausted.');
      }
      this.evidence.delete(evictable);
    }
    return id;
  }

  private releaseProtectedCopilotEvidence(): void {
    for (const evidenceId of this.protectedCopilotEvidence) this.evidence.delete(evidenceId);
    this.protectedCopilotEvidence.clear();
  }
}

function integrityMaterialFromPrepared(prepared: readonly PreparedScenarioJob[]): ScenarioIntegrityMaterial {
  const profiles = new Map<string, TurnStageProfile>();
  const suites = new Map<string, { id: string; profileId: string; cases: ScenarioDefinition[] }>();
  const cases: Record<string, ScenarioDefinition> = {};
  for (const { job, loaded } of prepared) {
    profiles.set(loaded.profile.id, structuredClone(loaded.profile));
    const caseKey = `${loaded.profile.id}/${job.suiteId ?? 'inline'}/${loaded.scenario.id}`;
    cases[caseKey] = structuredClone(loaded.scenario);
    if (job.suiteId) {
      const suiteKey = `${loaded.profile.id}/${job.suiteId}`;
      const group = suites.get(suiteKey) ?? { id: job.suiteId, profileId: loaded.profile.id, cases: [] };
      if (!group.cases.some((item) => item.id === loaded.scenario.id)) group.cases.push(structuredClone(loaded.scenario));
      suites.set(suiteKey, group);
    }
  }
  const profile = [...profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  const suite = [...suites.values()]
    .map((item) => ({ ...item, cases: [...item.cases].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => `${a.profileId}/${a.id}`.localeCompare(`${b.profileId}/${b.id}`));
  return {
    profile,
    ...(suite.length ? { suite } : {}),
    cases: Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function collectionValues(collection: vscode.TestItemCollection): vscode.TestItem[] { const values: vscode.TestItem[] = []; collection.forEach((item) => values.push(item)); return values; }
function campaignCaseKey(profileId: string, suiteId: string | undefined, scenarioId: string): string { return `${profileId}/${suiteId ?? 'inline'}/${scenarioId}`; }
function campaignOutcomeCounts(record: CampaignRunRecordV1): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of record.cases) if (item.outcome) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return counts;
}
function campaignGroupId(runId: string, job: ScenarioJob): string { return `${runId}:${digestValue(campaignCaseKey(job.profileId, job.suiteId, job.scenarioId)).slice(0, 24)}`; }
function percentile95(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!sorted.length) return undefined;
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}
function withTargetControls(scenario: ScenarioDefinition, controls: Record<string, unknown> | undefined): ScenarioDefinition { return { ...scenario, controls: { ...(scenario.controls ?? {}), ...(controls ?? {}) } }; }
function withoutAssertions(scenario: ScenarioDefinition): ScenarioDefinition { return { ...scenario, assertions: [], steps: scenario.steps.map((step) => ({ ...step, assertions: [] })) }; }
function withRunSelection(scenario: ScenarioDefinition, selection: ScenarioRunSelection): ScenarioDefinition {
  if (!scenario.adversarial || (selection.repetitions === undefined && selection.failFast === undefined)) return scenario;
  return {
    ...scenario,
    adversarial: {
      ...scenario.adversarial,
      ...(selection.repetitions === undefined ? {} : { repetitions: selection.repetitions }),
      ...(selection.failFast === undefined ? {} : { failFast: selection.failFast }),
    },
  };
}
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
function adversarialOutcomeLabel(outcome: NonNullable<ScenarioRunResult['adversarial']>['outcome']): string {
  if (outcome === 'resisted') return 'RESISTED';
  if (outcome === 'attackSucceeded') return 'ATTACK SUCCEEDED';
  if (outcome === 'indeterminate') return 'INDETERMINATE';
  return 'INFRASTRUCTURE ERROR';
}
function adversarialRecordStatus(outcome: NonNullable<ScenarioRunResult['adversarial']>['outcome']): ScenarioExecutionRecord['status'] {
  if (outcome === 'resisted') return 'passed';
  if (outcome === 'attackSucceeded') return 'failed';
  return 'error';
}
function uniqueEvidenceLocations(locations: ScenarioEvidenceLocation[]): ScenarioEvidenceLocation[] {
  const byKind = new Map<string, ScenarioEvidenceLocation>();
  for (const location of locations) if (!byKind.has(location.kind)) byKind.set(location.kind, location);
  return [...byKind.values()];
}
