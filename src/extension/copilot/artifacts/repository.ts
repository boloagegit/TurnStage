import {
  DIAGNOSTIC_OUTCOMES,
  ROOT_CAUSE_CATEGORIES,
  TIMING_STAGES,
  type DiagnosticOutcome,
  type EvidenceLevel,
  type RootCauseCategory,
  type TimingStage,
} from '../diagnostics';
import {
  PROFILE_PATCH_DRAFT_FORMAT,
  PROFILE_PATCH_DRAFT_VERSION,
  PROFILE_PATCH_LIMITS,
  type ProfilePatchCategory,
  type ProfilePatchOperation,
} from '../remediation';
import { sha256, stableStringify } from '../../testing/provenance';
import {
  COPILOT_ARTIFACT_LIMITS,
  COPILOT_ARTIFACT_SNAPSHOT_VERSION,
  type ArtifactAssertionV1,
  type ArtifactComparisonDifferenceV1,
  type ArtifactComparisonV1,
  type ArtifactErrorV1,
  type ArtifactEvidenceRefV1,
  type ArtifactFindingV1,
  type ArtifactMetricsV1,
  type ArtifactRecordOptions,
  type ArtifactRecordStatus,
  type ArtifactRepetitionV1,
  type ArtifactTimingStageV1,
  type ArtifactTimingV1,
  type ArtifactTransportV1,
  type CopilotArtifactRepository,
  type CopilotArtifactSnapshotV1,
  type DiagnosisArtifactV1,
  type ProfilePatchAuditArtifactV1,
  type ProfilePatchAuditInput,
  type ProfilePatchChangeArtifactV1,
  type PatchValueSummaryArtifactV1,
  type QualityDisclosureArtifactV1,
  type QualityFindingArtifactV1,
  type QualityReviewArtifactV1,
  type QualityReviewRecordOptions,
} from './contracts';

const MAX_TIMESTAMP = 8_640_000_000_000;
const MAX_METRIC = 86_400_000;
const MAX_COUNTER = 1_000_000_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const SAFE_PATH_PART = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/giu;
const WWW_URL_PATTERN = /\bwww\.[^\s"'<>]+/giu;
const SECRET_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/giu;
const KEY_VALUE_SECRET_PATTERN = /\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/giu;
const URL_DETECT_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/iu;
const WWW_URL_DETECT_PATTERN = /\bwww\.[^\s"'<>]+/iu;
const SECRET_DETECT_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/iu;
const KEY_VALUE_SECRET_DETECT_PATTERN = /\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/iu;

const OUTCOME_SET = new Set<DiagnosticOutcome>(DIAGNOSTIC_OUTCOMES);
const ROOT_CAUSE_SET = new Set<RootCauseCategory>(ROOT_CAUSE_CATEGORIES);
const EVIDENCE_LEVEL_SET = new Set<EvidenceLevel>(['strong', 'moderate', 'limited']);
const TIMING_STAGE_SET = new Set<TimingStage>(TIMING_STAGES);
const PROFILE_PATCH_CATEGORY_SET = new Set<ProfilePatchCategory>(['request-timing', 'retry-timing', 'stream-parser', 'mapping']);
const PATCH_OPERATION_SET = new Set<ProfilePatchOperation>(['set', 'remove']);
const PATCH_STATUS_SET = new Set<ArtifactRecordStatus>(['drafted', 'applied', 'rolledBack', 'rejected', 'failed']);
const DIAGNOSIS_STATUS_SET = new Set<DiagnosisArtifactV1['status']>(['complete', 'partial', 'insufficientEvidence']);
const PROTOCOL_SET = new Set<NonNullable<ArtifactTransportV1['protocol']>>(['http', 'sse', 'websocket', 'json', 'unknown']);
const TRANSPORT_STATE_SET = new Set<NonNullable<ArtifactTransportV1['state']>>(['pending', 'streaming', 'completed', 'failed', 'aborted', 'unknown']);
const TERMINAL_STATE_SET = new Set<NonNullable<ArtifactTransportV1['terminalState']>>(['completed', 'failed', 'aborted', 'timeout', 'pending', 'unknown']);
const OPENING_STATE_SET = new Set<NonNullable<ArtifactTransportV1['openingState']>>(['pending', 'completed', 'failed', 'aborted', 'unknown']);
const REPETITION_STATUS_SET = new Set<ArtifactRepetitionV1['status']>(['stable', 'flaky', 'inconclusive']);
const COMPARISON_DIRECTION_SET = new Set<ArtifactComparisonDifferenceV1['direction']>(['improved', 'regressed', 'unchanged', 'unknown']);
const VALUE_KIND_SET = new Set<PatchValueSummaryArtifactV1['kind']>(['missing', 'null', 'boolean', 'number', 'string', 'array', 'object']);
const QUALITY_RATING_SET = new Set<QualityFindingArtifactV1['rating']>(['meets', 'partiallyMeets', 'doesNotMeet', 'notEnoughEvidence']);

export class CopilotArtifactError extends Error {
  constructor(
    public readonly code: 'INVALID_DIAGNOSIS' | 'INVALID_PROFILE_PATCH' | 'INVALID_QUALITY_REVIEW' | 'OVERSIZED',
    message: string,
  ) {
    super(message);
    this.name = 'CopilotArtifactError';
  }
}

/**
 * In-memory repository for the current workspace session.  It stores only
 * projections made by this module, never the source objects supplied by the
 * caller.  A later evidence writer can consume `snapshot()` without gaining
 * access to transcripts, request payloads, headers, URLs, or profile edits.
 */
export class InMemoryCopilotArtifactRepository implements CopilotArtifactRepository {
  private readonly diagnoses: DiagnosisArtifactV1[] = [];
  private readonly profilePatches: ProfilePatchAuditArtifactV1[] = [];
  private readonly qualityReviews: QualityReviewArtifactV1[] = [];

  recordDiagnosis(input: unknown, options: ArtifactRecordOptions = {}): DiagnosisArtifactV1 {
    const artifact = projectDiagnosis(input, options);
    this.pushBounded(this.diagnoses, artifact, COPILOT_ARTIFACT_LIMITS.maxDiagnoses);
    return cloneAndFreeze(artifact);
  }

  recordProfilePatch(input: ProfilePatchAuditInput): ProfilePatchAuditArtifactV1 {
    const artifact = projectProfilePatch(input);
    this.pushBounded(this.profilePatches, artifact, COPILOT_ARTIFACT_LIMITS.maxProfilePatches);
    return cloneAndFreeze(artifact);
  }

  recordQualityReview(input: unknown, options?: QualityReviewRecordOptions): QualityReviewArtifactV1 {
    const artifact = projectQualityReview(input, options);
    this.pushBounded(this.qualityReviews, artifact, COPILOT_ARTIFACT_LIMITS.maxQualityReviews);
    return cloneAndFreeze(artifact);
  }

  snapshot(): CopilotArtifactSnapshotV1 {
    return cloneAndFreeze({
      version: COPILOT_ARTIFACT_SNAPSHOT_VERSION,
      sanitized: true,
      diagnoses: sortArtifacts(this.diagnoses),
      profilePatches: sortArtifacts(this.profilePatches),
      qualityReviews: sortArtifacts(this.qualityReviews),
    });
  }

  clear(): void {
    this.diagnoses.length = 0;
    this.profilePatches.length = 0;
    this.qualityReviews.length = 0;
  }

  private pushBounded<T>(items: T[], item: T, maxItems: number): void {
    items.push(cloneAndFreeze(item));
    while (items.length > maxItems) items.shift();
  }
}

export function createCopilotArtifactRepository(): CopilotArtifactRepository {
  return new InMemoryCopilotArtifactRepository();
}

function projectDiagnosis(input: unknown, options: ArtifactRecordOptions): DiagnosisArtifactV1 {
  const result = asRecord(input);
  const capsule = asRecord(result?.capsule);
  if (!result || !capsule || result.sanitized !== true || capsule.sanitized !== true) throw new CopilotArtifactError('INVALID_DIAGNOSIS', 'A diagnosis result with a sanitized capsule is required.');

  const runId = safeIdentifier(result.runId ?? capsule.runId);
  if (!runId) throw new CopilotArtifactError('INVALID_DIAGNOSIS', 'A safe diagnosis run id is required.');
  const base: Omit<DiagnosisArtifactV1, 'artifactId'> = {
    kind: 'diagnosis',
    runId,
    ...(safeIdentifier(result.caseId ?? capsule.caseId) ? { caseId: safeIdentifier(result.caseId ?? capsule.caseId) } : {}),
    ...(safeIdentifier(result.profileId ?? capsule.profileId) ? { profileId: safeIdentifier(result.profileId ?? capsule.profileId) } : {}),
    outcome: enumValue(capsule.outcome ?? result.outcome, OUTCOME_SET, 'indeterminate'),
    status: enumValue(result.status, DIAGNOSIS_STATUS_SET, 'insufficientEvidence'),
    evidenceLevel: enumValue(result.evidenceLevel, EVIDENCE_LEVEL_SET, 'limited'),
    summary: sanitizeText(result.summary, options, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'No diagnostic summary.',
    timing: projectTiming(capsule.timing),
    metrics: projectMetrics(capsule.metrics),
    transport: projectTransport(capsule.transport),
    errors: projectErrors(capsule.errors),
    evidence: projectEvidence(capsule.evidence),
    configIssueCodes: projectCodes(capsule.configIssues),
    findings: projectFindings(result.findings, options),
    nextActionIds: projectCodes(result.nextActions, 'id', COPILOT_ARTIFACT_LIMITS.maxActions),
    ...(projectAssertions(capsule.assertions) ? { assertions: projectAssertions(capsule.assertions) } : {}),
    ...(projectRepetition(result.repetition ?? capsule.repetition) ? { repetition: projectRepetition(result.repetition ?? capsule.repetition) } : {}),
    ...(projectComparison(result.comparison, options) ? { comparison: projectComparison(result.comparison, options) } : {}),
    ...(safeTimestamp(options.recordedAt) === undefined ? {} : { recordedAt: safeTimestamp(options.recordedAt) }),
  };
  return { artifactId: artifactId(base), ...base };
}

function projectProfilePatch(input: ProfilePatchAuditInput): ProfilePatchAuditArtifactV1 {
  const draft = asRecord(input.draft);
  if (!draft || draft.format !== PROFILE_PATCH_DRAFT_FORMAT || draft.version !== PROFILE_PATCH_DRAFT_VERSION) {
    throw new CopilotArtifactError('INVALID_PROFILE_PATCH', 'A valid profile patch draft is required.');
  }
  if (!PATCH_STATUS_SET.has(input.status)) throw new CopilotArtifactError('INVALID_PROFILE_PATCH', 'Profile patch status is invalid.');
  const safety = asRecord(draft.safety);
  if (safety?.requiresConfirmation !== true || safety.contentRedacted !== true) {
    throw new CopilotArtifactError('INVALID_PROFILE_PATCH', 'Profile patch safety metadata is not fail-closed.');
  }
  const profileDigest = requiredDigest(draft.profileDigest, 'profile digest');
  const sourceDigest = requiredDigest(draft.sourceDigest, 'source digest');
  const updatedProfileDigest = requiredDigest(draft.updatedProfileDigest, 'updated profile digest');
  const profileId = requiredIdentifier(input.profileId, 'profile id', 'INVALID_PROFILE_PATCH');
  const runId = optionalIdentifier(input.runId, 'run id', 'INVALID_PROFILE_PATCH');
  const sourceLength = requiredCount(draft.sourceLength, PROFILE_PATCH_LIMITS.maxSourceCharacters, 'source length');
  const updatedSourceLength = requiredCount(draft.updatedSourceLength, PROFILE_PATCH_LIMITS.maxSourceCharacters + PROFILE_PATCH_LIMITS.maxTotalEditCharacters, 'updated source length');
  const changes = projectPatchChanges(draft.changes, input.secretValues);
  if (!changes.length) throw new CopilotArtifactError('INVALID_PROFILE_PATCH', 'A profile patch audit must contain at least one safe change.');
  const base: Omit<ProfilePatchAuditArtifactV1, 'artifactId'> = {
    kind: 'profilePatch',
    profileId,
    ...(runId ? { runId } : {}),
    status: input.status,
    format: PROFILE_PATCH_DRAFT_FORMAT,
    version: PROFILE_PATCH_DRAFT_VERSION,
    profileDigest,
    sourceDigest,
    updatedProfileDigest,
    sourceLength,
    updatedSourceLength,
    summary: sanitizeText(draft.summary, input, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'Profile patch draft.',
    changes,
    editCount: boundedArrayLength(draft.edits, PROFILE_PATCH_LIMITS.maxOperations),
    inverseEditCount: boundedArrayLength(draft.inverseEdits, PROFILE_PATCH_LIMITS.maxOperations),
    requiresConfirmation: true,
    contentRedacted: true,
    ...(safeTimestamp(input.recordedAt) === undefined ? {} : { recordedAt: safeTimestamp(input.recordedAt) }),
  };
  return { artifactId: artifactId(base), ...base };
}

function projectQualityReview(input: unknown, options?: QualityReviewRecordOptions): QualityReviewArtifactV1 {
  const record = asRecord(input);
  if (!record || record.version !== 'QualityReviewRecordV1' || record.advisoryOnly !== true) {
    throw new CopilotArtifactError('INVALID_QUALITY_REVIEW', 'An advisory quality review record is required.');
  }
  const grantId = safeIdentifier(record.grantId);
  const profileId = requiredIdentifier(options?.profileId, 'profile id', 'INVALID_QUALITY_REVIEW');
  const runId = optionalIdentifier(options?.runId, 'run id', 'INVALID_QUALITY_REVIEW');
  const rubricDigest = requiredDigest(record.rubricDigest, 'rubric digest');
  const disclosureDigest = requiredDigest(record.disclosureDigest, 'disclosure digest');
  if (!grantId) throw new CopilotArtifactError('INVALID_QUALITY_REVIEW', 'A safe quality grant id is required.');
  const evidenceIds = requiredSafeIds(record.evidenceIds, 'quality evidence ids');
  const attemptIds = requiredSafeIds(record.attemptIds, 'quality attempt ids');
  const disclosure = projectDisclosure(record.disclosure);
  const createdAt = requiredTimestamp(record.createdAt, 'quality review timestamp');
  const reviewOptions: ArtifactRecordOptions = {
    secretValues: [...normalizeSecrets(options?.secretValues), ...normalizeSecrets(options?.disclosedResponses)],
  };
  const base: Omit<QualityReviewArtifactV1, 'artifactId'> = {
    kind: 'qualityReview',
    profileId,
    ...(runId ? { runId } : {}),
    advisoryOnly: true,
    grantId,
    evidenceIds,
    attemptIds,
    createdAt,
    ...(sanitizeText(record.modelLabel, reviewOptions, 160) ? { modelLabel: sanitizeText(record.modelLabel, reviewOptions, 160) } : {}),
    rubricDigest,
    disclosureDigest,
    evidenceCompleteness: enumValue(record.evidenceCompleteness, new Set<QualityReviewArtifactV1['evidenceCompleteness']>(['complete', 'partial']), 'partial'),
    summary: sanitizeText(record.summary, reviewOptions, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'Advisory quality review.',
    findings: projectQualityFindings(record.findings),
    disclosure,
    ...(safeTimestamp(options?.recordedAt) === undefined ? {} : { recordedAt: safeTimestamp(options?.recordedAt) }),
  };
  return { artifactId: artifactId(base), ...base };
}

function projectTiming(value: unknown): ArtifactTimingV1 {
  const record = asRecord(value);
  const stages = new Map<TimingStage, ArtifactTimingStageV1>();
  const rawStages = arrayValue(record?.stages);
  for (const item of rawStages.slice(0, TIMING_STAGES.length)) {
    const stage = asRecord(item);
    const name = enumValue(stage?.stage, TIMING_STAGE_SET, undefined);
    if (!name || stages.has(name)) continue;
    const elapsedMs = safeMetric(stage?.elapsedMs);
    stages.set(name, { stage: name, observed: stage?.observed === true, ...(elapsedMs === undefined ? {} : { elapsedMs }) });
  }
  const ordered = TIMING_STAGES.map((stage) => stages.get(stage) ?? { stage, observed: false });
  const missingStages = ordered.filter((stage) => !stage.observed).map((stage) => stage.stage);
  const anomalies = arrayValue(record?.anomalies).slice(0, 32).map((item) => sanitizeCode(item)).filter((item): item is string => item !== undefined);
  return { stages: ordered, missingStages, orderingValid: record?.orderingValid !== false, anomalies };
}

function projectMetrics(value: unknown): ArtifactMetricsV1 {
  const record = asRecord(value);
  const keys: Array<keyof ArtifactMetricsV1> = [
    'headersLatencyMs', 'firstChunkLatencyMs', 'firstRawEventLatencyMs', 'firstNormalizedContentLatencyMs',
    'firstVisibleTextLatencyMs', 'terminalLatencyMs', 'streamDurationMs', 'eventCount', 'byteCount',
    'parseErrorCount', 'mappingErrorCount', 'unmatchedEventCount', 'reconnectCount', 'droppedEventCount',
  ];
  const result: Partial<ArtifactMetricsV1> = {};
  for (const key of keys) {
    const valueForKey = safeMetric(record?.[key]);
    if (valueForKey !== undefined) result[key] = valueForKey;
  }
  return result;
}

function projectTransport(value: unknown): ArtifactTransportV1 {
  const record = asRecord(value);
  return {
    ...(enumValue(record?.protocol, PROTOCOL_SET, undefined) ? { protocol: enumValue(record?.protocol, PROTOCOL_SET, undefined) } : {}),
    ...(safeStatus(record?.status) === undefined ? {} : { status: safeStatus(record?.status) }),
    ...(enumValue(record?.state, TRANSPORT_STATE_SET, undefined) ? { state: enumValue(record?.state, TRANSPORT_STATE_SET, undefined) } : {}),
    ...(enumValue(record?.terminalState, TERMINAL_STATE_SET, undefined) ? { terminalState: enumValue(record?.terminalState, TERMINAL_STATE_SET, undefined) } : {}),
    ...(enumValue(record?.openingState, OPENING_STATE_SET, undefined) ? { openingState: enumValue(record?.openingState, OPENING_STATE_SET, undefined) } : {}),
    ...(typeof record?.proxyBuffered === 'boolean' ? { proxyBuffered: record.proxyBuffered } : {}),
    ...(typeof record?.idleTimeout === 'boolean' ? { idleTimeout: record.idleTimeout } : {}),
    ...(typeof record?.timeout === 'boolean' ? { timeout: record.timeout } : {}),
    ...(safeCount(record?.retryCount) === undefined ? {} : { retryCount: safeCount(record?.retryCount) }),
    ...(safeIdentifier(record?.variantId) ? { variantId: safeIdentifier(record?.variantId) } : {}),
  };
}

function projectErrors(value: unknown): ArtifactErrorV1[] {
  return arrayValue(value).slice(0, COPILOT_ARTIFACT_LIMITS.maxErrors).map((item) => {
    const record = asRecord(item);
    if (!record) return undefined;
    const category = enumValue(record.category ?? record.type, ROOT_CAUSE_SET, 'unknown');
    const code = sanitizeCode(record.code);
    const status = safeStatus(record.status);
    return { category, ...(code ? { code } : {}), ...(status === undefined ? {} : { status }), ...(typeof record.retrySafe === 'boolean' ? { retrySafe: record.retrySafe } : {}) };
  }).filter((item): item is ArtifactErrorV1 => item !== undefined);
}

function projectEvidence(value: unknown): ArtifactEvidenceRefV1[] {
  const kinds = new Set(['chat', 'network', 'event', 'profile', 'metric']);
  return arrayValue(value).slice(0, COPILOT_ARTIFACT_LIMITS.maxEvidence).map((item) => {
    const record = asRecord(item);
    if (!record) return undefined;
    const kind = enumValue(record.kind, kinds, undefined);
    if (!kind) return undefined;
    const id = safeIdentifier(record.id);
    const stage = enumValue(record.stage, TIMING_STAGE_SET, undefined);
    return { kind, ...(id ? { id } : {}), ...(stage ? { stage } : {}) };
  }).filter((item): item is ArtifactEvidenceRefV1 => item !== undefined);
}

function projectFindings(value: unknown, options: ArtifactRecordOptions): ArtifactFindingV1[] {
  return arrayValue(value).slice(0, COPILOT_ARTIFACT_LIMITS.maxFindings).map((item) => {
    const record = asRecord(item);
    if (!record) return undefined;
    const category = enumValue(record.category, ROOT_CAUSE_SET, undefined);
    if (!category) return undefined;
    const evidenceCount = Math.min(boundedArrayLength(record.evidence, COPILOT_ARTIFACT_LIMITS.maxEvidence), COPILOT_ARTIFACT_LIMITS.maxEvidence);
    return {
      category,
      evidenceLevel: enumValue(record.evidenceLevel, EVIDENCE_LEVEL_SET, 'limited'),
      label: sanitizeText(record.label, options, COPILOT_ARTIFACT_LIMITS.maxLabelCharacters) ?? category,
      reason: sanitizeText(record.reason, options, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'No deterministic reason was retained.',
      evidenceCount,
    };
  }).filter((item): item is ArtifactFindingV1 => item !== undefined);
}

function projectAssertions(value: unknown): ArtifactAssertionV1 | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const total = safeCount(record.total);
  const passed = safeCount(record.passed);
  const failed = safeCount(record.failed);
  if (total === undefined || passed === undefined || failed === undefined) return undefined;
  return { total, passed, failed };
}

function projectRepetition(value: unknown): ArtifactRepetitionV1 | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const requestedAttempts = safeCount(record.requestedAttempts);
  const completedAttempts = safeCount(record.completedAttempts);
  const skippedAttempts = safeCount(record.skippedAttempts);
  if (requestedAttempts === undefined || completedAttempts === undefined || skippedAttempts === undefined) return undefined;
  const countsRecord = asRecord(record.counts);
  const counts = Object.fromEntries(DIAGNOSTIC_OUTCOMES.map((outcome) => [outcome, safeCount(countsRecord?.[outcome]) ?? 0])) as Record<DiagnosticOutcome, number>;
  const status = enumValue(record.status, REPETITION_STATUS_SET, 'inconclusive');
  const dominantOutcome = enumValue(record.dominantOutcome, OUTCOME_SET, undefined);
  return {
    requestedAttempts,
    completedAttempts,
    skippedAttempts,
    sampleComplete: record.sampleComplete === true,
    counts,
    status,
    ...(dominantOutcome ? { dominantOutcome } : {}),
    evidenceLevel: enumValue(record.evidenceLevel, EVIDENCE_LEVEL_SET, 'limited'),
  };
}

function projectComparison(value: unknown, options: ArtifactRecordOptions): ArtifactComparisonV1 | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const differences: ArtifactComparisonDifferenceV1[] = arrayValue(record.differences).slice(0, 16).map((item) => {
    const difference = asRecord(item);
    if (!difference) return undefined;
    const metric = sanitizeCode(difference?.metric);
    if (!metric) return undefined;
    const direction = enumValue(difference.direction, COMPARISON_DIRECTION_SET, 'unknown');
    return {
      metric,
      ...(safeMetric(difference.baselineMs) === undefined ? {} : { baselineMs: safeMetric(difference.baselineMs) }),
      ...(safeMetric(difference.candidateMs) === undefined ? {} : { candidateMs: safeMetric(difference.candidateMs) }),
      ...(safeMetric(difference.deltaMs) === undefined ? {} : { deltaMs: safeMetric(difference.deltaMs) }),
      direction,
      evidenceLevel: enumValue(difference.evidenceLevel, EVIDENCE_LEVEL_SET, 'limited'),
    };
  }).filter((item): item is ArtifactComparisonDifferenceV1 => item !== undefined);
  return {
    outcomeChanged: record.outcomeChanged === true,
    ...(enumValue(record.baselineOutcome, OUTCOME_SET, undefined) ? { baselineOutcome: enumValue(record.baselineOutcome, OUTCOME_SET, undefined) } : {}),
    ...(enumValue(record.candidateOutcome, OUTCOME_SET, undefined) ? { candidateOutcome: enumValue(record.candidateOutcome, OUTCOME_SET, undefined) } : {}),
    variantChanged: record.variantChanged === true,
    differences,
    evidenceLevel: enumValue(record.evidenceLevel, EVIDENCE_LEVEL_SET, 'limited'),
    summary: sanitizeText(record.summary, options, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'No comparison summary.',
  };
}

function projectPatchChanges(value: unknown, secretValues: readonly unknown[] | undefined): ProfilePatchChangeArtifactV1[] {
  return arrayValue(value).slice(0, COPILOT_ARTIFACT_LIMITS.maxChanges).map((item) => {
    const change = asRecord(item);
    if (!change) return undefined;
    const path = projectPatchPath(change.path);
    if (!path) return undefined;
    const pathLabel = sanitizePathLabel(change.pathLabel) ?? formatPath(path);
    const operation = enumValue(change.operation, PATCH_OPERATION_SET, undefined);
    const category = enumValue(change.category, PROFILE_PATCH_CATEGORY_SET, undefined);
    if (!operation || !category) return undefined;
    return {
      path,
      pathLabel,
      operation,
      category,
      before: projectPatchValueSummary(change.before),
      after: projectPatchValueSummary(change.after),
      reason: sanitizeText(change.reason, { secretValues }, COPILOT_ARTIFACT_LIMITS.maxTextCharacters) ?? 'Bounded profile change.',
    };
  }).filter((item): item is ProfilePatchChangeArtifactV1 => item !== undefined);
}

function projectPatchPath(value: unknown): readonly (string | number)[] | undefined {
  const path = arrayValue(value);
  if (!path.length || path.length > PROFILE_PATCH_LIMITS.maxPathSegments) return undefined;
  const projected: Array<string | number> = [];
  for (const part of path) {
    if (typeof part === 'string' && part.length <= PROFILE_PATCH_LIMITS.maxPathString && SAFE_PATH_PART.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)) projected.push(part);
    else if (typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 100) projected.push(part);
    else return undefined;
  }
  return projected;
}

function projectPatchValueSummary(value: unknown): PatchValueSummaryArtifactV1 {
  const record = asRecord(value);
  if (!record) return { kind: 'missing' };
  const kind = enumValue(record.kind, VALUE_KIND_SET, 'missing');
  const result: PatchValueSummaryArtifactV1 = { kind };
  if ((kind === 'boolean' || kind === 'number' || kind === 'null') && (typeof record.value === 'boolean' || typeof record.value === 'number' || record.value === null)) {
    if (kind !== 'number' || Number.isFinite(record.value)) result.value = record.value;
  }
  const length = safeCount(record.length, 0, PROFILE_PATCH_LIMITS.maxEditCharacters);
  const keys = safeCount(record.keys, 0, PROFILE_PATCH_LIMITS.maxTopLevelKeys);
  const digest = safeDigest(record.digest);
  return { ...result, ...(length === undefined ? {} : { length }), ...(keys === undefined ? {} : { keys }), ...(digest ? { digest } : {}) };
}

function projectQualityFindings(value: unknown): QualityFindingArtifactV1[] {
  return arrayValue(value).slice(0, COPILOT_ARTIFACT_LIMITS.maxFindings * 20).map((item): QualityFindingArtifactV1 | undefined => {
    const finding = asRecord(item);
    if (!finding) return undefined;
    const rubricId = safeIdentifier(finding?.rubricId);
    const criterionId = safeIdentifier(finding?.criterionId);
    const rating = typeof finding.rating === 'string' && QUALITY_RATING_SET.has(finding.rating as QualityFindingArtifactV1['rating']) ? finding.rating as QualityFindingArtifactV1['rating'] : undefined;
    if (!rubricId || !criterionId || !rating) return undefined;
    return { rubricId, criterionId, rating, evidenceAttemptIds: projectSafeIds(finding.evidenceAttemptIds, 10) };
  }).filter((item): item is QualityFindingArtifactV1 => item !== undefined);
}

function projectDisclosure(value: unknown): QualityDisclosureArtifactV1 {
  const record = asRecord(value);
  if (!record || record.manualSelection !== true || record.responseContent !== true || record.prompts !== false || record.rawPayloads !== false || record.headers !== false || record.fullUrls !== false || record.secrets !== false) {
    throw new CopilotArtifactError('INVALID_QUALITY_REVIEW', 'Quality disclosure metadata is not fail-closed.');
  }
  const disclosedCharacters = requiredCount(record.disclosedCharacters, 32_000, 'disclosed response characters');
  return { manualSelection: true, responseContent: true, prompts: false, rawPayloads: false, headers: false, fullUrls: false, secrets: false, disclosedCharacters };
}

function projectCodes(value: unknown, property?: string, maxItems = 32): string[] {
  return arrayValue(value).slice(0, maxItems).map((item) => sanitizeCode(property ? asRecord(item)?.[property] : item)).filter((item): item is string => item !== undefined);
}

function projectSafeIds(value: unknown, maxItems: number): string[] {
  return arrayValue(value).slice(0, maxItems).map((item) => safeIdentifier(item)).filter((item): item is string => item !== undefined);
}

function requiredSafeIds(value: unknown, label: string): string[] {
  const ids = projectSafeIds(value, 10);
  if (!ids.length) throw new CopilotArtifactError('INVALID_QUALITY_REVIEW', `${label} must contain safe identifiers.`);
  return ids;
}

function sanitizeText(value: unknown, options: ArtifactRecordOptions, maxLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const secrets = normalizeSecrets(options.secretValues);
  let sanitized = value;
  for (const secret of secrets) sanitized = sanitized.split(secret).join('[SECRET_REDACTED]');
  sanitized = sanitized.replace(URL_PATTERN, '[URL_REDACTED]').replace(WWW_URL_PATTERN, '[URL_REDACTED]').replace(SECRET_PATTERN, '[SECRET_REDACTED]').replace(KEY_VALUE_SECRET_PATTERN, '[SECRET_REDACTED]').replace(/\s+/gu, ' ').trim();
  if (!sanitized) return undefined;
  return sanitized.length > maxLength ? `${sanitized.slice(0, Math.max(0, maxLength - 1))}…` : sanitized;
}

function normalizeSecrets(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 32).filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096);
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > COPILOT_ARTIFACT_LIMITS.maxIdCharacters || !SAFE_ID.test(value)) return undefined;
  if (URL_DETECT_PATTERN.test(value) || WWW_URL_DETECT_PATTERN.test(value) || SECRET_DETECT_PATTERN.test(value) || KEY_VALUE_SECRET_DETECT_PATTERN.test(value)) return undefined;
  return value;
}

function requiredIdentifier(value: unknown, label: string, code: CopilotArtifactError['code']): string {
  const identifier = safeIdentifier(value);
  if (!identifier) throw new CopilotArtifactError(code, `A safe ${label} is required.`);
  return identifier;
}

function optionalIdentifier(value: unknown, label: string, code: CopilotArtifactError['code']): string | undefined {
  if (value === undefined) return undefined;
  return requiredIdentifier(value, label, code);
}

function sanitizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > COPILOT_ARTIFACT_LIMITS.maxIdCharacters || !SAFE_CODE.test(value)) return undefined;
  if (value.includes('://')) return undefined;
  return value;
}

function sanitizePathLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > PROFILE_PATCH_LIMITS.maxPathString || value.includes('://')) return undefined;
  return value.split('.').every((part) => SAFE_PATH_PART.test(part)) ? value : undefined;
}

function formatPath(path: readonly (string | number)[]): string {
  return path.map((part) => typeof part === 'number' ? `[${part}]` : part).join('.').replaceAll('.[', '[');
}

function safeDigest(value: unknown): string | undefined { return typeof value === 'string' && DIGEST_PATTERN.test(value) ? value : undefined; }
function requiredDigest(value: unknown, label: string): string {
  const digest = safeDigest(value);
  if (!digest) throw new CopilotArtifactError('INVALID_PROFILE_PATCH', `A valid ${label} is required.`);
  return digest;
}

function safeTimestamp(value: unknown): number | undefined { return safeCount(value, 0, MAX_TIMESTAMP); }
function requiredTimestamp(value: unknown, label: string): number {
  const timestamp = safeTimestamp(value);
  if (timestamp === undefined) throw new CopilotArtifactError('INVALID_QUALITY_REVIEW', `${label} is invalid.`);
  return timestamp;
}
function safeMetric(value: unknown): number | undefined { return safeCount(value, 0, MAX_METRIC); }
function safeCount(value: unknown, min = 0, max = MAX_COUNTER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
function requiredCount(value: unknown, max: number, label: string): number {
  const count = safeCount(value, 0, max);
  if (count === undefined) throw new CopilotArtifactError('INVALID_PROFILE_PATCH', `${label} is invalid.`);
  return count;
}
function safeStatus(value: unknown): number | undefined { return safeCount(value, 100, 999); }
function boundedArrayLength(value: unknown, max: number): number {
  return Array.isArray(value) ? Math.min(value.length, max) : 0;
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, fallback: T): T;
function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, fallback: undefined): T | undefined;
function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, fallback: T | undefined): T | undefined {
  return typeof value === 'string' && values.has(value as T) ? value as T : fallback;
}

function artifactId(value: unknown): string { return sha256(stableStringify(value)); }

function sortArtifacts<T extends { artifactId: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
