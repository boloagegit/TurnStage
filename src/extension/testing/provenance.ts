import { createHash } from 'node:crypto';

export const PROVENANCE_FORMAT = 'turnstage-provenance-manifest' as const;
export const PROVENANCE_VERSION = 1 as const;
export const PROVENANCE_REDACTION_LEVEL = 'metadata-only' as const;
export const PROVENANCE_REDACTION_MARKER = '[REDACTED]' as const;
export const PROVENANCE_PAYLOAD_DIGEST_MARKER = '[PAYLOAD_DIGEST]' as const;

const MAX_MANIFEST_STRING = 4_096;
const MAX_RUN_ID = 256;
const MAX_SELECTED_TESTS = 10_000;
const MAX_FILES = 10_000;
const MAX_NODES = 100_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|api[-_]?key|secret|token|password|credential|credentials|private[-_]?key)$/i;
const PAYLOAD_KEY = /^(?:body|request[-_]?body|response[-_]?body|response[-_]?body[-_]?preview|raw|raw[-_]?event|prompt|input|output|content|message[-_]?content)$/i;

export interface ProvenanceEnvironmentIdentity {
  id: string;
  name?: string;
  provider?: string;
  region?: string;
  fingerprint?: string;
}

export type ProvenanceFileContents = string | Uint8Array | readonly number[];

export interface ProvenanceFileInput {
  path: string;
  contents: ProvenanceFileContents;
}

export interface ProvenanceInput {
  runId: string;
  /** Supplying a fixed timestamp makes the complete manifest reproducible. */
  generatedAt?: string;
  runnerVersion: string;
  runnerKind?: 'cli' | 'extension' | 'unknown';
  extensionVersion?: string;
  gitSha?: string;
  gitRef?: string;
  selectedTestIds: readonly string[];
  policy?: unknown;
  suite?: unknown;
  profile?: unknown;
  result?: unknown;
  evidence?: unknown;
  /** Only the safe identity fields are copied; variables and secret references are ignored. */
  environmentIdentity?: ProvenanceEnvironmentIdentity;
  /** Known values are used only to scrub digest inputs; they are never persisted. */
  secretValues?: readonly unknown[];
  evidenceFiles?: readonly ProvenanceFileInput[];
}

export interface ProvenanceFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProvenanceDigests {
  suiteDigest: string;
  profileDigest: string;
  resultDigest: string;
  evidenceDigest: string;
  evidenceManifestDigest: string;
}

export interface ProvenanceManifest {
  format: typeof PROVENANCE_FORMAT;
  version: typeof PROVENANCE_VERSION;
  generatedAt: string;
  runId: string;
  runner: {
    kind: NonNullable<ProvenanceInput['runnerKind']>;
    version: string;
    extensionVersion?: string;
  };
  git?: { sha?: string; ref?: string };
  selectedTestIds: string[];
  policy: unknown;
  environment?: ProvenanceEnvironmentIdentity;
  redaction: {
    level: typeof PROVENANCE_REDACTION_LEVEL;
    secretsExcluded: true;
    excludedFields: readonly string[];
  };
  files: ProvenanceFileDigest[];
  digests: ProvenanceDigests;
  /** Flat aliases keep the manifest convenient for CI consumers. */
  suiteDigest: string;
  profileDigest: string;
  resultDigest: string;
  evidenceDigest: string;
  evidenceManifestDigest: string;
  /** Digest over this manifest with this field omitted. */
  manifestDigest: string;
}

export interface ProvenanceExpectedValues {
  suite?: unknown;
  profile?: unknown;
  result?: unknown;
  evidence?: unknown;
  evidenceFiles?: readonly ProvenanceFileInput[];
  secretValues?: readonly unknown[];
}

export interface ProvenanceVerificationResult {
  valid: boolean;
  manifestValid: boolean;
  checks: {
    manifest: boolean;
    suite?: boolean;
    profile?: boolean;
    result?: boolean;
    evidence?: boolean;
    evidenceManifest?: boolean;
    files?: boolean;
    redaction?: boolean;
  };
  errors: string[];
}

export class ProvenanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceInputError';
  }
}

/**
 * Build a metadata-only manifest. Raw profiles, suites, results, evidence and
 * file contents are never copied into the manifest; only their redacted
 * cryptographic digests are retained.
 */
export function createProvenanceManifest(input: ProvenanceInput): ProvenanceManifest {
  validateInput(input);
  const secretValues = normalizeSecrets(input.secretValues);
  const files = createFileDigests(input.evidenceFiles ?? [], secretValues);
  const digests: ProvenanceDigests = {
    suiteDigest: digestValue(input.suite, { secretValues }),
    profileDigest: digestValue(input.profile, { secretValues }),
    resultDigest: digestValue(input.result, { secretValues }),
    evidenceDigest: digestValue(input.evidence, { secretValues }),
    evidenceManifestDigest: digestValue(files),
  };
  const manifest: Omit<ProvenanceManifest, 'manifestDigest'> = {
    format: PROVENANCE_FORMAT,
    version: PROVENANCE_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runId: input.runId,
    runner: {
      kind: input.runnerKind ?? 'unknown',
      version: input.runnerVersion,
      ...(input.extensionVersion ? { extensionVersion: input.extensionVersion } : {}),
    },
    ...(input.gitSha || input.gitRef ? { git: { ...(input.gitSha ? { sha: input.gitSha } : {}), ...(input.gitRef ? { ref: input.gitRef } : {}) } } : {}),
    selectedTestIds: [...input.selectedTestIds],
    policy: sanitizeForManifest(input.policy, secretValues),
    ...(input.environmentIdentity ? { environment: sanitizeEnvironmentIdentity(input.environmentIdentity, secretValues) } : {}),
    redaction: {
      level: PROVENANCE_REDACTION_LEVEL,
      secretsExcluded: true,
      excludedFields: ['secretValues', 'requestHeaders', 'responseHeaders', 'requestBody', 'responseBody', 'rawEvents', 'messageContent'],
    },
    files,
    digests,
    suiteDigest: digests.suiteDigest,
    profileDigest: digests.profileDigest,
    resultDigest: digests.resultDigest,
    evidenceDigest: digests.evidenceDigest,
    evidenceManifestDigest: digests.evidenceManifestDigest,
  };
  const manifestDigest = sha256(stableStringify(manifest));
  return { ...manifest, manifestDigest };
}

/** Verify the manifest's own digest and, when supplied, its source values and evidence files. */
export function verifyProvenanceManifest(value: unknown, expected: ProvenanceExpectedValues = {}): ProvenanceVerificationResult {
  const errors: string[] = [];
  const checks: ProvenanceVerificationResult['checks'] = { manifest: false };
  if (!isRecord(value)) return { valid: false, manifestValid: false, checks, errors: ['Manifest must be an object.'] };
  if (value.format !== PROVENANCE_FORMAT) errors.push(`Unsupported provenance format: ${String(value.format)}.`);
  if (value.version !== PROVENANCE_VERSION) errors.push(`Unsupported provenance version: ${String(value.version)}.`);
  const parsed = parseManifest(value, errors);
  if (!parsed) return { valid: false, manifestValid: false, checks, errors };

  const unsigned = { ...parsed } as Partial<ProvenanceManifest>;
  delete unsigned.manifestDigest;
  checks.manifest = sha256(stableStringify(unsigned)) === parsed.manifestDigest;
  if (!checks.manifest) errors.push('Manifest digest does not match its contents.');

  const expectedSecrets = normalizeSecrets(expected.secretValues);
  if (expected.secretValues !== undefined) {
    const serialized = stableStringify(parsed);
    checks.redaction = !expectedSecrets.some((secret) => typeof secret === 'string' && secret.length > 0 && serialized.includes(secret));
    if (!checks.redaction) errors.push('Manifest contains a known secret value.');
  }

  if (expected.suite !== undefined) checks.suite = checkDigest('suiteDigest', parsed.digests.suiteDigest, expected.suite, expectedSecrets, errors);
  if (expected.profile !== undefined) checks.profile = checkDigest('profileDigest', parsed.digests.profileDigest, expected.profile, expectedSecrets, errors);
  if (expected.result !== undefined) checks.result = checkDigest('resultDigest', parsed.digests.resultDigest, expected.result, expectedSecrets, errors);
  if (expected.evidence !== undefined) checks.evidence = checkDigest('evidenceDigest', parsed.digests.evidenceDigest, expected.evidence, expectedSecrets, errors);
  if (expected.evidenceFiles !== undefined) {
    const expectedFiles = createFileDigests(expected.evidenceFiles, expectedSecrets);
    checks.evidenceManifest = parsed.digests.evidenceManifestDigest === digestValue(expectedFiles);
    checks.files = filesEqual(parsed.files, expectedFiles);
    if (!checks.evidenceManifest) errors.push('Evidence file manifest digest does not match.');
    if (!checks.files) errors.push('Evidence files are missing, reordered, or changed.');
  }

  const allChecks = Object.values(checks);
  const valid = allChecks.every((check) => check !== false);
  return { valid, manifestValid: checks.manifest, checks, errors };
}

export const verifyManifest = verifyProvenanceManifest;
export const createEvidenceManifest = createProvenanceManifest;

export interface DigestOptions {
  secretValues?: readonly unknown[];
  /** Payload fields are represented by a digest marker rather than copied. */
  redactPayloads?: boolean;
}

/** SHA-256 of a canonical, key-ordered, cycle-checked JSON projection. */
export function digestValue(value: unknown, options: DigestOptions = {}): string {
  const secrets = normalizeSecrets(options.secretValues);
  const sanitized = sanitizeForDigest(value, secrets, options.redactPayloads ?? false);
  return sha256(stableStringify(sanitized));
}

/** Deterministic JSON encoding: object keys are sorted, array order is retained. */
export function stableStringify(value: unknown): string {
  const state: WalkState = { seen: new WeakSet<object>(), nodes: 0 };
  return JSON.stringify(canonicalize(value, state));
}

/** Public redaction helper for callers that need a safe metadata projection. */
export function sanitizeForManifest(value: unknown, secretValues: readonly unknown[] = []): unknown {
  const state: WalkState = { seen: new WeakSet<object>(), nodes: 0 };
  return sanitize(value, normalizeSecrets(secretValues), state, true);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateInput(input: ProvenanceInput): void {
  if (!input || typeof input !== 'object') throw new ProvenanceInputError('Provenance input is required.');
  if (!isSafeString(input.runId, MAX_RUN_ID) || !input.runId.trim()) throw new ProvenanceInputError('runId must be a non-empty bounded string.');
  if (!isSafeString(input.runnerVersion, MAX_MANIFEST_STRING) || !input.runnerVersion.trim()) throw new ProvenanceInputError('runnerVersion must be a non-empty bounded string.');
  if (input.extensionVersion !== undefined && !isSafeString(input.extensionVersion, MAX_MANIFEST_STRING)) throw new ProvenanceInputError('extensionVersion must be a bounded string.');
  if (input.gitSha !== undefined && !isSafeString(input.gitSha, MAX_MANIFEST_STRING)) throw new ProvenanceInputError('gitSha must be a bounded string.');
  if (input.gitRef !== undefined && !isSafeString(input.gitRef, MAX_MANIFEST_STRING)) throw new ProvenanceInputError('gitRef must be a bounded string.');
  if (input.generatedAt !== undefined && !isSafeString(input.generatedAt, MAX_MANIFEST_STRING)) throw new ProvenanceInputError('generatedAt must be a bounded string.');
  if (!Array.isArray(input.selectedTestIds) || input.selectedTestIds.length > MAX_SELECTED_TESTS || input.selectedTestIds.some((id) => !isSafeString(id, MAX_MANIFEST_STRING) || !id.trim())) throw new ProvenanceInputError(`selectedTestIds must contain at most ${MAX_SELECTED_TESTS} non-empty strings.`);
  if (input.runnerKind !== undefined && !['cli', 'extension', 'unknown'].includes(input.runnerKind)) throw new ProvenanceInputError('runnerKind is invalid.');
  if (input.environmentIdentity !== undefined) validateEnvironmentIdentity(input.environmentIdentity);
  if (input.evidenceFiles !== undefined && (!Array.isArray(input.evidenceFiles) || input.evidenceFiles.length > MAX_FILES)) throw new ProvenanceInputError(`evidenceFiles must contain at most ${MAX_FILES} files.`);
}

function validateEnvironmentIdentity(value: ProvenanceEnvironmentIdentity): void {
  if (!value || typeof value !== 'object' || !isSafeString(value.id, MAX_MANIFEST_STRING) || !value.id.trim()) throw new ProvenanceInputError('environmentIdentity.id must be a non-empty bounded string.');
  for (const key of ['name', 'provider', 'region', 'fingerprint'] as const) if (value[key] !== undefined && !isSafeString(value[key], MAX_MANIFEST_STRING)) throw new ProvenanceInputError(`environmentIdentity.${key} must be a bounded string.`);
}

function createFileDigests(files: readonly ProvenanceFileInput[], secretValues: readonly string[]): ProvenanceFileDigest[] {
  const entries: ProvenanceFileDigest[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || typeof file !== 'object') throw new ProvenanceInputError(`evidenceFiles[${index}] must be an object.`);
    const path = normalizeManifestPath(file.path);
    if (!path) throw new ProvenanceInputError(`evidenceFiles[${index}].path must be workspace-relative and safe.`);
    if (paths.has(path)) throw new ProvenanceInputError(`Duplicate evidence file path: ${path}.`);
    paths.add(path);
    const bytes = toBytes(file.contents);
    const redactedBytes = secretValues.length ? redactBytes(bytes, secretValues) : bytes;
    entries.push({ path, bytes: bytes.length, sha256: sha256(redactedBytes) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function toBytes(contents: ProvenanceFileContents): Uint8Array {
  if (typeof contents === 'string') {
    if (contents.length > MAX_FILE_BYTES) throw new ProvenanceInputError('Evidence file is too large.');
    return new TextEncoder().encode(contents);
  }
  if (contents instanceof Uint8Array) {
    if (contents.byteLength > MAX_FILE_BYTES) throw new ProvenanceInputError('Evidence file is too large.');
    return new Uint8Array(contents);
  }
  if (!Array.isArray(contents) || contents.length > MAX_FILE_BYTES || contents.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new ProvenanceInputError('Evidence file contents must be bounded bytes.');
  return Uint8Array.from(contents);
}

function redactBytes(bytes: Uint8Array, secrets: readonly string[]): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!secrets.some((secret) => typeof secret === 'string' && secret.length > 0 && text.includes(secret))) return bytes;
  let redacted = text;
  for (const secret of secrets) if (secret.length) redacted = redacted.split(secret).join(PROVENANCE_REDACTION_MARKER);
  return new TextEncoder().encode(redacted);
}

function checkDigest(name: keyof ProvenanceDigests, expectedDigest: string, value: unknown, secrets: readonly string[], errors: string[]): boolean {
  const actual = digestValue(value, { secretValues: secrets });
  const matches = actual === expectedDigest;
  if (!matches) errors.push(`${name} does not match.`);
  return matches;
}

function filesEqual(a: readonly ProvenanceFileDigest[], b: readonly ProvenanceFileDigest[]): boolean {
  return a.length === b.length && a.every((file, index) => file.path === b[index]?.path && file.bytes === b[index]?.bytes && file.sha256 === b[index]?.sha256);
}

function parseManifest(value: Record<string, unknown>, errors: string[]): ProvenanceManifest | undefined {
  if (!isSafeString(value.generatedAt, MAX_MANIFEST_STRING) || !isSafeString(value.runId, MAX_RUN_ID) || !isSafeString(value.manifestDigest, 128)) errors.push('Manifest metadata is malformed.');
  if (!Array.isArray(value.selectedTestIds) || value.selectedTestIds.some((id) => !isSafeString(id, MAX_MANIFEST_STRING))) errors.push('Manifest selectedTestIds are malformed.');
  if (!isRecord(value.runner) || !isSafeString(value.runner.kind, 32) || !isSafeString(value.runner.version, MAX_MANIFEST_STRING)) errors.push('Manifest runner metadata is malformed.');
  if (!isRecord(value.redaction) || value.redaction.level !== PROVENANCE_REDACTION_LEVEL || value.redaction.secretsExcluded !== true || !Array.isArray(value.redaction.excludedFields)) errors.push('Manifest redaction metadata is malformed.');
  if (!isRecord(value.digests) || !isDigest(value.digests.suiteDigest) || !isDigest(value.digests.profileDigest) || !isDigest(value.digests.resultDigest) || !isDigest(value.digests.evidenceDigest) || !isDigest(value.digests.evidenceManifestDigest)) errors.push('Manifest digests are malformed.');
  if (!Array.isArray(value.files) || value.files.some((file) => !isRecord(file) || !isSafeString(file.path, 4_096) || !isDigest(file.sha256) || !Number.isInteger(file.bytes) || Number(file.bytes) < 0)) errors.push('Manifest evidence files are malformed.');
  if (errors.length) return undefined;
  return value as unknown as ProvenanceManifest;
}

function sanitizeEnvironmentIdentity(value: ProvenanceEnvironmentIdentity, secrets: readonly string[]): ProvenanceEnvironmentIdentity {
  return {
    id: scrubString(value.id, secrets),
    ...(value.name ? { name: scrubString(value.name, secrets) } : {}),
    ...(value.provider ? { provider: scrubString(value.provider, secrets) } : {}),
    ...(value.region ? { region: scrubString(value.region, secrets) } : {}),
    ...(value.fingerprint ? { fingerprint: scrubString(value.fingerprint, secrets) } : {}),
  };
}

function sanitizeForDigest(value: unknown, secrets: readonly string[], redactPayloads: boolean): unknown {
  const state: WalkState = { seen: new WeakSet<object>(), nodes: 0 };
  return sanitize(value, secrets, state, redactPayloads);
}

interface WalkState { seen: WeakSet<object>; nodes: number }

function sanitize(value: unknown, secrets: readonly string[], state: WalkState, redactPayloads: boolean, key?: string): unknown {
  if (++state.nodes > MAX_NODES) throw new ProvenanceInputError('Provenance value exceeds the node limit.');
  if (key && SENSITIVE_KEY.test(key)) return PROVENANCE_REDACTION_MARKER;
  if (key && redactPayloads && PAYLOAD_KEY.test(key)) return payloadDigest(value, secrets);
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value, secrets);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProvenanceInputError('Provenance values must contain finite numbers.');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new ProvenanceInputError('Provenance values must be JSON-compatible.');
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') throw new ProvenanceInputError('Unsupported provenance value.');
  if (state.seen.has(value)) throw new ProvenanceInputError('Cyclic provenance values are not supported.');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, state, redactPayloads));
    const result: Record<string, unknown> = {};
    for (const childKey of Object.keys(value as Record<string, unknown>).sort()) result[childKey] = sanitize((value as Record<string, unknown>)[childKey], secrets, state, redactPayloads, childKey);
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function payloadDigest(value: unknown, secrets: readonly string[]): string {
  return `${PROVENANCE_PAYLOAD_DIGEST_MARKER}:${digestValue(value, { secretValues: secrets, redactPayloads: false })}`;
}

function canonicalize(value: unknown, state: WalkState): unknown {
  if (++state.nodes > MAX_NODES) throw new ProvenanceInputError('Provenance value exceeds the node limit.');
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProvenanceInputError('Provenance values must contain finite numbers.');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new ProvenanceInputError('Provenance values must be JSON-compatible.');
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') throw new ProvenanceInputError('Unsupported provenance value.');
  if (state.seen.has(value)) throw new ProvenanceInputError('Cyclic provenance values are not supported.');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, state));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) result[key] = canonicalize((value as Record<string, unknown>)[key], state);
    return result;
  } finally {
    state.seen.delete(value);
  }
}

function normalizeSecrets(value: readonly unknown[] | undefined): string[] {
  if (!value) return [];
  return value.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function scrubString(value: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join(PROVENANCE_REDACTION_MARKER), value);
}

function normalizeManifestPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4_096 || hasControlCharacters(value)) return undefined;
  let path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('://')) return undefined;
  while (path.startsWith('./')) path = path.slice(2);
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) return undefined;
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized || undefined;
}

function isSafeString(value: unknown, maxLength: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !hasControlCharacters(value); }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
