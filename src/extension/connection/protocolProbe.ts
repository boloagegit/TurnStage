/**
 * Pure, bounded analysis for the first response obtained by a connection
 * probe. No response body or event payload is returned from this module. The
 * caller may therefore safely persist the result or pass it to a webview.
 */

import type { RawStreamEvent } from '../../shared/types';

export const MAX_PROBE_BODY_PREFIX_BYTES = 8 * 1024;
export const MAX_PROBE_EVENTS = 1_000;
export const MAX_PROBE_FINDINGS = 32;

export type ProbeProtocol = 'sse' | 'ndjson' | 'json' | 'text-stream' | 'unknown';
export type ProbeConfidence = 'high' | 'medium' | 'low';
export type ProbeFindingSeverity = 'info' | 'warning' | 'error';
export type ProbeFindingCategory = 'http' | 'protocol' | 'timing' | 'stream' | 'mapping' | 'terminal';

export interface ProbeTimingInput {
  readonly headersLatencyMs?: number;
  readonly firstChunkLatencyMs?: number;
  readonly firstEventLatencyMs?: number;
  readonly totalLatencyMs?: number;
}

export interface ProbeMappingInput {
  readonly configured?: boolean;
  readonly mappedEventCount?: number;
  readonly unmatchedEventCount?: number;
  readonly mappingErrorCount?: number;
  readonly terminalMapped?: boolean;
}

/** Only metadata is consumed from raw events; arbitrary data is never copied. */
export interface ProbeRawEvent {
  readonly sequence?: number;
  readonly protocol?: RawStreamEvent['protocol'] | ProbeProtocol;
  readonly sse?: { readonly event?: string };
  readonly raw?: string;
  readonly data?: unknown;
  readonly parseError?: string;
  readonly mappingRuleId?: string;
  readonly mappingError?: string;
}

export interface ProbeNormalizedEvent {
  readonly sequence?: number;
  readonly rawSequence?: number;
  readonly type?: string;
}

export interface ConnectionProbeInput {
  readonly status?: number;
  readonly contentType?: string;
  readonly timing?: ProbeTimingInput;
  /** The prefix is inspected in memory and never copied to the result. */
  readonly bodyPrefix?: string;
  readonly bodyPrefixTruncated?: boolean;
  readonly rawEvents?: readonly ProbeRawEvent[];
  readonly normalizedEvents?: readonly ProbeNormalizedEvent[];
  readonly mapping?: ProbeMappingInput;
  /** Explicit transport observation can override inference when available. */
  readonly terminalEventSeen?: boolean;
  readonly terminalEventSequence?: number;
}

export interface ProbeSignal {
  readonly id: 'content-type' | 'body-prefix' | 'raw-event' | 'status';
  readonly value: string;
}

export interface ProbeFindingEvidence {
  readonly kind: 'status' | 'content-type' | 'timing' | 'body-prefix' | 'raw-event' | 'normalized-event' | 'mapping';
  readonly count?: number;
  readonly sequence?: number;
}

export interface ProbeFinding {
  readonly id: string;
  readonly category: ProbeFindingCategory;
  readonly severity: ProbeFindingSeverity;
  readonly message: string;
  readonly evidence: readonly ProbeFindingEvidence[];
}

export interface ProtocolFingerprintV1 {
  readonly format: 'turnstage-protocol-fingerprint';
  readonly version: 1;
  readonly protocol: ProbeProtocol;
  readonly confidence: ProbeConfidence;
  readonly contentType?: string;
  readonly status?: number;
  readonly signals: readonly ProbeSignal[];
  readonly rawEventCount: number;
  readonly normalizedEventCount: number;
  readonly mappedEventCount: number;
  readonly unmatchedEventCount: number;
  readonly parseErrorCount: number;
  readonly mappingErrorCount: number;
  readonly terminalEventSeen: boolean;
  readonly terminalEventSequence?: number;
  readonly terminalMapped: boolean;
  readonly bodyPrefixTruncated: boolean;
  readonly inputEventsTruncated: boolean;
}

export interface ConnectionProbeResultV1 {
  readonly format: 'turnstage-connection-probe-result';
  readonly version: 1;
  readonly fingerprint: ProtocolFingerprintV1;
  readonly findings: readonly ProbeFinding[];
  readonly safe: boolean;
}

export interface ProbeAnalyzerOptions {
  readonly slowHeadersMs?: number;
  readonly slowFirstChunkMs?: number;
  readonly slowFirstEventMs?: number;
  readonly slowTotalMs?: number;
}

interface ProtocolScore {
  readonly protocol: ProbeProtocol;
  readonly score: number;
  readonly signal: ProbeSignal;
}

const DEFAULT_SLOW_HEADERS_MS = 2_000;
const DEFAULT_SLOW_FIRST_CHUNK_MS = 3_000;
const DEFAULT_SLOW_FIRST_EVENT_MS = 3_000;
const DEFAULT_SLOW_TOTAL_MS = 30_000;
const probeEncoder = new TextEncoder();
const TERMINAL_TYPES = new Set([
  'stream.completed', 'stream.failed', 'stream.aborted', 'turn.completed', 'turn.failed', 'turn.aborted',
  'message.completed', 'message.failed', 'done', 'complete', 'completed', 'error', 'failed', 'aborted',
]);
/** Analyze bounded probe metadata deterministically. */
export function analyzeConnectionProbe(input: ConnectionProbeInput, options: ProbeAnalyzerOptions = {}): ConnectionProbeResultV1 {
  const body = boundedUtf8Prefix(input.bodyPrefix ?? '', MAX_PROBE_BODY_PREFIX_BYTES);
  const rawInput = input.rawEvents ?? [];
  const normalizedInput = input.normalizedEvents ?? [];
  const rawEvents = rawInput.slice(0, MAX_PROBE_EVENTS);
  const normalizedEvents = normalizedInput.slice(0, MAX_PROBE_EVENTS);
  const inputEventsTruncated = rawInput.length > MAX_PROBE_EVENTS || normalizedInput.length > MAX_PROBE_EVENTS;
  const contentType = normalizeContentType(input.contentType);
  const protocolScores = inferProtocol(contentType, body.text, rawEvents);
  const selected = selectProtocol(protocolScores);
  const mappedEventCount = boundedCount(input.mapping?.mappedEventCount ?? rawEvents.filter((event) => typeof event.mappingRuleId === 'string' && event.mappingRuleId.length > 0).length);
  const unmatchedEventCount = boundedCount(input.mapping?.unmatchedEventCount ?? rawEvents.filter((event) => !event.mappingRuleId && !event.mappingError).length);
  const parseErrorCount = boundedCount(rawEvents.filter((event) => typeof event.parseError === 'string' && event.parseError.length > 0).length);
  const mappingErrorCount = boundedCount(input.mapping?.mappingErrorCount ?? rawEvents.filter((event) => typeof event.mappingError === 'string' && event.mappingError.length > 0).length);
  const terminal = terminalObservation(input, rawEvents, normalizedEvents, body.text);
  const terminalMapped = input.mapping?.terminalMapped ?? normalizedEvents.some((event) => isTerminalType(event.type));
  const fingerprint: ProtocolFingerprintV1 = {
    format: 'turnstage-protocol-fingerprint',
    version: 1,
    protocol: selected.protocol,
    confidence: selected.confidence,
    ...(contentType ? { contentType } : {}),
    ...(validStatus(input.status) ? { status: input.status } : {}),
    signals: selected.signals,
    rawEventCount: rawEvents.length,
    normalizedEventCount: normalizedEvents.length,
    mappedEventCount,
    unmatchedEventCount,
    parseErrorCount,
    mappingErrorCount,
    terminalEventSeen: terminal.seen,
    ...(terminal.sequence === undefined ? {} : { terminalEventSequence: terminal.sequence }),
    terminalMapped: Boolean(terminal.seen && terminalMapped),
    bodyPrefixTruncated: Boolean(input.bodyPrefixTruncated || body.truncated),
    inputEventsTruncated,
  };
  const findings = buildFindings({ input, body: body.text, contentType, rawEvents, normalizedEvents, fingerprint, terminal }, options);
  return { format: 'turnstage-connection-probe-result', version: 1, fingerprint, findings, safe: findings.every((finding) => finding.severity !== 'error') };
}

/** Aliases keep the API discoverable for callers that focus on fingerprints. */
export const analyzeProtocolFingerprint = analyzeConnectionProbe;
export const fingerprintProtocol = analyzeConnectionProbe;

function inferProtocol(contentType: string | undefined, bodyPrefix: string, rawEvents: readonly ProbeRawEvent[]): ProtocolScore[] {
  const scores: ProtocolScore[] = [];
  const add = (protocol: ProbeProtocol, score: number, id: ProbeSignal['id'], value: string): void => { scores.push({ protocol, score, signal: { id, value } }); };
  if (contentType) {
    if (contentType === 'text/event-stream') add('sse', 100, 'content-type', 'text/event-stream');
    else if (/^(?:application\/x-ndjson|application\/ndjson|application\/jsonl|application\/json-seq)$/.test(contentType)) add('ndjson', 100, 'content-type', contentType);
    else if (contentType === 'application/json' || contentType.endsWith('+json')) add('json', 95, 'content-type', contentType);
    else if (contentType.startsWith('text/')) add('text-stream', 55, 'content-type', contentType);
  }
  const normalized = stripBom(bodyPrefix).trimStart();
  if (/^(?:event\s*:\s*|id\s*:\s*|retry\s*:\s*|data\s*:\s*)/m.test(normalized) || /\n\s*\n/.test(normalized) && /(?:^|\n)\s*data\s*:/.test(normalized)) add('sse', 80, 'body-prefix', 'SSE field framing');
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.every((line) => parsesJson(line))) add('ndjson', 75, 'body-prefix', 'multiple JSON records');
  else if (lines.length === 1 && parsesJson(normalized)) add('json', 70, 'body-prefix', 'one complete JSON value');
  else if (normalized && !hasControlCharacters(normalized) && !/^(?:event|id|retry|data)\s*:/.test(normalized)) add('text-stream', 35, 'body-prefix', 'non-JSON text prefix');
  const protocolCounts = new Map<ProbeProtocol, number>();
  for (const event of rawEvents) {
    const protocol = normalizeProtocol(event.protocol);
    if (protocol === 'unknown') continue;
    protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
  }
  for (const [protocol, count] of protocolCounts) add(protocol, Math.min(90, 50 + count), 'raw-event', `${protocol} raw events`);
  return scores;
}

function selectProtocol(scores: readonly ProtocolScore[]): { protocol: ProbeProtocol; confidence: ProbeConfidence; signals: readonly ProbeSignal[] } {
  if (!scores.length) return { protocol: 'unknown', confidence: 'low', signals: [] };
  const grouped = new Map<ProbeProtocol, { score: number; signals: ProbeSignal[] }>();
  for (const score of scores) {
    const current = grouped.get(score.protocol) ?? { score: 0, signals: [] };
    current.score += score.score;
    if (!current.signals.some((signal) => signal.id === score.signal.id && signal.value === score.signal.value)) current.signals.push(score.signal);
    grouped.set(score.protocol, current);
  }
  const ranked = [...grouped.entries()].sort((a, b) => b[1].score - a[1].score || protocolOrder(a[0]) - protocolOrder(b[0]));
  const [protocol, selected] = ranked[0]!;
  const secondScore = ranked[1]?.[1].score ?? 0;
  const confidence = selected.score >= 100 && selected.score - secondScore >= 20 ? 'high' : selected.score >= 70 && selected.score - secondScore >= 10 ? 'medium' : 'low';
  return { protocol, confidence, signals: selected.signals.slice(0, 8) };
}

function protocolOrder(protocol: ProbeProtocol): number { return ['sse', 'ndjson', 'json', 'text-stream', 'unknown'].indexOf(protocol); }

function terminalObservation(input: ConnectionProbeInput, rawEvents: readonly ProbeRawEvent[], normalizedEvents: readonly ProbeNormalizedEvent[], bodyPrefix: string): { seen: boolean; sequence?: number } {
  if (input.terminalEventSeen !== undefined) return { seen: input.terminalEventSeen, ...(input.terminalEventSeen && input.terminalEventSequence !== undefined ? { sequence: safeSequence(input.terminalEventSequence) } : {}) };
  for (const event of normalizedEvents) if (isTerminalType(event.type)) return { seen: true, ...(event.sequence === undefined ? {} : { sequence: safeSequence(event.sequence) }) };
  for (const event of rawEvents) {
    if (isTerminalType(event.sse?.event) || isTerminalData(event.data) || isTerminalData(event.raw)) return { seen: true, ...(event.sequence === undefined ? {} : { sequence: safeSequence(event.sequence) }) };
  }
  if (/^\s*data\s*:\s*\[DONE\]\s*(?:\r?\n|$)/im.test(bodyPrefix) || /^\s*\[DONE\]\s*$/m.test(bodyPrefix)) return { seen: true };
  return { seen: false };
}

function buildFindings(args: {
  readonly input: ConnectionProbeInput;
  readonly body: string;
  readonly contentType?: string;
  readonly rawEvents: readonly ProbeRawEvent[];
  readonly normalizedEvents: readonly ProbeNormalizedEvent[];
  readonly fingerprint: ProtocolFingerprintV1;
  readonly terminal: { seen: boolean; sequence?: number };
}, options: ProbeAnalyzerOptions): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  const add = (id: string, category: ProbeFindingCategory, severity: ProbeFindingSeverity, message: string, evidence: readonly ProbeFindingEvidence[]): void => {
    if (findings.some((finding) => finding.id === id) || findings.length >= MAX_PROBE_FINDINGS) return;
    findings.push({ id, category, severity, message, evidence: evidence.slice(0, 4) });
  };
  const status = args.input.status;
  if (status === 401 || status === 403) add('http-auth-required', 'http', 'error', 'The endpoint rejected the probe because authentication is required.', [{ kind: 'status' }]);
  else if (status === 429) add('http-rate-limited', 'http', 'warning', 'The endpoint rate-limited the probe.', [{ kind: 'status' }]);
  else if (validStatus(status) && status >= 500) add('http-server-error', 'http', 'error', 'The endpoint returned a server error.', [{ kind: 'status' }]);
  else if (validStatus(status) && status >= 400) add('http-client-error', 'http', 'error', 'The endpoint returned a client error.', [{ kind: 'status' }]);
  else if (status === undefined) add('http-status-missing', 'http', 'warning', 'The probe did not observe an HTTP status.', [{ kind: 'status' }]);
  else if (status >= 200 && status < 300) add('http-ok', 'http', 'info', 'The endpoint returned a successful HTTP status.', [{ kind: 'status' }]);

  if (args.fingerprint.protocol === 'unknown') add('protocol-unknown', 'protocol', 'error', 'The response protocol could not be identified from bounded probe evidence.', [{ kind: 'content-type' }, { kind: 'body-prefix' }]);
  if (args.contentType && protocolContentTypeMismatch(args.fingerprint.protocol, args.contentType)) add('content-type-mismatch', 'protocol', 'warning', 'The response content type does not match the inferred stream protocol.', [{ kind: 'content-type' }, { kind: 'body-prefix' }]);
  if (args.fingerprint.bodyPrefixTruncated) add('body-prefix-truncated', 'protocol', 'info', 'Only a bounded response prefix was inspected.', [{ kind: 'body-prefix' }]);
  if (args.fingerprint.inputEventsTruncated) add('event-input-truncated', 'stream', 'warning', 'The probe event list exceeded the bounded analysis window.', [{ kind: 'raw-event', count: MAX_PROBE_EVENTS }]);

  const timing = args.input.timing;
  if (atLeast(timing?.headersLatencyMs, options.slowHeadersMs ?? DEFAULT_SLOW_HEADERS_MS)) add('slow-headers', 'timing', 'warning', 'Response headers arrived slower than the probe threshold.', [{ kind: 'timing' }]);
  if (atLeast(timing?.firstChunkLatencyMs, options.slowFirstChunkMs ?? DEFAULT_SLOW_FIRST_CHUNK_MS)) add('slow-first-chunk', 'timing', 'warning', 'The first response chunk arrived slower than the probe threshold.', [{ kind: 'timing' }]);
  if (atLeast(timing?.firstEventLatencyMs, options.slowFirstEventMs ?? DEFAULT_SLOW_FIRST_EVENT_MS)) add('slow-first-event', 'timing', 'warning', 'The first parsed event arrived slower than the probe threshold.', [{ kind: 'timing' }]);
  if (atLeast(timing?.totalLatencyMs, options.slowTotalMs ?? DEFAULT_SLOW_TOTAL_MS)) add('slow-total', 'timing', 'warning', 'The probe completed slower than the probe threshold.', [{ kind: 'timing' }]);

  if (args.fingerprint.rawEventCount === 0 && !args.body.trim()) add('no-response-data', 'stream', 'error', 'The successful response contained no bounded body prefix or parsed events.', [{ kind: 'body-prefix' }, { kind: 'raw-event', count: 0 }]);
  if (args.fingerprint.parseErrorCount > 0) add('event-parse-error', 'stream', 'error', 'One or more response events could not be parsed.', [{ kind: 'raw-event', count: args.fingerprint.parseErrorCount }]);
  if (args.fingerprint.mappingErrorCount > 0) add('mapping-error', 'mapping', 'error', 'One or more response events produced mapping errors.', [{ kind: 'mapping', count: args.fingerprint.mappingErrorCount }]);
  if (args.fingerprint.unmatchedEventCount > 0) add('unmatched-events', 'mapping', 'warning', 'Some response events did not match a configured mapping.', [{ kind: 'mapping', count: args.fingerprint.unmatchedEventCount }]);
  if (args.fingerprint.rawEventCount > 0 && args.fingerprint.normalizedEventCount === 0) add('mapping-no-events', 'mapping', 'error', 'Parsed response events produced no normalized events.', [{ kind: 'raw-event', count: args.fingerprint.rawEventCount }, { kind: 'normalized-event', count: 0 }]);
  if (args.fingerprint.terminalEventSeen && !args.fingerprint.terminalMapped && args.fingerprint.rawEventCount > 0) add('terminal-not-mapped', 'terminal', 'error', 'A terminal response signal was observed but no normalized terminal event was mapped.', [{ kind: 'raw-event', sequence: args.terminal.sequence }, { kind: 'normalized-event', count: args.fingerprint.normalizedEventCount }]);
  if (!args.fingerprint.terminalEventSeen && args.fingerprint.rawEventCount > 0 && (!args.fingerprint.bodyPrefixTruncated || args.rawEvents.length > 0)) add('missing-terminal-event', 'terminal', 'warning', 'The response ended without a detectable terminal event.', [{ kind: 'raw-event', count: args.fingerprint.rawEventCount }]);
  if (args.fingerprint.terminalEventSeen && args.fingerprint.terminalMapped) add('terminal-observed', 'terminal', 'info', 'A terminal response signal was observed and mapped.', [{ kind: 'normalized-event', sequence: args.terminal.sequence }]);
  if (args.fingerprint.protocol === 'sse' && args.body && !containsSseFraming(args.body) && args.fingerprint.rawEventCount === 0) add('sse-framing-not-observed', 'protocol', 'warning', 'The response was labelled as SSE, but no SSE field framing appeared in the inspected prefix.', [{ kind: 'content-type' }, { kind: 'body-prefix' }]);
  if (args.input.mapping?.configured === false) add('mapping-not-configured', 'mapping', 'error', 'No response mapping has been configured for this probe.', [{ kind: 'mapping' }]);
  return findings;
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().split(';', 1)[0]?.trim();
  return normalized && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(normalized) ? normalized : undefined;
}
function normalizeProtocol(value: unknown): ProbeProtocol {
  return value === 'sse' || value === 'ndjson' || value === 'json' || value === 'text-stream' ? value : 'unknown';
}
function parsesJson(value: string): boolean { try { JSON.parse(value); return true; } catch { return false; } }
function stripBom(value: string): string { return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value; }
function boundedUtf8Prefix(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!value) return { text: '', truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const length = probeEncoder.encode(character).byteLength;
    if (bytes + length > maxBytes) return { text: value.slice(0, end), truncated: true };
    bytes += length;
    end += character.length;
  }
  return { text: value, truncated: false };
}
function validStatus(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599; }
function boundedCount(value: number): number { return Number.isFinite(value) && value > 0 ? Math.min(MAX_PROBE_EVENTS, Math.floor(value)) : 0; }
function safeSequence(value: number): number | undefined { return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined; }
function atLeast(value: number | undefined, threshold: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= Math.max(0, threshold); }
function isTerminalType(value: unknown): boolean { return typeof value === 'string' && TERMINAL_TYPES.has(value.toLowerCase()); }
function isTerminalData(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === '[DONE]' || isTerminalType(value.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return isTerminalType(object.type) || isTerminalType(object.event) || isTerminalType(object.status) || object.finish_reason !== undefined;
}
function protocolContentTypeMismatch(protocol: ProbeProtocol, contentType: string): boolean {
  if (protocol === 'sse') return contentType !== 'text/event-stream';
  if (protocol === 'ndjson') return !/(?:ndjson|jsonl|json-seq)/.test(contentType);
  if (protocol === 'json') return !(contentType === 'application/json' || contentType.endsWith('+json'));
  if (protocol === 'text-stream') return !contentType.startsWith('text/');
  return false;
}
function containsSseFraming(value: string): boolean { return /(?:^|\n)\s*(?:data|event|id|retry)\s*:/.test(value); }
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}
