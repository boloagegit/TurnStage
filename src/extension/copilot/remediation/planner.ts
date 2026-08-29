import { findNodeAtLocation, parse, parseTree, type Node } from 'jsonc-parser';
import { digestValue, sha256, stableStringify } from '../../testing/provenance';
import {
  PROFILE_PATCH_DRAFT_FORMAT,
  PROFILE_PATCH_DRAFT_VERSION,
  PROFILE_PATCH_LIMITS,
  ProfilePatchError,
  type ProfilePatchCategory,
  type ProfilePatchChangeV1,
  type ProfilePatchDigestCheckV1,
  type ProfilePatchDraftV1,
  type ProfilePatchOperation,
  type ProfilePatchOperationV1,
  type ProfilePatchPath,
  type ProfilePatchPathPart,
  type ProfilePatchPlanInputV1,
  type ProfilePatchTextEditV1,
  type ProfilePatchValidationResultV1,
  type ProfilePatchValueSummaryV1,
  type ProfilePatchVerificationInputV1,
  type ProfilePatchVerificationResultV1,
} from './contracts';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DANGEROUS_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUEST_ROOTS: readonly (readonly string[])[] = [
  ['conversation', 'send'],
  ['conversation', 'stop', 'request'],
  ['opening', 'request'],
];
const REQUEST_TIMING_FIELDS = new Set(['timeoutMs', 'idleTimeoutMs']);
const RETRY_FIELDS = new Set(['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'retryOnStatuses']);
const STREAM_FIELDS = new Set(['transport', 'dataFormat', 'mappingMode', 'doneValue', 'unexpectedEndPolicy']);
const MATCH_FIELDS = new Set(['event', 'path', 'operator', 'value']);
const EMIT_FIELDS = new Set([
  'text', 'markdown', 'conversationId', 'messageId', 'role', 'toolCallId', 'name', 'citation',
  'citationId', 'followup', 'action', 'form', 'metric',
]);
const SAFE_NORMALIZED_EVENT_TYPES = new Set([
  'conversation.started', 'conversation.ready', 'conversation.failed', 'conversation.reset',
  'content.text.delta', 'content.markdown.delta', 'content.text', 'content.markdown',
  'message.started', 'message.completed', 'message.failed', 'message.metric.updated',
  'tool.started', 'tool.delta', 'tool.completed', 'tool.failed', 'citation.upsert', 'content.citation',
  'followup.upsert', 'action.upsert', 'form.upsert', 'stream.completed', 'stream.error',
]);
const SAFE_MAPPING_PATH = /^(?:\$\.?)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*$/;
const SAFE_EVENT_NAME = /^[A-Za-z0-9._:/-]+$/;
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s]+/i;
const SECRET_PATTERN = /\b(?:bearer\s+|basic\s+|sk-[A-Za-z0-9]|gh[pousr]_[A-Za-z0-9]|xox[baprs]-|AIza[A-Za-z0-9_-]{16,}|token[-_:=]|password[-_:=]|secret[-_:=])[^\s]*/i;
const PATH_LIKE_KEYS = new Set(['path', 'event', 'operator', 'type', 'aggregation', 'format', 'doneValue', 'transport', 'dataFormat', 'mappingMode', 'unexpectedEndPolicy']);
const SAFE_REASON_FALLBACK: Record<ProfilePatchCategory, string> = {
  'request-timing': 'Adjust request timing within the configured safety bounds.',
  'retry-timing': 'Adjust retry timing within the configured safety bounds.',
  'stream-parser': 'Adjust the stream parser setting within the configured safety bounds.',
  mapping: 'Adjust a stream mapping within the configured safety bounds.',
};

interface ParsedSource {
  value: Record<string, unknown>;
  tree: Node;
}

interface NormalizedOperation {
  path: ProfilePatchPath;
  operation: ProfilePatchOperation;
  value?: unknown;
  reason: string;
  category: ProfilePatchCategory;
}

interface SequentialEdit extends ProfilePatchTextEditV1 {
  oldContent: string;
}

interface ComposedEdits {
  text: string;
  edits: ProfilePatchTextEditV1[];
  map: number[];
}

/** Returns the canonical SHA-256 digest used as the profile TOCTOU lock. */
export function computeProfileDigest(profile: unknown, secretValues: readonly unknown[] = []): string {
  return digestValue(profile, { secretValues });
}

export const canonicalProfileDigest = computeProfileDigest;
export const profileDigest = computeProfileDigest;

/** Check a canonical profile digest without returning any profile data. */
export function checkProfileDigest(profile: unknown, expected?: string, secretValues: readonly unknown[] = []): ProfilePatchDigestCheckV1 {
  const actual = computeProfileDigest(profile, secretValues);
  return { ...(expected === undefined ? {} : { expected }), actual, matches: expected === undefined || actual === expected };
}

/** Fail closed when a caller's profile lock does not match the current profile. */
export function assertExpectedProfileDigest(profile: unknown, expected: string, secretValues: readonly unknown[] = []): string {
  if (!isDigest(expected)) throw new ProfilePatchError('DIGEST_MISMATCH', 'Expected profile digest is malformed.');
  const actual = computeProfileDigest(profile, secretValues);
  if (actual !== expected) throw new ProfilePatchError('DIGEST_MISMATCH', 'The profile changed since the diagnostic was captured.');
  return actual;
}

/** Public allowlist used by the Copilot adapter before it asks for a draft. */
export function isAllowedProfilePatchPath(path: unknown): path is ProfilePatchPath {
  return classifyPath(path).valid;
}

export const isAllowedPatchPath = isAllowedProfilePatchPath;

/** Return the narrow remediation category for an allowlisted path. */
export function profilePatchCategory(path: ProfilePatchPath): ProfilePatchCategory | undefined {
  const result = classifyPath(path);
  return result.valid ? result.category : undefined;
}

/**
 * Build a deterministic, comment-preserving JSONC remediation draft. The
 * planner performs no file or workspace mutation; the host applies `edits`
 * only after presenting its own confirmation UI and checking this draft's
 * digest again.
 */
export function createProfilePatchDraft(input: ProfilePatchPlanInputV1): ProfilePatchDraftV1 {
  const parsed = parseProfileSource(input.sourceText);
  const secretValues = normalizeSecretValues(input.secretValues);
  const sourceProfileDigest = computeProfileDigest(parsed.value, secretValues);
  if (input.profile === undefined || !isRecord(input.profile)) throw new ProfilePatchError('INVALID_PROFILE', 'A parsed profile object is required.');
  if (computeProfileDigest(input.profile, secretValues) !== sourceProfileDigest) throw new ProfilePatchError('INVALID_PROFILE', 'The supplied profile does not match the JSONC source.');
  if (input.expectedProfileDigest !== undefined) assertExpectedProfileDigest(parsed.value, input.expectedProfileDigest, secretValues);
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new ProfilePatchError('INVALID_INPUT', 'At least one profile patch operation is required.');
  if (input.operations.length > PROFILE_PATCH_LIMITS.maxOperations) throw new ProfilePatchError('OVERSIZED', `A profile patch may contain at most ${PROFILE_PATCH_LIMITS.maxOperations} operations.`);
  const operations = normalizeOperations(input.operations);
  assertNoConflictingOperations(operations);

  const sourceDigest = sha256(input.sourceText);
  if (input.expectedSourceDigest !== undefined) {
    if (!isDigest(input.expectedSourceDigest)) throw new ProfilePatchError('DIGEST_MISMATCH', 'Expected source digest is malformed.');
    if (input.expectedSourceDigest !== sourceDigest) throw new ProfilePatchError('DIGEST_MISMATCH', 'The JSONC document changed since the diagnostic was captured.');
  }
  const sequentialEdits: SequentialEdit[] = [];
  const changes: ProfilePatchChangeV1[] = [];
  let currentText = input.sourceText;
  for (const operation of operations) {
    const current = parseProfileSource(currentText);
    const before = getPathValue(current.value, operation.path);
    if (operation.operation === 'remove' && before === undefined) throw new ProfilePatchError('NO_OP', `The profile path ${formatPath(operation.path)} is not present.`);
    if (operation.operation === 'set' && jsonEqual(before, operation.value)) throw new ProfilePatchError('NO_OP', `The profile path ${formatPath(operation.path)} already has the requested value.`);
    const edit = makeJsoncEdit(currentText, current.tree, operation);
    const oldContent = currentText.slice(edit.offset, edit.offset + edit.length);
    if (oldContent.length !== edit.length) throw new ProfilePatchError('INVALID_SOURCE', 'The JSONC edit range is outside the source document.');
    if (containsSensitiveMaterial(edit.content) || containsSensitiveMaterial(oldContent) && operation.operation === 'set' && edit.length > 0 && !isSafeReplacementPath(operation.path)) {
      throw new ProfilePatchError('UNSAFE_EDIT', 'The proposed edit contains material outside the remediation boundary.');
    }
    currentText = applyTextEdits(currentText, [edit]);
    sequentialEdits.push({ ...edit, oldContent });
    const after = operation.operation === 'remove' ? undefined : operation.value;
    changes.push({
      path: [...operation.path],
      pathLabel: formatPath(operation.path),
      operation: operation.operation,
      category: operation.category,
      before: summarizeValue(before, secretValues),
      after: summarizeValue(after, secretValues),
      reason: operation.reason,
    });
  }
  const updated = parseProfileSource(currentText);
  const forward = composeSequentialEdits(input.sourceText, sequentialEdits);
  const inverseSequence: SequentialEdit[] = [...sequentialEdits].reverse().map((edit) => ({ offset: edit.offset, length: edit.content.length, content: edit.oldContent, oldContent: edit.content }));
  const inverse = composeSequentialEdits(currentText, inverseSequence);
  if (forward.text !== currentText || inverse.text !== input.sourceText) throw new ProfilePatchError('CONFLICTING_EDITS', 'Could not compose a deterministic profile edit plan.');
  const draft: ProfilePatchDraftV1 = {
    format: PROFILE_PATCH_DRAFT_FORMAT,
    version: PROFILE_PATCH_DRAFT_VERSION,
    profileDigest: sourceProfileDigest,
    sourceDigest,
    updatedProfileDigest: computeProfileDigest(updated.value, secretValues),
    sourceLength: input.sourceText.length,
    updatedSourceLength: currentText.length,
    summary: `Prepared ${changes.length} allowlisted profile change${changes.length === 1 ? '' : 's'}. Review the native diff before applying.`,
    changes,
    edits: forward.edits,
    inverseEdits: inverse.edits,
    safety: {
      allowlisted: true,
      networkSettingsChanged: false,
      secretSettingsChanged: false,
      requiresConfirmation: true,
      contentRedacted: true,
    },
  };
  const validation = validateProfilePatchDraft(draft);
  if (!validation.valid) throw new ProfilePatchError('INVALID_DRAFT', validation.errors[0] ?? 'The generated profile patch draft is invalid.');
  return draft;
}

export const createProfilePatchPlan = createProfilePatchDraft;
export const planProfilePatch = createProfilePatchDraft;
export const draftProfilePatch = createProfilePatchDraft;

/** Apply non-overlapping edits in a deterministic order. This is pure. */
export function applyTextEdits(sourceText: string, edits: readonly ProfilePatchTextEditV1[]): string {
  validateTextEdits(edits, sourceText.length, 'edits');
  let result = sourceText;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset || b.length - a.length)) result = result.slice(0, edit.offset) + edit.content + result.slice(edit.offset + edit.length);
  return result;
}

export const applyProfilePatchEdits = applyTextEdits;

/** Validate an untrusted draft before showing or applying it. */
export function validateProfilePatchDraft(value: unknown): ProfilePatchValidationResultV1 {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ['Profile patch draft must be an object.'] };
  const allowedKeys = new Set(['format', 'version', 'profileDigest', 'sourceDigest', 'updatedProfileDigest', 'sourceLength', 'updatedSourceLength', 'summary', 'changes', 'edits', 'inverseEdits', 'safety']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) errors.push('Profile patch draft contains an unsupported property.');
  if (value.format !== PROFILE_PATCH_DRAFT_FORMAT || value.version !== PROFILE_PATCH_DRAFT_VERSION) errors.push('Profile patch draft format or version is unsupported.');
  for (const key of ['profileDigest', 'sourceDigest', 'updatedProfileDigest']) if (!isDigest(value[key])) errors.push(`Profile patch ${key} is malformed.`);
  for (const key of ['sourceLength', 'updatedSourceLength']) if (!isBoundedInteger(value[key], 0, PROFILE_PATCH_LIMITS.maxSourceCharacters)) errors.push(`Profile patch ${key} is out of bounds.`);
  if (!isBoundedString(value.summary, PROFILE_PATCH_LIMITS.maxSummaryLength) || containsSensitiveMaterial(value.summary)) errors.push('Profile patch summary is unsafe or too long.');
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > PROFILE_PATCH_LIMITS.maxOperations) errors.push('Profile patch changes are out of bounds.');
  else validateChanges(value.changes, errors);
  validateTextEdits(value.edits, typeof value.sourceLength === 'number' ? value.sourceLength : PROFILE_PATCH_LIMITS.maxSourceCharacters, 'edits', errors);
  validateTextEdits(value.inverseEdits, typeof value.updatedSourceLength === 'number' ? value.updatedSourceLength : PROFILE_PATCH_LIMITS.maxSourceCharacters, 'inverseEdits', errors);
  if (!isSafeSafety(value.safety)) errors.push('Profile patch safety metadata is malformed.');
  return { valid: errors.length === 0, errors: errors.slice(0, 20) };
}

export function assertValidProfilePatchDraft(value: unknown): asserts value is ProfilePatchDraftV1 {
  const result = validateProfilePatchDraft(value);
  if (!result.valid) throw new ProfilePatchError('INVALID_DRAFT', result.errors[0] ?? 'Profile patch draft is invalid.');
}

/**
 * Verify both the profile digest and the source-text digest immediately before
 * a host applies a WorkspaceEdit. Applying the proposed edits and checking the
 * resulting digest also detects tampering with the serialized draft itself.
 */
export function verifyProfilePatchDraft(input: ProfilePatchVerificationInputV1): ProfilePatchVerificationResultV1 {
  const errors: string[] = [];
  const validation = validateProfilePatchDraft(input.draft);
  if (!validation.valid) errors.push(...validation.errors);
  const secretValues = normalizeSecretValues(input.secretValues);
  let actualProfileDigest = '';
  let actualSourceDigest = '';
  try {
    const parsed = parseProfileSource(input.sourceText);
    actualProfileDigest = computeProfileDigest(parsed.value, secretValues);
    if (!isRecord(input.profile) || computeProfileDigest(input.profile, secretValues) !== actualProfileDigest) errors.push('The supplied profile does not match the current JSONC source.');
    actualSourceDigest = sha256(input.sourceText);
    if (actualProfileDigest !== input.draft.profileDigest) errors.push('The profile changed since this draft was created.');
    if (actualSourceDigest !== input.draft.sourceDigest) errors.push('The JSONC document changed since this draft was created.');
    if (validation.valid) {
      const updatedText = applyTextEdits(input.sourceText, input.draft.edits);
      const updated = parseProfileSource(updatedText);
      if (updatedText.length !== input.draft.updatedSourceLength) errors.push('The serialized profile edit has an unexpected result length.');
      if (computeProfileDigest(updated.value, secretValues) !== input.draft.updatedProfileDigest) errors.push('The serialized profile edit result does not match its locked digest.');
      const rollbackText = applyTextEdits(updatedText, input.draft.inverseEdits);
      if (rollbackText !== input.sourceText) errors.push('The serialized rollback edit does not restore the locked source.');
    }
  } catch (error) {
    errors.push(error instanceof ProfilePatchError ? error.message : 'The current JSONC source could not be verified.');
  }
  return {
    valid: errors.length === 0,
    profileDigest: { expected: input.draft.profileDigest, actual: actualProfileDigest, matches: Boolean(actualProfileDigest) && actualProfileDigest === input.draft.profileDigest },
    sourceDigest: { expected: input.draft.sourceDigest, actual: actualSourceDigest, matches: Boolean(actualSourceDigest) && actualSourceDigest === input.draft.sourceDigest },
    errors: errors.slice(0, 20),
  };
}

export const verifyPatchDraft = verifyProfilePatchDraft;

function normalizeOperations(value: readonly ProfilePatchOperationV1[]): NormalizedOperation[] {
  const result: NormalizedOperation[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) throw new ProfilePatchError('INVALID_INPUT', `Profile patch operation ${index + 1} must be an object.`);
    const unsupported = Object.keys(raw).filter((key) => !new Set(['path', 'operation', 'value', 'reason', 'category']).has(key));
    if (unsupported.length) throw new ProfilePatchError('INVALID_INPUT', `Profile patch operation ${index + 1} contains an unsupported property.`);
    const path = normalizePath(raw.path);
    const classified = classifyPath(path);
    if (!classified.valid) throw new ProfilePatchError('INVALID_PATH', `Profile patch path ${formatPath(path)} is not allowlisted.`);
    const operation: ProfilePatchOperation = raw.operation === undefined ? 'set' : raw.operation;
    if (operation !== 'set' && operation !== 'remove') throw new ProfilePatchError('INVALID_INPUT', `Profile patch operation ${index + 1} has an unsupported operation.`);
    if (operation === 'remove' && Object.prototype.hasOwnProperty.call(raw, 'value')) throw new ProfilePatchError('INVALID_VALUE', `Remove operation ${index + 1} must not contain a value.`);
    if (operation === 'set') validatePatchValue(path, raw.value);
    if (raw.category !== undefined && raw.category !== classified.category) throw new ProfilePatchError('INVALID_INPUT', `Profile patch category does not match ${formatPath(path)}.`);
    const reason = sanitizeReason(raw.reason, classified.category, path);
    result.push({ path: [...path], operation, ...(operation === 'set' ? { value: cloneJsonValue(raw.value) } : {}), reason, category: classified.category });
  }
  return result.sort((a, b) => comparePaths(a.path, b.path));
}

function assertNoConflictingOperations(operations: readonly NormalizedOperation[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < operations.length; index += 1) {
    const current = operations[index];
    if (!current) continue;
    const key = pathKey(current.path);
    if (seen.has(key)) throw new ProfilePatchError('CONFLICTING_EDITS', `Duplicate profile patch path ${formatPath(current.path)}.`);
    seen.add(key);
    const prior = operations[index - 1];
    if (prior && (isPathPrefix(prior.path, current.path) || isPathPrefix(current.path, prior.path))) throw new ProfilePatchError('CONFLICTING_EDITS', `Conflicting profile patch paths ${formatPath(prior.path)} and ${formatPath(current.path)}.`);
  }
}

function classifyPath(value: unknown): { valid: false } | { valid: true; category: ProfilePatchCategory } {
  if (!Array.isArray(value) || value.length < 2 || value.length > PROFILE_PATCH_LIMITS.maxPathSegments) return { valid: false };
  if (value.some((part) => (typeof part !== 'string' && typeof part !== 'number') || (typeof part === 'string' && (!part || part.length > 128 || DANGEROUS_PATH_PARTS.has(part) || !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(part))) || (typeof part === 'number' && (!Number.isInteger(part) || part < 0 || part > PROFILE_PATCH_LIMITS.maxArrayItems)))) return { valid: false };
  if (REQUEST_ROOTS.some((root) => pathStartsWith(value, root))) {
    const root = REQUEST_ROOTS.find((candidate) => pathStartsWith(value, candidate));
    if (!root) return { valid: false };
    const rest = value.slice(root.length);
    if (rest.length === 1 && typeof rest[0] === 'string' && REQUEST_TIMING_FIELDS.has(rest[0])) return { valid: true, category: 'request-timing' };
    if (rest.length === 2 && rest[0] === 'reconnect' && typeof rest[1] === 'string' && RETRY_FIELDS.has(rest[1])) return { valid: true, category: 'retry-timing' };
    return { valid: false };
  }
  if (value[0] === 'stream' && value.length === 2 && typeof value[1] === 'string' && STREAM_FIELDS.has(value[1])) return { valid: true, category: 'stream-parser' };
  if (value[0] !== 'stream' || value[1] !== 'mappings' || typeof value[2] !== 'number' || value.length < 4) return { valid: false };
  const mappingPath = value.slice(3);
  if (mappingPath[0] === 'match' && mappingPath.length === 2 && typeof mappingPath[1] === 'string' && MATCH_FIELDS.has(mappingPath[1])) return { valid: true, category: 'mapping' };
  if (mappingPath[0] === 'continue' && mappingPath.length === 1) return { valid: true, category: 'mapping' };
  if (mappingPath[0] === 'emit' && mappingPath.length === 2 && mappingPath[1] === 'type') return { valid: true, category: 'mapping' };
  if (mappingPath[0] === 'emit' && typeof mappingPath[1] === 'string' && EMIT_FIELDS.has(mappingPath[1]) && mappingPath.length === 3 && mappingPath[2] === 'path') return { valid: true, category: 'mapping' };
  return { valid: false };
}

function validatePatchValue(path: ProfilePatchPath, value: unknown): void {
  if (value === undefined) throw new ProfilePatchError('INVALID_VALUE', `A set operation for ${formatPath(path)} requires a value.`);
  const field = path.at(-1);
  if (field === undefined) throw new ProfilePatchError('INVALID_PATH', 'Profile patch path is empty.');
  if (REQUEST_TIMING_FIELDS.has(String(field))) {
    if (!isBoundedInteger(value, 1, 900_000)) throw new ProfilePatchError('INVALID_VALUE', `${String(field)} must be an integer from 1 to 900000.`);
    return;
  }
  if (field === 'maxAttempts') {
    if (!isBoundedInteger(value, 0, 5)) throw new ProfilePatchError('INVALID_VALUE', 'maxAttempts must be an integer from 0 to 5.');
    return;
  }
  if (field === 'baseDelayMs') {
    if (!isBoundedInteger(value, 0, 30_000)) throw new ProfilePatchError('INVALID_VALUE', 'baseDelayMs must be an integer from 0 to 30000.');
    return;
  }
  if (field === 'maxDelayMs') {
    if (!isBoundedInteger(value, 0, 120_000)) throw new ProfilePatchError('INVALID_VALUE', 'maxDelayMs must be an integer from 0 to 120000.');
    return;
  }
  if (field === 'retryOnStatuses') {
    if (!Array.isArray(value) || value.length > PROFILE_PATCH_LIMITS.maxRetryStatuses || value.some((item) => !isBoundedInteger(item, 100, 599)) || new Set(value).size !== value.length) throw new ProfilePatchError('INVALID_VALUE', 'retryOnStatuses must contain unique HTTP statuses from 100 to 599.');
    return;
  }
  if (field === 'transport') {
    if (!isString(value) || !['sse', 'ndjson', 'json', 'text-stream', 'fixture'].includes(value)) throw new ProfilePatchError('INVALID_VALUE', 'transport is unsupported.');
    return;
  }
  if (field === 'dataFormat') {
    if (!isString(value) || !['json', 'text'].includes(value)) throw new ProfilePatchError('INVALID_VALUE', 'dataFormat is unsupported.');
    return;
  }
  if (field === 'mappingMode') {
    if (!isString(value) || !['firstMatch', 'allMatches'].includes(value)) throw new ProfilePatchError('INVALID_VALUE', 'mappingMode is unsupported.');
    return;
  }
  if (field === 'unexpectedEndPolicy') {
    if (!isString(value) || !['fail', 'completeWithWarning'].includes(value)) throw new ProfilePatchError('INVALID_VALUE', 'unexpectedEndPolicy is unsupported.');
    return;
  }
  if (field === 'doneValue') {
    // The profile schema intentionally leaves the sentinel open-ended, but a
    // remediation must still keep it printable, bounded, and non-sensitive.
    // An empty string remains valid for schema compatibility; callers can use
    // remove when they want the runtime default of [DONE].
    if (!isString(value) || value.length > PROFILE_PATCH_LIMITS.maxStringValueLength || hasDisallowedControlCharacters(value) || containsSensitiveMaterial(value)) throw new ProfilePatchError('INVALID_VALUE', 'doneValue must be a bounded printable string without URLs or secrets.');
    return;
  }
  if (field === 'continue') {
    if (typeof value !== 'boolean') throw new ProfilePatchError('INVALID_VALUE', 'continue must be boolean.');
    return;
  }
  if (field === 'type') {
    if (!isString(value) || value.length > 96 || (!SAFE_NORMALIZED_EVENT_TYPES.has(value) && !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/.test(value))) throw new ProfilePatchError('INVALID_VALUE', 'Mapping event type is unsupported.');
    return;
  }
  if (field === 'path') {
    if (!isString(value) || value.length > PROFILE_PATCH_LIMITS.maxPathString || !SAFE_MAPPING_PATH.test(value) || containsSensitiveMaterial(value)) throw new ProfilePatchError('INVALID_VALUE', 'Mapping path is invalid or unsafe.');
    return;
  }
  if (field === 'event') {
    if (!isString(value) || value.length > PROFILE_PATCH_LIMITS.maxStringValueLength || !SAFE_EVENT_NAME.test(value) || containsSensitiveMaterial(value)) throw new ProfilePatchError('INVALID_VALUE', 'Mapping event name is invalid or unsafe.');
    return;
  }
  if (field === 'operator') {
    if (!isString(value) || !['equals', 'notEquals', 'exists', 'notExists', 'oneOf', 'contains', 'startsWith', 'endsWith', 'regex'].includes(value)) throw new ProfilePatchError('INVALID_VALUE', 'Mapping match operator is unsupported.');
    return;
  }
  if (field === 'value') {
    validateBoundedJsonValue(value, 0, true);
    return;
  }
  if (typeof path.at(-2) === 'string' && EMIT_FIELDS.has(String(path.at(-2))) && field === 'path') return;
  throw new ProfilePatchError('INVALID_VALUE', `Value for ${formatPath(path)} is not supported.`);
}

function validateBoundedJsonValue(value: unknown, depth: number, scalarOnly: boolean): void {
  if (depth > 4) throw new ProfilePatchError('OVERSIZED', 'Mapping value is too deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProfilePatchError('INVALID_VALUE', 'Mapping value must be finite.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > PROFILE_PATCH_LIMITS.maxStringValueLength || hasDisallowedControlCharacters(value) || containsSensitiveMaterial(value)) throw new ProfilePatchError('INVALID_VALUE', 'Mapping value is invalid or unsafe.');
    return;
  }
  if (Array.isArray(value)) {
    if (scalarOnly && value.length > PROFILE_PATCH_LIMITS.maxArrayItems) throw new ProfilePatchError('OVERSIZED', 'Mapping value array is too large.');
    for (const item of value) {
      if (scalarOnly && item && typeof item === 'object') throw new ProfilePatchError('INVALID_VALUE', 'Mapping match values may contain only scalar values.');
      validateBoundedJsonValue(item, depth + 1, scalarOnly);
    }
    return;
  }
  throw new ProfilePatchError('INVALID_VALUE', 'Mapping value must be a bounded scalar or scalar array.');
}

function makeJsoncEdit(source: string, tree: Node, operation: NormalizedOperation): ProfilePatchTextEditV1 {
  const node = findNodeAtLocation(tree, [...operation.path]);
  if (operation.operation === 'set' && node) return { offset: node.offset, length: node.length, content: serializeJsonValue(operation.value) };
  if (operation.operation === 'remove' && node) return makeRemoveEdit(source, tree, operation.path, node);
  if (operation.operation === 'remove') throw new ProfilePatchError('NO_OP', `The profile path ${formatPath(operation.path)} is not present.`);
  const existingPrefix = findExistingPrefix(tree, operation.path);
  if (!existingPrefix.node || existingPrefix.path.length >= operation.path.length || typeof operation.path[existingPrefix.path.length] !== 'string') throw new ProfilePatchError('INVALID_PATH', `Cannot add profile path ${formatPath(operation.path)}.`);
  const nested = buildNestedValue(operation.path.slice(existingPrefix.path.length + 1), operation.value);
  return makeInsertPropertyEdit(source, existingPrefix.node, operation.path[existingPrefix.path.length] as string, nested);
}

function findExistingPrefix(tree: Node, path: ProfilePatchPath): { path: ProfilePatchPath; node?: Node } {
  let bestPath: ProfilePatchPath = [];
  let bestNode: Node | undefined = tree;
  for (let length = 1; length <= path.length; length += 1) {
    const node = findNodeAtLocation(tree, [...path.slice(0, length)]);
    if (!node) break;
    bestPath = path.slice(0, length);
    bestNode = node;
  }
  return { path: bestPath, node: bestNode };
}

function buildNestedValue(missingPath: ProfilePatchPath, value: unknown): unknown {
  let result = cloneJsonValue(value);
  for (let index = missingPath.length - 1; index >= 0; index -= 1) {
    const key = missingPath[index];
    if (typeof key !== 'string') throw new ProfilePatchError('INVALID_PATH', 'Array entries cannot be created by a profile remediation.');
    result = { [key]: result };
  }
  return result;
}

function makeInsertPropertyEdit(source: string, objectNode: Node, key: string, value: unknown): ProfilePatchTextEditV1 {
  if (objectNode.type !== 'object') throw new ProfilePatchError('INVALID_PATH', 'Profile remediation can only add object properties.');
  const open = source.indexOf('{', objectNode.offset);
  const close = objectNode.offset + objectNode.length - 1;
  if (open < objectNode.offset || close <= open || source[close] !== '}') throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC object is malformed.');
  const propertyText = `${JSON.stringify(key)}: ${serializeJsonValue(value)}`;
  const children = objectNode.children ?? [];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectIndent(source, objectNode, children, newline);
  const childIndent = indent.parent + indent.unit;
  if (children.length === 0) {
    const interior = source.slice(open + 1, close);
    if (interior.includes(newline)) return { offset: open + 1, length: 0, content: `${newline}${childIndent}${propertyText}` };
    return { offset: open + 1, length: 0, content: propertyText };
  }
  const last = children[children.length - 1];
  if (!last) throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC object has no usable property.');
  const tail = source.slice(last.offset + last.length, close);
  const multiline = source.slice(objectNode.offset, close).includes(newline);
  const hasTrailingComment = /\/\//.test(tail.split(newline)[0] ?? '') || /\/\*/.test(tail);
  const hasTrailingComma = /^\s*,/.test(tail);
  if (hasTrailingComment || hasTrailingComma) {
    return { offset: last.offset, length: 0, content: `${propertyText}${multiline ? `,${newline}${childIndent}` : ', '}` };
  }
  return { offset: last.offset + last.length, length: 0, content: `${multiline ? `,${newline}${childIndent}` : ', '}${propertyText}` };
}

function makeRemoveEdit(source: string, tree: Node, path: ProfilePatchPath, valueNode: Node): ProfilePatchTextEditV1 {
  const parentPath = path.slice(0, -1);
  const parent = findNodeAtLocation(tree, [...parentPath]);
  if (!parent || parent.type !== 'object') throw new ProfilePatchError('INVALID_PATH', 'Only object properties can be removed by a profile remediation.');
  const propertyIndex = (parent.children ?? []).findIndex((child) => child.children?.[1]?.offset === valueNode.offset);
  if (propertyIndex < 0) throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC property could not be located.');
  const property = parent.children?.[propertyIndex];
  if (!property) throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC property is malformed.');
  const children = parent.children ?? [];
  if (propertyIndex < children.length - 1) {
    const next = children[propertyIndex + 1];
    if (!next) throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC property sequence is malformed.');
    const between = source.slice(property.offset + property.length, next.offset);
    const comma = between.indexOf(',');
    if (comma < 0) throw new ProfilePatchError('INVALID_SOURCE', 'The target JSONC property has no separator.');
    return { offset: property.offset, length: property.length + comma + 1, content: '' };
  }
  const previous = children[propertyIndex - 1];
  if (previous) {
    const between = source.slice(previous.offset + previous.length, property.offset);
    const comma = between.indexOf(',');
    if (comma >= 0) {
      const absoluteComma = previous.offset + previous.length + comma;
      return { offset: absoluteComma, length: property.offset + property.length - absoluteComma, content: '' };
    }
  }
  const after = source.slice(property.offset + property.length, parent.offset + parent.length - 1);
  const trailingComma = after.indexOf(',');
  return { offset: property.offset, length: property.length + (trailingComma >= 0 ? trailingComma + 1 : 0), content: '' };
}

function composeSequentialEdits(source: string, sequence: readonly SequentialEdit[]): ComposedEdits {
  let text = source;
  let map = Array.from({ length: source.length }, (_, index) => index);
  for (const edit of sequence) {
    if (edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > text.length) throw new ProfilePatchError('CONFLICTING_EDITS', 'A sequential JSONC edit is outside the current text.');
    const oldContent = text.slice(edit.offset, edit.offset + edit.length);
    if (oldContent !== edit.oldContent) throw new ProfilePatchError('CONFLICTING_EDITS', 'A sequential JSONC edit no longer matches its source range.');
    text = text.slice(0, edit.offset) + edit.content + text.slice(edit.offset + edit.length);
    map = [...map.slice(0, edit.offset), ...new Array<number>(edit.content.length).fill(-1), ...map.slice(edit.offset + edit.length)];
  }
  return { text, edits: deriveComposedEdits(source, text, map), map };
}

function deriveComposedEdits(source: string, target: string, map: readonly number[]): ProfilePatchTextEditV1[] {
  const result: ProfilePatchTextEditV1[] = [];
  let sourceCursor = 0;
  let targetCursor = 0;
  while (targetCursor < target.length) {
    if (map[targetCursor] === sourceCursor) {
      sourceCursor += 1;
      targetCursor += 1;
      continue;
    }
    let anchor = targetCursor;
    while (anchor < target.length && (map[anchor] ?? -1) < sourceCursor) anchor += 1;
    if (anchor >= target.length) {
      result.push({ offset: sourceCursor, length: source.length - sourceCursor, content: target.slice(targetCursor) });
      sourceCursor = source.length;
      targetCursor = target.length;
      break;
    }
    const nextSource = map[anchor] ?? source.length;
    result.push({ offset: sourceCursor, length: Math.max(0, nextSource - sourceCursor), content: target.slice(targetCursor, anchor) });
    sourceCursor = nextSource;
    targetCursor = anchor;
  }
  if (sourceCursor < source.length) result.push({ offset: sourceCursor, length: source.length - sourceCursor, content: '' });
  return coalesceEdits(result.filter((edit) => edit.length > 0 || edit.content.length > 0));
}

function coalesceEdits(edits: readonly ProfilePatchTextEditV1[]): ProfilePatchTextEditV1[] {
  const result: ProfilePatchTextEditV1[] = [];
  for (const edit of edits) {
    const prior = result.at(-1);
    if (prior && prior.offset + prior.length === edit.offset) {
      prior.length += edit.length;
      prior.content += edit.content;
    } else result.push({ ...edit });
  }
  return result;
}

function parseProfileSource(sourceText: string): ParsedSource {
  if (typeof sourceText !== 'string' || sourceText.length === 0 || sourceText.length > PROFILE_PATCH_LIMITS.maxSourceCharacters) throw new ProfilePatchError('INVALID_SOURCE', 'Profile JSONC source is empty or too large.');
  const errors: unknown[] = [];
  const tree = parseTree(sourceText, errors as never[], { allowTrailingComma: true, disallowComments: false });
  const value = parse(sourceText, errors as never[], { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (!tree || tree.type !== 'object' || !isRecord(value) || errors.length > 0) throw new ProfilePatchError('INVALID_SOURCE', 'Profile JSONC source is malformed.');
  if (hasDuplicateObjectKeys(tree)) throw new ProfilePatchError('INVALID_SOURCE', 'Profile JSONC source contains duplicate object keys.');
  return { value, tree };
}

function hasDuplicateObjectKeys(node: Node): boolean {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const child of node.children ?? []) {
      const keyNode = child.children?.[0];
      if (!keyNode || typeof keyNode.value !== 'string') return true;
      if (keys.has(keyNode.value)) return true;
      keys.add(keyNode.value);
    }
  }
  return (node.children ?? []).some((child) => hasDuplicateObjectKeys(child));
}

function getPathValue(root: unknown, path: ProfilePatchPath): unknown {
  let value = root;
  for (const part of path) {
    if (Array.isArray(value) && typeof part === 'number') value = value[part];
    else if (isRecord(value) && typeof part === 'string') value = value[part];
    else return undefined;
  }
  return value;
}

function summarizeValue(value: unknown, secretValues: readonly string[]): ProfilePatchValueSummaryV1 {
  if (value === undefined) return { kind: 'missing' };
  if (value === null) return { kind: 'null', value: null };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number', value };
  if (typeof value === 'string') {
    const safe = value.length <= 64 && !containsSensitiveMaterial(value, secretValues) && !hasDisallowedControlCharacters(value);
    return safe ? { kind: 'string', value } : { kind: 'string', length: value.length, digest: digestValue(value, { secretValues }) };
  }
  if (Array.isArray(value)) return { kind: 'array', length: value.length, digest: digestValue(value, { secretValues }) };
  if (isRecord(value)) return { kind: 'object', keys: Object.keys(value).length, digest: digestValue(value, { secretValues }) };
  return { kind: 'string', length: 0 };
}

function validateChanges(changes: readonly unknown[], errors: string[]): void {
  const seen = new Set<string>();
  for (const raw of changes) {
    if (!isRecord(raw)) { errors.push('Profile patch change must be an object.'); continue; }
    const path = normalizePathForValidation(raw.path);
    if (!path || !classifyPath(path).valid) errors.push('Profile patch change path is not allowlisted.');
    else {
      const key = pathKey(path);
      if (seen.has(key)) errors.push('Profile patch changes contain duplicate paths.');
      seen.add(key);
      if (raw.pathLabel !== formatPath(path)) errors.push('Profile patch change pathLabel is not canonical.');
      const category = classifyPath(path);
      if (!category.valid || raw.category !== category.category) errors.push('Profile patch change category is invalid.');
    }
    if (raw.operation !== 'set' && raw.operation !== 'remove') errors.push('Profile patch change operation is invalid.');
    if (!isValidSummary(raw.before) || !isValidSummary(raw.after)) errors.push('Profile patch change summary is malformed.');
    if (!isBoundedString(raw.reason, PROFILE_PATCH_LIMITS.maxReasonLength) || containsSensitiveMaterial(raw.reason)) errors.push('Profile patch change reason is unsafe or too long.');
  }
}

function isValidSummary(value: unknown): value is ProfilePatchValueSummaryV1 {
  if (!isRecord(value) || !['missing', 'null', 'boolean', 'number', 'string', 'array', 'object'].includes(String(value.kind))) return false;
  if (value.value !== undefined && value.value !== null && typeof value.value !== 'string' && typeof value.value !== 'number' && typeof value.value !== 'boolean') return false;
  if (value.length !== undefined && !isBoundedInteger(value.length, 0, PROFILE_PATCH_LIMITS.maxStringValueLength * PROFILE_PATCH_LIMITS.maxArrayItems)) return false;
  if (value.keys !== undefined && !isBoundedInteger(value.keys, 0, PROFILE_PATCH_LIMITS.maxTopLevelKeys * PROFILE_PATCH_LIMITS.maxArrayItems)) return false;
  if (value.digest !== undefined && !isDigest(value.digest)) return false;
  return true;
}

function validateTextEdits(value: unknown, sourceLength: number, name: string, errors: string[] = []): void {
  if (!Array.isArray(value) || value.length > PROFILE_PATCH_LIMITS.maxOperations) { errors.push(`${name} are out of bounds.`); return; }
  let total = 0;
  let previousEnd = -1;
  for (const edit of value) {
    if (!isRecord(edit) || !isBoundedInteger(edit.offset, 0, sourceLength) || !isBoundedInteger(edit.length, 0, sourceLength) || Number(edit.offset) + Number(edit.length) > sourceLength || !isSafeEditContent(edit.content) || containsSensitiveMaterial(edit.content)) { errors.push(`${name} contain an unsafe edit.`); continue; }
    if (Number(edit.offset) < previousEnd) errors.push(`${name} contain overlapping edits.`);
    previousEnd = Number(edit.offset) + Number(edit.length);
    total += edit.content.length;
  }
  if (total > PROFILE_PATCH_LIMITS.maxTotalEditCharacters) errors.push(`${name} exceed the total edit limit.`);
}

function isSafeSafety(value: unknown): boolean {
  return isRecord(value)
    && value.allowlisted === true
    && value.networkSettingsChanged === false
    && value.secretSettingsChanged === false
    && value.requiresConfirmation === true
    && value.contentRedacted === true
    && Object.keys(value).length === 5;
}

function isSafeEditContent(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PROFILE_PATCH_LIMITS.maxEditCharacters && !hasDisallowedControlCharacters(value, true);
}

function normalizePath(value: unknown): ProfilePatchPath {
  const path = normalizePathForValidation(value);
  if (!path) throw new ProfilePatchError('INVALID_PATH', 'Profile patch path must contain bounded string and array-index segments.');
  return path;
}

function normalizePathForValidation(value: unknown): ProfilePatchPath | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROFILE_PATCH_LIMITS.maxPathSegments) return undefined;
  if (value.some((part) => (typeof part === 'string' && (!part || part.length > 128 || DANGEROUS_PATH_PARTS.has(part) || !/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(part))) || (typeof part === 'number' && (!Number.isInteger(part) || part < 0 || part > PROFILE_PATCH_LIMITS.maxArrayItems)) || (typeof part !== 'string' && typeof part !== 'number'))) return undefined;
  return value as ProfilePatchPath;
}

function sanitizeReason(value: unknown, category: ProfilePatchCategory, path: ProfilePatchPath): string {
  const fallback = SAFE_REASON_FALLBACK[category];
  if (typeof value !== 'string' || !value.trim()) return fallback;
  let reason = replaceControlCharacters(value.trim()).replace(URL_PATTERN, '[REDACTED_URL]').replace(SECRET_PATTERN, '[REDACTED_SECRET]');
  if (reason.length > PROFILE_PATCH_LIMITS.maxReasonLength) reason = `${reason.slice(0, PROFILE_PATCH_LIMITS.maxReasonLength - 1)}…`;
  if (!reason.trim() || containsSensitiveMaterial(reason)) return `${fallback} (${formatPath(path)}).`;
  return reason;
}

function containsSensitiveMaterial(value: unknown, secretValues: readonly string[] = []): boolean {
  if (typeof value !== 'string') return false;
  return URL_PATTERN.test(value) || SECRET_PATTERN.test(value) || secretValues.some((secret) => secret.length > 0 && value.includes(secret));
}

function isSafeReplacementPath(path: ProfilePatchPath): boolean {
  return PATH_LIKE_KEYS.has(String(path.at(-1))) || String(path.at(-1)) === 'continue' || String(path.at(-1)) === 'retryOnStatuses' || REQUEST_TIMING_FIELDS.has(String(path.at(-1))) || RETRY_FIELDS.has(String(path.at(-1)));
}

function serializeJsonValue(value: unknown): string {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new ProfilePatchError('INVALID_VALUE', 'Profile patch value is not JSON-compatible.'); }
  if (serialized === undefined || serialized.length > PROFILE_PATCH_LIMITS.maxEditCharacters) throw new ProfilePatchError('OVERSIZED', 'Profile patch value is too large.');
  return serialized;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]));
  throw new ProfilePatchError('INVALID_VALUE', 'Profile patch value is not JSON-compatible.');
}

function detectIndent(source: string, objectNode: Node, children: readonly Node[], newline: string): { parent: string; unit: string } {
  const lineStart = source.lastIndexOf(newline, objectNode.offset - 1) + newline.length;
  const parent = /^[ \t]*/.exec(source.slice(lineStart, objectNode.offset))?.[0] ?? '';
  const first = children[0];
  if (first) {
    const childLineStart = source.lastIndexOf(newline, first.offset - 1) + newline.length;
    const childIndent = /^[ \t]*/.exec(source.slice(childLineStart, first.offset))?.[0] ?? '';
    if (childIndent.startsWith(parent) && childIndent.length > parent.length) return { parent, unit: childIndent.slice(parent.length) };
  }
  return { parent, unit: source.includes('\t') ? '\t' : '  ' };
}

function formatPath(path: ProfilePatchPath): string {
  return path.map((part, index) => typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`).join('');
}

function pathKey(path: ProfilePatchPath): string {
  return path.map((part) => typeof part === 'number' ? `#${part}` : `$${part}`).join('/');
}

function comparePaths(a: ProfilePatchPath, b: ProfilePatchPath): number {
  const left = pathKey(a);
  const right = pathKey(b);
  return left.localeCompare(right);
}

function isPathPrefix(prefix: ProfilePatchPath, value: ProfilePatchPath): boolean {
  return prefix.length < value.length && prefix.every((part, index) => part === value[index]);
}

function pathStartsWith(path: readonly ProfilePatchPathPart[], prefix: readonly string[]): boolean {
  return path.length > prefix.length && prefix.every((part, index) => path[index] === part);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try { return stableStringify(left) === stableStringify(right); } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === 'string'; }
function isDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST_PATTERN.test(value); }
function isBoundedString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !hasDisallowedControlCharacters(value); }
function isBoundedInteger(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }
function normalizeSecretValues(value: readonly unknown[] | undefined): string[] { return (value ?? []).filter((item): item is string => typeof item === 'string' && item.length > 0).sort((a, b) => b.length - a.length || a.localeCompare(b)); }

function hasDisallowedControlCharacters(value: string, allowFormattingWhitespace = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) {
      if (allowFormattingWhitespace) continue;
      return true;
    }
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 31 || code === 127 ? ' ' : value[index];
  }
  return result;
}
