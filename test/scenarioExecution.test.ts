import { describe, expect, it } from 'vitest';
import type { InteractionContext, NetworkExchange, ScenarioDefinition, SessionSnapshot } from '../src/shared/types';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { aggregateAttempts, createAdversarialRunPlan, createScenarioRunPlan, MAX_COPILOT_RUN_ATTEMPTS, MAX_COPILOT_RUN_REQUESTS, runScenarioGroup, type ScenarioSession } from '../src/extension/testing/scenarioExecution';

class RepetitionSession implements ScenarioSession {
  readonly snapshot: SessionSnapshot = createSnapshot(true);
  readonly network: NetworkExchange[] = [];
  starts = 0;
  sends = 0;
  constructor(private readonly reply: string, private readonly onSend?: () => void) {}

  setEphemeralControls(values: Record<string, unknown>): void { this.snapshot.controls = { ...this.snapshot.controls, ...values }; }
  async startSession(): Promise<void> { this.starts += 1; this.snapshot.sessionState = 'ready'; }
  async send(text: string, interaction: InteractionContext): Promise<void> {
    void interaction;
    this.sends += 1;
    const sequence = this.sends;
    this.snapshot.conversationId = `conversation-${sequence}`;
    this.snapshot.messages.push(
      { id: `user-${sequence}`, role: 'user', status: 'completed', createdAt: sequence, completedAt: sequence, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] },
      { id: `assistant-${sequence}`, role: 'assistant', status: 'completed', createdAt: sequence, completedAt: sequence, parts: [{ type: 'text', text: this.reply }], citations: [], actions: [], followups: [] },
    );
    this.snapshot.rawEvents.push({ sequence, receivedAt: sequence, elapsedMs: 1, protocol: 'fixture', raw: '{}', data: {} });
    this.snapshot.normalizedEvents.push({ version: 1, type: 'content.text.delta', sequence, receivedAt: sequence, rawSequence: sequence, text: this.reply });
    this.snapshot.turnState = 'completed';
    this.network.push({ id: `network-${sequence}`, kind: 'stream', attempt: 1, method: 'POST', url: 'https://example.test', state: 'completed', startedAt: sequence, completedAt: sequence + 1, status: 200, requestHeaders: {}, timing: {}, transferredBytes: 1, eventCount: 1 });
    this.onSend?.();
  }
  async abort(): Promise<void> { this.snapshot.turnState = 'aborted'; }
  getNetworkEntries(): NetworkExchange[] { return structuredClone(this.network); }
}

function adversarial(id: string, repetitions?: number, overrides: Partial<NonNullable<ScenarioDefinition['adversarial']>> = {}): ScenarioDefinition {
  return {
    id,
    name: id,
    steps: [{ id: 'attack', input: 'probe' }],
    adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 5_000, forbid: { content: ['protected-marker'] }, ...(repetitions === undefined ? {} : { repetitions }), ...overrides },
  };
}

describe('shared scenario execution and repetition planning', () => {
  it('keeps one Copilot action bounded while allowing 100 cases at five attempts', () => {
    expect(MAX_COPILOT_RUN_ATTEMPTS).toBe(500);
    expect(MAX_COPILOT_RUN_REQUESTS).toBe(5_000);
    const plan = createScenarioRunPlan(Array.from({ length: 100 }, (_, index) => ({
      ...adversarial(`case-${index + 1}`, 5),
      steps: Array.from({ length: 10 }, (__, turn) => ({ id: `turn-${turn + 1}`, input: 'probe' })),
    })));
    expect(plan).toMatchObject({ valid: true, plannedAttempts: 500, maximumRequests: 5_000 });
  });

  it('plans a 100-case suite with mixed per-case repetition overrides without expanding transcripts', () => {
    const scenarios = Array.from({ length: 100 }, (_, index) => adversarial(`case-${index + 1}`, index === 41 ? 10 : undefined));
    const plan = createScenarioRunPlan(scenarios, { defaultRepetitions: 3, maxConcurrency: 4 });

    expect(plan.valid).toBe(true);
    expect(plan.selectedCases).toBe(100);
    expect(plan.plannedAttempts).toBe(307);
    expect(plan.plannedTurns).toBe(307);
    expect(plan.maximumRequests).toBe(307);
    expect(plan.cases[41]).toMatchObject({ scenarioId: 'case-42', repetitions: 10 });
    expect(plan.cases[0]).toMatchObject({ repetitions: 3 });
  });

  it('accepts an authored suite directly and applies its default and per-case policy', () => {
    const suite = {
      format: 'turnstage-adversarial-suite' as const,
      version: 1 as const,
      id: 'suite',
      name: 'Suite',
      runPolicy: { defaultRepetitions: 3, maxRequests: 10 },
      cases: [
        { id: 'normal', name: 'Normal', turns: [{ id: 'turn', input: 'probe' }], forbid: { urls: true } },
        { id: 'high-risk', name: 'High risk', repetitions: 5, turns: [{ id: 'turn', input: 'probe' }], forbid: { urls: true } },
      ],
    };
    const plan = createAdversarialRunPlan(suite);
    expect(plan).toMatchObject({ valid: true, selectedCases: 2, plannedAttempts: 8, plannedTurns: 8, maximumRequests: 8 });
    expect(plan.cases.map((item) => item.repetitions)).toEqual([3, 5]);
  });

  it('fails closed on repetition, attempt, request, and duration caps', () => {
    expect(createScenarioRunPlan([adversarial('too-many', 51)])).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-repetitions' })]) });
    const scenarios = Array.from({ length: 500 }, (_, index) => adversarial(`case-${index + 1}`, 50));
    const plan = createScenarioRunPlan(scenarios);
    expect(plan.valid).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['attempt-cap']));
    expect(createScenarioRunPlan([adversarial('budget')], { defaultRepetitions: 2, maxRequests: 1, maxDurationMs: 1 })).toMatchObject({ valid: false, withinBudget: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'request-cap' }), expect.objectContaining({ code: 'duration-cap' })]) });
  });

  it('starts every repetition with a new session and keeps the ordered turns inside each attempt', async () => {
    const sessions: RepetitionSession[] = [];
    const scenario: ScenarioDefinition = { ...adversarial('multi', 3), steps: [{ id: 'first', input: 'one' }, { id: 'second', input: 'two' }], adversarial: { ...adversarial('multi', 3).adversarial!, mode: 'multiTurn', maxTurns: 2 } };
    const group = await runScenarioGroup('profile', scenario, async () => {
      const session = new RepetitionSession('safe'); sessions.push(session); return session;
    });

    expect(sessions).toHaveLength(3);
    expect(sessions.every((session) => session.starts === 1 && session.sends === 2)).toBe(true);
    expect(group).toMatchObject({ requestedAttempts: 3, completedAttempts: 3, skippedAttempts: 0, sampleComplete: true, outcome: 'resisted', stability: 'stable-pass', counts: { resisted: 3 } });
    expect(group.result.passed).toBe(true);
    expect(group.result.repetitions?.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
  });

  it('marks fail-fast attack samples incomplete instead of reporting a pass rate', async () => {
    let created = 0;
    const group = await runScenarioGroup('profile', adversarial('fail-fast', 5, { failFast: true }), async () => {
      created += 1; return new RepetitionSession('protected-marker');
    });

    expect(created).toBe(1);
    expect(group).toMatchObject({ requestedAttempts: 5, completedAttempts: 1, skippedAttempts: 4, sampleComplete: false, outcome: 'attackSucceeded', stability: 'inconclusive', counts: { attackSucceeded: 1 } });
    expect(group.result.passed).toBe(false);
    expect(group.result.repetitions?.attempts).toHaveLength(1);
  });

  it('stops at the active attempt boundary on cancellation and can resume from the next attempt', async () => {
    let requested = false;
    let listener: (() => void) | undefined;
    const cancellation = {
      get isCancellationRequested(): boolean { return requested; },
      onCancellationRequested(callback: () => void): { dispose(): void } { listener = callback; return { dispose: () => { listener = undefined; } }; },
    };
    let created = 0;
    const first = await runScenarioGroup('profile', adversarial('cancel', 3), async () => {
      created += 1; return new RepetitionSession('safe', () => { requested = true; listener?.(); });
    }, { cancellation });

    expect(created).toBe(1);
    expect(first).toMatchObject({ completedAttempts: 1, skippedAttempts: 2, sampleComplete: false, outcome: 'indeterminate', stability: 'inconclusive' });
    const resumed = await runScenarioGroup('profile', adversarial('cancel', 3), async () => new RepetitionSession('safe'), { existing: first.record });
    expect(resumed).toMatchObject({ completedAttempts: 3, skippedAttempts: 0, sampleComplete: true, outcome: 'indeterminate', stability: 'inconclusive' });
    expect(resumed.attempts.map((attempt) => attempt.summary.attempt)).toEqual([1, 2, 3]);
  });

  it('preserves legacy single-attempt semantics and strict aggregate precedence', () => {
    const legacy = createScenarioRunPlan([adversarial('legacy')]);
    expect(legacy).toMatchObject({ valid: true, plannedAttempts: 1, plannedTurns: 1 });
    expect(aggregateAttempts([
      { attempt: 1, outcome: 'resisted', durationMs: 1, attemptedTurns: 1, completedTurns: 1, startedAt: 1, completedAt: 2 },
      { attempt: 2, outcome: 'indeterminate', durationMs: 1, attemptedTurns: 1, completedTurns: 0, startedAt: 3, completedAt: 4 },
      { attempt: 3, outcome: 'attackSucceeded', durationMs: 1, attemptedTurns: 1, completedTurns: 1, startedAt: 5, completedAt: 6 },
    ], 3, true)).toMatchObject({ outcome: 'attackSucceeded', sampleComplete: true, counts: { resisted: 1, indeterminate: 1, attackSucceeded: 1 } });
  });
});
