import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { AdversarialResultSummary, ScenarioEvidenceLocation } from '../../shared/types';
import { compareIntegrityLock, createIntegrityLock } from './evidenceCapsule';
import {
  CopilotRuntimeError,
  type CopilotRuntime,
  type DraftRegressionInput,
  type FindTestsInput,
  type FindTestsRuntimeResult,
  type FailureRecord,
  type InspectFailureInput,
  type InspectFailureRuntimeResult,
  type RunPreflight,
  type RunTestsInput,
  type RunTestsRuntimeResult,
  type TestDescriptor,
  type ValidateTestsInput,
  type ValidateTestsRuntimeResult,
} from './types';
import type { ScenarioTestController } from '../testing/scenarioTestController';
import { mapChangedFilesToTests } from '../testing/impactMapping';

interface StoredRun {
  runId: string;
  preflight: RunPreflight;
  cases: RunTestsRuntimeResult['cases'];
  summaries: AdversarialResultSummary[];
}

/**
 * Compatibility adapter for the current Test Explorer controller. It only
 * delegates execution to `ScenarioTestController.runAll`; the Copilot layer
 * does not reimplement scenario or adversarial execution semantics.
 *
 * Once the shared execution service lands, activation can replace this adapter
 * with that service without changing tool schemas or result handling.
 */
export class ScenarioCopilotRuntime implements CopilotRuntime {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly tests: ScenarioTestController) {}

  isWorkspaceTrusted(): boolean { return vscode.workspace.isTrusted; }

  async previewRun(input: RunTestsInput, token: vscode.CancellationToken): Promise<RunPreflight> {
    throwIfCancelled(token);
    const preview = await this.tests.previewSelection({ itemIds: input.selectors, repetitions: input.repetitions, failFast: input.failFast });
    throwIfCancelled(token);
    return {
      requiresNetwork: true,
      workspaceTrusted: this.isWorkspaceTrusted(),
      selectedCount: preview.selectedCount,
      plannedTurns: preview.plannedTurns,
      maxRequests: preview.maximumRequests,
      timeoutMs: preview.maximumDurationMs,
      repetitions: preview.maximumRepetitions,
      credentialsResolved: 'unknown',
      selectedEnvironment: preview.environments.length === 1 ? preview.environments[0] : preview.environments.join(', '),
      warnings: [...preview.warnings, ...(preview.selectedCount > 100 ? ['The result is paginated to at most 100 cases per Copilot page.'] : [])],
    };
  }

  async findTests(input: FindTestsInput, token: vscode.CancellationToken): Promise<FindTestsRuntimeResult> {
    throwIfCancelled(token);
    await this.tests.refresh();
    throwIfCancelled(token);
    let items = (await this.tests.describeTests(input.includeSteps)).map((item): TestDescriptor => ({ ...item, selectionReason: 'discovered in Test Explorer' }));
    const query = input.query?.toLocaleLowerCase();
    if (query) items = items.filter((item) => `${item.id} ${item.label}`.toLocaleLowerCase().includes(query));
    if (input.profileId) items = items.filter((item) => item.profileId === input.profileId || item.id.includes(input.profileId!));
    if (input.suiteId) items = items.filter((item) => item.suiteId === input.suiteId || item.id.includes(input.suiteId!));
    if (input.caseId) items = items.filter((item) => item.caseId === input.caseId || item.id.includes(input.caseId!));
    if (input.tag) items = items.filter((item) => item.tags?.includes(input.tag!));
    if (input.changedFiles?.length) {
      const cases = items.filter((item) => item.kind === 'case');
      const impact = mapChangedFilesToTests(input.changedFiles, cases, { includeUnbound: input.includeUnbound });
      const selected = new Map(impact.selected.map((item) => [item.id, item]));
      items = cases.flatMap((item) => {
        const candidate = selected.get(item.id);
        return candidate ? [{ ...item, selectionReason: candidate.reasons.map((reason) => reason.message).join(' ') }] : [];
      });
    }
    return { tests: items.slice(0, 10_000), total: items.length };
  }

  async runTests(input: RunTestsInput, token: vscode.CancellationToken): Promise<RunTestsRuntimeResult> {
    throwIfCancelled(token);
    if (!this.isWorkspaceTrusted()) throw new CopilotRuntimeError('WORKSPACE_UNTRUSTED', 'Test execution requires a trusted workspace.');
    const preflight = await this.previewRun(input, token);
    if (!preflight.selectedCount) throw new CopilotRuntimeError('NOT_FOUND', 'No matching TurnStage tests were selected.');
    const material = await this.tests.getIntegrityMaterial({ itemIds: input.selectors });
    const observedIntegrity = createIntegrityLock(material.profile, material.suite, material.cases);
    const integrity = compareIntegrityLock(input.expectedIntegrity, observedIntegrity);
    if (input.expectedIntegrity && !integrity.matches) throw new CopilotRuntimeError('INTEGRITY_MISMATCH', 'The selected TurnStage test contract changed after the expected integrity lock was created. No tests were run.');
    const runId = randomUUID();
    await this.tests.runSelection({ itemIds: input.selectors, repetitions: input.repetitions, failFast: input.failFast }, token);
    throwIfCancelled(token);
    const summaries = this.tests.getLatestRunSummaries();
    const cases = summaries.map((summary) => ({
      id: summary.scenarioId,
      label: summary.scenarioName,
      outcome: summary.outcome,
      evidenceId: summary.evidenceId,
      failureId: summary.outcome === 'resisted' || summary.outcome === 'passed' ? undefined : `${runId}:${summary.scenarioId}`,
      stability: summary.stability,
      counts: summary.counts,
    }));
    const adversarialSummaries = this.latestSummaries();
    const outcome = aggregateCaseOutcome(cases);
    const stored: StoredRun = { runId, preflight, cases, summaries: adversarialSummaries };
    this.runs.set(runId, stored);
    while (this.runs.size > 20) this.runs.delete(this.runs.keys().next().value!);
    return { runId, preflight, outcome, cases, totalCases: preflight.selectedCount, completedCases: summaries.length, sampleComplete: summaries.every((summary) => summary.sampleComplete !== false), integrity };
  }

  async inspectFailure(input: InspectFailureInput, token: vscode.CancellationToken): Promise<InspectFailureRuntimeResult> {
    throwIfCancelled(token);
    const run = this.runs.get(input.runId);
    if (!run) throw new CopilotRuntimeError('NOT_FOUND', 'The requested TurnStage run is no longer available.');
    const failures: FailureRecord[] = run.summaries
      .filter((summary) => summary.outcome !== 'resisted')
      .map((summary) => {
        const failureId = `${run.runId}:${summary.scenarioId}`;
        const evidence = this.tests.getEvidence(summary.evidenceId);
        return {
          id: failureId,
          caseId: summary.scenarioId,
          caseLabel: summary.scenarioName,
          outcome: summary.outcome,
          label: summary.primaryFinding?.label ?? summary.primaryIssue?.label,
          turnId: summary.primaryFinding?.turnId ?? summary.primaryIssue?.turnId,
          turnIndex: summary.primaryFinding?.turnIndex ?? summary.primaryIssue?.turnIndex,
          ruleId: summary.primaryFinding?.ruleId,
          evidenceId: summary.evidenceId,
          evidence: {
            failedContract: {
              id: summary.scenarioId,
              label: summary.primaryFinding?.label ?? summary.primaryIssue?.label ?? summary.scenarioName,
              outcome: summary.outcome,
            },
            evidenceRefs: evidence ? locationsToReferences(evidence.evidence, summary.availableLocations) : locationsToReferences(undefined, summary.availableLocations),
            completeness: evidence ? 'complete' as const : 'missing' as const,
            profile: evidence ? { id: evidence.evidence.profileId } : undefined,
            suite: evidence ? { id: evidence.evidence.scenarioId } : undefined,
          },
        } satisfies FailureRecord;
      });
    const selected = input.failureId ? failures.filter((failure) => failure.id === input.failureId) : failures;
    if (input.failureId && !selected.length) throw new CopilotRuntimeError('NOT_FOUND', 'The requested failure is not present in this run.');
    return { runId: input.runId, failures: selected, total: selected.length };
  }

  async draftRegression(input: DraftRegressionInput & { draft: import('./types').RegressionDraft }, token: vscode.CancellationToken) {
    throwIfCancelled(token);
    const run = this.runs.get(input.runId);
    if (!run) throw new CopilotRuntimeError('NOT_FOUND', 'The source TurnStage run is no longer available.');
    const failure = run.cases.find((item) => item.failureId === input.failureId);
    if (!failure) throw new CopilotRuntimeError('NOT_FOUND', 'The source failure is not present in this run.');
    return { runId: input.runId, failureId: input.failureId, draft: input.draft, sourceEvidenceId: failure.evidenceId };
  }

  async validateTests(input: ValidateTestsInput, token: vscode.CancellationToken): Promise<ValidateTestsRuntimeResult> {
    throwIfCancelled(token);
    await this.tests.refresh();
    const descriptors = (await this.tests.describeTests(false)).filter((item) => {
      if (item.kind === 'step') return false;
      if (input.profileId && item.profileId !== input.profileId && !item.id.includes(input.profileId)) return false;
      if (input.suiteId && item.suiteId !== input.suiteId && !item.id.includes(input.suiteId)) return false;
      if (input.caseId && item.caseId !== input.caseId && !item.id.includes(input.caseId)) return false;
      return true;
    });
    const issues = descriptors.length ? [] : [{ code: 'NOT_FOUND', path: 'tests', message: 'No matching TurnStage tests were discovered.', severity: 'error' as const }];
    const material = await this.tests.getIntegrityMaterial({ profileId: input.profileId, suiteId: input.suiteId, caseId: input.caseId });
    const integrity = compareIntegrityLock(input.expectedIntegrity, createIntegrityLock(material.profile, material.suite, material.cases));
    return { valid: issues.length === 0 && (!integrity || integrity.matches), issues, total: descriptors.length, integrity };
  }

  private latestSummaries(): AdversarialResultSummary[] {
    const uris = new Map<string, vscode.Uri>();
    this.tests.controller.items.forEach((item) => { if (item.uri) uris.set(item.uri.toString(), item.uri); });
    return [...uris.values()].flatMap((uri) => this.tests.getLatestResults(uri));
  }
}

function locationsToReferences(evidence: { snapshot?: unknown } | undefined, locations: readonly ScenarioEvidenceLocation[]): Array<{ kind: 'chat' | 'network' | 'event'; id: string }> {
  const references: Array<{ kind: 'chat' | 'network' | 'event'; id: string }> = [];
  for (const location of locations.slice(0, 20)) {
    if (location.kind === 'message' && location.messageId) references.push({ kind: 'chat', id: location.messageId });
    else if (location.kind === 'network' && location.networkId) references.push({ kind: 'network', id: location.networkId });
    else if ((location.kind === 'rawEvent' || location.kind === 'normalizedEvent') && location.sequence !== undefined) references.push({ kind: 'event', id: String(location.sequence) });
  }
  if (!references.length && evidence) references.push({ kind: 'chat', id: 'snapshot' });
  return references;
}

function aggregateCaseOutcome(cases: readonly RunTestsRuntimeResult['cases'][number][]): RunTestsRuntimeResult['outcome'] {
  if (cases.some((item) => item.outcome === 'attackSucceeded' || item.outcome === 'failed')) return 'attackSucceeded';
  if (cases.some((item) => item.outcome === 'infrastructureError' || item.outcome === 'error')) return 'infrastructureError';
  if (cases.some((item) => item.outcome === 'indeterminate' || item.outcome === 'cancelled')) return 'indeterminate';
  return cases.some((item) => item.outcome === 'passed') ? 'passed' : 'resisted';
}

function throwIfCancelled(token: vscode.CancellationToken): void { if (token.isCancellationRequested) throw new CopilotRuntimeError('CANCELLED', 'The operation was cancelled.', true); }
