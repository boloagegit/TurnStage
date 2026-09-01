import type { ChatMessage, LocalRunSummary, NetworkExchange, SessionDelta, SessionSnapshot, SessionSnapshotCore } from './types';

export interface SessionSyncPayload {
  snapshot: SessionSnapshot;
  runs: LocalRunSummary[];
  requestPreview?: unknown;
  networkEntries?: NetworkExchange[];
}

/**
 * Tracks one Webview checkpoint and emits bounded append/upsert deltas for the
 * normal streaming path. Returning undefined intentionally requests a full
 * checkpoint when ordering or identity can no longer be proven.
 */
export class SessionDeltaTracker {
  private sessionId?: string;
  private rawLastSequence?: number;
  private normalizedLastSequence?: number;
  private messageIds = new Set<string>();
  private messageSignatures = new Map<string, string>();
  private runsSignature = '';
  private requestPreviewSignature = '';
  private networkSignature = '';

  checkpoint(payload: SessionSyncPayload): void {
    const { snapshot } = payload;
    this.sessionId = snapshot.sessionId;
    this.rawLastSequence = snapshot.rawEvents.at(-1)?.sequence;
    this.normalizedLastSequence = snapshot.normalizedEvents.at(-1)?.sequence;
    this.messageIds = new Set(snapshot.messages.map((message) => message.id));
    this.messageSignatures = new Map(snapshot.messages.map((message) => [message.id, messageSignature(message)]));
    this.runsSignature = safeSignature(payload.runs);
    this.requestPreviewSignature = safeSignature(payload.requestPreview);
    this.networkSignature = safeSignature(payload.networkEntries ?? []);
  }

  next(payload: SessionSyncPayload): SessionDelta | undefined {
    const { snapshot } = payload;
    if (this.sessionId !== snapshot.sessionId) return undefined;
    if (!continuesAfter(snapshot.rawEvents, this.rawLastSequence) || !continuesAfter(snapshot.normalizedEvents, this.normalizedLastSequence)) return undefined;

    const currentIds = new Set(snapshot.messages.map((message) => message.id));
    const removeIds = [...this.messageIds].filter((id) => !currentIds.has(id));
    const tailStart = Math.max(0, snapshot.messages.length - 4);
    const upsert: ChatMessage[] = [];
    for (let index = 0; index < snapshot.messages.length; index += 1) {
      const message = snapshot.messages[index]!;
      if (index < tailStart && this.messageIds.has(message.id)) continue;
      const signature = messageSignature(message);
      if (this.messageSignatures.get(message.id) !== signature) upsert.push(message);
      this.messageSignatures.set(message.id, signature);
    }
    for (const id of removeIds) this.messageSignatures.delete(id);

    const runsSignature = safeSignature(payload.runs);
    const requestPreviewSignature = safeSignature(payload.requestPreview);
    const networkSignature = safeSignature(payload.networkEntries ?? []);
    const delta: SessionDelta = {
      baseSessionId: snapshot.sessionId,
      core: sessionCore(snapshot),
      rawEvents: eventDelta(snapshot.rawEvents, this.rawLastSequence),
      normalizedEvents: eventDelta(snapshot.normalizedEvents, this.normalizedLastSequence),
      messages: { removeIds, upsert },
      ...(runsSignature !== this.runsSignature ? { runs: payload.runs } : {}),
      ...(requestPreviewSignature !== this.requestPreviewSignature ? { requestPreviewChanged: true, requestPreview: payload.requestPreview } : {}),
      ...(networkSignature !== this.networkSignature ? { networkEntries: payload.networkEntries ?? [] } : {}),
    };
    this.rawLastSequence = snapshot.rawEvents.at(-1)?.sequence;
    this.normalizedLastSequence = snapshot.normalizedEvents.at(-1)?.sequence;
    this.messageIds = currentIds;
    this.runsSignature = runsSignature;
    this.requestPreviewSignature = requestPreviewSignature;
    this.networkSignature = networkSignature;
    return delta;
  }
}

export function applySessionDelta(snapshot: SessionSnapshot | undefined, delta: SessionDelta): SessionSnapshot | undefined {
  if (!snapshot || snapshot.sessionId !== delta.baseSessionId || delta.core.sessionId !== delta.baseSessionId) return undefined;
  return {
    ...delta.core,
    rawEvents: applyEventDelta(snapshot.rawEvents, delta.rawEvents),
    normalizedEvents: applyEventDelta(snapshot.normalizedEvents, delta.normalizedEvents),
    messages: applyMessageDelta(snapshot.messages, delta.messages.removeIds, delta.messages.upsert),
  };
}

function sessionCore(snapshot: SessionSnapshot): SessionSnapshotCore {
  const { messages, rawEvents, normalizedEvents, ...core } = snapshot;
  void messages;
  void rawEvents;
  void normalizedEvents;
  return core;
}

function continuesAfter<T extends { sequence: number }>(events: readonly T[], previousLast: number | undefined): boolean {
  if (previousLast === undefined) return true;
  const index = lowerBoundSequence(events, previousLast);
  return events[index]?.sequence === previousLast;
}

function eventDelta<T extends { sequence: number }>(events: readonly T[], previousLast: number | undefined): { retainFromSequence?: number; append: T[] } {
  const retainFromSequence = events[0]?.sequence;
  return {
    ...(retainFromSequence === undefined ? {} : { retainFromSequence }),
    append: previousLast === undefined ? [...events] : events.slice(upperBoundSequence(events, previousLast)),
  };
}

function applyEventDelta<T extends { sequence: number }>(current: readonly T[], delta: { retainFromSequence?: number; append: T[] }): T[] {
  const retained = delta.retainFromSequence === undefined || (current[0]?.sequence ?? Number.POSITIVE_INFINITY) >= delta.retainFromSequence
    ? [...current]
    : current.slice(lowerBoundSequence(current, delta.retainFromSequence));
  if (!delta.append.length) return retained;
  if ((retained.at(-1)?.sequence ?? Number.NEGATIVE_INFINITY) < delta.append[0]!.sequence) return [...retained, ...delta.append];
  const appendedSequences = new Set(delta.append.map((event) => event.sequence));
  return [...retained.filter((event) => !appendedSequences.has(event.sequence)), ...delta.append].sort((left, right) => left.sequence - right.sequence);
}

function lowerBoundSequence<T extends { sequence: number }>(events: readonly T[], sequence: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.sequence < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundSequence<T extends { sequence: number }>(events: readonly T[], sequence: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.sequence <= sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

function applyMessageDelta(current: readonly ChatMessage[], removeIds: readonly string[], upsert: readonly ChatMessage[]): ChatMessage[] {
  const removed = new Set(removeIds);
  const updates = new Map(upsert.map((message) => [message.id, message]));
  const next = current.filter((message) => !removed.has(message.id)).map((message) => updates.get(message.id) ?? message);
  const existing = new Set(next.map((message) => message.id));
  for (const message of upsert) if (!existing.has(message.id)) { next.push(message); existing.add(message.id); }
  return next;
}

function messageSignature(message: ChatMessage): string {
  return safeSignature(message);
}

function safeSignature(value: unknown): string {
  try { return JSON.stringify(value) ?? 'undefined'; } catch { return '[unserializable]'; }
}
