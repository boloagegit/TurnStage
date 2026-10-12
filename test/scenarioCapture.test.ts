import { describe, expect, it } from 'vitest';
import { buildCapturedScenario, captureEffectOptions, capturedUserSteps, isScenarioReady, markCapturedScenarioReady, MAX_CAPTURED_TURN_CHARACTERS, MAX_SUGGESTED_EVENT_TYPES, snapshotThrough, suggestedCaptureAssertions } from '../src/extension/testing/scenarioCapture';
import type { ChatMessage, SessionSnapshot, TurnStageProfile } from '../src/shared/types';

const profile: TurnStageProfile = {
  version: 1,
  id: 'capture-profile',
  name: 'Capture profile',
  opening: { mode: 'disabled' },
  conversation: { send: { method: 'POST', url: 'https://example.test/chat' } },
  stream: { transport: 'sse', mappings: [
    { id: 'text', match: { event: 'message' }, emit: { type: 'content.text.delta', textPath: '$.text' } },
    { id: 'tool', match: { event: 'tool' }, emit: { type: 'tool.started', toolCallIdPath: '$.id', toolNamePath: '$.name' } },
  ] },
};

describe('captured test scenarios', () => {
  it('captures only ordered user turns and marks the new contract as review-only', () => {
    const scenario = buildCapturedScenario({
      kind: 'contract',
      name: 'Captured flow',
      snapshot: snapshot([
        message('user-1', 'user', 'First prompt'),
        message('assistant-1', 'assistant', 'Private assistant output'),
        message('user-2', 'user', 'Second prompt'),
      ]),
      profile,
      source: { kind: 'run', runId: 'run-1' },
      capturedAt: '2026-09-04T00:00:00.000Z',
    });

    expect(scenario.steps.map((step) => step.input)).toEqual(['First prompt', 'Second prompt']);
    expect(JSON.stringify(scenario)).not.toContain('Private assistant output');
    expect(scenario.capture).toMatchObject({ status: 'needsReview', source: 'run', runId: 'run-1', profileId: profile.id });
    expect(isScenarioReady(scenario)).toBe(false);
    expect(markCapturedScenarioReady(scenario)).toMatchObject({ capture: { status: 'ready' } });
    expect(markCapturedScenarioReady(scenario).tags).not.toContain('needs-review');
  });

  it('records the non-secret controls the conversation ran with so the case reproduces', () => {
    const withControls: TurnStageProfile = { ...profile, controls: [
      { id: 'mode', type: 'select', label: 'Mode', default: 'normal', persist: 'workspace', options: [{ label: 'Normal', value: 'normal' }, { label: 'Partial error', value: 'partial-error' }] },
      { id: 'verbose', type: 'boolean', label: 'Verbose', default: false, persist: 'none' },
      { id: 'token', type: 'text', label: 'Token', persist: 'secret' },
    ] };
    const scenario = buildCapturedScenario({
      kind: 'contract',
      name: 'Partial error',
      snapshot: { ...snapshot([message('user-1', 'user', 'Hello')]), controls: { mode: 'partial-error', verbose: false, token: '[REDACTED]' } },
      profile: withControls,
      source: { kind: 'conversation' },
    });
    expect(scenario.controls).toEqual({ mode: 'partial-error', verbose: false });
    expect(buildCapturedScenario({ kind: 'contract', name: 'Plain', snapshot: snapshot([message('user-1', 'user', 'Hello')]), profile, source: { kind: 'conversation' } }).controls).toBeUndefined();
  });

  it('captures only the turns up to a chosen reply', () => {
    const full = snapshot([message('u1', 'user', 'First'), message('a1', 'assistant', 'One'), message('u2', 'user', 'Second'), message('a2', 'assistant', 'Two')]);
    expect(capturedUserSteps(snapshotThrough(full, 'a1')).map((step) => step.input)).toEqual(['First']);
    expect(capturedUserSteps(snapshotThrough(full)).map((step) => step.input)).toEqual(['First', 'Second']);
    expect(() => snapshotThrough(full, 'gone')).toThrow(/no longer in this conversation/u);
  });

  it('suggests checks on the structure of the reply, not its wording', () => {
    const source = snapshot([message('u1', 'user', 'Find it'), message('a1', 'assistant', 'Here it is')]);
    source.normalizedEvents = ['conversation.started', 'tool.started', 'content.text.delta', 'content.text.delta', 'tool.started', 'stream.completed']
      .map((type, index) => ({ version: 1 as const, type, sequence: index + 1, receivedAt: index + 1, ...(type === 'tool.started' ? { name: index === 1 ? 'search' : 'fetch' } : {}) }));
    const checks = suggestedCaptureAssertions(source);
    expect(checks).toEqual([
      { path: 'turn.state', operator: 'equals', value: 'completed' },
      { path: 'events.normalized[*].type', operator: 'sequenceContains', value: ['conversation.started', 'tool.started', 'content.text.delta', 'stream.completed'] },
      { path: 'events.normalized[*].name', operator: 'contains', value: 'search' },
      { path: 'events.normalized[*].name', operator: 'contains', value: 'fetch' },
      { path: 'assistant.text', operator: 'regex', value: '\\S', message: 'The reply is not empty.' },
      { path: 'metrics.parseErrorCount', operator: 'equals', value: 0 },
      { path: 'metrics.mappingErrorCount', operator: 'equals', value: 0 },
    ]);
    expect(JSON.stringify(checks)).not.toContain('Here it is');
    expect(buildCapturedScenario({ kind: 'contract', name: 'Find it', snapshot: source, profile, source: { kind: 'conversation' } }).assertions).toEqual(checks);
    // A run that already had mapping errors is not turned into a check that demands none.
    expect(suggestedCaptureAssertions({ ...source, metrics: { ...source.metrics, mappingErrorCount: 2 } }).some((check) => check.path === 'metrics.mappingErrorCount')).toBe(false);
    source.normalizedEvents = Array.from({ length: 20 }, (_, index) => ({ version: 1 as const, type: `event.${index}`, sequence: index, receivedAt: index }));
    expect((suggestedCaptureAssertions(source)[1]!.value as string[]).length).toBe(MAX_SUGGESTED_EVENT_TYPES);
  });

  it('leaves later turns out of the events of a case saved from an earlier reply', () => {
    const full = snapshot([{ ...message('u1', 'user', 'First'), createdAt: 1 }, { ...message('a1', 'assistant', 'One'), createdAt: 2, completedAt: 5 }, { ...message('u2', 'user', 'Second'), createdAt: 6 }, { ...message('a2', 'assistant', 'Two'), createdAt: 7, completedAt: 9 }]);
    full.normalizedEvents = [3, 4, 7, 8].map((receivedAt, index) => ({ version: 1 as const, type: index < 2 ? 'first.turn' : 'second.turn', sequence: index, receivedAt }));
    expect(snapshotThrough(full, 'a1').normalizedEvents.map((event) => event.type)).toEqual(['first.turn', 'first.turn']);
    expect(snapshotThrough(full, 'a2').normalizedEvents).toHaveLength(4);
  });

  it('builds a bounded multi-turn adversarial draft and unique id', () => {
    const scenario = buildCapturedScenario({
      kind: 'adversarial',
      name: 'Repeated probe',
      snapshot: snapshot([message('user-1', 'user', 'One'), message('user-2', 'user', 'Two')]),
      profile,
      source: { kind: 'conversation' },
      existingIds: new Set(['repeated-probe']),
      forbid: { urls: true, events: ['tool.started', 'tool.started'] },
      repetitions: 5,
      timeoutMs: 45_000,
    });

    expect(scenario.id).toBe('repeated-probe-2');
    expect(scenario.adversarial).toMatchObject({ mode: 'multiTurn', maxTurns: 2, repetitions: 5, timeoutMs: 45_000, forbid: { urls: true, events: ['tool.started'] } });
  });

  it('fails closed for empty, excessive, or unbounded capture input', () => {
    expect(() => capturedUserSteps(snapshot([]))).toThrow('There are no user messages');
    expect(() => capturedUserSteps(snapshot(Array.from({ length: 11 }, (_, index) => message(`user-${index}`, 'user', String(index)))))).toThrow('more than 10 user turns');
    expect(() => capturedUserSteps(snapshot([message('user-large', 'user', 'x'.repeat(MAX_CAPTURED_TURN_CHARACTERS + 1))]))).toThrow('too large');
    expect(() => buildCapturedScenario({ kind: 'adversarial', name: 'No rule', snapshot: snapshot([message('user-1', 'user', 'Probe')]), profile, source: { kind: 'conversation' }, forbid: {} })).toThrow('prohibited effect');
    expect(() => buildCapturedScenario({ kind: 'adversarial', name: 'Too many', snapshot: snapshot([message('user-1', 'user', 'Probe')]), profile, source: { kind: 'conversation' }, forbid: { urls: true }, repetitions: 51 })).toThrow('Repetitions');
  });

  it('offers only effects observable by the profile and captured evidence', () => {
    const source = snapshot([message('user-1', 'user', 'Probe')]);
    source.normalizedEvents = [{ version: 1, type: 'tool.started', sequence: 1, receivedAt: 1 }];
    const options = captureEffectOptions(profile, source);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'urls' }),
      expect.objectContaining({ kind: 'tools', observed: true }),
      expect.objectContaining({ kind: 'event', event: 'tool.started', observed: true }),
    ]));
  });
});

function message(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, role, status: 'completed', createdAt: 1, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] };
}

function snapshot(messages: ChatMessage[]): SessionSnapshot {
  return { sessionId: 'session-1', sessionState: 'ready', turnState: 'completed', messages, rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [], droppedEventCount: 0, trusted: true, controls: {} };
}
