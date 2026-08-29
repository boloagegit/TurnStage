import type {
  DiagnosticOutcome,
  EvidenceLevel,
  RootCauseCategory,
  TimingStage,
} from '../diagnostics';
import type { ProfilePatchCategory, ProfilePatchDraftV1, ProfilePatchOperation } from '../remediation';

/**
 * A deliberately metadata-only view of Copilot artifacts.  This is the
 * boundary consumed by evidence export; it is not a transcript store.
 */
export const COPILOT_ARTIFACT_SNAPSHOT_VERSION = 'CopilotArtifactSnapshotV1' as const;

export const COPILOT_ARTIFACT_LIMITS = {
  maxDiagnoses: 100,
  maxProfilePatches: 100,
  maxQualityReviews: 100,
  maxFindings: 12,
  maxEvidence: 64,
  maxErrors: 32,
  maxChanges: 64,
  maxActions: 8,
  maxTextCharacters: 512,
  maxLabelCharacters: 160,
  maxIdCharacters: 128,
} as const;

export type ArtifactRecordStatus = 'drafted' | 'applied' | 'rolledBack' | 'rejected' | 'failed';

export interface ArtifactTimingStageV1 {
  stage: TimingStage;
  observed: boolean;
  elapsedMs?: number;
}

export interface ArtifactTimingV1 {
  stages: readonly ArtifactTimingStageV1[];
  missingStages: readonly TimingStage[];
  orderingValid: boolean;
  anomalies: readonly string[];
}

export interface ArtifactMetricsV1 {
  headersLatencyMs?: number;
  firstChunkLatencyMs?: number;
  firstRawEventLatencyMs?: number;
  firstNormalizedContentLatencyMs?: number;
  firstVisibleTextLatencyMs?: number;
  terminalLatencyMs?: number;
  streamDurationMs?: number;
  eventCount?: number;
  byteCount?: number;
  parseErrorCount?: number;
  mappingErrorCount?: number;
  unmatchedEventCount?: number;
  reconnectCount?: number;
  droppedEventCount?: number;
}

export interface ArtifactTransportV1 {
  protocol?: 'http' | 'sse' | 'websocket' | 'json' | 'unknown';
  status?: number;
  state?: 'pending' | 'streaming' | 'completed' | 'failed' | 'aborted' | 'unknown';
  terminalState?: 'completed' | 'failed' | 'aborted' | 'timeout' | 'pending' | 'unknown';
  openingState?: 'pending' | 'completed' | 'failed' | 'aborted' | 'unknown';
  proxyBuffered?: boolean;
  idleTimeout?: boolean;
  timeout?: boolean;
  retryCount?: number;
  variantId?: string;
}

export interface ArtifactEvidenceRefV1 {
  kind: 'chat' | 'network' | 'event' | 'profile' | 'metric';
  /** A safe local evidence key only; URLs and arbitrary paths are omitted. */
  id?: string;
  stage?: TimingStage;
}

export interface ArtifactFindingV1 {
  category: RootCauseCategory;
  evidenceLevel: EvidenceLevel;
  label: string;
  reason: string;
  evidenceCount: number;
}

export interface ArtifactErrorV1 {
  category: RootCauseCategory | 'unknown';
  code?: string;
  status?: number;
  retrySafe?: boolean;
}

export interface ArtifactAssertionV1 {
  total: number;
  passed: number;
  failed: number;
}

export interface ArtifactRepetitionV1 {
  requestedAttempts: number;
  completedAttempts: number;
  skippedAttempts: number;
  sampleComplete: boolean;
  counts: Readonly<Record<DiagnosticOutcome, number>>;
  status: 'stable' | 'flaky' | 'inconclusive';
  dominantOutcome?: DiagnosticOutcome;
  evidenceLevel: EvidenceLevel;
}

export interface ArtifactComparisonDifferenceV1 {
  metric: string;
  baselineMs?: number;
  candidateMs?: number;
  deltaMs?: number;
  direction: 'improved' | 'regressed' | 'unchanged' | 'unknown';
  evidenceLevel: EvidenceLevel;
}

export interface ArtifactComparisonV1 {
  outcomeChanged: boolean;
  baselineOutcome?: DiagnosticOutcome;
  candidateOutcome?: DiagnosticOutcome;
  variantChanged: boolean;
  differences: readonly ArtifactComparisonDifferenceV1[];
  evidenceLevel: EvidenceLevel;
  summary: string;
}

export interface DiagnosisArtifactV1 {
  artifactId: string;
  kind: 'diagnosis';
  runId: string;
  caseId?: string;
  profileId?: string;
  outcome: DiagnosticOutcome;
  status: 'complete' | 'partial' | 'insufficientEvidence';
  evidenceLevel: EvidenceLevel;
  summary: string;
  timing: ArtifactTimingV1;
  metrics: ArtifactMetricsV1;
  transport: ArtifactTransportV1;
  errors: readonly ArtifactErrorV1[];
  evidence: readonly ArtifactEvidenceRefV1[];
  configIssueCodes: readonly string[];
  findings: readonly ArtifactFindingV1[];
  nextActionIds: readonly string[];
  assertions?: ArtifactAssertionV1;
  repetition?: ArtifactRepetitionV1;
  comparison?: ArtifactComparisonV1;
  recordedAt?: number;
}

export interface PatchValueSummaryArtifactV1 {
  kind: 'missing' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
  /** Strings are intentionally never copied from a profile patch. */
  value?: boolean | number | null;
  length?: number;
  keys?: number;
  digest?: string;
}

export interface ProfilePatchChangeArtifactV1 {
  path: readonly (string | number)[];
  pathLabel: string;
  operation: ProfilePatchOperation;
  category: ProfilePatchCategory;
  before: PatchValueSummaryArtifactV1;
  after: PatchValueSummaryArtifactV1;
  reason: string;
}

export interface ProfilePatchAuditArtifactV1 {
  artifactId: string;
  kind: 'profilePatch';
  profileId: string;
  /** A trusted originating run when the patch was drafted from a run. */
  runId?: string;
  status: ArtifactRecordStatus;
  format: 'turnstage-profile-patch-draft';
  version: 1;
  profileDigest: string;
  sourceDigest: string;
  updatedProfileDigest: string;
  sourceLength: number;
  updatedSourceLength: number;
  summary: string;
  changes: readonly ProfilePatchChangeArtifactV1[];
  /** Number of edits, without retaining edit ranges or edit contents. */
  editCount: number;
  /** Number of inverse edits, without retaining their contents. */
  inverseEditCount: number;
  requiresConfirmation: true;
  contentRedacted: true;
  recordedAt?: number;
}

export interface QualityFindingArtifactV1 {
  rubricId: string;
  criterionId: string;
  rating: 'meets' | 'partiallyMeets' | 'doesNotMeet' | 'notEnoughEvidence';
  evidenceAttemptIds: readonly string[];
}

export interface QualityDisclosureArtifactV1 {
  manualSelection: true;
  responseContent: true;
  prompts: false;
  rawPayloads: false;
  headers: false;
  fullUrls: false;
  secrets: false;
  disclosedCharacters: number;
}

export interface QualityReviewArtifactV1 {
  artifactId: string;
  kind: 'qualityReview';
  profileId: string;
  /** A trusted originating run when all selected evidence maps to one run. */
  runId?: string;
  advisoryOnly: true;
  grantId: string;
  evidenceIds: readonly string[];
  attemptIds: readonly string[];
  createdAt: number;
  modelLabel?: string;
  rubricDigest: string;
  disclosureDigest: string;
  evidenceCompleteness: 'complete' | 'partial';
  summary: string;
  findings: readonly QualityFindingArtifactV1[];
  disclosure: QualityDisclosureArtifactV1;
}

export interface CopilotArtifactSnapshotV1 {
  version: typeof COPILOT_ARTIFACT_SNAPSHOT_VERSION;
  sanitized: true;
  diagnoses: readonly DiagnosisArtifactV1[];
  profilePatches: readonly ProfilePatchAuditArtifactV1[];
  qualityReviews: readonly QualityReviewArtifactV1[];
}

export interface ArtifactRecordOptions {
  /** Fixed time is useful for deterministic tests and reproducible evidence. */
  recordedAt?: number;
  /** Known values are scrubbed transiently and never retained. */
  secretValues?: readonly unknown[];
}

export interface ProfilePatchAuditInput extends ArtifactRecordOptions {
  draft: ProfilePatchDraftV1;
  status: ArtifactRecordStatus;
  profileId: string;
  /** A trusted originating run when the patch was drafted from a run. */
  runId?: string;
}

export interface QualityReviewRecordOptions extends ArtifactRecordOptions {
  profileId: string;
  runId?: string;
  /** Optional disclosed text is used transiently to scrub generated summaries. */
  disclosedResponses?: readonly unknown[];
}

export interface CopilotArtifactRepository {
  recordDiagnosis(input: unknown, options?: ArtifactRecordOptions): DiagnosisArtifactV1;
  recordProfilePatch(input: ProfilePatchAuditInput): ProfilePatchAuditArtifactV1;
  recordQualityReview(input: unknown, options?: QualityReviewRecordOptions): QualityReviewArtifactV1;
  snapshot(): CopilotArtifactSnapshotV1;
  clear(): void;
}
