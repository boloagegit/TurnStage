import type { AdversarialCaseCatalog, ContractCaseCatalog, HostPayload, LinkedAdversarialCaseDetail, LinkedContractCaseDetail, TestOperationAction } from '../../src/shared/protocol';
import type { AdversarialResultSummary, AutomationResultSummary, ScenarioDefinition, ScenarioRunResult, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { adversarialCsvTemplate, parseAdversarialCsv, serializeAdversarialCsv } from '../../src/extension/testing/adversarialCsv';
import { contractCsvTemplate, parseContractCsv, serializeContractCsv } from '../../src/extension/testing/contractCsv';
import { parseAdversarialJsonl, serializeAdversarialJsonl } from '../../src/extension/testing/adversarialJsonl';
import { createAdversarialSuite, normalizeAdversarialSuite, parseAdversarialSuite, serializeAdversarialSuite } from '../../src/extension/testing/adversarialSuite';
import { createContractSuite, normalizeContractSuite, parseContractSuite, serializeContractSuite } from '../../src/extension/testing/contractSuite';
import { runScenario } from '../../src/extension/testing/scenarioRunner';
import { runScenarioGroup } from '../../src/extension/testing/scenarioExecution';
import { BrowserSession } from './browserSession';
import { ArtifactStore, type StoredArtifact } from './artifactStore';
import { redactKnownSecrets } from '../../src/shared/redaction';
import { buildEvidenceTimeline } from '../../src/extension/testing/evidenceTimeline';
import { strToU8, zipSync } from 'fflate';

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

export class WebTestController {
  private readonly store = new ArtifactStore();
  private automationResults: AutomationResultSummary[] = [];
  private adversarialResults: AdversarialResultSummary[] = [];
  private cancelled = false;
  private readonly cancellationListeners = new Set<() => void>();

  constructor(
    private readonly profile: () => TurnStageProfile,
    private readonly environment: () => TurnStageEnvironment,
    private readonly secrets: Map<string, string>,
    private readonly post: (payload: HostPayload, requestId?: string) => void,
  ) {}

  async run(action: TestOperationAction, scenarioId?: string, kind?: 'contract' | 'adversarial'): Promise<void> {
    if (action !== 'runAll' && action !== 'runContracts' && action !== 'runCase') return;
    this.cancelled = false;
    const all = await this.scenarioEntries();
    const selected = all.filter(({ scenario }) => scenarioId ? scenario.id === scenarioId && (!kind || Boolean(scenario.adversarial) === (kind === 'adversarial')) : action === 'runContracts' ? !scenario.adversarial : true);
    this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: 0, totalAttempts: selected.length, completedAttempts: 0, maxConcurrency: 1 } } });
    let completed = 0;
    for (const item of selected) {
      if (this.cancelled) break;
      await this.executeScenario(item, true);
      completed += 1;
      this.post({ type: 'test.results', results: this.adversarialResults, automationResults: this.automationResults });
      this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: selected.length, completedAttempts: completed, maxConcurrency: 1 } } });
    }
    this.post({ type: 'test.operation', operation: { action, state: this.cancelled ? 'cancelled' : 'completed', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: selected.length, completedAttempts: completed, maxConcurrency: 1 } } });
  }

  cancel(): void { this.cancelled = true; for (const listener of this.cancellationListeners) listener(); }

  async rerun(status: 'failed' | 'unstable' | 'incomplete'): Promise<void> {
    this.cancelled = false;
    const selectedIds = new Set([
      ...this.adversarialResults.filter((item) => status === 'failed' ? item.outcome !== 'resisted' : status === 'unstable' ? item.repetitions?.stability === 'unstable' : item.repetitions?.sampleComplete === false).map((item) => `${item.suiteId ?? 'inline'}:${item.scenarioId}`),
      ...(status === 'failed' ? this.automationResults.filter((item) => item.outcome !== 'passed').map((item) => `${item.suiteId ?? 'inline'}:${item.scenarioId}`) : []),
    ]);
    const selected = (await this.scenarioEntries()).filter((item) => selectedIds.has(`${item.suiteId ?? 'inline'}:${item.scenario.id}`));
    const action: TestOperationAction = status === 'failed' ? 'rerunFailed' : status === 'unstable' ? 'rerunUnstable' : 'rerunIncomplete';
    this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: 0, totalAttempts: selected.length, completedAttempts: 0, maxConcurrency: 1 } } });
    let completed = 0;
    for (const item of selected) {
      if (this.cancelled) break;
      await this.executeScenario(item, true);
      completed += 1;
      this.post({ type: 'test.results', results: this.adversarialResults, automationResults: this.automationResults });
      this.post({ type: 'test.operation', operation: { action, state: 'running', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: selected.length, completedAttempts: completed, maxConcurrency: 1 } } });
    }
    this.post({ type: 'test.operation', operation: { action, state: this.cancelled ? 'cancelled' : 'completed', progress: { totalCases: selected.length, completedCases: completed, totalAttempts: selected.length, completedAttempts: completed, maxConcurrency: 1 } } });
  }

  async scenarioEntries(): Promise<WebScenarioEntry[]> {
    const profile = this.profile();
    const suites = await this.store.list<WebSuite>('suites', profile.id);
    return [
      ...(profile.tests?.scenarios ?? []).map((scenario) => ({ key: `${profile.id}/inline/${scenario.id}`, itemId: `inline:${scenario.id}`, scenario })),
      ...suites.flatMap((suite) => suite.value.scenarios.map((scenario) => ({ key: `${profile.id}/${suite.value.suiteId}/${scenario.id}`, itemId: `${suite.value.sourcePath}:${scenario.id}`, suiteId: suite.value.suiteId, scenario }))),
    ];
  }

  async executeScenario(item: WebScenarioEntry, cancellable = false): Promise<{ result: ScenarioRunResult; evidenceId: string }> {
    const profile = this.profile();
    const runtime = new BrowserSession(profile, this.environment(), this.secrets, () => undefined);
    let result: ScenarioRunResult;
    const isCancelled = () => this.cancelled;
    const listeners = this.cancellationListeners;
    const cancellation = cancellable ? { get isCancellationRequested() { return isCancelled(); }, onCancellationRequested: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } } : undefined;
    try { result = item.scenario.adversarial
      ? (await runScenarioGroup(profile.id, item.scenario, async () => new BrowserSession(profile, this.environment(), this.secrets, () => undefined), { cancellation })).result
      : await runScenario(profile.id, item.scenario, runtime, cancellation); }
    catch (error) { result = executionError(profile.id, item.scenario, error); }
    result = redactKnownSecrets(result, [...this.secrets.values()]) as ScenarioRunResult;
    const evidenceId = crypto.randomUUID();
    await this.store.put<RetainedEvidence>('evidence', { id: evidenceId, profileId: profile.id, kind: item.scenario.adversarial ? 'adversarial' : 'contract', name: item.scenario.name, updatedAt: Date.now(), value: { scenario: item.scenario, result } });
    await this.store.put<ScenarioRunResult>('runs', { id: crypto.randomUUID(), profileId: profile.id, kind: 'test', name: item.scenario.name, updatedAt: Date.now(), value: result });
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

  async exportReport(format: 'json' | 'junit' | 'html', evidenceId?: string): Promise<void> {
    const artifacts = evidenceId ? [await this.store.get<RetainedEvidence>('evidence', evidenceId)].filter(Boolean) as Array<StoredArtifact<RetainedEvidence>> : await this.store.list<RetainedEvidence>('evidence', this.profile().id);
    const content = format === 'json' ? JSON.stringify(webReport(artifacts), null, 2) : format === 'junit' ? junitReport(artifacts) : htmlReport(artifacts);
    const name = `turnstage-report-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.${format === 'junit' ? 'xml' : format}`;
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
      : { type: 'contract.operation', action: 'linkSuite', status: 'completed', detail: `Imported ${suite.scenarios.length} cases from ${selected.name}.`, path: suite.sourcePath });
    await this.postCatalog(kind);
  }

  async postCatalog(kind: 'contract' | 'adversarial'): Promise<void> {
    const suites = (await this.store.list<WebSuite>('suites', this.profile().id)).filter((suite) => suite.value.kind === kind);
    if (kind === 'adversarial') {
      const entries: AdversarialCaseCatalog['entries'] = suites.flatMap(({ value }) => value.scenarios.map((scenario) => ({
        sourcePath: value.sourcePath, suiteId: value.suiteId, suiteName: value.name, scenarioId: scenario.id, scenarioName: scenario.name, tags: scenario.tags ?? [], capture: scenario.capture,
        mode: scenario.adversarial?.mode ?? 'singleTurn', turns: scenario.steps.length, maxTurns: scenario.adversarial?.maxTurns ?? scenario.steps.length, repetitions: scenario.adversarial?.repetitions ?? 1, timeoutMs: scenario.adversarial?.timeoutMs ?? 60_000,
        prohibit: { content: scenario.adversarial?.forbid?.content?.length ?? 0, events: scenario.adversarial?.forbid?.events?.length ?? 0, urls: scenario.adversarial?.forbid?.urls === true, ctas: scenario.adversarial?.forbid?.ctas === true, tools: scenario.adversarial?.forbid?.tools === true },
      })));
      this.post({ type: 'adversarial.catalog', catalog: { entries: entries.slice(0, 100), total: entries.length, truncated: entries.length > 100, issues: [] } });
    } else {
      const entries: ContractCaseCatalog['entries'] = suites.flatMap(({ value }) => value.scenarios.map((scenario) => ({ sourcePath: value.sourcePath, suiteId: value.suiteId, suiteName: value.name, scenarioId: scenario.id, scenarioName: scenario.name, tags: scenario.tags ?? [], capture: scenario.capture, turns: scenario.steps.length, assertions: scenario.steps.reduce((sum, step) => sum + (step.assertions?.length ?? 0), scenario.assertions?.length ?? 0), comparison: Boolean(scenario.comparison), performance: Boolean(scenario.performance), faults: Boolean(scenario.faults) })));
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
    const scenarios = suites.flatMap((item) => item.value.scenarios);
    if (!scenarios.length) throw new Error(`There are no browser-local ${kind} suites to export.`);
    const id = `browser-${kind}-suite`;
    const name = `Browser ${kind} suite`;
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
  return { profileId, ...(suiteId ? { suiteId } : {}), scenarioId: scenario.id, scenarioName: scenario.name, outcome: result.passed ? 'passed' : 'failed', durationMs: result.durationMs, passedChecks: checks.filter((check) => check.passed).length, failedChecks: checks.filter((check) => !check.passed).length, completedSteps: result.steps.length, evidenceId, primaryLocation: firstFailure?.location ?? { kind: 'profile', path: 'tests.scenarios' }, comparison: Boolean(result.comparison), performance: checks.some((check) => check.kind === 'performance') };
}

function adversarialSummary(profileId: string, scenario: ScenarioDefinition, result: ScenarioRunResult, evidenceId: string, suiteId?: string): AdversarialResultSummary {
  const evaluation = result.adversarial!;
  const locations = [...evaluation.findings.flatMap((finding) => finding.locations), ...evaluation.issues.map((issue) => issue.location)];
  return { profileId, ...(suiteId ? { suiteId } : {}), scenarioId: scenario.id, scenarioName: scenario.name, outcome: evaluation.outcome, durationMs: result.durationMs, attemptedTurns: evaluation.attemptedTurns, completedTurns: evaluation.completedTurns, plannedTurns: evaluation.plannedTurns, findingCount: evaluation.findings.length, issueCount: evaluation.issues.length, primaryFinding: evaluation.findings[0], primaryIssue: evaluation.issues[0], evidenceId, primaryLocation: locations[0] ?? { kind: 'profile', path: 'tests.scenarios' }, availableLocations: locations, ...(result.repetitions ? { repetitions: { requestedAttempts: result.repetitions.requestedAttempts, completedAttempts: result.repetitions.completedAttempts, skippedAttempts: result.repetitions.skippedAttempts, sampleComplete: result.repetitions.sampleComplete, stability: result.repetitions.stability, counts: { ...result.repetitions.counts } } } : {}) };
}

function executionError(profileId: string, scenario: ScenarioDefinition, error: unknown): ScenarioRunResult {
  const message = error instanceof Error ? error.message : String(error);
  return { scenarioId: scenario.id, passed: false, durationMs: 0, steps: [], checks: [{ id: 'web-execution-error', label: message, passed: false, kind: 'invariant', location: { kind: 'profile', path: 'tests.scenarios' } }], evidence: { profileId, scenarioId: scenario.id, snapshot: { sessionId: crypto.randomUUID(), sessionState: 'failed', turnState: 'failed', messages: [], rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [{ type: 'WebTestExecutionError', message }], droppedEventCount: 0, trusted: true, controls: {} }, networkEntries: [] } };
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
  return { suiteId, name, kind, sourceFormat: format, sourcePath: `browser://suite/${crypto.randomUUID()}/${fileName}`, revision: await digest(raw), scenarios, raw };
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

async function digest(value: string): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function download(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function downloadBytes(name: string, content: Uint8Array, type: string): void { const url = URL.createObjectURL(new Blob([content as BlobPart], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function safeFileName(value: string): string { return value.replaceAll(/[^A-Za-z0-9_.-]+/gu, '-').slice(0, 128) || 'scenario'; }
function webReport(items: Array<StoredArtifact<RetainedEvidence>>) { return { format: 'turnstage-web-report', version: 1, generatedAt: new Date().toISOString(), summary: { total: items.length, passed: items.filter((item) => item.value.result.passed).length, failed: items.filter((item) => !item.value.result.passed).length }, scenarios: items.map((item) => ({ id: item.value.scenario.id, name: item.value.scenario.name, result: item.value.result })) }; }
function junitReport(items: Array<StoredArtifact<RetainedEvidence>>): string { const cases = items.map((item) => `<testcase name="${xml(item.value.scenario.name)}" time="${(item.value.result.durationMs / 1000).toFixed(3)}">${item.value.result.passed ? '' : `<failure message="Scenario failed"/>`}</testcase>`).join(''); return `<?xml version="1.0" encoding="UTF-8"?><testsuite tests="${items.length}" failures="${items.filter((item) => !item.value.result.passed).length}">${cases}</testsuite>`; }
function htmlReport(items: Array<StoredArtifact<RetainedEvidence>>): string { const rows = items.map((item) => `<tr><td>${xml(item.value.scenario.name)}</td><td>${item.value.result.passed ? 'Passed' : 'Failed'}</td><td>${item.value.result.durationMs} ms</td></tr>`).join(''); return `<!doctype html><html><meta charset="utf-8"><title>TurnStage Web report</title><style>body{font:14px system-ui;margin:32px}table{border-collapse:collapse}td,th{padding:8px 12px;border-bottom:1px solid #ccc}</style><h1>TurnStage Web report</h1><table><thead><tr><th>Scenario</th><th>Outcome</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table></html>`; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
