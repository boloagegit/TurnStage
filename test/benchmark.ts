/**
 * Run with: npx vitest bench --config test/benchmark.vitest.config.ts --run
 *
 * Vitest reports the measurements at runtime; this file intentionally contains
 * no precomputed or representative numbers.
 */
import { bench, describe } from 'vitest';
import type { RawStreamEvent, StreamDefinition } from '../src/shared/types';
import { MappingEngine } from '../src/extension/mapping/mappingEngine';
import { NdjsonParser, SseParser } from '../src/extension/transport/streamParser';
import { EventBuffer } from '../src/extension/runtime/eventBuffer';
import { createSnapshot, reduceEvent } from '../src/extension/runtime/reducer';

const sseChunks = [
  'event: message\ndata: {"text":"first"}\n\n',
  'event: message\ndata: {"text":"second"}\n\n',
  'event: done\ndata: [DONE]\n\n',
];
const ndjsonChunks = [
  '{"kind":"delta","text":"first"}\n{"kind":"delta",',
  '"text":"second"}\r\n{"kind":"done"}\r\n',
];
const mappingStream: StreamDefinition = {
  transport: 'sse',
  mappingMode: 'allMatches',
  mappings: [
    { id: 'delta', match: { path: '$.kind', operator: 'equals', value: 'delta' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
    { id: 'has-text', match: { path: '$.text', operator: 'exists' }, emit: { type: 'diagnostic.updated', diagnostic: { path: '$' } } },
  ],
};
const mappingEngine = new MappingEngine(mappingStream);
const mappingEvent: RawStreamEvent = {
  sequence: 1,
  receivedAt: Date.now(),
  elapsedMs: 0,
  protocol: 'sse',
  sse: { event: 'message' },
  raw: '{"kind":"delta","text":"benchmark"}',
  data: { kind: 'delta', text: 'benchmark' },
};

describe('TurnStage stream benchmarks', () => {
  bench('parse representative SSE chunks', () => {
    const parser = new SseParser();
    for (const chunk of sseChunks) parser.feed(chunk);
    parser.finish();
  });

  bench('parse representative NDJSON chunks', () => {
    const parser = new NdjsonParser();
    for (const chunk of ndjsonChunks) parser.feed(chunk);
    parser.finish();
  });

  bench('map one event through all matching rules', () => {
    mappingEngine.map(mappingEvent);
  });

  bench('map 20,000 text delta events', () => {
    for (let index = 0; index < 20_000; index++) mappingEngine.map({ ...mappingEvent, sequence: index + 1 });
  });

  bench('retain 5,000 bounded raw events', () => {
    const buffer = new EventBuffer<RawStreamEvent>(5_000, 10 * 1024 * 1024);
    for (let index = 0; index < 5_000; index++) buffer.push({ ...mappingEvent, sequence: index + 1 });
  });

  bench('reduce correlated tools, citations, and follow-ups', () => {
    const snapshot = createSnapshot(true);
    for (let index = 0; index < 100; index++) {
      const base = { version: 1 as const, sequence: index * 3 + 1, receivedAt: index };
      reduceEvent(snapshot, { ...base, type: 'tool.started', toolCallId: `tool-${index}`, name: 'sample_search' });
      reduceEvent(snapshot, { ...base, sequence: base.sequence + 1, type: 'citation.upsert', citation: { id: `citation-${index}`, title: 'Example source' } });
      reduceEvent(snapshot, { ...base, sequence: base.sequence + 2, type: 'followup.upsert', followup: { id: `followup-${index}`, label: 'Show another example', prompt: 'Show another example', behavior: 'send' } });
    }
  });

  bench('reduce 5,000 correlated text deltas', () => {
    const snapshot = createSnapshot(true);
    for (let index = 0; index < 5_000; index += 1) reduceEvent(snapshot, {
      version: 1,
      type: 'content.text.delta',
      sequence: index + 1,
      rawSequence: index + 1,
      receivedAt: index,
      mappingRuleId: 'delta',
      text: 'x',
    });
  });
});
