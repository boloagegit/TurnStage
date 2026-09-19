import type { AdversarialCaseCatalog, ContractCaseCatalog, HostPayload, LinkedAdversarialCaseDetail, LinkedContractCaseDetail, TestOperationAction } from '../../src/shared/protocol';
import type { AdversarialResultSummary, AutomationResultSummary, ScenarioDefinition, ScenarioRunResult, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { adversarialCsvTemplate, parseAdversarialCsv, serializeAdversarialCsv } from '../../src/extension/testing/adversarialCsv';
import { contractCsvTemplate, parseContractCsv, serializeContractCsv } from '../../src/extension/testing/contractCsv';
import { parseAdversarialJsonl, serializeAdversarialJsonl } from '../../src/extension/testing/adversarialJsonl';
import { createAdversarialSuite, normalizeAdversarialSuite, parseAdversarialSuite, serializeAdversarialSuite, validateAdversarialSuite } from '../../src/extension/testing/adversarialSuite';
import { createContractSuite, normalizeContractSuite, parseContractSuite, serializeContractSuite, validateContractSuite } from '../../src/extension/testing/contractSuite';
import { runScenario } from '../../src/extension/testing/scenarioRunner';
import { MAX_RUN_PLAN_ATTEMPTS, MAX_RUN_PLAN_REQUESTS, runScenarioGroup } from '../../src/extension/testing/scenarioExecution';
import { BrowserSession } from './browserSession';
import { ArtifactStore, type StoredArtifact } from './artifactStore';
import { redactKnownSecrets } from '../../src/shared/redaction';
import { buildEvidenceTimeline } from '../../src/extension/testing/evidenceTimeline';
import { isScenarioReady } from '../../src/extension/testing/scenarioCapture';
import { resolveTestSelection, testCaseKey, type TestCaseIdentity } from '../../src/shared/testSelection';
import { createTestRunHistoryRecord, nonPassingCases, type CompletedTestRunCase, type TestRunHistoryRecord } from '../../src/shared/testRunHistory';
import { strToU8, zipSync } from 'fflate';
import { browserSha256, browserUuid } from './browserCrypto';
import { renderTestReportHtml, type TestReportKind, type TestReportOutcome } from '../../src/shared/testReportHtml';

interface WebSuite {
  suiteId: string;
  name: string;
  kind: 'contract' | 'adversarial';
  sourceFormat: 'csv' | 'jsonc' | 'jsonl';
  sourcePath: string;
  revision: string;
  scenarios: ScenarioDefinition[];
  raw: string;
}

interface RetainedEvidence { scenario: ScenarioDefinition; result: ScenarioRunResult }
export interface WebScenarioEntry { key: string; itemId: string; suiteId?: string; scenario: ScenarioDefinition }
interface WebRunContext { profile: TurnStageProfile; environment: TurnStageEnvironment; secrets: Map<string, string> }

export function webCaseUnsupportedReason(scenario: ScenarioDefinition): string | undefined {
  if (scenario.faults) return 'Network fault simulation requires the VS Code extension. No request was sent.';
  if (scenario.comparison) return 'Baseline/candidate comparison is not available in Web. No request was sent.';
  if (scenario.performance) return 'Performance checks are not available in Web. No request was sent.';
  return undefined;
}

function assertWebCaseSupported(scenario: ScenarioDefinition): void {
  const reason = webCaseUnsupportedReason(scenario);
  if (reason) throw new Error(reason);
}

export class WebTestController {
  private readonly store = new ArtifactStore();
  private automationResults: AutomationResultSummary[] = [];
  private adversarialResults: AdversarialResultSummary[] = [];
  private cancelled = false;
  private activeRun = false;
  private readonly cancellationListeners = new Set<() => void>();

  constructor(
    private readonly profile: () => TurnStageProfile,
    private readonly environment: () => TurnStageEnvironment,
    private readonly secrets: Map<string, string>,
    private readonly post: (payload: HostPayload, requestId?: string) => void,
    private readonly reportLocale: () => string = () => navigator.language,
  ) {}

  async run(action: TestOperationAction, scenarioId?: string, kind?: 'contract' | 'adversarial', suiteId?: string): Promise<void> {
    if (action !== 'runAll' && action !== 'runContracts' && action !== 'runCase') return;
    const context = this.runContext();
    const all = await this.scenarioEntries(context.profile);
    if (this.profile().id !== context.profile.id) throw new Error('The active profile changed before this test run. No request was sent.');
    const entries = all.map((item) => ({ ...item, profileId: context.profile.id, scenarioId: item.scenario.id, kind: item.scenario.adversarial ? 'adversarial' as const : 'contract' as const, ready: isScenarioReady(item.scenario) }));
    const selected = resolveTestSelection(entries, action === 'runCase'
      ? { cases: [{ profileId: context.profile.id, scenarioId: scenarioId ?? '', suiteId, kind: kind ?? 'adversarial' }] }
      : { kind: action === 'runAll' ? 'adversarial' : 'contract' });
    await this.runResolved(action, selected, context);
  }

  async runCases(cases: readonly TestCaseIdentity[], sourceRunId?: string): Promise<void> {
    const context = this.runContext();
    const all = await this.scenarioEntries(context.profile);
    if (this.profile().id !== context.profile.id) throw new Error('The active profile changed before this test run. No request was sent.');
    const entries = all.map((item) => ({ ...item, profileId: context.profile.id, scenarioId: item.scenario.id, kind: item.scenario.adversarial ? 'adversarial' as const : 'contract' as const, ready: isScenarioReady(item.scenario) }));
    await this.runResolved('runSelection', resolveTestSelection(entries, { cases }), context, sourceRunId);
  }

  async rerunHistory(runId: string, kind?: 'contract' | 'adversarial'): Promise<void> {
    const profileId = this.profile().id;
    const record = (await this.store.get<TestRunHistoryRecord>('runs', `test-batch:${profileId}:${runId}`))?.value;
    if (!record || record.profileId !== profileId) throw new Error('The selected test run is no longer available.');
    const cases = nonPassingCases(record).filter((item) => kind === undefined || item.kind === kind);
    if (!cases.length) throw new Error('The selected test run has no non-passing cases.');
    await this.runCases(cases, runId);
  }

  private runContext(): WebRunContext { return { profile: structuredClone(this.profile()), environment: structuredClone(this.environment()), secrets: new Map(this.secrets) }; }

  private async runResolved(action: TestOperationAction, selected: readonly WebScenarioEntry[], context: WebRunContext, sourceRunId?: string): Promise<void> {
    if (this.activeRun) throw new Error('A TurnStage test run is already active.');
    if (this.profile().id !== context.profile.id) throw new Error('The active profile changed before this test run. No request was sent.');
    if (selected.length > 500) throw new Error('A test run can contain at most 500 cases. Run a smaller selection.');
    for (const item of selected) assertWebCaseSupported(item.scenario);
    const attempts = selected.reduce((total, item) => total + (item.scenario.adversarial?.repetitions ?? 1), 0);
    const { profile, environment, secrets } = context;
    const cases = structuredClone(selected);
    const requests = cases.reduce((total, item) => total + (item.scenario.steps.length + Number(profile.opening?.mode === 'request')) * (item.scenario.adversarial?.repetitions ?? 1), 0);
    if (attempts > MAX_RUN_PLAN_ATTEMPTS || requests > MAX_RUN_PLAN_REQUESTS) throw new Error('The selected cases exceed the bounded test-run attempt or request limit. Run a smaller selection.');
    this.activeRun = true;
    this.cancelled = false;
    const startedAt = Date.now();
    const runId = browserUuid();
    const completedCases: CompletedTestRunCase[] = [];
    this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: 0, totalAttempts: attempts, completedAttempts: 0, maxConcurrency: 1 } } });
    let completed = 0;
    let completedAttempts = 0;
    let historyFailure: unknown;
    try {
      for (const item of cases) {
        if (this.cancelled) break;
        if (this.profile().id !== profile.id) throw new Error('The active profile changed during this test run. The remaining cases were not sent.');
        const execution = await this.executeScenario(item, true, { profile, environment, secrets });
        const outcome = execution.result.adversarial?.outcome ?? (execution.result.evidence.snapshot.errors.some((error) => error.type === 'WebTestExecutionError') ? 'error' : execution.result.passed ? 'passed' : 'failed');
        completedCases.push({ profileId: profile.id, suiteId: item.suiteId, scenarioId: item.scenario.id, kind: item.scenario.adversarial ? 'adversarial' : 'contract', outcome, completedAttempts: execution.result.repetitions?.completedAttempts ?? 1, durationMs: execution.result.durationMs, evidenceId: execution.evidenceId });
        completed += 1;
        completedAttempts += execution.result.repetitions?.completedAttempts ?? 1;
        this.post({ type: 'test.results', results: this.adversarialResults, automationResults: this.automationResults });
        this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: attempts, completedAttempts, maxConcurrency: 1 } } });
      }
      this.post({ type: 'test.operation', operation: { action, state: this.cancelled ? 'cancelled' : 'completed', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: attempts, completedAttempts, maxConcurrency: 1 } } });
    } catch (error) {
      this.post({ type: 'test.operation', operation: { action, state: 'failed', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: attempts, completedAttempts, maxConcurrency: 1 } } });
      throw error;
    } finally {
      try {
        const record = createTestRunHistoryRecord({ id: runId, profileId: profile.id, startedAt, finishedAt: Date.now(), status: this.cancelled ? 'cancelled' : completed === cases.length ? 'completed' : 'failed', runner: 'web', profile, environment, sourceRunId, secretValues: [...secrets.values()], cases: cases.map((item) => ({ profileId: profile.id, suiteId: item.suiteId, scenarioId: item.scenario.id, kind: item.scenario.adversarial ? 'adversarial' as const : 'contract' as const, name: item.scenario.name, scenario: item.scenario })), completed: completedCases });
        await this.store.put('runs', { id: `test-batch:${profile.id}:${runId}`, profileId: profile.id, kind: 'test-batch', name: 'Test run', updatedAt: record.finishedAt, value: record });
        await this.trimRunHistory(profile.id);
        await this.postHistory(profile.id);
      } catch (error) {
        historyFailure = error;
      } finally {
        this.activeRun = false;
      }
    }
    if (historyFailure) throw historyFailure;
  }

  async postHistory(profileId = this.profile().id): Promise<void> {
    const evidenceIds = new Set((await this.store.keys('evidence', profileId)).map(String));
    const runs = (await this.store.list<TestRunHistoryRecord>('runs', profileId)).filter((item) => item.kind === 'test-batch').map((item) => item.value).slice(0, 21)
      .map((run) => ({ ...run, cases: run.cases.map((item) => ({ ...item, evidenceAvailable: Boolean(item.evidenceId && evidenceIds.has(item.evidenceId)) })) }));
    const baselineRunId = (await this.store.get<{ runId: string }>('runs', `test-baseline:${profileId}`))?.value.runId;
    this.post({ type: 'test.history', profileId, runs, ...(baselineRunId ? { baselineRunId } : {}) });
  }

  async acceptBaseline(runId: string): Promise<void> {
    const profileId = this.profile().id;
    const artifact = await this.store.get<TestRunHistoryRecord>('runs', `test-batch:${profileId}:${runId}`);
    if (!artifact || artifact.value.status !== 'completed') throw new Error('Only a completed test run can be used as a baseline.');
    await this.store.put('runs', { id: `test-baseline:${profileId}`, profileId, kind: 'test-baseline', name: 'Accepted test baseline', updatedAt: Date.now(), value: { runId } });
    await this.postHistory();
  }

  async clearHistory(kind: 'contract' | 'adversarial'): Promise<void> {
    if (this.activeRun) throw new Error('Stop the active test run before clearing its history.');
    const profileId = this.profile().id;
    await this.store.clearTestHistory(profileId, kind);
    await this.postHistory(profileId);
  }

  private async trimRunHistory(profileId: string): Promise<void> {
    const runs = (await this.store.list<TestRunHistoryRecord>('runs', profileId)).filter((item) => item.kind === 'test-batch');
    const pinned = (await this.store.get<{ runId: string }>('runs', `test-baseline:${profileId}`))?.value.runId;
    for (const item of runs.slice(20)) if (item.value.id !== pinned) await this.store.delete('runs', item.id);
  }

  cancel(): void { this.cancelled = true; for (const listener of this.cancellationListeners) listener(); }

  async rerun(status: 'failed' | 'unstable' | 'incomplete'): Promise<void> {
    const context = this.runContext();
    const profileId = context.profile.id;
    const identities: TestCaseIdentity[] = [
      ...this.adversarialResults.filter((item) => status === 'failed' ? item.outcome !== 'resisted' : status === 'unstable' ? item.repetitions?.stability === 'unstable' : item.repetitions?.sampleComplete === false).map((item) => ({ profileId, suiteId: item.suiteId, scenarioId: item.scenarioId, kind: 'adversarial' as const })),
      ...(status === 'failed' ? this.automationResults.filter((item) => item.outcome !== 'passed').map((item) => ({ profileId, suiteId: item.suiteId, scenarioId: item.scenarioId, kind: 'contract' as const })) : []),
    ];
    const unique = [...new Map(identities.map((item) => [testCaseKey(item), item])).values()];
    const entries = (await this.scenarioEntries(context.profile)).map((item) => ({ ...item, profileId, scenarioId: item.scenario.id, kind: item.scenario.adversarial ? 'adversarial' as const : 'contract' as const, ready: isScenarioReady(item.scenario) }));
    const selected = resolveTestSelection(entries, { cases: unique });
    const action: TestOperationAction = status === 'failed' ? 'rerunFailed' : status === 'unstable' ? 'rerunUnstable' : 'rerunIncomplete';
    await this.runResolved(action, selected, context);
  }

  async scenarioEntries(profile = this.profile()): Promise<WebScenarioEntry[]> {
    const suites = await this.store.list<WebSuite>('suites', profile.id);
    return [
      ...(profile.tests?.scenarios ?? []).map((scenario) => ({ key: `${profile.id}/inline/${scenario.id}`, itemId: `inline:${scenario.id}`, scenario })),
      ...suites.flatMap((suite) => suite.value.scenarios.map((scenario) => ({ key: `${profile.id}/${suite.value.suiteId}/${scenario.id}`, itemId: `${suite.value.sourcePath}:${scenario.id}`, suiteId: suite.value.suiteId, scenario }))),
    ];
  }

  async executeScenario(item: WebScenarioEntry, cancellable = false, context?: { profile: TurnStageProfile; environment: TurnStageEnvironment; secrets: Map<string, string> }): Promise<{ result: ScenarioRunResult; evidenceId: string }> {
    const profile = context?.profile ?? this.profile();
    const environment = context?.environment ?? this.environment();
    const secrets = context?.secrets ?? this.secrets;
    const runtime = new BrowserSession(profile, environment, secrets, () => undefined);
    let result: ScenarioRunResult;
    const isCancelled = () => this.cancelled;
    const listeners = this.cancellationListeners;
    const cancellation = cancellable ? { get isCancellationRequested() { return isCancelled(); }, onCancellationRequested: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } } : undefined;
    try { assertWebCaseSupported(item.scenario);
      result = item.scenario.adversarial
      ? (await runScenarioGroup(profile.id, item.scenario, async () => new BrowserSession(profile, environment, secrets, () => undefined), { cancellation, runId: browserUuid() })).result
      : await runScenario(profile.id, item.scenario, runtime, cancellation); }
    catch (error) { result = executionError(profile.id, item.scenario, error); }
    result = redactKnownSecrets(result, [...secrets.values()]) as ScenarioRunResult;
    const evidenceId = browserUuid();
    await this.store.put<RetainedEvidence>('evidence', { id: evidenceId, profileId: profile.id, kind: item.scenario.adversarial ? 'adversarial' : 'contract', name: item.scenario.name, updatedAt: Date.now(), value: { scenario: item.scenario, result } });
    await this.store.put<ScenarioRunResult>('runs', { id: browserUuid(), profileId: profile.id, kind: 'test', name: item.scenario.name, updatedAt: Date.now(), value: result });
    if (result.adversarial) this.upsertAdversarial(adversarialSummary(profile.id, item.scenario, result, evidenceId, item.suiteId));
    else this.upsertAutomation(automationSummary(profile.id, item.scenario, result, evidenceId, item.suiteId));
    return { result, evidenceId };
  }

  async evidenceResult(evidenceId: string): Promise<RetainedEvidence | undefined> { return (await this.store.get<RetainedEvidence>('evidence', evidenceId))?.value; }

  async saveCapturedScenario(scenario: ScenarioDefinition, kind: 'contract' | 'adversarial'): Promise<string> {
    const suite: WebSuite = { suiteId: `captured-${kind}`, name: `Captured ${kind} cases`, kind, sourceFormat: 'jsonc', sourcePath: `browser://captured/${kind}`, revision: '', scenarios: [scenario], raw: '' };
    const existing = (await this.store.list<WebSuite>('suites', this.profile().id)).find((item) => item.value.sourcePath === suite.sourcePath);
    const scenarios = [...(existing?.value.scenarios.filter((item) => item.id !== scenario.id) ?? []), scenario];
    const raw = serializeSuite(suite, scenarios);
    const value = { ...(existing?.value ?? suite), scenarios, raw, revision: await digest(raw) };
    await this.store.put<WebSuite>('suites', { id: existing?.id ?? `${this.profile().id}:${suite.sourcePath}`, profileId: this.profile().id, kind, name: value.name, updatedAt: Date.now(), value });
    await this.postCatalog(kind);
    return value.sourcePath;
  }

  async openEvidence(evidenceId: string): Promise<void> {
    const retained = await this.store.get<RetainedEvidence>('evidence', evidenceId);
    if (!retained) throw new Error('The selected Web evidence is no longer available.');
    const result = retained.value.result;
    this.post({ type: 'session.snapshot', snapshot: result.evidence.snapshot, runs: [], requestPreview: result.evidence.requestPreview, networkEntries: result.evidence.networkEntries });
  }

  async postTimeline(evidenceId: string): Promise<void> {
    const retained = await this.store.get<RetainedEvidence>('evidence', evidenceId);
    if (!retained) throw new Error('The selected Web evidence is no longer available.');
    this.post({ type: 'test.timeline', evidenceId, timeline: buildEvidenceTimeline(retained.value.result) });
  }

  async exportEvidenceBundle(): Promise<void> {
    const retained = await this.store.list<RetainedEvidence>('evidence', this.profile().id);
    const files = Object.fromEntries(retained.map((item) => [`evidence/${safeFileName(item.value.scenario.id)}-${item.id}.json`, strToU8(JSON.stringify(item.value, null, 2))]));
    const manifest = { format: 'turnstage-web-evidence-bundle', version: 1, generatedAt: new Date().toISOString(), profileId: this.profile().id, evidenceCount: retained.length };
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 6 });
    const name = `turnstage-evidence-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.zip`;
    downloadBytes(name, bytes, 'application/zip');
    this.post({ type: 'test.exported', kind: 'evidenceBundle', path: name });
  }

  async exportReport(format: 'json' | 'junit' | 'html', evidenceId?: string, kind?: TestReportKind): Promise<void> {
    const profileId = this.profile().id;
    let artifacts: Array<StoredArtifact<RetainedEvidence>>;
    if (evidenceId) {
      const selected = await this.store.get<RetainedEvidence>('evidence', evidenceId);
      if (!selected || selected.profileId !== profileId || (kind && selected.kind !== kind)) throw new Error('The selected test evidence is no longer available for this profile and test type.');
      artifacts = [selected];
    } else if (kind) {
      const ids = kind === 'contract' ? this.automationResults.map((item) => item.evidenceId) : this.adversarialResults.map((item) => item.evidenceId);
      artifacts = (await Promise.all(ids.map((id) => id ? this.store.get<RetainedEvidence>('evidence', id) : undefined))).filter((item): item is StoredArtifact<RetainedEvidence> => Boolean(item));
      if (artifacts.length !== ids.length || artifacts.some((item) => item.profileId !== profileId || item.kind !== kind)) throw new Error('Some latest test evidence is no longer available. Run the cases again before exporting.');
    } else artifacts = await this.store.list<RetainedEvidence>('evidence', profileId);
    if (!artifacts.length) throw new Error('No test results are available to export.');
    if (!kind && format === 'html' && new Set(artifacts.map((item) => item.kind)).size > 1) throw new Error('Choose general or red-team results before exporting an HTML report.');
    const reportKind = kind ?? (artifacts.every((item) => item.kind === 'adversarial') ? 'adversarial' : 'contract');
    const content = format === 'json' ? JSON.stringify(webReport(artifacts), null, 2) : format === 'junit' ? junitReport(artifacts) : htmlReport(artifacts, reportKind, this.reportLocale());
    const name = `turnstage-${reportKind}-report-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.${format === 'junit' ? 'xml' : format}`;
    download(name, content, format === 'html' ? 'text/html' : format === 'junit' ? 'application/xml' : 'application/json');
    this.post({ type: 'test.exported', kind: 'report', path: name });
  }

  async exportRunReport(runId: string, format: 'json' | 'junit' | 'html', kind?: TestReportKind): Promise<void> {
    const profileId = this.profile().id;
    const run = (await this.store.get<TestRunHistoryRecord>('runs', `test-batch:${profileId}:${runId}`))?.value;
    if (!run || run.profileId !== profileId) throw new Error('The selected test run is no longer available.');
    const artifacts = await Promise.all(run.cases.map((item) => (!kind || item.kind === kind) && item.evidenceId ? this.store.get<RetainedEvidence>('evidence', item.evidenceId) : undefined));
    if (run.cases.some((item, index) => (!kind || item.kind === kind) && item.evidenceId && (!artifacts[index] || artifacts[index]?.profileId !== profileId || artifacts[index]?.kind !== item.kind))) throw new Error('Some evidence for this test run has expired or changed. Export was cancelled rather than mixing in another run.');
    const content = runScopedReport(run, artifacts, format, kind, this.reportLocale());
    const name = `turnstage-run-${safeFileName(runId)}${kind ? `-${kind}` : ''}.${format === 'junit' ? 'xml' : format}`;
    download(name, content, format === 'html' ? 'text/html' : format === 'junit' ? 'application/xml' : 'application/json');
    this.post({ type: 'test.exported', kind: 'report', path: name });
  }

  async importSuite(kind: 'contract' | 'adversarial', format: 'csv' | 'jsonc' | 'jsonl'): Promise<void> {
    const selected = await pickTextFile(format === 'csv' ? '.csv,text/csv' : '.json,.jsonc,.jsonl,application/json');
    if (!selected) return;
    const suite = await parseSuite(kind, format, selected.name, selected.text);
    await this.store.put<WebSuite>('suites', { id: `${this.profile().id}:${suite.sourcePath}`, profileId: this.profile().id, kind, name: suite.name, updatedAt: Date.now(), value: suite });
    this.post(kind === 'adversarial'
      ? { type: 'adversarial.operation', action: format === 'csv' ? 'importCsv' : format === 'jsonl' ? 'importJsonl' : 'importJsonc', status: 'completed', detail: `Imported ${suite.scenarios.length} cases from ${selected.name}.`, path: suite.sourcePath }
      : { type: 'contract.operation', action: format === 'csv' ? 'importCsv' : 'importJsonc', status: 'completed', detail: `Imported ${suite.scenarios.length} cases from ${selected.name}.`, path: suite.sourcePath });
    await this.postCatalog(kind);
  }

  async postCatalog(kind: 'contract' | 'adversarial'): Promise<void> {
    const suites = (await this.store.list<WebSuite>('suites', this.profile().id)).filter((suite) => suite.value.kind === kind);
    if (kind === 'adversarial') {
      const entries: AdversarialCaseCatalog['entries'] = suites.flatMap(({ value }) => value.scenarios.map((scenario) => ({
        sourcePath: value.sourcePath, revision: value.revision, suiteId: value.suiteId, suiteName: value.name, scenarioId: scenario.id, scenarioName: scenario.name, tags: scenario.tags ?? [], capture: scenario.capture,
        mode: scenario.adversarial?.mode ?? 'singleTurn', turns: scenario.steps.length, maxTurns: scenario.adversarial?.maxTurns ?? scenario.steps.length, repetitions: scenario.adversarial?.repetitions ?? 1, timeoutMs: scenario.adversarial?.timeoutMs ?? 60_000,
        prohibit: { content: scenario.adversarial?.forbid?.content?.length ?? 0, events: scenario.adversarial?.forbid?.events?.length ?? 0, urls: scenario.adversarial?.forbid?.urls === true, ctas: scenario.adversarial?.forbid?.ctas === true, tools: scenario.adversarial?.forbid?.tools === true },
      })));
      this.post({ type: 'adversarial.catalog', catalog: { entries: entries.slice(0, 100), total: entries.length, truncated: entries.length > 100, issues: [] } });
    } else {
      const entries: ContractCaseCatalog['entries'] = suites.flatMap(({ value }) => value.scenarios.map((scenario) => ({ sourcePath: value.sourcePath, revision: value.revision, suiteId: value.suiteId, suiteName: value.name, scenarioId: scenario.id, scenarioName: scenario.name, tags: scenario.tags ?? [], capture: scenario.capture, turns: scenario.steps.length, assertions: scenario.steps.reduce((sum, step) => sum + (step.assertions?.length ?? 0), scenario.assertions?.length ?? 0), comparison: Boolean(scenario.comparison), performance: Boolean(scenario.performance), faults: Boolean(scenario.faults) })));
      this.post({ type: 'contract.catalog', catalog: { entries: entries.slice(0, 100), total: entries.length, truncated: entries.length > 100, issues: [] } });
    }
  }

  async loadCase(kind: 'contract' | 'adversarial', sourcePath: string, scenarioId: string): Promise<void> {
    const suite = await this.findSuite(sourcePath);
    const scenario = suite.value.scenarios.find((item) => item.id === scenarioId);
    if (!scenario) throw new Error('The selected browser-local case no longer exists.');
    const detail = { sourcePath, sourceFormat: suite.value.sourceFormat === 'csv' ? 'csv' : 'jsonc', revision: suite.value.revision, scenario };
    this.post(kind === 'adversarial' ? { type: 'adversarial.case.loaded', detail: detail as LinkedAdversarialCaseDetail } : { type: 'contract.case.loaded', detail: detail as LinkedContractCaseDetail });
  }

  async saveCase(kind: 'contract' | 'adversarial', sourcePath: string, scenarioId: string, expectedRevision: string, scenario: ScenarioDefinition): Promise<void> {
    const artifact = await this.findSuite(sourcePath);
    if (artifact.value.revision !== expectedRevision) throw new Error('The browser-local suite changed. Reload the case before saving.');
    const scenarios = artifact.value.scenarios.map((item) => item.id === scenarioId ? structuredClone(scenario) : item);
    const raw = serializeSuite(artifact.value, scenarios);
    const value = { ...artifact.value, scenarios, raw, revision: await digest(raw) };
    await this.store.put('suites', { ...artifact, updatedAt: Date.now(), value });
    const detail = { sourcePath, sourceFormat: value.sourceFormat === 'csv' ? 'csv' as const : 'jsonc' as const, revision: value.revision, scenario };
    this.post(kind === 'adversarial' ? { type: 'adversarial.case.saved', detail } : { type: 'contract.case.saved', detail });
    await this.postCatalog(kind);
  }

  async deleteCase(kind: 'contract' | 'adversarial', sourcePath: string, scenarioId: string, expectedRevision: string): Promise<void> {
    const artifact = await this.findSuite(sourcePath);
    if (artifact.value.kind !== kind || artifact.value.revision !== expectedRevision) throw new Error('The browser-local suite changed. Refresh the case list before deleting.');
    if (!artifact.value.scenarios.some((item) => item.id === scenarioId)) throw new Error('The selected browser-local case no longer exists.');
    const scenarios = artifact.value.scenarios.filter((item) => item.id !== scenarioId);
    const raw = serializeSuite(artifact.value, scenarios);
    await this.store.put('suites', { ...artifact, updatedAt: Date.now(), value: { ...artifact.value, scenarios, raw, revision: await digest(raw) } });
    this.post(kind === 'adversarial' ? { type: 'adversarial.case.deleted', sourcePath, scenarioId } : { type: 'contract.case.deleted', sourcePath, scenarioId });
    await this.postCatalog(kind);
  }

  exportTemplate(kind: 'contract' | 'adversarial'): void {
    const content = kind === 'adversarial' ? adversarialCsvTemplate() : contractCsvTemplate();
    download(`turnstage-${kind}-template.csv`, content, 'text/csv');
  }

  async exportSuite(sourcePath: string): Promise<void> {
    const suite = await this.findSuite(sourcePath);
    const extension = suite.value.sourceFormat === 'jsonl' ? 'jsonl' : suite.value.sourceFormat === 'csv' ? 'csv' : 'jsonc';
    download(`${safeFileName(suite.value.suiteId)}.${extension}`, suite.value.raw, extension === 'csv' ? 'text/csv' : extension === 'jsonl' ? 'application/x-ndjson' : 'application/json');
  }

  async exportSuites(kind: 'contract' | 'adversarial', format: 'csv' | 'jsonc' | 'jsonl'): Promise<void> {
    const suites = (await this.store.list<WebSuite>('suites', this.profile().id)).filter((item) => item.value.kind === kind);
    const inline = (this.profile().tests?.scenarios ?? []).filter((scenario) => kind === 'adversarial' ? Boolean(scenario.adversarial) : !scenario.adversarial);
    const scenarios = [...inline, ...suites.flatMap((item) => item.value.scenarios)];
    if (!scenarios.length) throw new Error(`There are no ${kind} cases to export.`);
    const id = `browser-${kind}-suite`;
    const name = `Browser ${kind} suite`;
    const issues = kind === 'adversarial'
      ? validateAdversarialSuite(createAdversarialSuite(id, name, scenarios))
      : validateContractSuite(createContractSuite(id, name, scenarios));
    if (issues.length) throw new Error(`The cases cannot be exported together: ${issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(' ')}`);
    const content = format === 'csv' ? kind === 'adversarial' ? serializeAdversarialCsv(scenarios) : serializeContractCsv(scenarios)
      : kind === 'adversarial' ? format === 'jsonl' ? serializeAdversarialJsonl(createAdversarialSuite(id, name, scenarios)) : serializeAdversarialSuite(createAdversarialSuite(id, name, scenarios))
      : serializeContractSuite(createContractSuite(id, name, scenarios));
    download(`turnstage-${kind}-suite.${format}`, content, format === 'csv' ? 'text/csv' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
  }

  private async findSuite(sourcePath: string): Promise<StoredArtifact<WebSuite>> {
    const suites = await this.store.list<WebSuite>('suites', this.profile().id);
    const suite = suites.find((item) => item.value.sourcePath === sourcePath);
    if (!suite) throw new Error('The browser-local suite no longer exists.');
    return suite;
  }

  private upsertAutomation(summary: AutomationResultSummary): void { this.automationResults = [...this.automationResults.filter((item) => item.scenarioId !== summary.scenarioId || item.suiteId !== summary.suiteId), summary]; }
  private upsertAdversarial(summary: AdversarialResultSummary): void { this.adversarialResults = [...this.adversarialResults.filter((item) => item.scenarioId !== summary.scenarioId || item.suiteId !== summary.suiteId), summary]; }
}

function automationSummary(profileId: string, scenario: ScenarioDefinition, result: ScenarioRunResult, evidenceId: string, suiteId?: string): AutomationResultSummary {
  const checks = [...result.steps.flatMap((step) => step.checks), ...result.checks];
  const firstFailure = checks.find((check) => !check.passed);
  return { profileId, ...(suiteId ? { suiteId } : {}), scenarioId: scenario.id, scenarioName: scenario.name, outcome: result.evidence.snapshot.errors.some((error) => error.type === 'WebTestExecutionError') ? 'error' : result.passed ? 'passed' : 'failed', durationMs: result.durationMs, passedChecks: checks.filter((check) => check.passed).length, failedChecks: checks.filter((check) => !check.passed).length, completedSteps: result.steps.length, evidenceId, primaryLocation: firstFailure?.location ?? { kind: 'profile', path: 'tests.scenarios' }, comparison: Boolean(result.comparison), performance: checks.some((check) => check.kind === 'performance') };
}

function adversarialSummary(profileId: string, scenario: ScenarioDefinition, result: ScenarioRunResult, evidenceId: string, suiteId?: string): AdversarialResultSummary {
  const evaluation = result.adversarial!;
  const locations = [...evaluation.findings.flatMap((finding) => finding.locations), ...evaluation.issues.map((issue) => issue.location)];
  return { profileId, ...(suiteId ? { suiteId } : {}), scenarioId: scenario.id, scenarioName: scenario.name, outcome: evaluation.outcome, durationMs: result.durationMs, attemptedTurns: evaluation.attemptedTurns, completedTurns: evaluation.completedTurns, plannedTurns: evaluation.plannedTurns, findingCount: evaluation.findings.length, issueCount: evaluation.issues.length, primaryFinding: evaluation.findings[0], primaryIssue: evaluation.issues[0], evidenceId, primaryLocation: locations[0] ?? { kind: 'profile', path: 'tests.scenarios' }, availableLocations: locations, ...(result.repetitions ? { repetitions: { requestedAttempts: result.repetitions.requestedAttempts, completedAttempts: result.repetitions.completedAttempts, skippedAttempts: result.repetitions.skippedAttempts, sampleComplete: result.repetitions.sampleComplete, stability: result.repetitions.stability, counts: { ...result.repetitions.counts } } } : {}) };
}

function executionError(profileId: string, scenario: ScenarioDefinition, error: unknown): ScenarioRunResult {
  const message = error instanceof Error ? error.message : String(error);
  return { scenarioId: scenario.id, passed: false, durationMs: 0, steps: [], checks: [{ id: 'web-execution-error', label: message, passed: false, kind: 'invariant', location: { kind: 'profile', path: 'tests.scenarios' } }], evidence: { profileId, scenarioId: scenario.id, snapshot: { sessionId: browserUuid(), sessionState: 'failed', turnState: 'failed', messages: [], rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [{ type: 'WebTestExecutionError', message }], droppedEventCount: 0, trusted: true, controls: {} }, networkEntries: [] } };
}

async function parseSuite(kind: 'contract' | 'adversarial', format: 'csv' | 'jsonc' | 'jsonl', fileName: string, raw: string): Promise<WebSuite> {
  let name = fileName; let suiteId = fileName.replace(/\.[^.]+$/u, '').replaceAll(/[^A-Za-z0-9_-]+/gu, '-'); let scenarios: ScenarioDefinition[] = [];
  if (format === 'csv') {
    const parsed = kind === 'adversarial' ? parseAdversarialCsv(raw) : parseContractCsv(raw);
    if (parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `Row ${issue.row}: ${issue.message}`).join(' '));
    scenarios = parsed.scenarios;
  } else if (format === 'jsonl') {
    if (kind !== 'adversarial') throw new Error('JSONL is supported only for adversarial suites.');
    const parsed = parseAdversarialJsonl(raw);
    if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `Line ${issue.line}: ${issue.message}`).join(' ') || 'Invalid adversarial JSONL.');
    suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeAdversarialSuite(parsed.suite);
  } else {
    if (kind === 'adversarial') {
      const parsed = parseAdversarialSuite(raw);
      if (!parsed.suite || parsed.parseErrors.length || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(' ') || 'Invalid adversarial suite JSONC.');
      suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeAdversarialSuite(parsed.suite);
    } else {
      const parsed = parseContractSuite(raw);
      if (!parsed.suite || parsed.parseErrors.length || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(' ') || 'Invalid contract suite JSONC.');
      suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeContractSuite(parsed.suite);
    }
  }
  if (!scenarios.length) throw new Error('The selected suite contains no cases.');
  return { suiteId, name, kind, sourceFormat: format, sourcePath: `browser://suite/${browserUuid()}/${fileName}`, revision: await digest(raw), scenarios, raw };
}

function serializeSuite(suite: WebSuite, scenarios: ScenarioDefinition[]): string {
  if (suite.sourceFormat === 'csv') return suite.kind === 'adversarial' ? serializeAdversarialCsv(scenarios) : serializeContractCsv(scenarios);
  if (suite.sourceFormat === 'jsonl') return serializeAdversarialJsonl(createAdversarialSuite(suite.suiteId, suite.name, scenarios));
  return suite.kind === 'adversarial'
    ? serializeAdversarialSuite(createAdversarialSuite(suite.suiteId, suite.name, scenarios))
    : serializeContractSuite(createContractSuite(suite.suiteId, suite.name, scenarios));
}

async function pickTextFile(accept: string): Promise<{ name: string; text: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => { const file = input.files?.[0]; if (!file) resolve(undefined); else void file.text().then((text) => resolve({ name: file.name, text }), () => resolve(undefined)); };
    input.click();
  });
}

async function digest(value: string): Promise<string> { return browserSha256(value); }
function download(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function downloadBytes(name: string, content: Uint8Array, type: string): void { const url = URL.createObjectURL(new Blob([content as BlobPart], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function safeFileName(value: string): string { return value.replaceAll(/[^A-Za-z0-9_.-]+/gu, '-').slice(0, 128) || 'scenario'; }
function webReport(items: Array<StoredArtifact<RetainedEvidence>>) { return { format: 'turnstage-web-report', version: 1, generatedAt: new Date().toISOString(), summary: { total: items.length, passed: items.filter((item) => item.value.result.passed).length, failed: items.filter((item) => !item.value.result.passed).length }, scenarios: items.map((item) => ({ id: item.value.scenario.id, name: item.value.scenario.name, result: item.value.result })) }; }
function junitReport(items: Array<StoredArtifact<RetainedEvidence>>): string { const cases = items.map((item) => `<testcase name="${xml(item.value.scenario.name)}" time="${(item.value.result.durationMs / 1000).toFixed(3)}">${item.value.result.passed ? '' : `<failure message="Scenario failed"/>`}</testcase>`).join(''); return `<?xml version="1.0" encoding="UTF-8"?><testsuite tests="${items.length}" failures="${items.filter((item) => !item.value.result.passed).length}">${cases}</testsuite>`; }
function htmlReport(items: Array<StoredArtifact<RetainedEvidence>>, kind: TestReportKind, locale: string): string {
  return renderTestReportHtml({
    kind, locale, generatedAt: new Date().toISOString(),
    cases: items.map(({ value }) => {
      const { scenario, result } = value;
      const checks = [...result.steps.flatMap((step) => step.checks), ...result.checks];
      const outcome: TestReportOutcome = kind === 'adversarial' ? result.adversarial?.outcome ?? 'incomplete'
        : result.evidence.snapshot.errors.some((error) => error.type === 'WebTestExecutionError') ? 'error' : result.passed ? 'passed' : 'failed';
      return {
        id: scenario.id, outcome, durationMs: result.durationMs,
        passedChecks: checks.filter((check) => check.passed).length,
        failedChecks: checks.filter((check) => !check.passed).length,
        findingCount: result.adversarial?.findings.length,
        facts: webReportFacts(result, locale),
        ...(result.repetitions ? { completedAttempts: result.repetitions.completedAttempts, requestedAttempts: result.repetitions.requestedAttempts, stability: result.repetitions.stability } : {}),
      };
    }),
  });
}
function runCaseState(item: TestRunHistoryRecord['cases'][number]): 'passed' | 'failed' | 'error' | 'incomplete' {
  if (!item.outcome || item.completedAttempts < item.requestedAttempts) return 'incomplete';
  if (item.outcome === 'passed' || item.outcome === 'resisted') return 'passed';
  if (item.outcome === 'failed' || item.outcome === 'attackSucceeded') return 'failed';
  return 'error';
}
function runScopedReport(run: TestRunHistoryRecord, artifacts: Array<StoredArtifact<RetainedEvidence> | undefined>, format: 'json' | 'junit' | 'html', kind?: TestReportKind, locale = 'en'): string {
  const cases = run.cases.map((item, index) => ({ item, state: runCaseState(item), evidence: artifacts[index]?.value })).filter(({ item }) => kind === undefined || item.kind === kind);
  if (!cases.length) throw new Error('The selected test run has no cases of this type.');
  const runError = run.status !== 'completed' && cases.every(({ state }) => state !== 'incomplete' && state !== 'error');
  if (format === 'json') return JSON.stringify({
    format: 'turnstage-web-run-report', version: 1, generatedAt: new Date().toISOString(), runId: run.id,
    profileId: run.profileId, status: run.status, runner: run.runner, startedAt: run.startedAt, finishedAt: run.finishedAt,
    totalCases: cases.length, evidenceCases: cases.filter(({ evidence }) => evidence).length,
    summary: { passed: cases.filter(({ state }) => state === 'passed').length, failed: cases.filter(({ state }) => state === 'failed').length, errors: cases.filter(({ state }) => state === 'error' || state === 'incomplete').length + Number(runError) },
    cases: cases.map(({ item, state, evidence }) => ({ key: item.key, kind: item.kind, suiteId: item.suiteId, scenarioId: item.scenarioId, name: item.name, outcome: item.outcome ?? null, state, requestedAttempts: item.requestedAttempts, completedAttempts: item.completedAttempts, durationMs: item.durationMs ?? null, ...(evidence ? { result: evidence.result } : {}) })),
  }, null, 2);
  if (format === 'junit') {
    const rows = cases.map(({ item, state }) => {
      const detail = state === 'failed' ? `<failure message="${xml(item.outcome ?? 'Failed')}"/>` : state === 'error' || state === 'incomplete' ? `<error message="${xml(state === 'incomplete' ? 'Case incomplete or not run' : item.outcome ?? 'Error')}"/>` : '';
      return `<testcase name="${xml(item.key)}" time="${((item.durationMs ?? 0) / 1000).toFixed(3)}">${detail}</testcase>`;
    });
    if (runError) rows.push(`<testcase name="Run status"><error message="${xml(`Run ${run.status}`)}"/></testcase>`);
    return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${xml(`TurnStage run ${run.id} (${run.status})`)}" tests="${rows.length}" failures="${cases.filter(({ state }) => state === 'failed').length}" errors="${cases.filter(({ state }) => state === 'error' || state === 'incomplete').length + Number(runError)}">${rows.join('')}</testsuite>`;
  }
  if (!kind && new Set(cases.map(({ item }) => item.kind)).size > 1) throw new Error('Choose general or red-team results before exporting an HTML report.');
  const reportKind = kind ?? (cases.every(({ item }) => item.kind === 'adversarial') ? 'adversarial' : 'contract');
  return renderTestReportHtml({
    kind: reportKind, locale, generatedAt: new Date().toISOString(), runId: run.id, runStatus: localizedRunStatus(run.status, locale),
    cases: cases.map(({ item, state, evidence }) => ({
      id: item.name || item.scenarioId, profileId: item.profileId,
      outcome: state === 'incomplete' ? 'incomplete' : item.outcome ?? 'incomplete',
      durationMs: item.durationMs, completedAttempts: item.completedAttempts, requestedAttempts: item.requestedAttempts,
      ...(evidence ? { passedChecks: [...evidence.result.steps.flatMap((step) => step.checks), ...evidence.result.checks].filter((check) => check.passed).length, failedChecks: [...evidence.result.steps.flatMap((step) => step.checks), ...evidence.result.checks].filter((check) => !check.passed).length, findingCount: evidence.result.adversarial?.findings.length, facts: webReportFacts(evidence.result, locale) } : {}),
    })),
  });
}
function webReportFacts(result: ScenarioRunResult, locale: string): Array<{ label: string; value: string }> {
  const language = locale.toLowerCase();
  const labels = language.startsWith('zh')
    ? { failedCheck: '失敗的檢查', finding: '紅隊發現', issue: '執行問題', stability: '穩定性', comparison: '比較差異' }
    : language.startsWith('ja')
      ? { failedCheck: '失敗したチェック', finding: 'レッドチームの検出', issue: '実行上の問題', stability: '安定性', comparison: '比較差分' }
      : language.startsWith('ko')
        ? { failedCheck: '실패한 검사', finding: '레드팀 발견', issue: '실행 문제', stability: '안정성', comparison: '비교 차이' }
        : { failedCheck: 'Failed check', finding: 'Red-team finding', issue: 'Execution issue', stability: 'Stability', comparison: 'Comparison difference' };
  const checks = [...result.steps.flatMap((step) => step.checks), ...result.checks];
  return [
    ...checks.filter((check) => !check.passed).map((check) => ({ label: labels.failedCheck, value: check.id })),
    ...(result.adversarial?.findings ?? []).map((finding) => ({ label: labels.finding, value: finding.label })),
    ...(result.adversarial?.issues ?? []).map((issue) => ({ label: labels.issue, value: issue.label })),
    ...(result.repetitions ? [{ label: labels.stability, value: result.repetitions.stability }] : []),
    ...(result.comparison ? [{ label: labels.comparison, value: `${result.comparison.differenceCount}: ${result.comparison.differencePaths.join(', ')}` }] : []),
  ];
}
function localizedRunStatus(status: string, locale: string): string {
  const translated = {
    'zh-TW': { completed: '已完成', cancelled: '已取消', failed: '失敗', running: '執行中' },
    ja: { completed: '完了', cancelled: 'キャンセル', failed: '失敗', running: '実行中' },
    ko: { completed: '완료', cancelled: '취소됨', failed: '실패', running: '실행 중' },
  } as const;
  const language = locale.toLowerCase().startsWith('zh') ? 'zh-TW' : locale.toLowerCase().startsWith('ja') ? 'ja' : locale.toLowerCase().startsWith('ko') ? 'ko' : undefined;
  return language ? translated[language][status as keyof typeof translated['zh-TW']] ?? status : status;
}
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
