import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { AdversarialResultSummary, ScenarioEvidenceLocation, ScenarioRunResult } from '../../shared/types';
import { compareIntegrityLock, createIntegrityLock } from './evidenceCapsule';
import {
  CopilotRuntimeError,
  type CopilotRuntime,
  type AnalyzeRunInput,
  type ApplyProfilePatchInput,
  type ApplyProfilePatchResult,
  type DraftProfilePatchInput,
  type DraftRegressionInput,
  type FindTestsInput,
  type FindTestsRuntimeResult,
  type FailureRecord,
  type InspectFailureInput,
  type InspectFailureRuntimeResult,
  type RunPreflight,
  type RunTestsInput,
  type RunTestsRuntimeResult,
  type StableRunSelector,
  type TestDescriptor,
  type ValidateTestsInput,
  type ValidateTestsRuntimeResult,
  type ReviewResponseQualityInput,
  type ReviewResponseQualityResult,
} from './types';
import type { ScenarioTestController } from '../testing/scenarioTestController';
import { MAX_COPILOT_RUN_ATTEMPTS, MAX_COPILOT_RUN_REQUESTS } from '../testing/scenarioExecution';
import { mapChangedFilesToTests } from '../testing/impactMapping';
import { diagnoseRun } from './diagnostics/engine';
import type { DiagnosticInput, DiagnosticOutcome, TimingStage } from './diagnostics/contracts';
import { applyTextEdits, computeProfileDigest, createProfilePatchDraft, verifyProfilePatchDraft } from './remediation/planner';
import { ProfilePatchError } from './remediation/contracts';
import { createQualityDisclosureGrant, QualityGrantStore, QualityPolicyError, validateQualityRubrics } from './quality/policy';
import { ProfileRepository, EnvironmentRepository } from '../config/profileRepository';
import { ProfileCodec } from '../config/profileCodec';
import { ProfileValidator } from '../config/profileValidator';
import type { CopilotArtifactRepository } from './artifacts';
import { buildEvidenceTimeline } from '../testing/evidenceTimeline';

interface StoredRun {
  runId: string;
  preflight: RunPreflight;
  cases: RunTestsRuntimeResult['cases'];
  summaries: AdversarialResultSummary[];
}

const INLINE_SUITE_SELECTOR = '@inline';

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
  private runActive = false;
  private readonly quality = new QualityGrantStore();
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();

  constructor(
    private readonly tests: ScenarioTestController,
    private readonly profiles?: ProfileRepository,
    private readonly environments?: EnvironmentRepository,
    private readonly artifacts?: CopilotArtifactRepository,
  ) {}

  isWorkspaceTrusted(): boolean { return vscode.workspace.isTrusted; }

  async previewRun(input: RunTestsInput, token: vscode.CancellationToken): Promise<RunPreflight> {
    throwIfCancelled(token);
    const itemIds = await this.resolveRunItemIds(input, token);
    return this.previewResolvedRun(input, itemIds, token);
  }

  private async previewResolvedRun(input: RunTestsInput, itemIds: readonly string[], token: vscode.CancellationToken): Promise<RunPreflight> {
    const preview = await this.tests.previewSelection({ itemIds, repetitions: input.repetitions, failFast: input.failFast });
    throwIfCancelled(token);
    return {
      requiresNetwork: true,
      workspaceTrusted: this.isWorkspaceTrusted(),
      selectedCount: preview.selectedCount,
      plannedAttempts: preview.plannedAttempts,
      plannedTurns: preview.plannedTurns,
      maxRequests: preview.maximumRequests,
      timeoutMs: preview.maximumDurationMs,
      repetitions: preview.maximumRepetitions,
      credentialsResolved: 'unknown',
      selectedEnvironment: preview.environments.length === 1 ? preview.environments[0] : preview.environments.join(', '),
      warnings: [...preview.warnings, ...(preview.selectedCount > 100 ? ['The result is paginated to at most 100 cases per Copilot page.'] : [])],
    };
  }

  private async resolveRunItemIds(input: RunTestsInput, token: vscode.CancellationToken): Promise<readonly string[]> {
    const suppliedSelectors = input.selectors;
    const hasStableSelector = input.profileId !== undefined || input.suiteId !== undefined || input.caseId !== undefined;
    if (suppliedSelectors?.length && hasStableSelector) throw new CopilotRuntimeError('INVALID_INPUT', 'Use either selectors or a top-level profileId/caseId selector, not both.');
    if (suppliedSelectors !== undefined && !suppliedSelectors.length) throw new CopilotRuntimeError('INVALID_INPUT', 'At least one test selector is required.');
    const selectors: Array<string | StableRunSelector> = suppliedSelectors?.length
      ? [...suppliedSelectors]
      : input.profileId && input.caseId
        ? [{ profileId: input.profileId, caseId: input.caseId, ...(input.suiteId ? { suiteId: input.suiteId } : {}) }]
        : [];
    if (!selectors.length) throw new CopilotRuntimeError('INVALID_INPUT', 'Provide selectors or both profileId and caseId.');
    throwIfCancelled(token);
    const descriptors = await this.tests.describeTests(true);
    const descriptorIds = new Set(descriptors.map((item) => item.id));
    const caseDescriptors = descriptors.filter((item) => item.kind === 'case');
    throwIfCancelled(token);
    const itemIds = selectors.map((selector) => {
      if (typeof selector !== 'string') return resolveStableRunSelector(selector, caseDescriptors);
      if (!descriptorIds.has(selector)) throw new CopilotRuntimeError('NOT_FOUND', 'An exact TurnStage selector was not returned by the current find_tests discovery.');
      return selector;
    });
    return [...new Set(itemIds)];
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
    let coverage: FindTestsRuntimeResult['coverage'];
    if (input.changedFiles?.length) {
      const cases = items.filter((item) => item.kind === 'case');
      const impact = mapChangedFilesToTests(input.changedFiles, cases, { includeUnbound: input.includeUnbound });
      const selected = new Map(impact.selected.map((item) => [item.id, item]));
      const matchedFiles = [...new Set(impact.selected.flatMap((item) => item.matchedFiles))].sort();
      const matchedSet = new Set(matchedFiles);
      const unmatchedFiles = impact.changedFiles.filter((path) => !matchedSet.has(path));
      const omittedUnbound = impact.omitted.filter((item) => item.reasons.some((reason) => reason.binding === 'none')).length;
      const diagnostics = impact.diagnostics.map((item) => `${item.scope}: ${item.message}`);
      if (!impact.selected.length) diagnostics.push('No test case has an explicit source binding that matches the supplied changed files.');
      if (unmatchedFiles.length) diagnostics.push(`${unmatchedFiles.length} changed file(s) are not covered by an explicit matching source binding.`);
      if (omittedUnbound) diagnostics.push(`${omittedUnbound} unbound test case(s) were omitted; set includeUnbound only when intentional broad selection is acceptable.`);
      coverage = { changedFiles: impact.changedFiles, matchedFiles, unmatchedFiles, diagnostics: diagnostics.slice(0, 100) };
      items = cases.flatMap((item) => {
        const candidate = selected.get(item.id);
        return candidate ? [{ ...item, selectionReason: candidate.reasons.map((reason) => reason.message).join(' ') }] : [];
      });
    }
    return { tests: items.slice(0, 10_000), total: items.length, coverage };
  }

  async runTests(input: RunTestsInput, token: vscode.CancellationToken): Promise<RunTestsRuntimeResult> {
    throwIfCancelled(token);
    assertWorkspaceTrusted();
    if (this.runActive) throw new CopilotRuntimeError('RUNTIME_FAILED', 'Another Copilot-triggered TurnStage run is already active. Wait for it to finish or cancel it before starting another run.');
    this.runActive = true;
    try {
    const itemIds = await this.resolveRunItemIds(input, token);
    const preflight = await this.previewResolvedRun(input, itemIds, token);
    if (!preflight.selectedCount) throw new CopilotRuntimeError('NOT_FOUND', 'No matching TurnStage tests were selected.');
    assertRunBudget(preflight);
    assertWorkspaceTrusted();
    const material = await this.tests.getIntegrityMaterial({ itemIds });
    assertWorkspaceTrusted();
    const observedIntegrity = createIntegrityLock(material.profile, material.suite, material.cases);
    const integrity = compareIntegrityLock(input.expectedIntegrity, observedIntegrity);
    if (input.expectedIntegrity && !integrity.matches) throw new CopilotRuntimeError('INTEGRITY_MISMATCH', 'The selected TurnStage test contract changed after the expected integrity lock was created. No tests were run.');
    const runId = randomUUID();
    assertWorkspaceTrusted();
    const execution = await this.tests.runSelection(
      { itemIds, repetitions: input.repetitions, failFast: input.failFast },
      token,
      {
        runId,
        validateIntegrity: (finalMaterial) => {
          const finalIntegrity = createIntegrityLock(finalMaterial.profile, finalMaterial.suite, finalMaterial.cases);
          if (!compareIntegrityLock(observedIntegrity, finalIntegrity).matches) {
            throw new CopilotRuntimeError('INTEGRITY_MISMATCH', 'The selected TurnStage test contract changed while preparing the final bounded run. No tests were run.');
          }
        },
      },
    );
    throwIfCancelled(token);
    // Workspace Trust changes reload VS Code in normal operation, but keep the
    // boundary fail-closed if a host or test double changes it while a run is
    // awaiting network work. Do not expose or retain results after revocation.
    assertWorkspaceTrusted();
    const summaries = execution.summaries;
    const cases = summaries.map((summary) => ({
      id: summary.scenarioId,
      profileId: summary.profileId,
      suiteId: summary.suiteId,
      label: summary.scenarioName,
      outcome: summary.outcome,
      evidenceId: summary.evidenceId,
      failureId: summary.outcome === 'resisted' || summary.outcome === 'passed' ? undefined : failureIdFor(runId, summary),
      stability: summary.stability,
      counts: summary.counts,
    }));
    const adversarialSummaries = [...execution.results];
    const outcome = aggregateCaseOutcome(cases);
    const stored: StoredRun = { runId, preflight, cases, summaries: adversarialSummaries };
    // The controller retains enough detailed evidence for one maximum bounded
    // Copilot run. Keep the runtime index aligned with that retention contract
    // instead of advertising older run IDs whose evidence may be evicted.
    this.runs.clear();
    this.runs.set(runId, stored);
    return { runId, preflight, outcome, cases, totalCases: preflight.selectedCount, completedCases: summaries.length, sampleComplete: summaries.every((summary) => summary.sampleComplete !== false), integrity };
    } finally {
      this.runActive = false;
    }
  }

  async inspectFailure(input: InspectFailureInput, token: vscode.CancellationToken): Promise<InspectFailureRuntimeResult> {
    throwIfCancelled(token);
    const run = this.runs.get(input.runId);
    if (!run) throw new CopilotRuntimeError('NOT_FOUND', 'The requested TurnStage run is no longer available.');
    const failures: FailureRecord[] = run.summaries
      .filter((summary) => isFailureOutcome(summary.outcome))
      .map((summary) => {
        const failureId = failureIdFor(run.runId, summary);
        const evidence = this.tests.getEvidence(summary.evidenceId);
        const timeline = evidence?.result ? buildEvidenceTimeline(evidence.result) : undefined;
        return {
          id: failureId,
          caseId: summary.scenarioId,
          profileId: summary.profileId,
          suiteId: summary.suiteId,
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
            completeness: timeline?.completeness ?? (evidence ? 'partial' as const : 'missing' as const),
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

  async analyzeRun(input: AnalyzeRunInput, token: vscode.CancellationToken) {
    throwIfCancelled(token);
    assertAnalyzeSelector(input);
    if (input.mode === 'configuration') {
      const entry = await this.resolveProfile(input.profile);
      const environmentEntries = await this.environments?.discover(entry.uri) ?? [];
      const issues = this.validator.validate(entry.profile, undefined, environmentEntries.map((item) => item.environment));
      const diagnosis = diagnoseRun({
        runId: `profile:${entry.profile!.id}`,
        focus: 'configuration',
        profileId: entry.profile!.id,
        outcome: issues.some((item) => item.severity === 'error') ? 'failed' : 'passed',
        configIssues: issues.map((item) => item.message),
        evidence: [{ kind: 'profile', id: entry.profile!.id, path: 'profile' }],
        transport: { protocol: transportProtocol(entry.profile!.stream.transport), state: 'unknown', terminalState: 'unknown' },
      });
      this.artifacts?.recordDiagnosis(diagnosis);
      return diagnosis;
    }
    const reference = input.evidenceId ? this.tests.getEvidence(input.evidenceId) : this.evidenceForRun(input.runId);
    if (!reference) throw new CopilotRuntimeError('NOT_FOUND', 'The requested TurnStage evidence is no longer available. Run the test again.');
    throwIfCancelled(token);
    const diagnosisRunId = input.runId ?? this.runIdForEvidence(input.evidenceId) ?? `evidence:${input.evidenceId ?? 'unknown'}`;
    const diagnosis = diagnoseRun(diagnosticInput(reference.result, reference.evidence, diagnosisRunId, input.mode));
    this.artifacts?.recordDiagnosis(diagnosis);
    return diagnosis;
  }

  async draftProfilePatch(input: DraftProfilePatchInput, token: vscode.CancellationToken) {
    throwIfCancelled(token);
    assertWorkspaceTrusted();
    const entry = await this.resolveProfile(input.profile);
    const sourceText = await readDocumentText(entry.uri);
    assertWorkspaceTrusted();
    try {
      const draft = createProfilePatchDraft({ profile: entry.profile, sourceText, operations: input.operations, expectedProfileDigest: input.expectedProfileDigest });
      this.artifacts?.recordProfilePatch({ draft, profileId: entry.profile!.id, status: 'drafted' });
      return draft;
    } catch (error) { throw remediationError(error); }
  }

  async applyProfilePatch(input: ApplyProfilePatchInput, token: vscode.CancellationToken): Promise<ApplyProfilePatchResult> {
    throwIfCancelled(token);
    assertWorkspaceTrusted();
    const entry = await this.resolveProfile(input.profile);
    const document = await vscode.workspace.openTextDocument(entry.uri);
    const sourceText = document.getText();
    const parsed = this.codec.parse(sourceText);
    if (!parsed.profile || parsed.errors.length) throw new CopilotRuntimeError('INVALID_DRAFT', 'The profile is not valid JSONC. No changes were applied.');
    const verification = verifyProfilePatchDraft({ profile: parsed.profile, sourceText, draft: input.draft });
    if (!verification.valid) throw new CopilotRuntimeError('INTEGRITY_MISMATCH', `The profile changed after the patch was drafted. ${verification.errors.join(' ')}`);
    const updatedText = applyTextEdits(sourceText, input.draft.edits);
    const updated = this.codec.parse(updatedText);
    if (!updated.profile || updated.errors.length) throw new CopilotRuntimeError('INVALID_DRAFT', 'The proposed profile patch would create invalid JSONC. No changes were applied.');
    const environmentEntries = await this.environments?.discover(entry.uri) ?? [];
    const preflightIssues = this.validator.validate(updated.profile, updated.tree, environmentEntries.map((item) => item.environment));
    if (preflightIssues.some((item) => item.severity === 'error')) throw new CopilotRuntimeError('INVALID_DRAFT', `The proposed profile patch failed validation: ${preflightIssues.slice(0, 5).map((item) => item.message).join(' ')}`);

    const preview = await vscode.workspace.openTextDocument({ language: 'jsonc', content: updatedText });
    await vscode.commands.executeCommand('vscode.diff', entry.uri, preview.uri, `TurnStage Profile Patch — ${entry.profile!.name}`, { preview: true });
    const applyLabel = vscode.l10n.t('Apply Profile Changes');
    const confirmed = await vscode.window.showInformationMessage(
      vscode.l10n.t('Apply {count} safe TurnStage profile setting change(s)?', { count: String(input.draft.changes.length) }),
      { modal: true, detail: input.draft.changes.slice(0, 12).map((change) => `${change.pathLabel}: ${change.reason}`).join('\n') },
      applyLabel,
    );
    if (confirmed !== applyLabel) throw new CopilotRuntimeError('CANCELLED', 'Profile patch application was cancelled.');
    throwIfCancelled(token);
    assertWorkspaceTrusted();

    const currentText = document.getText();
    const currentProfile = this.codec.parse(currentText).profile;
    if (!currentProfile || computeProfileDigest(currentProfile) !== input.draft.profileDigest || currentText !== sourceText) throw new CopilotRuntimeError('INTEGRITY_MISMATCH', 'The profile changed while the patch preview was open. No changes were applied.');
    const edit = new vscode.WorkspaceEdit();
    for (const item of [...input.draft.edits].sort((a, b) => b.offset - a.offset)) edit.replace(entry.uri, new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.content);
    assertWorkspaceTrusted();
    if (!await vscode.workspace.applyEdit(edit)) throw new CopilotRuntimeError('RUNTIME_FAILED', 'VS Code could not apply the profile patch.');
    const appliedVersion = document.version;
    const appliedText = document.getText();
    if (appliedText !== updatedText) {
      this.artifacts?.recordProfilePatch({ draft: input.draft, profileId: entry.profile!.id, status: 'failed' });
      throw new CopilotRuntimeError('RUNTIME_FAILED', 'The profile changed while the patch was being applied. Automatic rollback was not attempted because the current text no longer matches the proposed patch. Review the open profile before continuing.');
    }
    if (!this.isWorkspaceTrusted()) {
      const rolledBack = await rollbackDocument(document, input.draft.inverseEdits, sourceText, appliedText, appliedVersion);
      this.artifacts?.recordProfilePatch({ draft: input.draft, profileId: entry.profile!.id, status: rolledBack ? 'rolledBack' : 'failed' });
      throw new CopilotRuntimeError('WORKSPACE_UNTRUSTED', rolledBack
        ? 'Workspace trust changed while applying the profile patch. TurnStage rolled the profile back.'
        : 'Workspace trust changed while applying the profile patch and automatic rollback could not be verified. Review the open profile and use VS Code Undo.');
    }
    let saved = false;
    try {
      saved = await document.save();
    } catch {
      saved = false;
    }
    if (!saved) {
      const rolledBack = await rollbackDocument(document, input.draft.inverseEdits, sourceText, appliedText, appliedVersion);
      this.artifacts?.recordProfilePatch({ draft: input.draft, profileId: entry.profile!.id, status: rolledBack ? 'rolledBack' : 'failed' });
      throw new CopilotRuntimeError('RUNTIME_FAILED', rolledBack
        ? 'The profile patch could not be saved. TurnStage rolled the profile back to its previous text.'
        : 'The profile patch was applied in the editor but could not be saved or rolled back safely. Review the open profile and use VS Code Undo before running tests.');
    }
    const afterText = document.getText();
    const after = this.codec.parse(afterText);
    const postIssues = after.profile ? this.validator.validate(after.profile, after.tree, environmentEntries.map((item) => item.environment)) : [];
    if (!after.profile || after.errors.length || postIssues.some((item) => item.severity === 'error') || computeProfileDigest(after.profile) !== input.draft.updatedProfileDigest) {
      const rolledBack = await rollbackDocument(document, input.draft.inverseEdits, sourceText, afterText, document.version);
      this.artifacts?.recordProfilePatch({ draft: input.draft, profileId: entry.profile!.id, status: rolledBack ? 'rolledBack' : 'failed' });
      throw new CopilotRuntimeError('RUNTIME_FAILED', rolledBack
        ? 'Post-apply verification failed. TurnStage verified that the profile was rolled back to its previous text.'
        : 'Post-apply verification failed and automatic rollback could not be verified. Review the open profile and use VS Code Undo before running tests.');
    }
    this.artifacts?.recordProfilePatch({ draft: input.draft, profileId: entry.profile!.id, status: 'applied' });
    return {
      applied: true,
      profile: entry.profile!.id,
      profileDigest: input.draft.updatedProfileDigest,
      validation: { valid: true, issues: postIssues.map((issue) => ({ code: 'PROFILE_VALIDATION', path: 'profile', message: issue.message, severity: issue.severity })) },
      undoAvailable: true,
    };
  }

  async reviewResponseQuality(input: ReviewResponseQualityInput, token: vscode.CancellationToken): Promise<ReviewResponseQualityResult> {
    throwIfCancelled(token);
    assertWorkspaceTrusted();
    try {
      if (input.action === 'record') {
        const grant = this.quality.get(input.grantId);
        const artifactScope = this.resolveQualityArtifactScope(grant.evidenceIds);
        const review = this.quality.record(input.grantId, input.review);
        this.artifacts?.recordQualityReview(review, { ...artifactScope, disclosedResponses: grant.attempts.map((attempt) => attempt.response) });
        return { action: 'record', review, advisoryOnly: true };
      }
      const references = input.evidenceIds.map((id) => ({ id, reference: this.tests.getEvidence(id) }));
      if (references.some((item) => !item.reference)) throw new CopilotRuntimeError('NOT_FOUND', 'One or more selected evidence attempts are no longer available.');
      const attempts = references.map(({ id, reference }) => {
        const assistant = [...reference!.evidence.snapshot.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'completed');
        const response = assistant?.parts.flatMap((part) => typeof part.text === 'string' ? [part.text] : []).join('') ?? '';
        return { attemptId: `${id}:${assistant?.id ?? 'missing'}`, response };
      });
      const first = references[0]!.reference!;
      const entry = await this.profiles?.read(first.uri);
      assertWorkspaceTrusted();
      const available = validateQualityRubrics(entry?.profile?.tests?.qualityRubrics);
      const rubrics = input.rubricIds?.length ? available.filter((rubric) => input.rubricIds!.includes(rubric.id)) : available;
      if (!rubrics.length) throw new CopilotRuntimeError('NOT_FOUND', 'No selected advisory quality rubric was found.');
      const grant = this.quality.issue(createQualityDisclosureGrant({ evidenceIds: input.evidenceIds, attempts, rubrics }));
      return { action: 'disclose', grant, advisoryOnly: true };
    } catch (error) {
      if (error instanceof CopilotRuntimeError) throw error;
      if (error instanceof QualityPolicyError) {
        const code = error.code === 'GRANT_EXPIRED' || error.code === 'GRANT_NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT';
        throw new CopilotRuntimeError(code, error.message);
      }
      throw error;
    }
  }

  private evidenceForRun(runId: string | undefined) {
    if (!runId) return undefined;
    const run = this.runs.get(runId);
    const evidenceId = run?.cases.find((item) => item.evidenceId)?.evidenceId;
    return evidenceId ? this.tests.getEvidence(evidenceId) : undefined;
  }

  private runIdForEvidence(evidenceId: string | undefined): string | undefined {
    if (!evidenceId) return undefined;
    for (const [runId, run] of this.runs) {
      if (run.cases.some((item) => item.evidenceId === evidenceId)) return runId;
    }
    return undefined;
  }

  private resolveQualityArtifactScope(evidenceIds: readonly string[]): { profileId: string; runId?: string } {
    const references = evidenceIds.map((id) => this.tests.getEvidence(id));
    if (references.some((reference) => !reference)) throw new CopilotRuntimeError('NOT_FOUND', 'The selected quality evidence is no longer available.');
    const profileIds = new Set(references.map((reference) => reference!.evidence.profileId));
    if (profileIds.size !== 1 || ![...profileIds][0]) throw new CopilotRuntimeError('INVALID_INPUT', 'Advisory quality evidence must belong to exactly one Profile.');

    const selectedEvidence = new Set(evidenceIds);
    const runIds = new Set<string>();
    for (const [runId, run] of this.runs) {
      if (run.cases.some((item) => item.evidenceId !== undefined && selectedEvidence.has(item.evidenceId))) runIds.add(runId);
    }
    const runId = runIds.size === 1 ? [...runIds][0] : undefined;
    return { profileId: [...profileIds][0]!, ...(runId ? { runId } : {}) };
  }

  private async resolveProfile(selector: string | undefined) {
    if (!selector || !this.profiles) throw new CopilotRuntimeError('NOT_FOUND', 'A discovered TurnStage profile is required.');
    const entries = await this.profiles.discover();
    const entry = entries.find((item) => item.profile?.id === selector || item.uri.toString() === selector || vscode.workspace.asRelativePath(item.uri) === selector);
    if (!entry?.profile || entry.error) throw new CopilotRuntimeError('NOT_FOUND', 'The requested TurnStage profile is not a valid discovered profile.');
    return entry as typeof entry & { profile: NonNullable<typeof entry.profile> };
  }
}

function diagnosticInput(result: ScenarioRunResult | undefined, evidence: import('../../shared/types').ScenarioRunEvidence, runId: string, focus: AnalyzeRunInput['mode']): DiagnosticInput {
  const snapshot = evidence.snapshot;
  const network = [...evidence.networkEntries].reverse().find((entry) => entry.kind === 'stream') ?? evidence.networkEntries.at(-1);
  const startedAt = snapshot.metrics.requestStartedAt ?? network?.startedAt;
  const firstNormalized = snapshot.normalizedEvents.find((event) => event.type === 'content.text.delta' || event.type === 'content.markdown.delta');
  const terminalAt = network?.completedAt;
  const timeout = snapshot.errors.some((error) => /timeout/i.test(`${error.type} ${error.message}`));
  const idleTimeout = snapshot.errors.some((error) => /idle.?timeout/i.test(`${error.type} ${error.message}`));
  const firstChunk = snapshot.metrics.firstChunkLatency ?? network?.timing.firstChunk;
  const firstEvent = snapshot.metrics.firstEventLatency;
  const ttft = snapshot.metrics.ttft;
  const proxyBuffered = typeof firstChunk === 'number' && firstChunk >= 250 && typeof firstEvent === 'number' && typeof ttft === 'number' && Math.abs(firstEvent - firstChunk) <= 20 && Math.abs(ttft - firstChunk) <= 20;
  const repetition = result?.repetitions ? {
    requestedAttempts: result.repetitions.requestedAttempts,
    sampleComplete: result.repetitions.sampleComplete,
    attempts: result.repetitions.attempts.map((attempt) => ({ attempt: attempt.attempt, outcome: attempt.outcome, completed: true, durationMs: attempt.durationMs })),
  } : undefined;
  const comparison = result?.comparison;
  return {
    runId,
    focus,
    caseId: evidence.scenarioId,
    profileId: evidence.profileId,
    outcome: diagnosticOutcome(result),
    timing: {
      request: startedAt === undefined ? undefined : 0,
      headers: snapshot.metrics.headersLatency ?? network?.timing.headers,
      firstChunk,
      firstRawEvent: firstEvent,
      firstNormalizedContent: startedAt !== undefined && firstNormalized ? firstNormalized.receivedAt - startedAt : ttft,
      firstVisibleText: ttft,
      terminal: snapshot.metrics.totalDuration ?? (startedAt !== undefined && terminalAt !== undefined ? terminalAt - startedAt : undefined),
    },
    metrics: { ...snapshot.metrics, firstNormalizedContentLatency: startedAt !== undefined && firstNormalized ? firstNormalized.receivedAt - startedAt : ttft, firstVisibleTextLatency: ttft, droppedEventCount: snapshot.droppedEventCount },
    transport: { protocol: transportProtocol(network?.protocol ?? snapshot.rawEvents[0]?.protocol), status: network?.status, state: network?.state, terminalState: timeout ? 'timeout' : terminalState(snapshot.turnState), proxyBuffered, idleTimeout, timeout, retryCount: snapshot.metrics.reconnectCount, variantId: network?.variantId, headersLatency: network?.timing.headers, firstChunkLatency: network?.timing.firstChunk, terminalLatency: network?.timing.total },
    errors: snapshot.errors.map((error) => ({ type: error.type, status: error.status, retrySafe: error.retrySafe })),
    evidence: evidenceReferences(evidence, result),
    assertions: result?.checks.map((check) => ({ id: check.id, passed: check.passed })),
    repetition,
    baseline: comparison ? { outcome: result?.passed ? 'passed' : 'failed', metrics: { terminalLatencyMs: comparison.baselineDurationMs } } : undefined,
    candidate: comparison ? { outcome: diagnosticOutcome(result), metrics: { terminalLatencyMs: comparison.candidateDurationMs } } : undefined,
  };
}

function diagnosticOutcome(result: ScenarioRunResult | undefined): DiagnosticOutcome { return result?.adversarial?.outcome ?? (result?.passed === true ? 'passed' : result?.passed === false ? 'failed' : 'indeterminate'); }
function transportProtocol(value: unknown): 'http' | 'sse' | 'websocket' | 'json' | 'unknown' { return value === 'sse' ? 'sse' : value === 'json' || value === 'ndjson' ? 'json' : value === 'http' || value === 'websocket' ? value : 'unknown'; }
function terminalState(value: string): 'completed' | 'failed' | 'aborted' | 'pending' | 'unknown' { return value === 'completed' || value === 'failed' || value === 'aborted' ? value : ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(value) ? 'pending' : 'unknown'; }
function evidenceReferences(evidence: import('../../shared/types').ScenarioRunEvidence, result?: ScenarioRunResult) {
  type SafeEvidenceRef = { kind: 'chat' | 'network' | 'event' | 'profile' | 'metric'; id: string; path?: string; stage?: TimingStage };
  const refs: SafeEvidenceRef[] = [{ kind: 'profile', id: evidence.profileId, path: 'tests' }];
  for (const entry of evidence.networkEntries.slice(0, 20)) refs.push({ kind: 'network', id: entry.id });
  for (const event of evidence.snapshot.rawEvents.slice(0, 20)) refs.push({ kind: 'event', id: String(event.sequence) });
  for (const message of evidence.snapshot.messages.filter((item) => item.role === 'assistant').slice(0, 20)) refs.push({ kind: 'chat', id: message.id });
  const staged: SafeEvidenceRef[] = [];
  for (const entry of result ? buildEvidenceTimeline(result).entries : []) {
    const stage = timelineStage(entry.phase);
    const location = entry.location;
    if (!stage || !location) continue;
    if (location.kind === 'message' && location.messageId) staged.push({ kind: 'chat', id: location.messageId, stage });
    else if (location.kind === 'network' && location.networkId) staged.push({ kind: 'network', id: location.networkId, stage });
    else if ((location.kind === 'rawEvent' || location.kind === 'normalizedEvent') && location.sequence !== undefined) staged.push({ kind: 'event', id: String(location.sequence), stage });
  }
  const combined = [...staged, ...refs];
  return combined.filter((item, index) => combined.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id && candidate.stage === item.stage && candidate.path === item.path) === index).slice(0, 100);
}

function timelineStage(phase: import('../../shared/types').EvidenceTimelinePhase): TimingStage | undefined {
  if (phase === 'request' || phase === 'headers' || phase === 'firstChunk' || phase === 'terminal') return phase;
  if (phase === 'firstEvent') return 'firstRawEvent';
  if (phase === 'firstMappedEvent') return 'firstNormalizedContent';
  if (phase === 'ttft') return 'firstVisibleText';
  return undefined;
}

async function readDocumentText(uri: vscode.Uri): Promise<string> { const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString()) ?? await vscode.workspace.openTextDocument(uri); return document.getText(); }
function remediationError(error: unknown): CopilotRuntimeError { return error instanceof ProfilePatchError ? new CopilotRuntimeError(error.code === 'DIGEST_MISMATCH' ? 'INTEGRITY_MISMATCH' : 'INVALID_DRAFT', error.message) : new CopilotRuntimeError('RUNTIME_FAILED', 'TurnStage could not create a safe profile patch.'); }
async function rollbackDocument(document: vscode.TextDocument, inverse: readonly { offset: number; length: number; content: string }[], expectedText: string, expectedCurrentText: string, expectedCurrentVersion: number): Promise<boolean> {
  // Never apply inverse offsets to a document that has changed since the
  // failed patch. This protects a user's concurrent edit from being replaced
  // by an inverse computed from an older source snapshot.
  if (document.version !== expectedCurrentVersion || document.getText() !== expectedCurrentText) return false;
  const edit = new vscode.WorkspaceEdit();
  for (const item of [...inverse].sort((a, b) => b.offset - a.offset)) edit.replace(document.uri, new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.content);
  try {
    if (!await vscode.workspace.applyEdit(edit)) return false;
    if (!await document.save()) return false;
    return document.getText() === expectedText;
  } catch {
    return false;
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

function resolveStableRunSelector(selector: StableRunSelector, descriptors: readonly TestDescriptor[]): string {
  const matches = descriptors.filter((item) => item.profileId === selector.profileId
    && item.caseId === selector.caseId
    && (selector.suiteId === undefined
      || (selector.suiteId === INLINE_SUITE_SELECTOR ? item.suiteId === undefined : item.suiteId === selector.suiteId)));
  if (!matches.length) throw new CopilotRuntimeError('NOT_FOUND', 'No TurnStage test matches the supplied profileId, caseId, and suiteId.');
  if (matches.length > 1) throw new CopilotRuntimeError('SELECTION_UNSUPPORTED', `A stable selector matches ${matches.length} tests. Add suiteId, use ${INLINE_SUITE_SELECTOR} for an inline Scenario, or use an exact selector returned by find_tests.`);
  return matches[0]!.id;
}

function aggregateCaseOutcome(cases: readonly RunTestsRuntimeResult['cases'][number][]): RunTestsRuntimeResult['outcome'] {
  if (cases.some((item) => item.outcome === 'attackSucceeded' || item.outcome === 'failed')) return 'attackSucceeded';
  if (cases.some((item) => item.outcome === 'infrastructureError' || item.outcome === 'error')) return 'infrastructureError';
  if (cases.some((item) => item.outcome === 'indeterminate' || item.outcome === 'cancelled')) return 'indeterminate';
  return cases.some((item) => item.outcome === 'passed') ? 'passed' : 'resisted';
}

function isFailureOutcome(outcome: string): boolean { return outcome !== 'resisted' && outcome !== 'passed'; }

function failureIdFor(runId: string, summary: { profileId: string; suiteId?: string; scenarioId: string }): string {
  return `${runId}:${summary.profileId}:${summary.suiteId ?? 'inline'}:${summary.scenarioId}`;
}

function assertRunBudget(preflight: RunPreflight): void {
  const plannedAttempts = preflight.plannedAttempts ?? preflight.repetitions * preflight.selectedCount;
  if (plannedAttempts > MAX_COPILOT_RUN_ATTEMPTS || preflight.maxRequests > MAX_COPILOT_RUN_REQUESTS) {
    throw new CopilotRuntimeError('RUN_BUDGET_EXCEEDED', `The selected TurnStage run exceeds the Copilot safety budget of ${MAX_COPILOT_RUN_ATTEMPTS} attempts and ${MAX_COPILOT_RUN_REQUESTS} requests.`);
  }
}

function assertAnalyzeSelector(input: AnalyzeRunInput): void {
  const selectors = [input.runId, input.evidenceId, input.profile].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (input.mode === 'configuration') {
    if (selectors.length !== 1 || !input.profile) throw new CopilotRuntimeError('INVALID_INPUT', 'Configuration analysis requires exactly one profile selector.');
    return;
  }
  if (selectors.length !== 1 || (!input.runId && !input.evidenceId)) throw new CopilotRuntimeError('INVALID_INPUT', 'Run analysis requires exactly one runId or evidenceId selector.');
}

function throwIfCancelled(token: vscode.CancellationToken): void { if (token.isCancellationRequested) throw new CopilotRuntimeError('CANCELLED', 'The operation was cancelled.', true); }
function assertWorkspaceTrusted(): void { if (!vscode.workspace.isTrusted) throw new CopilotRuntimeError('WORKSPACE_UNTRUSTED', 'This Copilot operation is disabled in Restricted Mode.'); }
