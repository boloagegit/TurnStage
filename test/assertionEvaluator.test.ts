import { describe, expect, it } from 'vitest';
import type { NetworkExchange, ScenarioAssertionDefinition } from '../src/shared/types';
import { evaluateAssertions, evaluateSessionInvariants, isSafeAssertionRegex, isValidAssertionPath, resolveAssertionPath, type AssertionEvidence } from '../src/extension/testing/assertionEvaluator';
import { createSnapshot } from '../src/extension/runtime/reducer';

function evidence(): AssertionEvidence {
  const snapshot = createSnapshot(true);
  snapshot.sessionId = 'session-1';
  snapshot.sessionState = 'ready';
  snapshot.turnState = 'completed';
  snapshot.conversationId = 'conversation-1';
  snapshot.title = 'Sample conversation';
  snapshot.messages = [{
    id: 'assistant-1',
    role: 'assistant',
    status: 'completed',
    createdAt: 1,
    completedAt: 120,
    parts: [{ type: 'text', text: 'sample result' }],
    citations: [],
    actions: [],
    followups: [],
  }];
  snapshot.rawEvents = [
    { sequence: 1, receivedAt: 10, elapsedMs: 10, protocol: 'sse', sse: { event: 'start' }, raw: '{}', data: {} },
    { sequence: 2, receivedAt: 20, elapsedMs: 20, protocol: 'sse', sse: { event: 'message' }, raw: '{"text":"sample"}', data: { text: 'sample' } },
    { sequence: 3, receivedAt: 30, elapsedMs: 30, protocol: 'sse', sse: { event: 'done' }, raw: '{}', data: {} },
  ];
  snapshot.normalizedEvents = [
    { version: 1, type: 'conversation.started', sequence: 1, receivedAt: 10, rawSequence: 1 },
    { version: 1, type: 'content.text.delta', sequence: 2, receivedAt: 20, rawSequence: 2, text: 'sample' },
    { version: 1, type: 'stream.completed', sequence: 3, receivedAt: 30, rawSequence: 3 },
  ];
  snapshot.metrics = {
    headersLatency: 5,
    firstChunkLatency: 8,
    ttft: 10,
    totalDuration: 120,
    eventCount: 3,
    byteCount: 30,
    parseErrorCount: 0,
    mappingErrorCount: 0,
    unmatchedEventCount: 0,
    reconnectCount: 0,
  };
  const networkEntries: NetworkExchange[] = [
    {
      id: 'network-1', kind: 'opening', attempt: 1, method: 'POST', url: 'https://example.test/opening', state: 'completed', startedAt: 1, completedAt: 5, status: 200,
      requestHeaders: {}, responseHeaders: { 'content-type': 'application/json' }, timing: { total: 4 }, transferredBytes: 10, eventCount: 0,
    },
    {
      id: 'network-2', kind: 'stream', attempt: 1, method: 'POST', url: 'https://example.test/stream', state: 'completed', startedAt: 6, completedAt: 120, status: 200,
      requestHeaders: {}, responseHeaders: { 'content-type': 'text/event-stream' }, timing: { total: 114 }, transferredBytes: 30, eventCount: 3,
    },
  ];
  return { snapshot, networkEntries };
}

describe('assertion path resolution', () => {
  it('resolves nested paths and wildcard sequences', () => {
    const root = { events: { normalized: [{ type: 'first' }, { type: 'second' }] } };

    expect(resolveAssertionPath(root, 'events.normalized[0].type')).toBe('first');
    expect(resolveAssertionPath(root, '$.events.normalized[*].type')).toEqual(['first', 'second']);
    expect(resolveAssertionPath(root, 'events.normalized[9].type')).toBeUndefined();
  });
});

describe('declarative assertion operators', () => {
  it('evaluates equality, existence, containment, regex, membership, numeric, and sequence operators', () => {
    const assertions: ScenarioAssertionDefinition[] = [
      { id: 'equals', path: 'turn.state', operator: 'equals', value: 'completed' },
      { id: 'not-equals', path: 'turn.state', operator: 'notEquals', value: 'failed' },
      { id: 'exists', path: 'conversation.id', operator: 'exists' },
      { id: 'not-exists', path: 'conversation.missing', operator: 'notExists' },
      { id: 'contains-string', path: 'assistant.text', operator: 'contains', value: 'sample' },
      { id: 'contains-sequence', path: 'events.normalized[*].type', operator: 'contains', value: 'content.text.delta' },
      { id: 'regex', path: 'assistant.text', operator: 'regex', value: '^sample result$' },
      { id: 'one-of', path: 'session.state', operator: 'oneOf', value: ['ready', 'failed'] },
      { id: 'less-than', path: 'metrics.totalDuration', operator: 'lessThan', value: 500 },
      { id: 'less-than-or-equal', path: 'metrics.totalDuration', operator: 'lessThanOrEqual', value: 120 },
      { id: 'greater-than', path: 'metrics.totalDuration', operator: 'greaterThan', value: 100 },
      { id: 'greater-than-or-equal', path: 'metrics.totalDuration', operator: 'greaterThanOrEqual', value: 120 },
      { id: 'sequence-equals', path: 'events.normalized[*].type', operator: 'sequenceEquals', value: ['conversation.started', 'content.text.delta', 'stream.completed'] },
      { id: 'sequence-contains', path: 'events.normalized[*].type', operator: 'sequenceContains', value: ['conversation.started', 'stream.completed'] },
    ];

    const checks = evaluateAssertions(assertions, evidence());

    expect(checks).toHaveLength(assertions.length);
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});

describe('assertion safety and evidence locations', () => {
  it('bounds regexes and accepts only known evidence roots', () => {
    expect(isSafeAssertionRegex('^sample+$')).toBe(true);
    expect(isSafeAssertionRegex('[')).toBe(false);
    expect(isSafeAssertionRegex('(a+)+$')).toBe(false);
    expect(isSafeAssertionRegex('a'.repeat(257))).toBe(false);
    expect(isValidAssertionPath('events.normalized[*].type')).toBe(true);
    expect(isValidAssertionPath('$.metrics.totalDuration')).toBe(true);
    expect(isValidAssertionPath('filesystem.password')).toBe(false);
    expect(isValidAssertionPath('events.normalized[foo].type')).toBe(false);
  });

  it('attaches network, raw, normalized, message, and profile locations', () => {
    const checks = evaluateAssertions([
      { id: 'network', path: 'network[*].status', operator: 'contains', value: 200 },
      { id: 'raw', path: 'events.raw[*].sequence', operator: 'sequenceContains', value: [2, 3] },
      { id: 'normalized', path: 'events.normalized[*].type', operator: 'sequenceContains', value: ['content.text.delta'] },
      { id: 'message', path: 'assistant.text', operator: 'contains', value: 'sample' },
      { id: 'profile', path: 'metrics.totalDuration', operator: 'greaterThan', value: 0 },
    ], evidence());
    const byId = new Map(checks.map((check) => [check.id, check]));

    expect(byId.get('network')?.location).toEqual({ kind: 'network', networkId: 'network-2' });
    expect(byId.get('raw')?.location).toEqual({ kind: 'rawEvent', sequence: 3 });
    expect(byId.get('normalized')?.location).toEqual({ kind: 'normalizedEvent', sequence: 3, rawSequence: 3 });
    expect(byId.get('message')?.location).toEqual({ kind: 'message', messageId: 'assistant-1' });
    expect(byId.get('profile')?.location).toEqual({ kind: 'profile', path: 'metrics.totalDuration' });
  });

  it('returns a failed check rather than throwing for an unsafe regex', () => {
    const [check] = evaluateAssertions([{ id: 'unsafe', path: 'assistant.text', operator: 'regex', value: '(a+)+$' }], evidence());

    expect(check).toMatchObject({ id: 'unsafe', passed: false });
  });
});

describe('session invariants', () => {
  it('passes for a terminal session with bounded metrics and no active parts', () => {
    const checks = evaluateSessionInvariants(evidence());

    expect(checks).toHaveLength(7);
    expect(checks.every((check) => check.kind === 'invariant' && check.passed)).toBe(true);
  });

  it('reports pending messages, active parts, invalid metrics, and dropped event coverage', () => {
    const broken = evidence();
    broken.snapshot.messages[0]!.status = 'pending';
    broken.snapshot.messages[0]!.completedAt = undefined;
    broken.snapshot.messages[0]!.parts.push({ type: 'progress', status: 'running' });
    broken.snapshot.metrics.totalDuration = -1;
    broken.snapshot.metrics.eventCount = 1;

    const checks = evaluateSessionInvariants(broken);
    const failedIds = checks.filter((check) => !check.passed).map((check) => check.id);

    expect(failedIds).toEqual(expect.arrayContaining([
      'invariant.messages-terminal',
      'invariant.assistant-state',
      'invariant.parts-terminal',
      'invariant.metrics-bounded',
      'invariant.event-count',
    ]));
  });

  it('detects a non-terminal turn as an invariant failure', () => {
    const broken = evidence();
    broken.snapshot.turnState = 'streaming';

    const checks = evaluateSessionInvariants(broken);

    expect(checks.find((check) => check.id === 'invariant.turn-terminal')).toMatchObject({ passed: false, actual: 'streaming' });
  });
});
