import { createHash } from 'node:crypto';
import type { AdversarialOutcome, EvidenceTimelineEntry, EvidenceTimelinePhase, EvidenceTimelineStatus, EvidenceTimelineSummary, NetworkExchange, ScenarioEvidenceLocation, ScenarioRunResult } from '../../shared/types';

export const EVIDENCE_TIMELINE_VERSION = 1 as const;
export const MAX_EVIDENCE_TIMELINE_ENTRIES = 256;
export const MAX_FAILURE_CLUSTER_ITEMS = 500;

export type EvidenceTimelineV1 = EvidenceTimelineSummary;

export interface FailureFingerprintV1 {
  version: 1;
  digest: string;
  outcome: AdversarialOutcome | 'passed' | 'failed';
  phase: EvidenceTimelinePhase | 'none';
  code: string;
  statusCode?: number;
  ruleId?: string;
}

export interface FailureClusterV1 {
  version: 1;
  fingerprint: FailureFingerprintV1;
  count: number;
  caseIds: string[];
}

/**
 * Build a bounded causal index over evidence that already exists. The builder
 * deliberately emits references and allowlisted metadata rather than copying
 * request/response content into another persistence or disclosure surface.
 */
export function buildEvidenceTimeline(result: ScenarioRunResult, limit = MAX_EVIDENCE_TIMELINE_ENTRIES): EvidenceTimelineV1 {
  const evidence = result.evidence;
  const snapshot = evidence.snapshot;
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_EVIDENCE_TIMELINE_ENTRIES, limit)) : MAX_EVIDENCE_TIMELINE_ENTRIES;
  const candidates: Array<EvidenceTimelineEntry & { priority: number }> = [];
  const baseTime = findBaseTime(result);

  for (const network of evidence.networkEntries.slice(0, 50)) {
    const location: ScenarioEvidenceLocation = { kind: 'network', networkId: boundedId(network.id) };
    const common = networkMetadata(network);
    add(candidates, baseTime, network.startedAt, 10, {
      id: `network-${boundedId(network.id)}-request`, phase: 'request', status: 'normal',
      label: network.kind === 'stream' ? 'Request sent' : `${capitalize(network.kind)} request sent`, location, metadata: common,
    });
    if (finiteNonNegative(network.timing.headers)) add(candidates, baseTime, network.startedAt + network.timing.headers, 20, {
      id: `network-${boundedId(network.id)}-headers`, phase: 'headers', status: statusForHttp(network.status),
      label: network.status === undefined ? 'Response headers received' : `Response headers ${network.status}`, location, metadata: common,
    });
    if (finiteNonNegative(network.timing.firstChunk)) add(candidates, baseTime, network.startedAt + network.timing.firstChunk, 30, {
      id: `network-${boundedId(network.id)}-first-chunk`, phase: 'firstChunk', status: 'normal',
      label: 'First response chunk', location, metadata: common,
    });
    if (network.error) {
      const at = completionTime(network, baseTime + result.durationMs);
      add(candidates, baseTime, at, 90, {
        id: `network-${boundedId(network.id)}-error`, phase: 'error', status: 'failure',
        label: safeErrorLabel(network.error.type, network.error.status), location,
        metadata: { ...common, errorType: boundedToken(network.error.type), ...(boundedRule(network.error.ruleId) ? { ruleId: boundedRule(network.error.ruleId) } : {}) },
      });
    }
  }

  const firstRaw = snapshot.rawEvents.filter(validEventTime).sort(eventOrder)[0];
  if (firstRaw) add(candidates, baseTime, firstRaw.receivedAt, 40, {
    id: `raw-${firstRaw.sequence}-first`, phase: 'firstEvent', status: firstRaw.parseError ? 'warning' : 'normal',
    label: firstRaw.parseError ? 'First stream event had a parse error' : 'First stream event',
    location: { kind: 'rawEvent', sequence: firstRaw.sequence },
    metadata: { protocol: firstRaw.protocol, ...(firstRaw.sse?.event ? { eventType: boundedToken(firstRaw.sse.event) } : {}) },
  });

  const firstMapped = snapshot.normalizedEvents.filter(validEventTime).sort(eventOrder)[0];
  if (firstMapped) add(candidates, baseTime, firstMapped.receivedAt, 50, {
    id: `normalized-${firstMapped.sequence}-first`, phase: 'firstMappedEvent', status: 'normal',
    label: 'First mapped event',
    location: { kind: 'normalizedEvent', sequence: firstMapped.sequence, rawSequence: firstMapped.rawSequence },
    metadata: { eventType: boundedToken(firstMapped.type), ...(boundedRule(firstMapped.mappingRuleId) ? { ruleId: boundedRule(firstMapped.mappingRuleId) } : {}) },
  });

  if (finiteNonNegative(snapshot.metrics.ttft) && finiteTimestamp(snapshot.metrics.requestStartedAt)) add(candidates, baseTime, snapshot.metrics.requestStartedAt + snapshot.metrics.ttft, 60, {
    id: 'metrics-ttft', phase: 'ttft', status: 'normal', label: 'First displayable response content',
    location: firstAssistantLocation(result),
  });

  const terminal = [...snapshot.normalizedEvents].filter((event) => terminalType(event.type) && validEventTime(event)).sort(eventOrder).at(-1);
  if (terminal) add(candidates, baseTime, terminal.receivedAt, 80, {
    id: `normalized-${terminal.sequence}-terminal`, phase: 'terminal', status: terminalStatus(terminal.type),
    label: terminalLabel(terminal.type),
    location: { kind: 'normalizedEvent', sequence: terminal.sequence, rawSequence: terminal.rawSequence },
    metadata: { eventType: boundedToken(terminal.type), ...(boundedRule(terminal.mappingRuleId) ? { ruleId: boundedRule(terminal.mappingRuleId) } : {}) },
  });

  const resultTime = findResultTime(result, baseTime);
  for (const finding of result.adversarial?.findings.slice(0, 100) ?? []) add(candidates, baseTime, resultTime, 70, {
    id: `finding-${boundedId(finding.id)}`, phase: 'finding', status: 'failure',
    label: `Adversarial ${finding.category} rule triggered`, location: finding.locations[0] ?? { kind: 'profile' },
    metadata: boundedRule(finding.ruleId) ? { ruleId: boundedRule(finding.ruleId) } : undefined,
  });
  for (const check of [...result.steps.flatMap((step) => step.checks), ...result.checks].filter((item) => !item.passed).slice(0, 100)) add(candidates, baseTime, resultTime, 71, {
    id: `check-${boundedId(check.id)}`, phase: 'finding', status: 'failure',
    label: `${capitalize(check.kind)} check failed`, location: check.location,
    metadata: { ruleId: boundedToken(check.id) },
  });
  for (const error of snapshot.errors.slice(0, 50)) add(candidates, baseTime, resultTime, 91, {
    id: `runtime-error-${boundedToken(error.type)}-${candidates.length}`, phase: 'error', status: 'failure',
    label: safeErrorLabel(error.type, error.status),
    location: error.rawSequence === undefined ? { kind: 'network' } : { kind: 'rawEvent', sequence: error.rawSequence },
    metadata: { errorType: boundedToken(error.type), ...(validStatus(error.status) ? { statusCode: error.status } : {}), ...(boundedRule(error.ruleId) ? { ruleId: boundedRule(error.ruleId) } : {}) },
  });

  const ordered = candidates.sort((left, right) => left.at - right.at || left.priority - right.priority || left.id.localeCompare(right.id));
  const entries = ordered.slice(0, safeLimit).map(({ priority, ...entry }) => {
    void priority;
    return entry;
  });
  const expected: EvidenceTimelinePhase[] = ['request', 'headers', 'firstChunk', 'firstEvent', 'firstMappedEvent', 'ttft', 'terminal'];
  const present = new Set(entries.map((entry) => entry.phase));
  const missingPhases = expected.filter((phase) => !present.has(phase));
  const dropped = snapshot.droppedEventCount > 0 || (snapshot.droppedNormalizedEventCount ?? 0) > 0 || (snapshot.droppedMessageCount ?? 0) > 0;
  const completeness = entries.length === 0 ? 'missing' : missingPhases.length || dropped || ordered.length > entries.length ? 'partial' : 'complete';
  return { version: EVIDENCE_TIMELINE_VERSION, baseTime, entries, completeness, missingPhases, truncated: ordered.length > entries.length };
}

export function fingerprintFailure(result: ScenarioRunResult): FailureFingerprintV1 {
  const timeline = buildEvidenceTimeline(result);
  const failure = timeline.entries.find((entry) => entry.status === 'failure');
  const outcome = result.adversarial?.outcome ?? (result.passed ? 'passed' : 'failed');
  const code = failure?.metadata?.errorType ?? failure?.metadata?.ruleId ?? failure?.metadata?.eventType ?? failure?.phase ?? 'unknown';
  const material: Omit<FailureFingerprintV1, 'version' | 'digest'> = {
    outcome,
    phase: failure?.phase ?? 'none',
    code: boundedToken(code),
    statusCode: failure?.metadata?.statusCode,
    ruleId: failure?.metadata?.ruleId,
  };
  return { version: 1, digest: createHash('sha256').update(stableJson(material)).digest('hex'), ...material };
}

export function clusterFailures(items: readonly { caseId: string; result: ScenarioRunResult }[]): FailureClusterV1[] {
  const groups = new Map<string, FailureClusterV1>();
  for (const item of items.slice(0, MAX_FAILURE_CLUSTER_ITEMS)) {
    const fingerprint = fingerprintFailure(item.result);
    const existing = groups.get(fingerprint.digest);
    const caseId = boundedId(item.caseId);
    if (existing) {
      existing.count += 1;
      if (existing.caseIds.length < 100 && !existing.caseIds.includes(caseId)) existing.caseIds.push(caseId);
    } else groups.set(fingerprint.digest, { version: 1, fingerprint, count: 1, caseIds: [caseId] });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.fingerprint.digest.localeCompare(right.fingerprint.digest));
}

function add(candidates: Array<EvidenceTimelineEntry & { priority: number }>, baseTime: number, at: number, priority: number, entry: Omit<EvidenceTimelineEntry, 'at' | 'elapsedMs'>): void {
  if (!finiteTimestamp(at)) return;
  candidates.push({ ...entry, at, elapsedMs: Math.max(0, at - baseTime), priority });
}

function findBaseTime(result: ScenarioRunResult): number {
  const snapshot = result.evidence.snapshot;
  const values = [snapshot.metrics.requestStartedAt, ...result.evidence.networkEntries.map((entry) => entry.startedAt), ...snapshot.rawEvents.map((event) => event.receivedAt), ...snapshot.normalizedEvents.map((event) => event.receivedAt)].filter(finiteTimestamp);
  return values.length ? Math.min(...values) : 0;
}

function findResultTime(result: ScenarioRunResult, baseTime: number): number {
  const fallback = baseTime + Math.max(0, finiteNonNegative(result.durationMs) ? result.durationMs : 0);
  const completed = result.evidence.networkEntries.map((entry) => completionTime(entry, fallback)).filter(finiteTimestamp);
  return completed.length ? Math.max(...completed) : fallback;
}

function completionTime(network: NetworkExchange, fallback: number): number {
  if (finiteTimestamp(network.completedAt)) return network.completedAt;
  if (finiteNonNegative(network.timing.total)) return network.startedAt + network.timing.total;
  return fallback;
}

function networkMetadata(network: NetworkExchange): EvidenceTimelineEntry['metadata'] {
  const correlationId = network.correlation?.requestId ?? network.correlation?.traceId;
  return {
    networkKind: network.kind,
    networkState: network.state,
    ...(network.protocol ? { protocol: network.protocol } : {}),
    ...(validStatus(network.status) ? { statusCode: network.status } : {}),
    ...(correlationId ? { correlationId: boundedId(correlationId) } : {}),
  };
}

function firstAssistantLocation(result: ScenarioRunResult): ScenarioEvidenceLocation | undefined {
  const message = result.evidence.snapshot.messages.find((item) => item.role === 'assistant' && finiteNonNegative(item.timing?.ttft));
  return message ? { kind: 'message', messageId: boundedId(message.id) } : undefined;
}

function validEventTime(value: { receivedAt: number }): boolean { return finiteTimestamp(value.receivedAt); }
function eventOrder(left: { receivedAt: number; sequence: number }, right: { receivedAt: number; sequence: number }): number { return left.receivedAt - right.receivedAt || left.sequence - right.sequence; }
function finiteTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function finiteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function validStatus(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599; }
function statusForHttp(status: number | undefined): EvidenceTimelineStatus { return status === undefined ? 'unknown' : status >= 400 ? 'failure' : 'normal'; }
function terminalType(type: string): boolean { return type === 'stream.completed' || type === 'stream.failed' || type === 'stream.aborted'; }
function terminalStatus(type: string): EvidenceTimelineStatus { return type === 'stream.completed' ? 'normal' : type === 'stream.failed' ? 'failure' : 'warning'; }
function terminalLabel(type: string): string { return type === 'stream.completed' ? 'Stream completed' : type === 'stream.failed' ? 'Stream failed' : 'Stream aborted'; }
function capitalize(value: string): string { return value.length ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value; }
function boundedId(value: string): string { return [...value].filter((character) => { const code = character.charCodeAt(0); return code > 31 && code !== 127; }).join('').slice(0, 256) || 'unknown'; }
function boundedToken(value: string): string { return value.replace(/[^A-Za-z0-9_.:/-]/g, '-').slice(0, 128) || 'unknown'; }
function boundedRule(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? boundedToken(value) : undefined; }
function safeErrorLabel(type: string, status?: number): string { const safe = boundedToken(type); return validStatus(status) ? `${safe} (${status})` : safe; }
function stableJson(value: Record<string, unknown>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)))); }
