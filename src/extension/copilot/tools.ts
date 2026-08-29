import * as vscode from 'vscode';
import { createEvidenceCapsule, redactForDisclosure } from './evidenceCapsule';
import {
  COPILOT_LIMITS,
  COPILOT_TOOL_NAMES,
  CopilotRuntimeError,
  type CopilotCancellationToken,
  type CopilotRuntime,
  type CopilotToolFailure,
  type CopilotToolName,
  type CopilotToolResponse,
  type CopilotToolSuccess,
  type DraftRegressionInput,
  type DraftProfilePatchInput,
  type FindTestsInput,
  type InspectFailureInput,
  type IntegrityLock,
  type RegressionDraft,
  type RunPreflight,
  type RunTestsInput,
  type SafeOutcome,
  type ValidateTestsInput,
  type AnalyzeRunInput,
  type ApplyProfilePatchInput,
  type ReviewResponseQualityInput,
} from './types';
import type { ProfilePatchDraftV1, ProfilePatchOperationV1 } from './remediation/contracts';
import type { QualityReviewSubmission } from './quality/contracts';
import type { AdversarialContentRule, AdversarialForbidDefinition, ScenarioAssertionDefinition } from '../../shared/types';
import { isSafeAssertionRegex, isValidAssertionPath } from '../testing/assertionEvaluator';
import { MAX_ADVERSARIAL_RULES, MAX_ADVERSARIAL_TURNS_PER_CASE } from '../testing/adversarialSuite';

const ERROR_CODES = {
  invalidInput: 'INVALID_INPUT',
  workspaceUntrusted: 'WORKSPACE_UNTRUSTED',
  cancelled: 'CANCELLED',
  runtimeUnavailable: 'RUNTIME_UNAVAILABLE',
  runtimeFailed: 'RUNTIME_FAILED',
  notFound: 'NOT_FOUND',
  invalidDraft: 'INVALID_DRAFT',
  integrityMismatch: 'INTEGRITY_MISMATCH',
  outputLimit: 'OUTPUT_LIMIT',
  runBudgetExceeded: 'RUN_BUDGET_EXCEEDED',
  selectionUnsupported: 'SELECTION_UNSUPPORTED',
  unsafeOperation: 'UNSAFE_OPERATION',
} as const;
const TRUSTED_ONLY_TOOLS = new Set<CopilotToolName>([
  COPILOT_TOOL_NAMES.runTests,
  COPILOT_TOOL_NAMES.draftProfilePatch,
  COPILOT_TOOL_NAMES.applyProfilePatch,
  COPILOT_TOOL_NAMES.reviewResponseQuality,
]);

export { ERROR_CODES as COPILOT_ERROR_CODES };

type ToolInput = FindTestsInput | RunTestsInput | InspectFailureInput | DraftRegressionInput | ValidateTestsInput | AnalyzeRunInput | DraftProfilePatchInput | ApplyProfilePatchInput | ReviewResponseQualityInput;

const INVOCATION_MESSAGES: Record<CopilotToolName, string> = {
  [COPILOT_TOOL_NAMES.findTests]: 'Find matching TurnStage tests',
  [COPILOT_TOOL_NAMES.runTests]: 'Run TurnStage tests',
  [COPILOT_TOOL_NAMES.inspectFailure]: 'Inspect a bounded TurnStage failure capsule',
  [COPILOT_TOOL_NAMES.draftRegression]: 'Draft a schema-validated TurnStage regression (no files will be changed)',
  [COPILOT_TOOL_NAMES.validateTests]: 'Validate TurnStage tests and their integrity lock',
  [COPILOT_TOOL_NAMES.analyzeRun]: 'Analyze bounded TurnStage diagnostic evidence',
  [COPILOT_TOOL_NAMES.draftProfilePatch]: 'Draft a safe TurnStage profile patch (no files will be changed)',
  [COPILOT_TOOL_NAMES.applyProfilePatch]: 'Apply confirmed TurnStage profile settings',
  [COPILOT_TOOL_NAMES.reviewResponseQuality]: 'Run an Advisory AI response-quality review',
};

const ALLOWED_KEYS: Record<CopilotToolName, readonly string[]> = {
  [COPILOT_TOOL_NAMES.findTests]: ['query', 'profileId', 'suiteId', 'caseId', 'tag', 'changedFiles', 'includeUnbound', 'includeSteps', 'cursor', 'limit'],
  [COPILOT_TOOL_NAMES.runTests]: ['selectors', 'repetitions', 'failFast', 'expectedIntegrity', 'cursor', 'limit'],
  [COPILOT_TOOL_NAMES.inspectFailure]: ['runId', 'failureId', 'includeEvents', 'cursor', 'limit'],
  [COPILOT_TOOL_NAMES.draftRegression]: ['runId', 'failureId', 'draft', 'sourceEvidenceId'],
  [COPILOT_TOOL_NAMES.validateTests]: ['profileId', 'suiteId', 'caseId', 'expectedIntegrity', 'cursor', 'limit'],
  [COPILOT_TOOL_NAMES.analyzeRun]: ['runId', 'evidenceId', 'profile', 'mode'],
  [COPILOT_TOOL_NAMES.draftProfilePatch]: ['profile', 'expectedProfileDigest', 'operations'],
  [COPILOT_TOOL_NAMES.applyProfilePatch]: ['profile', 'draft'],
  [COPILOT_TOOL_NAMES.reviewResponseQuality]: ['action', 'evidenceIds', 'rubricIds', 'grantId', 'review'],
};

export interface ToolRegistrationOptions {
  /** Optional logger used by integration tests and hosts that want diagnostics. */
  onError?: (tool: CopilotToolName, error: unknown) => void;
}

/** Register every static manifest tool against the injected runtime. */
export function registerCopilotTools(runtime: CopilotRuntime, options: ToolRegistrationOptions = {}): vscode.Disposable[] {
  const languageModel = vscode.lm;
  if (!languageModel || typeof languageModel.registerTool !== 'function') return [];
  return (Object.values(COPILOT_TOOL_NAMES) as CopilotToolName[]).map((name) => {
    const implementation: vscode.LanguageModelTool<unknown> = {
      prepareInvocation: (invocation, token) => prepareInvocation(name, invocation.input, runtime, token),
      invoke: async (invocation, token) => {
        try {
          const response = await executeCopilotTool(name, invocation.input, runtime, token);
          return toLanguageModelResult(response);
        } catch (error) {
          options.onError?.(name, error);
          return toLanguageModelResult(failure(name, ERROR_CODES.runtimeFailed, 'TurnStage tool failed safely.', true));
        }
      },
    };
    return languageModel.registerTool(name, implementation);
  });
}

/**
 * Pure-ish tool execution entry point used by tests and by the VS Code
 * adapter. It returns JSON-safe objects and never edits a workspace.
 */
export async function executeCopilotTool(
  name: CopilotToolName,
  rawInput: unknown,
  runtime: CopilotRuntime,
  token: CopilotCancellationToken,
): Promise<CopilotToolResponse<unknown>> {
  try {
    if (token.isCancellationRequested) return failure(name, ERROR_CODES.cancelled, 'The tool invocation was cancelled.', true);
    const input = parseInput(name, rawInput);
    if (!runtime.isWorkspaceTrusted() && TRUSTED_ONLY_TOOLS.has(name)) {
      return failure(name, ERROR_CODES.workspaceUntrusted, 'This Copilot operation is disabled in Restricted Mode. Sanitized diagnosis remains available.', false);
    }
    const result = await invokeRuntime(name, input, runtime, token);
    if (token.isCancellationRequested) return failure(name, ERROR_CODES.cancelled, 'The tool invocation was cancelled before the result was complete.', true);
    const response = success(name, normalizeResult(name, result, input));
    return ensureBoundedResponse(response);
  } catch (error) {
    if (error instanceof InputError) return failure(name, ERROR_CODES.invalidInput, error.message, false);
    if (error instanceof CopilotRuntimeError) return failure(name, error.code, error.message, error.retryable);
    if (isCancellation(error)) return failure(name, ERROR_CODES.cancelled, 'The tool invocation was cancelled.', true);
    return failure(name, ERROR_CODES.runtimeFailed, 'TurnStage could not complete the requested operation.', true);
  }
}

/** Exposed for focused tests and for hosts that need to render the same preview. */
export async function prepareInvocation(
  name: CopilotToolName,
  rawInput: unknown,
  runtime: CopilotRuntime,
  token: CopilotCancellationToken,
): Promise<vscode.PreparedToolInvocation | undefined> {
  if (name === COPILOT_TOOL_NAMES.applyProfilePatch) {
    try {
      const input = parseInput(name, rawInput) as ApplyProfilePatchInput;
      const detail = input.draft.changes.slice(0, 12).map((change) => `${change.pathLabel}: ${summarizePatchValue(change.before)} → ${summarizePatchValue(change.after)} — ${change.reason}`).join('\n');
      return { invocationMessage: `Apply ${input.draft.changes.length} confirmed TurnStage profile setting change(s)`, confirmationMessages: { title: 'Apply safe TurnStage profile changes?', message: `${detail}${input.draft.changes.length > 12 ? '\nAdditional bounded changes are included in the draft.' : ''}\nThe current profile digest must still match. VS Code Undo remains available.` } };
    } catch { return { invocationMessage: 'Validate TurnStage profile patch' }; }
  }
  if (name === COPILOT_TOOL_NAMES.reviewResponseQuality) {
    try {
      const input = parseInput(name, rawInput) as ReviewResponseQualityInput;
      if (input.action === 'disclose') return { invocationMessage: 'Disclose selected responses for Advisory AI review', confirmationMessages: { title: 'Share selected response text with Copilot?', message: `TurnStage will disclose ${input.evidenceIds.length} explicitly selected response attempt(s), capped at 8,000 characters each and 32,000 total. Prompts, headers, raw payloads, full URLs, and secrets are excluded. This advisory review cannot change the formal test outcome.` } };
    } catch { return { invocationMessage: 'Validate advisory quality review input' }; }
  }
  if (name !== COPILOT_TOOL_NAMES.runTests) {
    return { invocationMessage: INVOCATION_MESSAGES[name] };
  }
  let input: RunTestsInput;
  try {
    input = parseInput(name, rawInput) as RunTestsInput;
  } catch {
    return { invocationMessage: 'Validate TurnStage run input' };
  }
  if (!runtime.isWorkspaceTrusted()) {
    return { invocationMessage: INVOCATION_MESSAGES[name] };
  }
  let preflight: RunPreflight | undefined;
  try {
    // previewRun is explicitly required to be side-effect free. It is called
    // here instead of duplicating selection/count logic in the tool layer.
    preflight = await runtime.previewRun(input, token);
  } catch {
    // The actual invocation still reports the stable runtime error. A generic
    // confirmation is safer than silently allowing a network run.
  }
  const detail = preflight ? preflightMessage(preflight) : 'Selected tests may issue network requests and resolve configured credentials.';
  return {
    invocationMessage: preflight ? `Run ${preflight.selectedCount} TurnStage test case(s)` : INVOCATION_MESSAGES[name],
    confirmationMessages: {
      title: 'Run TurnStage tests with network access?',
      message: detail,
    },
  };
}

function invokeRuntime(name: CopilotToolName, input: ToolInput, runtime: CopilotRuntime, token: CopilotCancellationToken): Promise<unknown> {
  switch (name) {
    case COPILOT_TOOL_NAMES.findTests: return runtime.findTests(input as FindTestsInput, token);
    case COPILOT_TOOL_NAMES.runTests: return runtime.runTests(input as RunTestsInput, token);
    case COPILOT_TOOL_NAMES.inspectFailure: return runtime.inspectFailure(input as InspectFailureInput, token);
    case COPILOT_TOOL_NAMES.draftRegression: return runtime.draftRegression(input as DraftRegressionInput & { draft: RegressionDraft }, token);
    case COPILOT_TOOL_NAMES.validateTests: return runtime.validateTests(input as ValidateTestsInput, token);
    case COPILOT_TOOL_NAMES.analyzeRun: return runtime.analyzeRun(input as AnalyzeRunInput, token);
    case COPILOT_TOOL_NAMES.draftProfilePatch: return runtime.draftProfilePatch(input as DraftProfilePatchInput, token);
    case COPILOT_TOOL_NAMES.applyProfilePatch: return runtime.applyProfilePatch(input as ApplyProfilePatchInput, token);
    case COPILOT_TOOL_NAMES.reviewResponseQuality: return runtime.reviewResponseQuality(input as ReviewResponseQualityInput, token);
  }
}

function normalizeResult(name: CopilotToolName, result: unknown, input: ToolInput): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CopilotRuntimeError(ERROR_CODES.runtimeFailed, 'TurnStage returned an invalid result.');
  const pageInput = ('cursor' in input || 'limit' in input) ? input as { cursor?: string; limit?: number } : {};
  if (name === COPILOT_TOOL_NAMES.findTests) {
    const value = result as { tests?: unknown; total?: unknown; coverage?: unknown };
    const tests = Array.isArray(value.tests) ? value.tests.filter(isTestDescriptor).slice(0, 10_000) : [];
    return { tests: page(tests, pageInput.cursor, pageInput.limit, value.total), total: safeCount(value.total, tests.length), coverage: normalizeCoverage(value.coverage) };
  }
  if (name === COPILOT_TOOL_NAMES.runTests) {
    const value = result as Record<string, unknown>;
    const preflight = normalizePreflight(value.preflight);
    const cases = Array.isArray(value.cases) ? value.cases.filter(isRunCase).slice(0, 10_000).map((item) => normalizeRunCase(item)) : [];
    return {
      runId: safeId(value.runId, 'runId'),
      outcome: safeOutcome(value.outcome),
      preflight,
      summary: {
        totalCases: safeCount(value.totalCases, cases.length),
        completedCases: safeCount(value.completedCases, cases.length),
        sampleComplete: value.sampleComplete !== false,
      },
      cases: page(cases, pageInput.cursor, pageInput.limit, value.totalCases),
      integrity: normalizeIntegrity(value.integrity),
    };
  }
  if (name === COPILOT_TOOL_NAMES.inspectFailure) {
    const value = result as { runId?: unknown; failures?: unknown; total?: unknown };
    const failures = Array.isArray(value.failures) ? value.failures.filter(isFailureRecord).slice(0, 10_000) : [];
    const items = failures.map((failure) => ({
      id: safeId(failure.id, 'failureId'),
      caseId: safeId(failure.caseId, 'caseId'),
      profileId: failure.profileId === undefined ? undefined : safeId(failure.profileId, 'profileId'),
      suiteId: failure.suiteId === undefined ? undefined : safeId(failure.suiteId, 'suiteId'),
      outcome: safeOutcome(failure.outcome),
      capsule: createEvidenceCapsule({ runId: safeId(value.runId, 'runId'), failureId: safeId(failure.id, 'failureId'), source: failure.evidence ?? { failedContract: { id: failure.id, label: failure.label ?? 'TurnStage failure', outcome: safeOutcome(failure.outcome) }, completeness: 'missing' } }),
    }));
    return { runId: safeId(value.runId, 'runId'), failures: page(items, pageInput.cursor, pageInput.limit, value.total), total: safeCount(value.total, items.length) };
  }
  if (name === COPILOT_TOOL_NAMES.draftRegression) {
    const value = result as Record<string, unknown>;
    const draft = parseRegressionDraft(value.draft);
    return {
      runId: safeId(value.runId, 'runId'),
      failureId: safeId(value.failureId, 'failureId'),
      sourceEvidenceId: value.sourceEvidenceId === undefined ? undefined : safeId(value.sourceEvidenceId, 'sourceEvidenceId'),
      draft: sanitizeDraft(draft),
      integrity: normalizeIntegrity(value.integrity),
      draftOnly: true,
    };
  }
  if (name === COPILOT_TOOL_NAMES.analyzeRun || name === COPILOT_TOOL_NAMES.draftProfilePatch || name === COPILOT_TOOL_NAMES.applyProfilePatch || name === COPILOT_TOOL_NAMES.reviewResponseQuality) {
    if (!isBoundedValue(result, 0, new WeakSet<object>(), { count: 0 }, 100_000, 16)) throw new CopilotRuntimeError(ERROR_CODES.outputLimit, 'TurnStage returned oversized diagnostic or advisory output.');
    return result;
  }
  const value = result as { valid?: unknown; issues?: unknown; total?: unknown; integrity?: unknown };
  const issues = Array.isArray(value.issues) ? value.issues.filter(isValidationIssue).slice(0, COPILOT_LIMITS.maxValidationIssues) : [];
  return {
    valid: value.valid === true && issues.every((issue) => issue.severity !== 'error'),
    issues: page(issues, pageInput.cursor, pageInput.limit, value.total),
    total: safeCount(value.total, issues.length),
    integrity: normalizeIntegrity(value.integrity),
  };
}

function normalizeCoverage(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CopilotRuntimeError(ERROR_CODES.runtimeFailed, 'TurnStage returned invalid source-impact coverage.');
  const paths = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string' && item.length <= 4_096).slice(0, 10_000) : [];
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics.filter((item): item is string => typeof item === 'string' && item.length <= 512).slice(0, 100) : [];
  return { changedFiles: paths(value.changedFiles), matchedFiles: paths(value.matchedFiles), unmatchedFiles: paths(value.unmatchedFiles), diagnostics };
}

function parseInput(name: CopilotToolName, raw: unknown): ToolInput {
  if (!isRecord(raw)) throw new InputError('Input must be a JSON object.');
  const allowed = new Set(ALLOWED_KEYS[name]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new InputError('Input contains an unsupported property.');
  const pageInput = parsePage(raw);
  switch (name) {
    case COPILOT_TOOL_NAMES.findTests:
      return {
        ...pageInput,
        query: optionalText(raw.query, COPILOT_LIMITS.maxQueryLength),
        profileId: optionalId(raw.profileId),
        suiteId: optionalId(raw.suiteId),
        caseId: optionalId(raw.caseId),
        tag: optionalText(raw.tag, 64),
        changedFiles: raw.changedFiles === undefined ? undefined : parseStringArray(raw.changedFiles, 1_000, 'changed file'),
        includeUnbound: optionalBoolean(raw.includeUnbound),
        includeSteps: optionalBoolean(raw.includeSteps),
      };
    case COPILOT_TOOL_NAMES.runTests: {
      const selectors = raw.selectors === undefined ? undefined : parseStringArray(raw.selectors, COPILOT_LIMITS.maxSelectors, 'selector');
      if (selectors !== undefined && selectors.length === 0) throw new InputError('selectors must contain at least one test id when provided.');
      const repetitions = raw.repetitions === undefined ? undefined : boundedInteger(raw.repetitions, 1, COPILOT_LIMITS.maxRepetitions, 'repetitions');
      return { ...pageInput, selectors, repetitions, failFast: optionalBoolean(raw.failFast), expectedIntegrity: raw.expectedIntegrity === undefined ? undefined : parseIntegrityLock(raw.expectedIntegrity) };
    }
    case COPILOT_TOOL_NAMES.inspectFailure:
      return { ...pageInput, runId: requiredId(raw.runId, 'runId'), failureId: optionalId(raw.failureId), includeEvents: optionalBoolean(raw.includeEvents) };
    case COPILOT_TOOL_NAMES.draftRegression:
      return { runId: requiredId(raw.runId, 'runId'), failureId: requiredId(raw.failureId, 'failureId'), sourceEvidenceId: optionalId(raw.sourceEvidenceId), draft: parseRegressionDraft(raw.draft) };
    case COPILOT_TOOL_NAMES.validateTests:
      return { ...pageInput, profileId: optionalId(raw.profileId), suiteId: optionalId(raw.suiteId), caseId: optionalId(raw.caseId), expectedIntegrity: raw.expectedIntegrity === undefined ? undefined : parseIntegrityLock(raw.expectedIntegrity) };
    case COPILOT_TOOL_NAMES.analyzeRun: {
      const mode = raw.mode;
      if (!['failure', 'performance', 'stability', 'comparison', 'configuration'].includes(String(mode))) throw new InputError('mode must be failure, performance, stability, comparison, or configuration.');
      const result: AnalyzeRunInput = { mode: mode as AnalyzeRunInput['mode'], runId: optionalId(raw.runId), evidenceId: optionalId(raw.evidenceId), profile: optionalText(raw.profile, COPILOT_LIMITS.maxInputString) };
      const selectors = [result.runId, result.evidenceId, result.profile].filter((value): value is string => typeof value === 'string' && value.length > 0);
      if (result.mode === 'configuration') {
        if (selectors.length !== 1 || !result.profile) throw new InputError('configuration mode requires exactly one profile selector.');
      } else if (selectors.length !== 1 || (!result.runId && !result.evidenceId)) {
        throw new InputError('failure, performance, stability, and comparison modes require exactly one runId or evidenceId selector.');
      }
      return result;
    }
    case COPILOT_TOOL_NAMES.draftProfilePatch: {
      if (!Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 64) throw new InputError('operations must contain 1 to 64 safe profile changes.');
      return { profile: requiredText(raw.profile, 'profile', COPILOT_LIMITS.maxInputString), expectedProfileDigest: raw.expectedProfileDigest === undefined ? undefined : requiredFingerprint(raw.expectedProfileDigest, 'expectedProfileDigest'), operations: raw.operations.map(parseProfilePatchOperation) };
    }
    case COPILOT_TOOL_NAMES.applyProfilePatch:
      return { profile: requiredText(raw.profile, 'profile', COPILOT_LIMITS.maxInputString), draft: parseProfilePatchDraft(raw.draft) };
    case COPILOT_TOOL_NAMES.reviewResponseQuality: {
      if (raw.action === 'disclose') return { action: 'disclose', evidenceIds: parseStringArray(raw.evidenceIds, 10, 'evidence id'), rubricIds: raw.rubricIds === undefined ? undefined : parseStringArray(raw.rubricIds, 20, 'rubric id', 256) };
      if (raw.action === 'record') {
        if (!isBoundedValue(raw.review)) throw new InputError('review must be a bounded advisory review object.');
        return { action: 'record', grantId: requiredId(raw.grantId, 'grantId'), review: raw.review as QualityReviewSubmission };
      }
      throw new InputError('action must be disclose or record.');
    }
  }
}

function parseProfilePatchOperation(value: unknown, index: number): ProfilePatchOperationV1 {
  if (!isRecord(value)) throw new InputError(`operations[${index}] must be an object.`);
  const allowed = new Set(['path', 'operation', 'value', 'reason', 'category']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new InputError(`operations[${index}] contains an unsupported property.`);
  if (!Array.isArray(value.path) || value.path.length < 1 || value.path.length > 12 || value.path.some((part) => typeof part !== 'string' && !Number.isInteger(part))) throw new InputError(`operations[${index}].path is invalid.`);
  if (value.operation !== undefined && value.operation !== 'set' && value.operation !== 'remove') throw new InputError(`operations[${index}].operation is invalid.`);
  if (value.operation !== 'remove' && !Object.prototype.hasOwnProperty.call(value, 'value')) throw new InputError(`operations[${index}].value is required.`);
  if (value.value !== undefined && !isBoundedValue(value.value)) throw new InputError(`operations[${index}].value is too large.`);
  if (value.category !== undefined && !['request-timing', 'retry-timing', 'stream-parser', 'mapping'].includes(String(value.category))) throw new InputError(`operations[${index}].category is invalid.`);
  return { path: value.path as Array<string | number>, operation: value.operation as ProfilePatchOperationV1['operation'], value: value.value, reason: value.reason === undefined ? undefined : requiredText(value.reason, `operations[${index}].reason`, 256), category: value.category as ProfilePatchOperationV1['category'] };
}

function parseProfilePatchDraft(value: unknown): ProfilePatchDraftV1 {
  if (!isRecord(value) || value.format !== 'turnstage-profile-patch-draft' || value.version !== 1 || !Array.isArray(value.changes) || !Array.isArray(value.edits) || !Array.isArray(value.inverseEdits) || !isRecord(value.safety)) throw new InputError('draft must be a valid TurnStage profile patch draft.');
  if (!isBoundedValue(value, 0, new WeakSet<object>(), { count: 0 }, 20_000)) throw new InputError('draft is oversized.');
  for (const field of ['profileDigest', 'sourceDigest', 'updatedProfileDigest']) requiredFingerprint(value[field], field);
  return value as unknown as ProfilePatchDraftV1;
}

function summarizePatchValue(value: { kind: string; value?: unknown; length?: number; keys?: number }): string {
  if (Object.prototype.hasOwnProperty.call(value, 'value')) return JSON.stringify(value.value);
  if (value.length !== undefined) return `${value.kind} (${value.length})`;
  if (value.keys !== undefined) return `${value.kind} (${value.keys} keys)`;
  return value.kind;
}

function parsePage(raw: Record<string, unknown>): { cursor?: string; limit: number } {
  const cursor = raw.cursor === undefined ? undefined : raw.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,6}$/.test(cursor) || Number(cursor) > 100_000)) throw new InputError('cursor must be a bounded decimal page cursor.');
  const limit = raw.limit === undefined ? COPILOT_LIMITS.defaultPageSize : boundedInteger(raw.limit, 1, COPILOT_LIMITS.maxPageSize, 'limit');
  return { cursor, limit };
}

function parseIntegrityLock(value: unknown): IntegrityLock {
  if (!isRecord(value)) throw new InputError('expectedIntegrity must be an object.');
  const keys = new Set(['profileFingerprint', 'suiteFingerprint', 'caseFingerprints']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new InputError('expectedIntegrity contains an unsupported property.');
  const profileFingerprint = requiredFingerprint(value.profileFingerprint, 'profileFingerprint');
  const suiteFingerprint = value.suiteFingerprint === undefined ? undefined : requiredFingerprint(value.suiteFingerprint, 'suiteFingerprint');
  let caseFingerprints: Record<string, string> | undefined;
  if (value.caseFingerprints !== undefined) {
    if (!isRecord(value.caseFingerprints) || Object.keys(value.caseFingerprints).length > 100) throw new InputError('caseFingerprints must contain at most 100 entries.');
    caseFingerprints = {};
    for (const [id, hash] of Object.entries(value.caseFingerprints)) caseFingerprints[requiredId(id, 'case id')] = requiredFingerprint(hash, 'case fingerprint');
  }
  return { profileFingerprint, suiteFingerprint, caseFingerprints };
}

function parseRegressionDraft(value: unknown): RegressionDraft {
  if (!isRecord(value)) throw new InputError('draft must be a JSON object.');
  const keys = new Set(['id', 'name', 'description', 'tags', 'steps', 'assertions', 'adversarial']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new InputError('draft contains an unsupported property.');
  const id = requiredSlug(value.id, 'draft id');
  const name = requiredText(value.name, 'draft name', 256);
  const description = value.description === undefined ? undefined : optionalText(value.description, COPILOT_LIMITS.maxDraftString);
  const tags = value.tags === undefined ? undefined : parseStringArray(value.tags, 20, 'tag', 64);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > COPILOT_LIMITS.maxDraftTurns) throw new InputError('draft.steps must contain 1 to 100 steps.');
  const steps = value.steps.map((rawStep, index) => parseDraftStep(rawStep, index));
  const assertions = value.assertions === undefined ? undefined : parseAssertions(value.assertions);
  const adversarial = value.adversarial === undefined ? undefined : parseAdversarial(value.adversarial);
  return { id, name, description, tags, steps, assertions, adversarial };
}

function parseDraftStep(value: unknown, index: number): RegressionDraft['steps'][number] {
  if (!isRecord(value)) throw new InputError(`draft.steps[${index}] must be an object.`);
  const keys = new Set(['id', 'name', 'input', 'additionalForbid']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new InputError(`draft.steps[${index}] contains an unsupported property.`);
  const step: RegressionDraft['steps'][number] = { id: requiredSlug(value.id, `draft.steps[${index}].id`), input: requiredText(value.input, `draft.steps[${index}].input`, COPILOT_LIMITS.maxDraftString) };
  if (value.name !== undefined) step.name = requiredText(value.name, `draft.steps[${index}].name`, 256);
  if (value.additionalForbid !== undefined) step.additionalForbid = parseForbid(value.additionalForbid, `draft.steps[${index}].additionalForbid`, true);
  return step;
}

function parseAssertions(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > COPILOT_LIMITS.maxDraftAssertions) throw new InputError('draft.assertions must contain at most 100 entries.');
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new InputError(`draft.assertions[${index}] must be an object.`);
    const keys = new Set(['id', 'path', 'operator', 'value', 'message']);
    if (Object.keys(raw).some((key) => !keys.has(key))) throw new InputError(`draft.assertions[${index}] contains an unsupported property.`);
    const operator = raw.operator;
    const operators = new Set(['equals', 'notEquals', 'exists', 'notExists', 'contains', 'regex', 'oneOf', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'sequenceEquals', 'sequenceContains']);
    if (typeof operator !== 'string' || !operators.has(operator)) throw new InputError(`draft.assertions[${index}].operator is unsupported.`);
    const path = requiredText(raw.path, `draft.assertions[${index}].path`, 256);
    if (!isValidAssertionPath(path)) throw new InputError(`draft.assertions[${index}].path is not a supported data path.`);
    if (!['exists', 'notExists'].includes(operator) && !Object.prototype.hasOwnProperty.call(raw, 'value')) throw new InputError(`draft.assertions[${index}] requires value for ${operator}.`);
    if (raw.value !== undefined && !isBoundedValue(raw.value)) throw new InputError(`draft.assertions[${index}].value is too large.`);
    if (operator === 'regex' && !isSafeAssertionRegex(raw.value)) throw new InputError(`draft.assertions[${index}].value is not a safe regular expression.`);
    const assertion: ScenarioAssertionDefinition = { id: raw.id === undefined ? undefined : requiredSlug(raw.id, `draft.assertions[${index}].id`), path, operator: operator as ScenarioAssertionDefinition['operator'], value: raw.value, message: raw.message === undefined ? undefined : requiredText(raw.message, `draft.assertions[${index}].message`, 512) };
    return assertion;
  });
}

function parseAdversarial(value: unknown): RegressionDraft['adversarial'] {
  if (!isRecord(value)) throw new InputError('draft.adversarial must be an object.');
  const keys = new Set(['mode', 'maxTurns', 'timeoutMs', 'stopOnAttackSucceeded', 'repetitions', 'failFast', 'forbid']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new InputError('draft.adversarial contains an unsupported property.');
  const mode = value.mode === undefined ? undefined : value.mode;
  if (mode !== undefined && mode !== 'singleTurn' && mode !== 'multiTurn') throw new InputError('draft.adversarial.mode is unsupported.');
  const maxTurns = value.maxTurns === undefined ? undefined : boundedInteger(value.maxTurns, 1, MAX_ADVERSARIAL_TURNS_PER_CASE, 'maxTurns');
  const timeoutMs = value.timeoutMs === undefined ? undefined : boundedInteger(value.timeoutMs, 1_000, 300_000, 'timeoutMs');
  const repetitions = value.repetitions === undefined ? undefined : boundedInteger(value.repetitions, 1, COPILOT_LIMITS.maxRepetitions, 'repetitions');
  const stopOnAttackSucceeded = optionalBoolean(value.stopOnAttackSucceeded);
  const failFast = optionalBoolean(value.failFast);
  const forbid = parseForbid(value.forbid, 'draft.adversarial.forbid', false);
  return { mode, maxTurns, timeoutMs, stopOnAttackSucceeded, repetitions, failFast, forbid };
}

function parseForbid(value: unknown, path: string, allowEmpty: boolean): AdversarialForbidDefinition {
  if (!isRecord(value)) throw new InputError(`${path} must be an object.`);
  const keys = new Set(['content', 'urls', 'ctas', 'tools', 'events']);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new InputError(`${path} contains an unsupported property.`);
  const result: AdversarialForbidDefinition = {};
  if (value.urls !== undefined) result.urls = requiredBoolean(value.urls, `${path}.urls`);
  if (value.ctas !== undefined) result.ctas = requiredBoolean(value.ctas, `${path}.ctas`);
  if (value.tools !== undefined) result.tools = requiredBoolean(value.tools, `${path}.tools`);
  if (value.events !== undefined) result.events = parseStringArray(value.events, MAX_ADVERSARIAL_RULES, 'event', 256);
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || value.content.length > MAX_ADVERSARIAL_RULES) throw new InputError(`${path}.content must contain at most ${MAX_ADVERSARIAL_RULES} rules.`);
    result.content = value.content.map((rawRule, index) => {
      if (typeof rawRule === 'string') return requiredText(rawRule, `${path}.content[${index}]`, 256);
      if (!isRecord(rawRule)) throw new InputError(`${path}.content[${index}] must be a string or object.`);
      const ruleKeys = new Set(['id', 'match', 'value', 'caseSensitive']);
      if (Object.keys(rawRule).some((key) => !ruleKeys.has(key))) throw new InputError(`${path}.content[${index}] contains an unsupported property.`);
      const match = rawRule.match;
      if (match !== 'contains' && match !== 'regex') throw new InputError(`${path}.content[${index}].match is unsupported.`);
      const rule: AdversarialContentRule = { id: rawRule.id === undefined ? undefined : requiredSlug(rawRule.id, `${path}.content[${index}].id`), match, value: requiredText(rawRule.value, `${path}.content[${index}].value`, 256), caseSensitive: rawRule.caseSensitive === undefined ? undefined : requiredBoolean(rawRule.caseSensitive, `${path}.content[${index}].caseSensitive`) };
      if (match === 'regex' && !isSafeAssertionRegex(rule.value)) throw new InputError(`${path}.content[${index}].value is not a safe regular expression.`);
      return rule;
    });
  }
  if (!allowEmpty && !result.urls && !result.ctas && !result.tools && !result.events?.length && !result.content?.length) throw new InputError(`${path} must contain at least one prohibited effect.`);
  return result;
}

function toLanguageModelResult(response: CopilotToolResponse<unknown>): vscode.LanguageModelToolResult {
  const text = JSON.stringify(response);
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text.length <= COPILOT_LIMITS.maxResultCharacters ? text : JSON.stringify(failure(response.tool, ERROR_CODES.outputLimit, 'Tool output exceeded the disclosure limit.', false)))]);
}

function ensureBoundedResponse(response: CopilotToolResponse<unknown>): CopilotToolResponse<unknown> {
  const text = JSON.stringify(response);
  return text.length <= COPILOT_LIMITS.maxResultCharacters ? response : failure(response.tool, ERROR_CODES.outputLimit, 'Tool output exceeded the disclosure limit.', false);
}

function preflightMessage(preflight: RunPreflight): string {
  const environment = preflight.selectedEnvironment ? ` Target/environment: ${preflight.selectedEnvironment}.` : '';
  const credentialText = preflight.credentialsResolved === 'yes' ? ' Configured credentials will be resolved.' : preflight.credentialsResolved === 'no' ? ' No credentials will be resolved.' : ' Credential resolution is runtime-dependent.';
  const warnings = preflight.warnings?.length ? ` Warnings: ${preflight.warnings.slice(0, 3).join(' ')}` : '';
  const attempts = preflight.plannedAttempts === undefined ? '' : `, ${preflight.plannedAttempts} attempt(s)`;
  return `Run ${preflight.selectedCount} case(s), ${preflight.plannedTurns} planned turn(s), up to ${preflight.maxRequests} request(s)${attempts}, timeout ${preflight.timeoutMs} ms, ${preflight.repetitions} repetition(s).${environment}${credentialText}${warnings}`;
}

function page<T>(items: readonly T[], cursor: string | undefined, requestedLimit: number | undefined, reportedTotal?: unknown): { items: T[]; nextCursor?: string; total: number; limit: number; offset: number } {
  const offset = cursor && /^\d{1,6}$/.test(cursor) ? Math.min(Number(cursor), items.length) : 0;
  const limit = requestedLimit === undefined ? COPILOT_LIMITS.defaultPageSize : Math.min(requestedLimit, COPILOT_LIMITS.maxPageSize);
  const pageItems = items.slice(offset, offset + limit);
  return { items: pageItems, nextCursor: offset + pageItems.length < items.length ? String(offset + pageItems.length) : undefined, total: safeCount(reportedTotal, items.length), limit, offset };
}

function normalizePreflight(value: unknown): RunPreflight {
  if (!isRecord(value)) throw new CopilotRuntimeError(ERROR_CODES.runtimeFailed, 'TurnStage returned an invalid preflight.');
  return {
    requiresNetwork: value.requiresNetwork === true,
    workspaceTrusted: value.workspaceTrusted === true,
    selectedCount: safeCount(value.selectedCount, 0),
    plannedAttempts: value.plannedAttempts === undefined ? undefined : safeCount(value.plannedAttempts, 0),
    plannedTurns: safeCount(value.plannedTurns, 0),
    maxRequests: safeCount(value.maxRequests, 0),
    timeoutMs: boundedDuration(value.timeoutMs),
    repetitions: boundedIntegerOutput(value.repetitions, 1, COPILOT_LIMITS.maxRepetitions, 1),
    credentialsResolved: value.credentialsResolved === 'yes' || value.credentialsResolved === 'no' ? value.credentialsResolved : 'unknown',
    selectedEnvironment: value.selectedEnvironment === undefined ? undefined : safeText(value.selectedEnvironment),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string').slice(0, 10).map((item) => safeText(item)) : undefined,
  };
}

function normalizeRunCase(value: Record<string, unknown>): Record<string, unknown> {
  return { id: safeId(value.id, 'caseId'), profileId: value.profileId === undefined ? undefined : safeId(value.profileId, 'profileId'), suiteId: value.suiteId === undefined ? undefined : safeId(value.suiteId, 'suiteId'), label: safeText(value.label), outcome: safeOutcome(value.outcome), stability: value.stability === undefined ? undefined : value.stability, counts: value.counts && isRecord(value.counts) ? Object.fromEntries(Object.entries(value.counts).slice(0, 4).map(([key, count]) => [key, boundedNumber(count)])) : undefined, evidenceId: value.evidenceId === undefined ? undefined : safeId(value.evidenceId, 'evidenceId'), failureId: value.failureId === undefined ? undefined : safeId(value.failureId, 'failureId') };
}

function normalizeIntegrity(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return {
    status: typeof value.status === 'string' && ['not-locked', 'matched', 'changed', 'missing-observation'].includes(value.status) ? value.status : 'missing-observation',
    matches: value.matches === true,
    expected: value.expected && isRecord(value.expected) ? redactForDisclosure(value.expected).value : undefined,
    observed: value.observed && isRecord(value.observed) ? redactForDisclosure(value.observed).value : undefined,
    changedFields: Array.isArray(value.changedFields) ? value.changedFields.filter((field): field is string => typeof field === 'string').slice(0, 100).map((field) => safeText(field)) : undefined,
  };
}

function sanitizeDraft(draft: RegressionDraft): RegressionDraft {
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 8) return '[omitted: depth limit]';
    if (typeof value === 'string') return safeText(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
    if (isRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) result[key] = /(?:authorization|cookie|password|secret|token|api[-_]?key|credential)/i.test(key) ? '[redacted]' : sanitize(child, depth + 1);
      return result;
    }
    return '[omitted]';
  };
  return sanitize(draft) as RegressionDraft;
}

function isTestDescriptor(value: unknown): value is Record<string, unknown> { return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string'; }
function isRunCase(value: unknown): value is Record<string, unknown> { return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.outcome === 'string'; }
function isFailureRecord(value: unknown): value is { id: string; caseId: string; profileId?: string; suiteId?: string; outcome: string; label?: string; evidence?: import('./types').EvidenceSource } { return isRecord(value) && typeof value.id === 'string' && typeof value.caseId === 'string' && (value.profileId === undefined || typeof value.profileId === 'string') && (value.suiteId === undefined || typeof value.suiteId === 'string') && typeof value.outcome === 'string'; }
function isValidationIssue(value: unknown): value is { code: string; path: string; message: string; severity: 'error' | 'warning' } { return isRecord(value) && typeof value.code === 'string' && typeof value.path === 'string' && typeof value.message === 'string' && (value.severity === 'error' || value.severity === 'warning'); }

function safeOutcome(value: unknown): SafeOutcome { return typeof value === 'string' && ['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError', 'passed', 'failed', 'error', 'cancelled'].includes(value) ? value as SafeOutcome : 'indeterminate'; }
function safeId(value: unknown, field: string): string { if (typeof value !== 'string' || !value.length || value.length > COPILOT_LIMITS.maxInputString) throw new CopilotRuntimeError(ERROR_CODES.runtimeFailed, `TurnStage returned an invalid ${field}.`); return value; }
function safeText(value: unknown): string { return typeof value === 'string' ? value.slice(0, COPILOT_LIMITS.maxDraftString) : String(value).slice(0, COPILOT_LIMITS.maxDraftString); }
function safeCount(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : fallback; }
function boundedNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= COPILOT_LIMITS.maxTimeoutMs ? Math.floor(value) : 0; }
function boundedDuration(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= COPILOT_LIMITS.maxTimeoutMs ? Math.floor(value) : 0; }
function boundedIntegerOutput(value: unknown, min: number, max: number, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback; }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function optionalBoolean(value: unknown): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') throw new InputError('Expected a boolean.'); return value; }
function requiredBoolean(value: unknown, field: string): boolean { if (typeof value !== 'boolean') throw new InputError(`${field} must be boolean.`); return value; }
function optionalText(value: unknown, max: number): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || value.length > max) throw new InputError(`Text input must be at most ${max} characters.`); return value; }
function requiredText(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`${field} must be a non-empty string of at most ${max} characters.`); return value; }
function optionalId(value: unknown): string | undefined { if (value === undefined) return undefined; return requiredId(value, 'id'); }
function requiredId(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim() || value.length > COPILOT_LIMITS.maxInputString) throw new InputError(`${field} must be a non-empty bounded string.`); return value; }
function requiredSlug(value: unknown, field: string): string { const id = requiredId(value, field); if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new InputError(`${field} must use lowercase letters, numbers, and hyphens.`); return id; }
function requiredFingerprint(value: unknown, field: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new InputError(`${field} must be a SHA-256 fingerprint.`); return value; }
function boundedInteger(value: unknown, min: number, max: number, field: string): number { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new InputError(`${field} must be an integer from ${min} to ${max}.`); return Number(value); }
function parseStringArray(value: unknown, maxItems: number, field: string, maxLength: number = COPILOT_LIMITS.maxInputString): string[] { if (!Array.isArray(value) || value.length > maxItems) throw new InputError(`${field} must contain at most ${maxItems} values.`); return value.map((item, index) => requiredText(item, `${field}[${index}]`, maxLength)); }
function isBoundedValue(value: unknown, depth = 0, ancestors = new WeakSet<object>(), nodes = { count: 0 }, maxNodes = 2_000, maxDepth = 8): boolean {
  if (++nodes.count > maxNodes || depth > maxDepth) return false;
  if (value === undefined || value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= COPILOT_LIMITS.maxDraftString;
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.length <= 10_000 && value.every((child) => isBoundedValue(child, depth + 1, ancestors, nodes, maxNodes, maxDepth))
    : Object.entries(value as Record<string, unknown>).length <= 1_000 && Object.entries(value as Record<string, unknown>).every(([key, child]) => key.length <= 256 && isBoundedValue(child, depth + 1, ancestors, nodes, maxNodes, maxDepth));
  ancestors.delete(value);
  return valid;
}
function isCancellation(error: unknown): boolean { return error instanceof Error && /cancel/i.test(error.message); }

class InputError extends Error {}

function success<T>(tool: CopilotToolName, data: T): CopilotToolSuccess<T> {
  return { ok: true, tool, data, bounded: true };
}

function failure(tool: CopilotToolName, code: string, message: string, retryable: boolean): CopilotToolFailure {
  const stableCode = (Object.values(ERROR_CODES) as readonly string[]).includes(code) ? code : ERROR_CODES.runtimeFailed;
  return { ok: false, tool, bounded: true, error: { code: stableCode, message: message.slice(0, 512), retryable } };
}
