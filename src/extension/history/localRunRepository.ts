import * as vscode from 'vscode';
import type { ChatMessage, Citation, Followup, LocalRun, MessagePart, MetricsSnapshot, NormalizedEvent, RawStreamEvent, RemoteSessionReference, ReplaySnapshot, ResponseAction, RuntimeErrorData, SessionSnapshot, Starter } from '../../shared/types';

type UnknownRecord = Record<string, unknown>;

const localSaveQueues = new Map<string, Promise<void>>();
const rawProtocols = new Set<RawStreamEvent['protocol']>(['sse', 'ndjson', 'json', 'text-stream', 'fixture']);
const sessionStates = new Set<SessionSnapshot['sessionState']>(['notStarted', 'loadingOpening', 'ready', 'resetting', 'failed']);
const turnStates = new Set<SessionSnapshot['turnState']>(['idle', 'submitting', 'waitingStart', 'streaming', 'stopping', 'completed', 'failed', 'aborted']);
const messageRoles = new Set<ChatMessage['role']>(['user', 'assistant', 'system', 'tool']);
const messageStatuses = new Set<ChatMessage['status']>(['pending', 'streaming', 'completed', 'failed', 'aborted']);
const starterBehaviors = new Set<Starter['behavior']>(['send', 'fill', 'action']);
const followupBehaviors = starterBehaviors;
const actionAppearances = new Set<NonNullable<ResponseAction['appearance']>>(['primary', 'secondary', 'link']);
const citationKinds = new Set<NonNullable<Citation['kind']>>(['url', 'file', 'symbol', 'artifact']);
const replayStatuses = new Set<ReplaySnapshot['status']>(['idle', 'playing', 'paused', 'completed', 'stopped']);
const replaySpeeds = new Set<ReplaySnapshot['speed']>([0.25, 0.5, 1, 2, 4]);

export class LocalRunRepository {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private uri(profileId: string): vscode.Uri { return vscode.Uri.joinPath(this.context.globalStorageUri, 'runs', `${profileId}.json`); }

  async list(profileId: string): Promise<LocalRun[]> {
    if (!isNonEmptyString(profileId)) return [];
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri(profileId))));
      return sanitizeLocalRuns(parsed, profileId);
    } catch {
      return [];
    }
  }

  async save(run: LocalRun, retention: number): Promise<void> {
    const profileId = isRecord(run) && isNonEmptyString(run.profileId) ? run.profileId : undefined;
    if (!profileId) return;
    const uri = this.uri(profileId);
    await withQueue(localSaveQueues, uri.toString(), async () => {
      const safeRun = sanitizeLocalRun(run, profileId);
      if (!safeRun) return;
      const runs = [safeRun, ...(await this.list(profileId)).filter((item) => item.id !== safeRun.id)].slice(0, normalizeRetention(retention));
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      // VS Code's workspace.fs adapters and the repository fakes do not expose a
      // common atomic replace contract. The in-process queue makes this
      // read-modify-write sequence lossless for concurrent extension callers.
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(runs)));
    });
  }

  async export(run: LocalRun): Promise<vscode.Uri | undefined> {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${run.profileId}-${run.id}.turnstage-run.json`), filters: { 'TurnStage Run': ['json'] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(run, null, 2))); return uri;
  }
}

function withQueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return current.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}

function sanitizeLocalRuns(value: unknown, profileId: string): LocalRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const safe = sanitizeLocalRun(item, profileId);
    return safe ? [safe] : [];
  });
}

function sanitizeLocalRun(value: unknown, profileId: string): LocalRun | undefined {
  const record = asRecord(value);
  if (!record || record.profileId !== profileId || !isNonEmptyString(record.id) || !isTimestamp(record.createdAt)) return undefined;
  const metrics = sanitizeMetrics(record.metrics);
  const result = sanitizeTurnResult(record.result);
  if (!metrics || !result) return undefined;

  const run: LocalRun = { id: record.id, profileId, createdAt: record.createdAt, metrics, result };
  if (record.request !== undefined) {
    const request = sanitizeRedactedRequest(record.request);
    if (!request) return undefined;
    run.request = request;
  }
  if (record.rawEvents !== undefined) {
    const rawEvents = sanitizeRawEvents(record.rawEvents);
    if (!rawEvents) return undefined;
    run.rawEvents = rawEvents;
  }
  if (record.normalizedEvents !== undefined) {
    const normalizedEvents = sanitizeNormalizedEvents(record.normalizedEvents);
    if (!normalizedEvents) return undefined;
    run.normalizedEvents = normalizedEvents;
  }
  if (record.snapshot !== undefined) {
    const snapshot = sanitizeSnapshot(record.snapshot);
    if (!snapshot) return undefined;
    run.snapshot = snapshot;
  }
  return run;
}

function sanitizeRedactedRequest(value: unknown): LocalRun['request'] | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.method) || !isNonEmptyString(record.url) || !isStringRecord(record.headers)) return undefined;
  const request: NonNullable<LocalRun['request']> = { method: record.method, url: record.url, headers: record.headers };
  if (record.body !== undefined) request.body = record.body;
  if (record.variantId !== undefined) {
    if (typeof record.variantId !== 'string') return undefined;
    request.variantId = record.variantId;
  }
  return request;
}

function sanitizeRawEvents(value: unknown): RawStreamEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: RawStreamEvent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !Object.prototype.hasOwnProperty.call(record, 'data') || !isNonNegativeNumber(record.sequence) || !isTimestamp(record.receivedAt) || !isNonNegativeNumber(record.elapsedMs) || typeof record.protocol !== 'string' || !rawProtocols.has(record.protocol as RawStreamEvent['protocol']) || typeof record.raw !== 'string') return undefined;
    const event: RawStreamEvent = { sequence: record.sequence, receivedAt: record.receivedAt, elapsedMs: record.elapsedMs, protocol: record.protocol as RawStreamEvent['protocol'], raw: record.raw, data: record.data };
    if (record.sse !== undefined) {
      const sse = sanitizeSse(record.sse);
      if (!sse) return undefined;
      event.sse = sse;
    }
    for (const key of ['parseError', 'mappingRuleId', 'mappingError'] as const) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== 'string') return undefined;
        event[key] = record[key];
      }
    }
    events.push(event);
  }
  return events;
}

function sanitizeSse(value: unknown): NonNullable<RawStreamEvent['sse']> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const sse: NonNullable<RawStreamEvent['sse']> = {};
  for (const key of ['event', 'id'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') return undefined;
      sse[key] = record[key];
    }
  }
  if (record.retry !== undefined) {
    if (!isNonNegativeNumber(record.retry)) return undefined;
    sse.retry = record.retry;
  }
  return sse;
}

function sanitizeNormalizedEvents(value: unknown): NormalizedEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: NormalizedEvent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || record.version !== 1 || !isNonEmptyString(record.type) || !isNonNegativeNumber(record.sequence) || !isTimestamp(record.receivedAt)) return undefined;
    if (record.rawSequence !== undefined && !isNonNegativeNumber(record.rawSequence)) return undefined;
    if (record.mappingRuleId !== undefined && typeof record.mappingRuleId !== 'string') return undefined;
    events.push({ ...record, version: 1, type: record.type, sequence: record.sequence, receivedAt: record.receivedAt } as NormalizedEvent);
  }
  return events;
}

function sanitizeMetrics(value: unknown): MetricsSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const required = ['eventCount', 'byteCount', 'parseErrorCount', 'mappingErrorCount', 'unmatchedEventCount'] as const;
  if (required.some((key) => !isNonNegativeNumber(record[key]))) return undefined;
  const metrics = {
    eventCount: record.eventCount,
    byteCount: record.byteCount,
    parseErrorCount: record.parseErrorCount,
    mappingErrorCount: record.mappingErrorCount,
    unmatchedEventCount: record.unmatchedEventCount,
  } as MetricsSnapshot;
  if (record.requestStartedAt !== undefined) {
    if (!isTimestamp(record.requestStartedAt)) return undefined;
    metrics.requestStartedAt = record.requestStartedAt;
  }
  const durations = ['headersLatency', 'firstChunkLatency', 'firstEventLatency', 'ttft', 'streamDuration', 'totalDuration', 'averageEventGap', 'maxEventGap'] as const;
  for (const key of durations) {
    if (record[key] !== undefined) {
      if (!isNonNegativeNumber(record[key])) return undefined;
      metrics[key] = record[key];
    }
  }
  if (record.abortReason !== undefined) {
    if (typeof record.abortReason !== 'string') return undefined;
    metrics.abortReason = record.abortReason;
  }
  return metrics;
}

function sanitizeTurnResult(value: unknown): LocalRun['result'] | undefined {
  const record = asRecord(value);
  if (!record || typeof record.type !== 'string') return undefined;
  if (record.type === 'completed') return { type: 'completed' };
  if (record.type === 'aborted') return typeof record.reason === 'string' ? { type: 'aborted', reason: record.reason } : undefined;
  if (record.type === 'failed') {
    const error = sanitizeRuntimeError(record.error);
    return error ? { type: 'failed', error } : undefined;
  }
  return undefined;
}

function sanitizeRuntimeError(value: unknown): RuntimeErrorData | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.type) || typeof record.message !== 'string') return undefined;
  const error: RuntimeErrorData = { type: record.type, message: record.message };
  for (const key of ['suggestion', 'ruleId'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') return undefined;
      error[key] = record[key];
    }
  }
  if (record.status !== undefined) {
    if (!isFiniteNumber(record.status)) return undefined;
    error.status = record.status;
  }
  if (record.rawSequence !== undefined) {
    if (!isNonNegativeNumber(record.rawSequence)) return undefined;
    error.rawSequence = record.rawSequence;
  }
  if (record.retrySafe !== undefined) {
    if (typeof record.retrySafe !== 'boolean') return undefined;
    error.retrySafe = record.retrySafe;
  }
  return error;
}

function sanitizeSnapshot(value: unknown): SessionSnapshot | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.sessionId) || typeof record.sessionState !== 'string' || !sessionStates.has(record.sessionState as SessionSnapshot['sessionState']) || typeof record.turnState !== 'string' || !turnStates.has(record.turnState as SessionSnapshot['turnState']) || typeof record.trusted !== 'boolean' || !isNonNegativeNumber(record.droppedEventCount)) return undefined;
  const messages = sanitizeMessages(record.messages);
  const rawEvents = sanitizeRawEvents(record.rawEvents);
  const normalizedEvents = sanitizeNormalizedEvents(record.normalizedEvents);
  const metrics = sanitizeMetrics(record.metrics);
  const errors = sanitizeErrors(record.errors);
  if (!messages || !rawEvents || !normalizedEvents || !metrics || !errors || !isRecord(record.controls)) return undefined;
  const snapshot: SessionSnapshot = { sessionId: record.sessionId, sessionState: record.sessionState as SessionSnapshot['sessionState'], turnState: record.turnState as SessionSnapshot['turnState'], messages, rawEvents, normalizedEvents, metrics, errors, droppedEventCount: record.droppedEventCount, trusted: record.trusted, controls: record.controls };
  for (const key of ['conversationId', 'title'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') return undefined;
      snapshot[key] = record[key];
    }
  }
  if (record.opening !== undefined) {
    const opening = sanitizeOpening(record.opening);
    if (!opening) return undefined;
    snapshot.opening = opening;
  }
  if (record.replay !== undefined) {
    const replay = sanitizeReplay(record.replay);
    if (!replay) return undefined;
    snapshot.replay = replay;
  }
  if (record.remoteSessions !== undefined) {
    const remoteSessions = sanitizeRemoteSessions(record.remoteSessions);
    if (!remoteSessions) return undefined;
    snapshot.remoteSessions = remoteSessions;
  }
  return snapshot;
}

function sanitizeMessages(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.id) || typeof record.role !== 'string' || !messageRoles.has(record.role as ChatMessage['role']) || typeof record.status !== 'string' || !messageStatuses.has(record.status as ChatMessage['status']) || !isTimestamp(record.createdAt) || !Array.isArray(record.parts) || !Array.isArray(record.citations) || !Array.isArray(record.actions) || !Array.isArray(record.followups)) return undefined;
    const parts = sanitizeMessageParts(record.parts);
    const citations = sanitizeCitations(record.citations);
    const actions = sanitizeActions(record.actions);
    const followups = sanitizeFollowups(record.followups);
    if (!parts || !citations || !actions || !followups) return undefined;
    const message: ChatMessage = { id: record.id, role: record.role as ChatMessage['role'], status: record.status as ChatMessage['status'], createdAt: record.createdAt, parts, citations, actions, followups };
    if (record.completedAt !== undefined) {
      if (!isTimestamp(record.completedAt)) return undefined;
      message.completedAt = record.completedAt;
    }
    if (record.metadata !== undefined) {
      if (!isRecord(record.metadata)) return undefined;
      message.metadata = record.metadata;
    }
    messages.push(message);
  }
  return messages;
}

function sanitizeMessageParts(value: unknown): MessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: MessagePart[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.type)) return undefined;
    if (record.text !== undefined && typeof record.text !== 'string') return undefined;
    parts.push({ ...record } as MessagePart);
  }
  return parts;
}

function sanitizeCitations(value: unknown): Citation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations: Citation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.id)) return undefined;
    if (record.kind !== undefined && (typeof record.kind !== 'string' || !citationKinds.has(record.kind as NonNullable<Citation['kind']>))) return undefined;
    for (const key of ['title', 'uri', 'path', 'snippet', 'description', 'sourceName'] as const) if (record[key] !== undefined && typeof record[key] !== 'string') return undefined;
    citations.push({ ...record } as Citation);
  }
  return citations;
}

function sanitizeActions(value: unknown): ResponseAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: ResponseAction[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.id) || !isNonEmptyString(record.label) || !isNonEmptyString(record.actionId)) return undefined;
    if (record.appearance !== undefined && (typeof record.appearance !== 'string' || !actionAppearances.has(record.appearance as NonNullable<ResponseAction['appearance']>))) return undefined;
    if (record.tooltip !== undefined && typeof record.tooltip !== 'string') return undefined;
    if (record.payload !== undefined && !isRecord(record.payload)) return undefined;
    if (record.confirm !== undefined) {
      const confirm = asRecord(record.confirm);
      if (!confirm || !isNonEmptyString(confirm.title) || typeof confirm.message !== 'string') return undefined;
    }
    actions.push({ ...record } as unknown as ResponseAction);
  }
  return actions;
}

function sanitizeFollowups(value: unknown): Followup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const followups: Followup[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.id) || !isNonEmptyString(record.label) || !isNonEmptyString(record.prompt) || typeof record.behavior !== 'string' || !followupBehaviors.has(record.behavior as Followup['behavior'])) return undefined;
    if (record.tooltip !== undefined && typeof record.tooltip !== 'string') return undefined;
    if (record.actionId !== undefined && typeof record.actionId !== 'string') return undefined;
    if (record.payload !== undefined && !isRecord(record.payload)) return undefined;
    followups.push({ ...record } as unknown as Followup);
  }
  return followups;
}

function sanitizeErrors(value: unknown): RuntimeErrorData[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const errors: RuntimeErrorData[] = [];
  for (const item of value) {
    const error = sanitizeRuntimeError(item);
    if (!error) return undefined;
    errors.push(error);
  }
  return errors;
}

function sanitizeOpening(value: unknown): SessionSnapshot['opening'] | undefined {
  const record = asRecord(value);
  if (!record || typeof record.message !== 'string') return undefined;
  const starters = sanitizeStarters(record.starters);
  return starters ? { message: record.message, starters } : undefined;
}

function sanitizeStarters(value: unknown): Starter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const starters: Starter[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.id) || !isNonEmptyString(record.label) || typeof record.prompt !== 'string' || typeof record.behavior !== 'string' || !starterBehaviors.has(record.behavior as Starter['behavior'])) return undefined;
    if (record.actionId !== undefined && typeof record.actionId !== 'string') return undefined;
    starters.push({ ...record } as unknown as Starter);
  }
  return starters;
}

function sanitizeReplay(value: unknown): ReplaySnapshot | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.runId) || typeof record.status !== 'string' || !replayStatuses.has(record.status as ReplaySnapshot['status']) || !replaySpeeds.has(record.speed as ReplaySnapshot['speed']) || !isNonNegativeNumber(record.index) || !isNonNegativeNumber(record.total)) return undefined;
  return { runId: record.runId, status: record.status as ReplaySnapshot['status'], speed: record.speed as ReplaySnapshot['speed'], index: record.index, total: record.total };
}

function sanitizeRemoteSessions(value: unknown): RemoteSessionReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references: RemoteSessionReference[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || !isNonEmptyString(record.conversationId) || typeof record.title !== 'string' || !isTimestamp(record.createdAt)) return undefined;
    const reference: RemoteSessionReference = { conversationId: record.conversationId, title: record.title, createdAt: record.createdAt };
    for (const key of ['actorId', 'environmentId'] as const) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== 'string') return undefined;
        reference[key] = record[key];
      }
    }
    references.push(reference);
  }
  return references;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function isRecord(value: unknown): value is UnknownRecord { return asRecord(value) !== undefined; }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isNonNegativeNumber(value: unknown): value is number { return isFiniteNumber(value) && value >= 0; }
function isTimestamp(value: unknown): value is number { return isNonNegativeNumber(value) && Number.isFinite(new Date(value).getTime()); }
function isStringRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every((item) => typeof item === 'string'); }
function normalizeRetention(value: number): number { return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0; }
