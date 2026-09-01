import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSnapshot } from '../src/shared/types';
import { applySessionDelta, SessionDeltaTracker, type SessionSyncPayload } from '../src/shared/sessionDelta';

function message(id: string, text: string, status: ChatMessage['status'] = 'completed'): ChatMessage {
  return { id, role: 'assistant', status, createdAt: 1, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] };
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-1', sessionState: 'ready', turnState: 'idle', messages: [message('message-1', 'first')],
    rawEvents: [{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'sse', raw: 'one', data: { value: 1 } }],
    normalizedEvents: [{ version: 1, type: 'content.delta', sequence: 1, receivedAt: 1, rawSequence: 1 }],
    metrics: { eventCount: 1, byteCount: 3, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 },
    errors: [], droppedEventCount: 0, trusted: true, controls: {}, ...overrides,
  };
}

function payload(value: SessionSnapshot): SessionSyncPayload { return { snapshot: value, runs: [], networkEntries: [] }; }

describe('session delta synchronization', () => {
  it('appends events and upserts only the changed tail message', () => {
    const tracker = new SessionDeltaTracker();
    const initial = snapshot();
    tracker.checkpoint(payload(initial));
    const next = snapshot({
      messages: [message('message-1', 'first'), message('message-2', 'streamed', 'streaming')],
      rawEvents: [...initial.rawEvents, { sequence: 2, receivedAt: 2, elapsedMs: 1, protocol: 'sse', raw: 'two', data: { value: 2 } }],
      normalizedEvents: [...initial.normalizedEvents, { version: 1, type: 'content.delta', sequence: 2, receivedAt: 2, rawSequence: 2 }],
      metrics: { ...initial.metrics, eventCount: 2 },
    });
    const delta = tracker.next(payload(next));
    expect(delta).toMatchObject({ baseSessionId: 'session-1', rawEvents: { append: [{ sequence: 2 }] }, normalizedEvents: { append: [{ sequence: 2 }] }, messages: { removeIds: [], upsert: [{ id: 'message-2' }] } });
    expect(applySessionDelta(initial, delta!)).toEqual(next);
  });

  it('drops evicted buffers and messages without duplicating appended data', () => {
    const tracker = new SessionDeltaTracker();
    const initial = snapshot({ messages: [message('old', 'old'), message('keep', 'keep')] });
    tracker.checkpoint(payload(initial));
    const next = snapshot({
      messages: [message('keep', 'keep'), message('new', 'new')],
      rawEvents: [{ sequence: 2, receivedAt: 2, elapsedMs: 1, protocol: 'sse', raw: 'two', data: {} }],
      normalizedEvents: [{ version: 1, type: 'content.delta', sequence: 2, receivedAt: 2 }],
    });
    const delta = tracker.next(payload(next));
    expect(delta).toBeUndefined();

    const continued = snapshot({
      messages: [message('keep', 'keep'), message('new', 'new')],
      rawEvents: [...initial.rawEvents, { sequence: 2, receivedAt: 2, elapsedMs: 1, protocol: 'sse', raw: 'two', data: {} }],
      normalizedEvents: [...initial.normalizedEvents, { version: 1, type: 'content.delta', sequence: 2, receivedAt: 2 }],
    });
    const continuedDelta = tracker.next(payload(continued));
    expect(continuedDelta?.messages.removeIds).toEqual(['old']);
    expect(applySessionDelta(initial, continuedDelta!)?.messages.map((item) => item.id)).toEqual(['keep', 'new']);
  });

  it('applies a rolling event-buffer window when the previous tail is retained', () => {
    const tracker = new SessionDeltaTracker();
    const raw = [1, 2, 3].map((sequence) => ({ sequence, receivedAt: sequence, elapsedMs: sequence, protocol: 'sse' as const, raw: String(sequence), data: {} }));
    const normalized = [1, 2, 3].map((sequence) => ({ version: 1 as const, type: 'content.delta', sequence, receivedAt: sequence }));
    const initial = snapshot({ rawEvents: raw, normalizedEvents: normalized });
    tracker.checkpoint(payload(initial));
    const next = snapshot({
      rawEvents: [...raw.slice(1), { sequence: 4, receivedAt: 4, elapsedMs: 4, protocol: 'sse', raw: '4', data: {} }],
      normalizedEvents: [...normalized.slice(1), { version: 1, type: 'content.delta', sequence: 4, receivedAt: 4 }],
    });

    const delta = tracker.next(payload(next));
    expect(delta?.rawEvents).toMatchObject({ retainFromSequence: 2, append: [{ sequence: 4 }] });
    expect(applySessionDelta(initial, delta!)?.rawEvents.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(applySessionDelta(initial, delta!)?.normalizedEvents.map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it('fails closed when the Webview checkpoint does not match', () => {
    const tracker = new SessionDeltaTracker();
    const initial = snapshot();
    tracker.checkpoint(payload(initial));
    const delta = tracker.next(payload(snapshot({ title: 'updated' })))!;
    expect(applySessionDelta(snapshot({ sessionId: 'other' }), delta)).toBeUndefined();
    expect(tracker.next(payload(snapshot({ sessionId: 'new-session' })))).toBeUndefined();
  });
});
