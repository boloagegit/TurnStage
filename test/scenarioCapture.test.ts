import { describe, expect, it } from 'vitest';
import { buildCapturedScenario, captureEffectOptions, capturedUserSteps, isScenarioReady, markCapturedScenarioReady, MAX_CAPTURED_TURN_CHARACTERS } from '../src/extension/testing/scenarioCapture';
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
