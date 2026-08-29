import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_QUALITY_RUBRIC,
  QUALITY_REVIEW_LIMITS,
  type QualityDisclosureAttempt,
  type QualityDisclosureGrantV1,
  type QualityReviewFinding,
  type QualityReviewRecordV1,
  type QualityReviewSubmission,
  type QualityRubricDefinition,
} from './contracts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Reject complete URLs and recognizable credential-shaped values only. */
const FULL_URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+|\bwww\.[^\s"'<>]+/i;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}|\b(?:gh[ps]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{10,}|sk-[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,})\b|\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]{4,})/i;

export class QualityPolicyError extends Error {
  constructor(readonly code: 'INVALID_RUBRIC' | 'INVALID_SELECTION' | 'INVALID_REVIEW' | 'GRANT_EXPIRED' | 'GRANT_NOT_FOUND', message: string) {
    super(message);
    this.name = 'QualityPolicyError';
  }
}

export function validateQualityRubrics(value: unknown): QualityRubricDefinition[] {
  if (value === undefined) return [structuredClone(DEFAULT_QUALITY_RUBRIC)];
  if (!Array.isArray(value) || value.length === 0 || value.length > QUALITY_REVIEW_LIMITS.maxRubrics) throw new QualityPolicyError('INVALID_RUBRIC', `qualityRubrics must contain 1-${QUALITY_REVIEW_LIMITS.maxRubrics} rubrics.`);
  const rubricIds = new Set<string>();
  return value.map((item, rubricIndex) => {
    if (!isRecord(item)) throw new QualityPolicyError('INVALID_RUBRIC', `qualityRubrics[${rubricIndex}] must be an object.`);
    rejectUnknownKeys(item, ['id', 'name', 'description', 'criteria'], `qualityRubrics[${rubricIndex}]`);
    const id = safeId(item.id, `qualityRubrics[${rubricIndex}].id`);
    if (rubricIds.has(id)) throw new QualityPolicyError('INVALID_RUBRIC', `Duplicate quality rubric id: ${id}.`);
    rubricIds.add(id);
    const criteriaValue = item.criteria;
    if (!Array.isArray(criteriaValue) || criteriaValue.length === 0 || criteriaValue.length > QUALITY_REVIEW_LIMITS.maxCriteriaPerRubric) throw new QualityPolicyError('INVALID_RUBRIC', `Rubric ${id} must contain 1-${QUALITY_REVIEW_LIMITS.maxCriteriaPerRubric} criteria.`);
    const criterionIds = new Set<string>();
    const criteria = criteriaValue.map((criterion, criterionIndex) => {
      if (!isRecord(criterion)) throw new QualityPolicyError('INVALID_RUBRIC', `Criterion ${criterionIndex} in ${id} must be an object.`);
      rejectUnknownKeys(criterion, ['id', 'label', 'description'], `criterion ${criterionIndex} in ${id}`);
      const criterionId = safeId(criterion.id, `criterion ${criterionIndex} id`);
      if (criterionIds.has(criterionId)) throw new QualityPolicyError('INVALID_RUBRIC', `Duplicate criterion id ${criterionId} in rubric ${id}.`);
      criterionIds.add(criterionId);
      return { id: criterionId, label: boundedText(criterion.label, 120, 'criterion label'), description: boundedText(criterion.description, 500, 'criterion description') };
    });
    return { id, name: boundedText(item.name, 120, 'rubric name'), ...(item.description === undefined ? {} : { description: boundedText(item.description, 500, 'rubric description') }), criteria };
  });
}

export function createQualityDisclosureGrant(input: {
  evidenceIds: readonly string[];
  attempts: readonly QualityDisclosureAttempt[];
  rubrics?: unknown;
  now?: number;
  grantId?: string;
}): QualityDisclosureGrantV1 {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new QualityPolicyError('INVALID_SELECTION', 'Invalid disclosure timestamp.');
  if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.length > QUALITY_REVIEW_LIMITS.maxSelectedAttempts) throw new QualityPolicyError('INVALID_SELECTION', `Select 1-${QUALITY_REVIEW_LIMITS.maxSelectedAttempts} evidence attempts explicitly.`);
  const evidenceIds = uniqueIds(input.evidenceIds, 'evidence id');
  if (!Array.isArray(input.attempts) || input.attempts.length !== evidenceIds.length) throw new QualityPolicyError('INVALID_SELECTION', 'Each selected evidence item must provide one assistant attempt.');
  const attemptIds = new Set<string>();
  let disclosedCharacters = 0;
  const attempts = input.attempts.map((attempt, index) => {
    if (!isRecord(attempt)) throw new QualityPolicyError('INVALID_SELECTION', `Attempt ${index} must be an object.`);
    const attemptId = safeId(attempt.attemptId, `attempt ${index} id`);
    if (attemptIds.has(attemptId)) throw new QualityPolicyError('INVALID_SELECTION', `Duplicate attempt id: ${attemptId}.`);
    attemptIds.add(attemptId);
    if (typeof attempt.response !== 'string' || !attempt.response.trim()) throw new QualityPolicyError('INVALID_SELECTION', `Attempt ${attemptId} has no assistant response.`);
    if (attempt.response.length > QUALITY_REVIEW_LIMITS.maxResponseCharacters) throw new QualityPolicyError('INVALID_SELECTION', `Attempt ${attemptId} exceeds ${QUALITY_REVIEW_LIMITS.maxResponseCharacters} characters.`);
    if (containsUnsafeDisclosure(attempt.response)) throw new QualityPolicyError('INVALID_SELECTION', `Attempt ${attemptId} contains a secret-like value and cannot be disclosed.`);
    disclosedCharacters += attempt.response.length;
    if (disclosedCharacters > QUALITY_REVIEW_LIMITS.maxTotalCharacters) throw new QualityPolicyError('INVALID_SELECTION', `Selected responses exceed ${QUALITY_REVIEW_LIMITS.maxTotalCharacters} characters.`);
    return { attemptId, response: attempt.response };
  });
  const grantId = safeId(input.grantId ?? randomUUID(), 'grant id');
  return {
    version: 'QualityDisclosureGrantV1', grantId, evidenceIds, attempts, rubrics: validateQualityRubrics(input.rubrics), disclosedCharacters,
    createdAt: now, expiresAt: now + QUALITY_REVIEW_LIMITS.grantTtlMs,
    disclosure: { manualSelection: true, responseContent: true, prompts: false, rawPayloads: false, headers: false, fullUrls: false, secrets: false },
  };
}

export function createQualityReviewRecord(grant: QualityDisclosureGrantV1, submission: unknown, now = Date.now()): QualityReviewRecordV1 {
  if (now > grant.expiresAt) throw new QualityPolicyError('GRANT_EXPIRED', 'The response disclosure grant expired. Start a new advisory review.');
  const review = validateQualityReviewSubmission(submission, grant);
  return {
    version: 'QualityReviewRecordV1', advisoryOnly: true, grantId: grant.grantId, evidenceIds: [...grant.evidenceIds], attemptIds: grant.attempts.map((item) => item.attemptId), createdAt: now,
    ...(review.modelLabel ? { modelLabel: review.modelLabel } : {}),
    rubricDigest: digest(grant.rubrics), disclosureDigest: digest({ evidenceIds: grant.evidenceIds, attemptIds: grant.attempts.map((item) => item.attemptId), disclosedCharacters: grant.disclosedCharacters, disclosure: grant.disclosure }),
    evidenceCompleteness: grant.attempts.length === grant.evidenceIds.length ? 'complete' : 'partial', summary: review.summary, findings: review.findings,
    disclosure: { ...grant.disclosure, disclosedCharacters: grant.disclosedCharacters },
  };
}

export function validateQualityReviewSubmission(value: unknown, grant: QualityDisclosureGrantV1): QualityReviewSubmission {
  if (!isRecord(value)) throw new QualityPolicyError('INVALID_REVIEW', 'Advisory review must be an object.');
  rejectUnknownKeys(value, ['summary', 'findings', 'modelLabel'], 'review');
  const summary = boundedText(value.summary, QUALITY_REVIEW_LIMITS.maxSummaryCharacters, 'review summary');
  if (!Array.isArray(value.findings) || !value.findings.length || value.findings.length > QUALITY_REVIEW_LIMITS.maxRubrics * QUALITY_REVIEW_LIMITS.maxCriteriaPerRubric) throw new QualityPolicyError('INVALID_REVIEW', 'Review findings must be a bounded non-empty array.');
  const rubricMap = new Map(grant.rubrics.map((rubric) => [rubric.id, new Set(rubric.criteria.map((criterion) => criterion.id))]));
  const attempts = new Set(grant.attempts.map((attempt) => attempt.attemptId));
  const seen = new Set<string>();
  const findings = value.findings.map((item, index): QualityReviewFinding => {
    if (!isRecord(item)) throw new QualityPolicyError('INVALID_REVIEW', `Finding ${index} must be an object.`);
    rejectUnknownKeys(item, ['rubricId', 'criterionId', 'rating', 'rationale', 'evidenceAttemptIds'], `finding ${index}`);
    const rubricId = safeId(item.rubricId, `finding ${index} rubricId`);
    const criterionId = safeId(item.criterionId, `finding ${index} criterionId`);
    if (!rubricMap.get(rubricId)?.has(criterionId)) throw new QualityPolicyError('INVALID_REVIEW', `Finding ${index} references an unknown rubric criterion.`);
    const key = `${rubricId}:${criterionId}`;
    if (seen.has(key)) throw new QualityPolicyError('INVALID_REVIEW', `Duplicate finding for ${key}.`);
    seen.add(key);
    if (!['meets', 'partiallyMeets', 'doesNotMeet', 'notEnoughEvidence'].includes(String(item.rating))) throw new QualityPolicyError('INVALID_REVIEW', `Finding ${index} has an invalid rating.`);
    if (!Array.isArray(item.evidenceAttemptIds) || item.evidenceAttemptIds.length > QUALITY_REVIEW_LIMITS.maxSelectedAttempts) throw new QualityPolicyError('INVALID_REVIEW', `Finding ${index} has invalid evidenceAttemptIds.`);
    const evidenceAttemptIds = uniqueIds(item.evidenceAttemptIds, 'attempt id');
    if (evidenceAttemptIds.some((id) => !attempts.has(id))) throw new QualityPolicyError('INVALID_REVIEW', `Finding ${index} references an undisclosed attempt.`);
    return { rubricId, criterionId, rating: item.rating as QualityReviewFinding['rating'], rationale: boundedText(item.rationale, QUALITY_REVIEW_LIMITS.maxFindingCharacters, `finding ${index} rationale`), evidenceAttemptIds };
  });
  return { summary, findings, ...(value.modelLabel === undefined ? {} : { modelLabel: boundedText(value.modelLabel, 120, 'model label') }) };
}

export class QualityGrantStore {
  private readonly grants = new Map<string, QualityDisclosureGrantV1>();
  private readonly records: QualityReviewRecordV1[] = [];

  issue(grant: QualityDisclosureGrantV1, now = Date.now()): QualityDisclosureGrantV1 {
    this.prune(now);
    this.grants.set(grant.grantId, structuredClone(grant));
    while (this.grants.size > QUALITY_REVIEW_LIMITS.maxActiveGrants) this.grants.delete(this.grants.keys().next().value!);
    return structuredClone(grant);
  }

  get(grantId: string, now = Date.now()): QualityDisclosureGrantV1 {
    this.prune(now);
    const grant = this.grants.get(grantId);
    if (!grant) throw new QualityPolicyError('GRANT_NOT_FOUND', 'The response disclosure grant is missing or expired.');
    return structuredClone(grant);
  }

  record(grantId: string, submission: unknown, now = Date.now()): QualityReviewRecordV1 {
    const grant = this.get(grantId, now);
    const record = createQualityReviewRecord(grant, submission, now);
    this.grants.delete(grantId);
    this.records.push(record);
    while (this.records.length > 100) this.records.shift();
    return structuredClone(record);
  }

  listRecords(): QualityReviewRecordV1[] { return structuredClone(this.records); }

  private prune(now: number): void { for (const [id, grant] of this.grants) if (grant.expiresAt < now) this.grants.delete(id); }
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function uniqueIds(values: readonly unknown[], label: string): string[] {
  const result = values.map((value, index) => safeId(value, `${label} ${index}`));
  if (new Set(result).size !== result.length) throw new QualityPolicyError('INVALID_SELECTION', `Duplicate ${label}.`);
  return result;
}
function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 256 || !SAFE_ID.test(value)) throw new QualityPolicyError('INVALID_SELECTION', `Invalid ${label}.`);
  return value;
}
function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || containsUnsafeDisclosure(value)) throw new QualityPolicyError('INVALID_SELECTION', `Invalid or unsafe ${label}.`);
  return value;
}
function containsUnsafeDisclosure(value: string): boolean { return FULL_URL.test(value) || SECRET_VALUE.test(value); }
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw new QualityPolicyError('INVALID_SELECTION', `${label} contains an unsupported property.`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
