import type * as vscode from 'vscode';
import type { AdversarialOutcome, AdversarialStability } from '../../shared/types';
import { MAX_ADVERSARIAL_REPETITIONS } from '../testing/adversarialSuite';

/** The names are part of the public Copilot contract. Keep them stable. */
export const COPILOT_TOOL_NAMES = {
  findTests: 'turnstage_find_tests',
  runTests: 'turnstage_run_tests',
  inspectFailure: 'turnstage_inspect_failure',
  draftRegression: 'turnstage_draft_regression',
  validateTests: 'turnstage_validate_tests',
} as const;

export type CopilotToolName = typeof COPILOT_TOOL_NAMES[keyof typeof COPILOT_TOOL_NAMES];
export type CopilotCancellationToken = vscode.CancellationToken;

export const COPILOT_LIMITS = {
  maxInputString: 512,
  maxQueryLength: 256,
  maxSelectors: 100,
  maxPageSize: 100,
  defaultPageSize: 25,
  maxOutputItems: 100,
  maxResultCharacters: 24_000,
  maxValidationIssues: 100,
  maxDraftTurns: 100,
  maxDraftAssertions: 100,
  maxDraftString: 4_096,
  /** Keep the Copilot input cap identical to the adversarial suite validator. */
  maxRepetitions: MAX_ADVERSARIAL_REPETITIONS,
  maxTimeoutMs: 900_000,
} as const;

export interface PageInput {
  /** An opaque decimal cursor. Cursors are never interpreted by the model. */
  cursor?: string;
  limit?: number;
}

export interface FindTestsInput extends PageInput {
  query?: string;
  profileId?: string;
  suiteId?: string;
  caseId?: string;
  tag?: string;
  changedFiles?: string[];
  includeUnbound?: boolean;
  includeSteps?: boolean;
}

export interface IntegrityLock {
  profileFingerprint: string;
  suiteFingerprint?: string;
  caseFingerprints?: Record<string, string>;
}

export interface RunTestsInput extends PageInput {
  selectors?: string[];
  repetitions?: number;
  failFast?: boolean;
  expectedIntegrity?: IntegrityLock;
}

export interface InspectFailureInput extends PageInput {
  runId: string;
  failureId?: string;
  includeEvents?: boolean;
}

export interface ValidateTestsInput extends PageInput {
  profileId?: string;
  suiteId?: string;
  caseId?: string;
  expectedIntegrity?: IntegrityLock;
}

/**
 * A draft accepted by the Copilot boundary. It intentionally models only the
 * declarative subset that can be written as a TurnStage ScenarioDefinition.
 * It is never written to disk by the Copilot tool.
 */
export interface RegressionDraft {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  steps: RegressionDraftStep[];
  assertions?: unknown[];
  adversarial?: RegressionDraftAdversarial;
}

export interface RegressionDraftStep {
  id: string;
  name?: string;
  input: string;
  additionalForbid?: unknown;
}

export interface RegressionDraftAdversarial {
  mode?: 'singleTurn' | 'multiTurn';
  maxTurns?: number;
  timeoutMs?: number;
  stopOnAttackSucceeded?: boolean;
  repetitions?: number;
  failFast?: boolean;
  forbid: unknown;
}

export interface DraftRegressionInput {
  runId: string;
  failureId: string;
  draft: unknown;
  sourceEvidenceId?: string;
}

export type SafeOutcome = AdversarialOutcome | 'passed' | 'failed' | 'error' | 'cancelled';

export interface TestDescriptor {
  id: string;
  label: string;
  kind: 'profile' | 'suite' | 'case' | 'step';
  profileId?: string;
  suiteId?: string;
  caseId?: string;
  tags?: string[];
  enabled?: boolean;
  plannedTurns?: number;
  repetitions?: number;
  sourceBinding?: import('../../shared/types').ScenarioSourceBinding;
  selectionReason?: string;
}

export interface FindTestsRuntimeResult {
  tests: readonly TestDescriptor[];
  total?: number;
}

export interface RunPreflight {
  requiresNetwork: boolean;
  workspaceTrusted: boolean;
  selectedCount: number;
  plannedTurns: number;
  maxRequests: number;
  timeoutMs: number;
  repetitions: number;
  credentialsResolved: 'yes' | 'no' | 'unknown';
  selectedEnvironment?: string;
  warnings?: string[];
}

export interface RunCaseResult {
  id: string;
  label: string;
  outcome: SafeOutcome;
  stability?: AdversarialStability;
  counts?: Partial<Record<AdversarialOutcome, number>>;
  evidenceId?: string;
  failureId?: string;
}

export interface RunTestsRuntimeResult {
  runId: string;
  preflight: RunPreflight;
  outcome: SafeOutcome;
  cases: readonly RunCaseResult[];
  totalCases?: number;
  completedCases?: number;
  sampleComplete?: boolean;
  integrity?: IntegrityComparison;
}

export interface EvidenceReference {
  kind: 'chat' | 'network' | 'event';
  id: string;
}

export interface EvidenceSource {
  failedContract?: {
    id: string;
    label: string;
    outcome: SafeOutcome;
    expected?: unknown;
    actual?: unknown;
  };
  turn?: { id?: string; index?: number };
  transport?: { protocol?: string; status?: number; terminalState?: string; requestId?: string };
  evidenceRefs?: readonly EvidenceReference[];
  completeness?: 'complete' | 'partial' | 'missing';
  profile?: unknown;
  suite?: unknown;
  expectedIntegrity?: IntegrityLock;
  observedIntegrity?: IntegrityLock;
}

export interface FailureRecord {
  id: string;
  caseId: string;
  caseLabel?: string;
  outcome: SafeOutcome;
  label?: string;
  turnId?: string;
  turnIndex?: number;
  ruleId?: string;
  evidenceId?: string;
  evidence?: EvidenceSource;
}

export interface InspectFailureRuntimeResult {
  runId: string;
  failures: readonly FailureRecord[];
  total?: number;
}

export interface DraftRegressionRuntimeResult {
  runId: string;
  failureId: string;
  draft: RegressionDraft;
  sourceEvidenceId?: string;
  integrity?: IntegrityComparison;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface IntegrityComparison {
  status: 'not-locked' | 'matched' | 'changed' | 'missing-observation';
  matches: boolean;
  expected?: IntegrityLock;
  observed?: IntegrityLock;
  changedFields?: string[];
}

export interface ValidateTestsRuntimeResult {
  valid: boolean;
  issues: readonly ValidationIssue[];
  total?: number;
  integrity?: IntegrityComparison;
}

/**
 * The only execution dependency of the Copilot facade. Implementations are
 * expected to delegate to the shared TurnStage execution service; the tools
 * themselves must never instantiate a runner or a SessionController.
 */
export interface CopilotRuntime {
  isWorkspaceTrusted(): boolean;
  previewRun(input: RunTestsInput, token: CopilotCancellationToken): Promise<RunPreflight>;
  findTests(input: FindTestsInput, token: CopilotCancellationToken): Promise<FindTestsRuntimeResult>;
  runTests(input: RunTestsInput, token: CopilotCancellationToken): Promise<RunTestsRuntimeResult>;
  inspectFailure(input: InspectFailureInput, token: CopilotCancellationToken): Promise<InspectFailureRuntimeResult>;
  draftRegression(input: DraftRegressionInput & { draft: RegressionDraft }, token: CopilotCancellationToken): Promise<DraftRegressionRuntimeResult>;
  validateTests(input: ValidateTestsInput, token: CopilotCancellationToken): Promise<ValidateTestsRuntimeResult>;
}

export class CopilotRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CopilotRuntimeError';
  }
}

export interface CopilotToolSuccess<T> {
  ok: true;
  tool: CopilotToolName;
  data: T;
  bounded: true;
}

export interface CopilotToolFailure {
  ok: false;
  tool: CopilotToolName;
  bounded: true;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type CopilotToolResponse<T> = CopilotToolSuccess<T> | CopilotToolFailure;
