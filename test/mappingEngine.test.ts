import { describe, expect, it } from 'vitest';
import type { RawStreamEvent, StreamDefinition } from '../src/shared/types';
import { MappingEngine } from '../src/extension/mapping/mappingEngine';

function raw(data: unknown, event = 'message'): RawStreamEvent {
  return {
    sequence: 7,
    receivedAt: 1_700_000_000_007,
    elapsedMs: 7,
    protocol: 'sse',
    sse: { event },
    raw: JSON.stringify(data),
    data,
  };
}

describe('MappingEngine', () => {
  it('uses the first matching rule by default and extracts nested values', () => {
    const stream: StreamDefinition = {
      transport: 'sse',
      mappingMode: 'firstMatch',
      mappings: [
        {
          id: 'delta',
          match: { event: 'message', path: '$.kind', operator: 'equals', value: 'delta' },
          emit: {
            type: 'content.text.delta',
            text: { path: '$.payload.text' },
            meta: { id: { path: '$.payload.id' }, tags: [{ path: '$.payload.tag' }] },
          },
        },
        {
          id: 'fallback',
          match: { event: 'message' },
          emit: { type: 'diagnostic.updated', diagnostic: { path: '$.payload' } },
        },
      ],
    };

    const result = new MappingEngine(stream).map(raw({ kind: 'delta', payload: { text: 'hello', id: 'm-1', tag: 'chat' } }));

    expect(result.errors).toEqual([]);
    expect(result.ruleIds).toEqual(['delta']);
    expect(result.events).toEqual([{
      version: 1,
      type: 'content.text.delta',
      text: 'hello',
      meta: { id: 'm-1', tags: ['chat'] },
      sequence: 7,
      receivedAt: 1_700_000_000_007,
      rawSequence: 7,
      mappingRuleId: 'delta',
    }]);
  });

  it('maps every matching rule in allMatches mode and honors continue in firstMatch mode', () => {
    const allMatches: StreamDefinition = {
      transport: 'ndjson',
      mappingMode: 'allMatches',
      mappings: [
        { id: 'text', match: { path: '$.text', operator: 'exists' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
        { id: 'tagged', match: { path: '$.tags', operator: 'contains', value: 'important' }, emit: { type: 'diagnostic.updated', diagnostic: { path: '$.tags' } } },
      ],
    };
    const both = new MappingEngine(allMatches).map(raw({ text: 'hello', tags: ['important'] }, 'line'));

    expect(both.ruleIds).toEqual(['text', 'tagged']);
    expect(both.events.map((event) => event.type)).toEqual(['content.text.delta', 'diagnostic.updated']);
    expect(both.events[1]?.diagnostic).toEqual(['important']);

    const continuing: StreamDefinition = {
      ...allMatches,
      mappingMode: 'firstMatch',
      mappings: allMatches.mappings.map((rule, index) => index === 0 ? { ...rule, continue: true } : rule),
    };
    expect(new MappingEngine(continuing).map(raw({ text: 'hello', tags: ['important'] }, 'line')).ruleIds).toEqual(['text', 'tagged']);
  });

  it('records mapping errors from a broken regex and continues evaluating later rules', () => {
    const stream: StreamDefinition = {
      transport: 'sse',
      mappingMode: 'firstMatch',
      mappings: [
        { id: 'broken', match: { path: '$.kind', operator: 'regex', value: '[' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
        { id: 'fallback', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
      ],
    };

    const result = new MappingEngine(stream).map(raw({ kind: 'delta', text: 'still mapped' }));

    expect(result.ruleIds).toEqual(['fallback']);
    expect(result.events[0]).toMatchObject({ type: 'content.text.delta', text: 'still mapped', mappingRuleId: 'fallback' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ ruleId: 'broken' });
    expect(result.errors[0]?.message).toEqual(expect.any(String));
  });

  it('extracts a generic message metric and optional message correlation id', () => {
    const stream: StreamDefinition = {
      transport: 'sse',
      mappings: [{
        id: 'message-e2e',
        match: { event: 'diagnostic' },
        emit: {
          type: 'message.metric.updated',
          messageId: { path: '$.assistantMessageId' },
          metric: { id: 'e2e', label: 'E2E', value: { path: '$.e2e_ms' }, unit: 'ms', format: 'duration', aggregation: 'last' },
        },
      }],
    };

    const result = new MappingEngine(stream).map(raw({ assistantMessageId: 'assistant-7', e2e_ms: 180 }, 'diagnostic'));
    expect(result.events[0]).toMatchObject({
      type: 'message.metric.updated',
      messageId: 'assistant-7',
      metric: { id: 'e2e', label: 'E2E', value: 180, unit: 'ms', format: 'duration', aggregation: 'last' },
    });
  });
});
