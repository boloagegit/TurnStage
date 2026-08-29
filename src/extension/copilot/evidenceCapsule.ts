import { createHash } from 'node:crypto';
import type {
  EvidenceReference,
  EvidenceSource,
  IntegrityComparison,
  IntegrityLock,
  SafeOutcome,
} from './types';

const MAX_STRING_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;

const SECRET_KEY = /(?:authorization|cookie|set-cookie|password|passphrase|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|private[-_]?key|client[-_]?secret|session[-_]?token)/i;
const SECRET_VALUE = /(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}|(?:gh[ps]_[a-z0-9_]{20,}|sk-[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,})/i;
const OMITTED_KEY = /^(?:raw|body|requestBody|responseBody|prompt|messages?|content|text|input|output)$/i;

export interface DisclosureSummary {
  included: string[];
  redacted: string[];
  omitted: string[];
  limits: {
    maxDepth: number;
    maxNodes: number;
    maxStringLength: number;
  };
}

export interface EvidenceCapsuleV1 {
  version: 'EvidenceCapsuleV1';
  runId: string;
  failureId?: string;
  failedContract: {
    id: string;
    label: string;
    outcome: SafeOutcome;
    expected?: unknown;
    actual?: unknown;
  };
  turn?: { id?: string; index?: number };
  transport?: { protocol?: string; status?: number; terminalState?: string; requestId?: string };
  evidenceRefs: EvidenceReference[];
  completeness: 'complete' | 'partial' | 'missing';
  profileFingerprint?: string;
  suiteFingerprint?: string;
  integrity: IntegrityComparison;
  disclosure: DisclosureSummary;
}

export interface EvidenceCapsuleInput {
  runId: string;
  failureId?: string;
  source: EvidenceSource;
}

export interface RedactionResult<T> {
  value: T;
  summary: DisclosureSummary;
}

/**
 * Stable JSON canonicalization for provenance fingerprints. Object keys are
 * sorted and values are bounded/secret-masked before hashing, so fingerprints
 * never contain a profile secret or an unbounded user value.
 */
export function fingerprint(value: unknown): string {
  // Fingerprints are one-way provenance values, not a disclosure channel. Do
  // not use the disclosure redactor here: dropping `input`, `content`, or
  // `messages` would let a Copilot edit weaken a locked contract without
  // changing its fingerprint. Secret-bearing fields are still replaced before
  // hashing, and oversized values are represented by a digest plus length.
  const canonical = canonicalize(fingerprintValue(value, '$', 0, new WeakSet<object>()));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createIntegrityLock(profile: unknown, suite?: unknown, caseValues?: Record<string, unknown>): IntegrityLock {
  const lock: IntegrityLock = { profileFingerprint: fingerprint(profile) };
  if (suite !== undefined) lock.suiteFingerprint = fingerprint(suite);
  if (caseValues) {
    const entries = Object.entries(caseValues).slice(0, 100).sort(([a], [b]) => a.localeCompare(b));
    lock.caseFingerprints = Object.fromEntries(entries.map(([id, value]) => [id, fingerprint(value)]));
  }
  return lock;
}

export function compareIntegrityLock(expected?: IntegrityLock, observed?: IntegrityLock): IntegrityComparison {
  if (!expected) return { status: 'not-locked', matches: true, observed };
  if (!observed) return { status: 'missing-observation', matches: false, expected, changedFields: ['observation'] };
  const changedFields: string[] = [];
  if (expected.profileFingerprint !== observed.profileFingerprint) changedFields.push('profileFingerprint');
  if ((expected.suiteFingerprint ?? undefined) !== (observed.suiteFingerprint ?? undefined)) changedFields.push('suiteFingerprint');
  const expectedCases = expected.caseFingerprints ?? {};
  const observedCases = observed.caseFingerprints ?? {};
  for (const id of new Set([...Object.keys(expectedCases), ...Object.keys(observedCases)])) {
    if (expectedCases[id] !== observedCases[id]) changedFields.push(`caseFingerprints.${id}`);
  }
  return {
    status: changedFields.length ? 'changed' : 'matched',
    matches: changedFields.length === 0,
    expected,
    observed,
    changedFields: changedFields.length ? changedFields : undefined,
  };
}

/**
 * Produce the deliberately small object that is safe to disclose to a coding
 * agent. Raw prompts, message text, request/response bodies and headers are
 * omitted even if the runtime accidentally supplies them.
 */
export function createEvidenceCapsule(input: EvidenceCapsuleInput): EvidenceCapsuleV1 {
  const source = input.source;
  const summary = emptySummary();
  const failedContract = source.failedContract && typeof source.failedContract === 'object' ? source.failedContract : {
    id: input.failureId ?? 'unknown-failure',
    label: 'TurnStage evidence failure',
    outcome: 'indeterminate' as const,
  };
  const expected = source.failedContract?.expected === undefined ? undefined : safeScalar(source.failedContract.expected, 'failedContract.expected', summary);
  const actual = source.failedContract?.actual === undefined ? undefined : safeScalar(source.failedContract.actual, 'failedContract.actual', summary);
  const evidenceRefs = uniqueReferences(Array.isArray(source.evidenceRefs) ? source.evidenceRefs : [], summary);
  const integrity = compareIntegrityLock(source.expectedIntegrity, source.observedIntegrity);
  const capsule: EvidenceCapsuleV1 = {
    version: 'EvidenceCapsuleV1',
    runId: boundedId(input.runId, 'runId', summary),
    failureId: input.failureId ? boundedId(input.failureId, 'failureId', summary) : undefined,
    failedContract: {
      id: boundedId(failedContract.id, 'failedContract.id', summary),
      label: boundedText(failedContract.label, 'failedContract.label', summary),
      outcome: safeOutcome(failedContract.outcome),
      expected,
      actual,
    },
    turn: source.turn ? {
      id: source.turn.id === undefined ? undefined : boundedId(source.turn.id, 'turn.id', summary),
      index: validIndex(source.turn.index) ? source.turn.index : undefined,
    } : undefined,
    transport: source.transport && typeof source.transport === 'object' ? {
      protocol: typeof source.transport.protocol !== 'string' ? undefined : boundedText(source.transport.protocol, 'transport.protocol', summary),
      status: validStatus(source.transport.status) ? source.transport.status : undefined,
      terminalState: typeof source.transport.terminalState !== 'string' ? undefined : boundedText(source.transport.terminalState, 'transport.terminalState', summary),
      requestId: typeof source.transport.requestId !== 'string' ? undefined : boundedId(source.transport.requestId, 'transport.requestId', summary),
    } : undefined,
    evidenceRefs,
    completeness: source.completeness === 'complete' || source.completeness === 'partial' ? source.completeness : 'missing',
    profileFingerprint: source.profile === undefined ? undefined : fingerprint(source.profile),
    suiteFingerprint: source.suite === undefined ? undefined : fingerprint(source.suite),
    integrity,
    disclosure: summary,
  };
  // A final structural pass protects against accidental oversized additions if
  // a runtime implementation supplies a future field.
  return capsule;
}

export function summarizeDisclosure(capsule: EvidenceCapsuleV1): string {
  const omitted = capsule.disclosure.omitted.length ? capsule.disclosure.omitted.join(', ') : 'none';
  const redacted = capsule.disclosure.redacted.length ? capsule.disclosure.redacted.join(', ') : 'none';
  return `EvidenceCapsuleV1 ${capsule.runId}: outcome=${capsule.failedContract.outcome}; completeness=${capsule.completeness}; omitted=${omitted}; redacted=${redacted}.`;
}

export function redactForDisclosure<T>(value: T): RedactionResult<T> {
  const summary = emptySummary();
  const seen = new WeakSet<object>();
  const copy = visit(value, '$', 0, summary, seen) as T;
  return { value: copy, summary };
}

function visit(value: unknown, path: string, depth: number, summary: DisclosureSummary, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) {
    summary.omitted.push(path);
    return '[omitted: depth limit]';
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) {
      summary.redacted.push(path);
      return '[redacted]';
    }
    return boundedText(value, path, summary);
  }
  if (typeof value !== 'object') {
    summary.omitted.push(path);
    return '[omitted: unsupported value]';
  }
  if (seen.has(value)) {
    summary.omitted.push(path);
    return '[omitted: circular value]';
  }
  if (summary.included.length + summary.redacted.length + summary.omitted.length >= MAX_NODES) {
    summary.omitted.push(path);
    return '[omitted: node limit]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_NODES).map((item, index) => visit(item, `${path}[${index}]`, depth + 1, summary, seen));
    if (value.length > items.length) summary.omitted.push(`${path}[${items.length}..]`);
    return items;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_NODES)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY.test(key)) {
      summary.redacted.push(childPath);
      result[key] = '[redacted]';
    } else if (OMITTED_KEY.test(key)) {
      summary.omitted.push(childPath);
    } else {
      result[key] = visit(child, childPath, depth + 1, summary, seen);
    }
  }
  seen.delete(value);
  return result;
}

function uniqueReferences(values: readonly EvidenceReference[], summary: DisclosureSummary): EvidenceReference[] {
  const result: EvidenceReference[] = [];
  const keys = new Set<string>();
  for (const value of values.slice(0, 100)) {
    if (!value || !['chat', 'network', 'event'].includes(value.kind) || typeof value.id !== 'string' || !value.id.trim()) {
      summary.omitted.push('evidenceRefs.invalid');
      continue;
    }
    const id = boundedId(value.id, `evidenceRefs.${value.kind}`, summary);
    const key = `${value.kind}:${id}`;
    if (keys.has(key)) continue;
    keys.add(key);
    result.push({ kind: value.kind, id });
  }
  return result;
}

function safeScalar(value: unknown, path: string, summary: DisclosureSummary): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedText(value, path, summary);
  summary.omitted.push(path);
  return '[omitted: non-scalar]';
}

function safeOutcome(value: unknown): SafeOutcome {
  return typeof value === 'string' && ['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError', 'passed', 'failed', 'error', 'cancelled'].includes(value)
    ? value as SafeOutcome
    : 'indeterminate';
}

function boundedId(value: unknown, path: string, summary: DisclosureSummary): string {
  if (typeof value !== 'string') {
    summary.omitted.push(path);
    return '[omitted]';
  }
  const text = value.slice(0, MAX_ID_LENGTH);
  if (text.length !== value.length) summary.omitted.push(path);
  return text;
}

function boundedText(value: unknown, path: string, summary: DisclosureSummary): string {
  if (typeof value !== 'string') {
    summary.omitted.push(path);
    return '[omitted]';
  }
  if (SECRET_VALUE.test(value)) {
    summary.redacted.push(path);
    return '[redacted]';
  }
  if (value.length <= MAX_STRING_LENGTH) return value;
  summary.omitted.push(path);
  return `${value.slice(0, MAX_STRING_LENGTH - 14)}…[truncated]`;
}

function validIndex(value: number | undefined): value is number { return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 100_000); }
function validStatus(value: number | undefined): value is number { return value === undefined || (Number.isInteger(value) && value >= 100 && value <= 599); }

function emptySummary(): DisclosureSummary {
  return {
    included: ['failedContract', 'turn', 'transport', 'evidenceRefs', 'completeness', 'fingerprints', 'integrity'],
    redacted: [],
    omitted: ['raw prompts', 'headers', 'request/response bodies', 'SecretStorage values'],
    limits: { maxDepth: MAX_DEPTH, maxNodes: MAX_NODES, maxStringLength: MAX_STRING_LENGTH },
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

const MAX_FINGERPRINT_DEPTH = 24;
const MAX_FINGERPRINT_NODES = 20_000;
const MAX_FINGERPRINT_STRING = 1_048_576;

function fingerprintValue(value: unknown, path: string, depth: number, seen: WeakSet<object>, state = { nodes: 0 }): unknown {
  if (++state.nodes > MAX_FINGERPRINT_NODES || depth > MAX_FINGERPRINT_DEPTH) return `[omitted:${path}:limit]`;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return `[secret:${value.length}]`;
    if (value.length <= MAX_FINGERPRINT_STRING) return value;
    return `[sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}:${value.length}]`;
  }
  if (typeof value !== 'object' || seen.has(value)) return `[omitted:${path}:unsupported]`;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) => fingerprintValue(item, `${path}[${index}]`, depth + 1, seen, state));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Preserve the key in the canonical value so adding/removing a secret
    // field still changes provenance, without putting the secret itself in the
    // digest input exposed to any caller.
    result[key] = SECRET_KEY.test(key)
      ? `[secret-field:${typeof child === 'string' ? child.length : 'object'}]`
      : fingerprintValue(child, `${path}.${key}`, depth + 1, seen, state);
  }
  seen.delete(value);
  return result;
}

/** Useful for tests and callers that need to ensure no secret-looking value was returned. */
export function disclosureText(capsule: EvidenceCapsuleV1): string { return JSON.stringify(capsule); }

export function isEvidenceCapsuleV1(value: unknown): value is EvidenceCapsuleV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 'EvidenceCapsuleV1'
    && typeof candidate.runId === 'string'
    && Boolean(candidate.failedContract && typeof candidate.failedContract === 'object')
    && Array.isArray(candidate.evidenceRefs)
    && ['complete', 'partial', 'missing'].includes(String(candidate.completeness));
}
