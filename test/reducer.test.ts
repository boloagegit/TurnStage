import { describe, expect, it } from 'vitest';
import type { NormalizedEvent, SessionSnapshot } from '../src/shared/types';
import { createSnapshot, reduceEvent } from '../src/extension/runtime/reducer';

function event(type: string, sequence: number, fields: Record<string, unknown> = {}): NormalizedEvent {
  return {
    version: 1,
    type,
    sequence,
    receivedAt: 1_700_000_000_000 + sequence,
    mappingRuleId: `${type}-${sequence}`,
    ...fields,
  };
}

function assistantMessage(snapshot: SessionSnapshot) {
  const message = snapshot.messages.find((item) => item.role === 'assistant');
  expect(message).toBeDefined();
  return message!;
}

describe('reduceEvent', () => {
  it('creates one assistant message and appends text deltas to one part', () => {
    const snapshot = createSnapshot(true);

    reduceEvent(snapshot, event('conversation.started', 1, { conversationId: 'conv-1', assistantMessageId: 'assistant-server-1' }));
    reduceEvent(snapshot, event('content.text.delta', 2, { text: 'Hello' }));
    reduceEvent(snapshot, event('content.text.delta', 3, { text: ', world!' }));

    expect(snapshot.conversationId).toBe('conv-1');
    expect(snapshot.turnState).toBe('streaming');
    expect(snapshot.messages).toHaveLength(1);
    expect(assistantMessage(snapshot)).toMatchObject({
      id: 'assistant-server-1',
      role: 'assistant',
      status: 'streaming',
      parts: [{ type: 'text', text: 'Hello, world!' }],
      metadata: { rawSequences: [1, 2, 3] },
    });
  });

  it('links normalized events to raw stream sequences without duplicates', () => {
    const snapshot = createSnapshot(true);
    reduceEvent(snapshot, event('content.text.delta', 10, { text: 'Hello', rawSequence: 4 }));
    reduceEvent(snapshot, event('content.text.delta', 11, { text: ' world', rawSequence: 4 }));
    reduceEvent(snapshot, event('stream.completed', 12, { rawSequence: 5 }));

    expect(assistantMessage(snapshot).metadata?.rawSequences).toEqual([4, 5]);
  });

  it('deduplicates a replayed normalized event without duplicating content', () => {
    const snapshot = createSnapshot(true);
    const delta = event('content.text.delta', 1, { text: 'once', mappingRuleId: 'delta' });

    reduceEvent(snapshot, delta);
    reduceEvent(snapshot, { ...delta });

    expect(snapshot.normalizedEvents).toHaveLength(1);
    expect(assistantMessage(snapshot).parts).toEqual([{ type: 'text', text: 'once' }]);
  });

  it('upserts citations, attaches references, and avoids duplicate citation entities', () => {
    const snapshot = createSnapshot(true);

    reduceEvent(snapshot, event('citation.upsert', 1, { citation: { id: 'cite-1', title: 'Original', kind: 'url' } }));
    reduceEvent(snapshot, event('citation.upsert', 2, { citation: { id: 'cite-1', title: 'Updated', uri: 'https://example.test' } }));
    reduceEvent(snapshot, event('citation.attach', 3, { citation: { id: 'cite-1', title: 'Ignored duplicate' } }));
    reduceEvent(snapshot, event('citation.attach', 4, { citation: { title: 'Generated id' } }));
    reduceEvent(snapshot, event('content.citation', 5, { citationId: 'cite-1' }));

    const message = assistantMessage(snapshot);
    expect(message.citations).toEqual([
      { id: 'cite-1', title: 'Updated', kind: 'url', uri: 'https://example.test' },
      { id: 'citation-4', title: 'Generated id' },
    ]);
    expect(message.parts).toContainEqual({ type: 'citation-reference', citationId: 'cite-1' });
  });

  it('tracks tool lifecycle and concatenates argument deltas', () => {
    const snapshot = createSnapshot(true);

    reduceEvent(snapshot, event('tool.started', 1, { toolCallId: 'tool-1', name: 'search' }));
    reduceEvent(snapshot, event('tool.arguments.delta', 2, { toolCallId: 'tool-1', arguments: '{"q":' }));
    reduceEvent(snapshot, event('tool.arguments.delta', 3, { toolCallId: 'tool-1', arguments: '"docs"}' }));
    reduceEvent(snapshot, event('tool.completed', 4, { toolCallId: 'tool-1', result: { count: 2 } }));

    expect(assistantMessage(snapshot).parts).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      toolCallId: 'tool-1',
      name: 'search',
      arguments: '{"q":"docs"}',
      status: 'completed',
      result: { count: 2 },
      completedAt: 1_700_000_000_004,
    }));
  });

  it('upserts and removes followups and actions', () => {
    const snapshot = createSnapshot(true);

    reduceEvent(snapshot, event('followup.upsert', 1, { followup: { id: 'f-1', label: 'First', prompt: 'one', behavior: 'send' } }));
    reduceEvent(snapshot, event('followup.upsert', 2, { followup: { id: 'f-1', label: 'Updated', prompt: 'two', behavior: 'fill' } }));
    reduceEvent(snapshot, event('followup.upsert', 3, { followup: { label: 'Generated', prompt: 'three', behavior: 'action' } }));
    reduceEvent(snapshot, event('action.upsert', 4, { action: { id: 'a-1', label: 'Run', actionId: 'run', appearance: 'primary' } }));
    reduceEvent(snapshot, event('action.remove', 5, { actionId: 'a-1' }));
    reduceEvent(snapshot, event('followup.remove', 6, { followupId: 'f-1' }));

    const message = assistantMessage(snapshot);
    expect(message.followups).toEqual([{ id: 'followup-3', label: 'Generated', prompt: 'three', behavior: 'action' }]);
    expect(message.actions).toEqual([]);
  });

  it('attaches configurable metrics to the explicit message and applies aggregation', () => {
    const snapshot = createSnapshot(true);
    reduceEvent(snapshot, event('conversation.started', 1, { conversationId: 'conv-1', assistantMessageId: 'assistant-server-1' }));
    reduceEvent(snapshot, event('message.metric.updated', 2, { messageId: 'assistant-server-1', metric: { id: 'tokens', label: 'Tokens', value: 12, aggregation: 'sum', format: 'number' } }));
    reduceEvent(snapshot, event('message.metric.updated', 3, { messageId: 'assistant-server-1', metric: { id: 'tokens', label: 'Tokens', value: 8, aggregation: 'sum', format: 'number' } }));
    reduceEvent(snapshot, event('message.metric.updated', 4, { metric: { id: 'e2e', label: 'E2E', value: 180, unit: 'ms', format: 'duration', aggregation: 'last' } }));

    expect(assistantMessage(snapshot).metrics).toEqual([
      { id: 'tokens', label: 'Tokens', value: 20, aggregation: 'sum', format: 'number', sampleCount: 2 },
      { id: 'e2e', label: 'E2E', value: 180, unit: 'ms', format: 'duration', aggregation: 'last', sampleCount: 1 },
    ]);
  });

  it('supports first, min, max, and count metrics without accepting invalid numeric samples', () => {
    const snapshot = createSnapshot(true);
    reduceEvent(snapshot, event('message.metric.updated', 1, { metric: { id: 'first', value: 'initial', aggregation: 'first' } }));
    reduceEvent(snapshot, event('message.metric.updated', 2, { metric: { id: 'first', value: 'ignored', aggregation: 'first' } }));
    reduceEvent(snapshot, event('message.metric.updated', 3, { metric: { id: 'min', value: 9, aggregation: 'min' } }));
    reduceEvent(snapshot, event('message.metric.updated', 4, { metric: { id: 'min', value: 4, aggregation: 'min' } }));
    reduceEvent(snapshot, event('message.metric.updated', 5, { metric: { id: 'max', value: 2, aggregation: 'max' } }));
    reduceEvent(snapshot, event('message.metric.updated', 6, { metric: { id: 'max', value: 7, aggregation: 'max' } }));
    reduceEvent(snapshot, event('message.metric.updated', 7, { metric: { id: 'events', aggregation: 'count' } }));
    reduceEvent(snapshot, event('message.metric.updated', 8, { metric: { id: 'events', aggregation: 'count' } }));
    reduceEvent(snapshot, event('message.metric.updated', 9, { metric: { id: 'min', value: 'invalid', aggregation: 'min' } }));

    expect(assistantMessage(snapshot).metrics?.map(({ id, value, sampleCount }) => ({ id, value, sampleCount }))).toEqual([
      { id: 'first', value: 'initial', sampleCount: 2 },
      { id: 'min', value: 4, sampleCount: 2 },
      { id: 'max', value: 7, sampleCount: 2 },
      { id: 'events', value: 2, sampleCount: 2 },
    ]);
  });

  it('updates a declarative form by id without duplicating it', () => {
    const snapshot = createSnapshot(true);
    reduceEvent(snapshot, event('form.upsert', 1, { form: { id: 'form-1', title: 'First', fields: [], submit: { action: 'send', messageTemplate: 'one', interactionKind: 'formSubmit' } } }));
    reduceEvent(snapshot, event('form.upsert', 2, { form: { id: 'form-1', title: 'Updated', fields: [], submit: { action: 'send', messageTemplate: 'two', interactionKind: 'formSubmit' } } }));

    expect(assistantMessage(snapshot).parts).toEqual([expect.objectContaining({ type: 'form', form: expect.objectContaining({ id: 'form-1', title: 'Updated' }) })]);
  });

  it('transitions terminal stream events and records stream failures', () => {
    const completed = createSnapshot(true);
    reduceEvent(completed, event('stream.completed', 1));
    expect(completed.turnState).toBe('completed');

    const failed = createSnapshot(true);
    reduceEvent(failed, event('stream.failed', 1, { error: 'remote exploded' }));
    expect(failed.turnState).toBe('failed');
    expect(failed.errors).toContainEqual({ type: 'StreamError', message: 'remote exploded', retrySafe: true });
  });
});
