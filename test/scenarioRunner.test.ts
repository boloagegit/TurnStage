import { describe, expect, it } from 'vitest';
import type { InteractionContext, NetworkExchange, ScenarioDefinition, SessionSnapshot } from '../src/shared/types';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { runScenario, type ScenarioSession } from '../src/extension/testing/scenarioRunner';

class FakeScenarioSession implements ScenarioSession {
  readonly snapshot: SessionSnapshot = createSnapshot(true);
  readonly requestPreview = { method: 'POST', url: 'https://example.test/chat', variantId: 'default' };
  readonly controlsApplied: Record<string, unknown>[] = [];
  readonly sent: Array<{ text: string; interaction: InteractionContext }> = [];
  readonly calls: string[] = [];
  private readonly networkEntries: NetworkExchange[] = [];
  afterSend?: () => void;
  starts = 0;
  aborts = 0;

  setEphemeralControls(values: Record<string, unknown>): void {
    this.calls.push('controls');
    this.controlsApplied.push(structuredClone(values));
    this.snapshot.controls = { ...this.snapshot.controls, ...values };
  }

  async startSession(): Promise<void> {
    this.calls.push('start');
    this.starts += 1;
    this.snapshot.sessionState = 'ready';
  }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    this.calls.push(`send:${text}`);
    this.sent.push({ text, interaction });
    const sequence = this.snapshot.rawEvents.length + 1;
    const now = sequence * 100;
    this.snapshot.conversationId = this.snapshot.conversationId ?? 'conversation-1';
    this.snapshot.messages.push(
      { id: `user-${sequence}`, role: 'user', status: 'completed', createdAt: now, completedAt: now, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] },
      { id: `assistant-${sequence}`, role: 'assistant', status: 'completed', createdAt: now, completedAt: now + 10, parts: [{ type: 'text', text: `reply: ${text}` }], citations: [], actions: [], followups: [] },
    );
    this.snapshot.rawEvents.push({ sequence, receivedAt: now, elapsedMs: 10, protocol: 'fixture', raw: JSON.stringify({ text }), data: { text } });
    this.snapshot.normalizedEvents.push({ version: 1, type: 'content.text.delta', sequence, receivedAt: now, rawSequence: sequence, text: `reply: ${text}` });
    this.snapshot.turnState = 'completed';
    this.snapshot.metrics = { ...this.snapshot.metrics, totalDuration: 100, eventCount: sequence, byteCount: sequence * 10 };
    this.networkEntries.push({
      id: `network-${sequence}`, kind: 'stream', attempt: 1, method: 'POST', url: 'https://example.test/chat', state: 'completed', startedAt: now, completedAt: now + 100, status: 200,
      requestHeaders: {}, responseHeaders: { 'content-type': 'text/event-stream' }, timing: { total: 100 }, transferredBytes: 10, eventCount: 1,
    });
    this.afterSend?.();
  }

  async abort(): Promise<void> {
    this.calls.push('abort');
    this.aborts += 1;
    this.snapshot.turnState = 'aborted';
  }

  getNetworkEntries(): NetworkExchange[] {
    return structuredClone(this.networkEntries);
  }
}

describe('runScenario', () => {
  it('runs multiple turns with ephemeral controls and evaluates step and final assertions', async () => {
    const session = new FakeScenarioSession();
    const scenario: ScenarioDefinition = {
      id: 'two-turn',
      name: 'Two turn contract',
      controls: { actor: 'actor-a', mode: 'normal' },
      steps: [
        {
          id: 'first',
          name: 'First turn',
          input: 'hello',
          assertions: [
            { id: 'first-state', path: 'turn.state', operator: 'equals', value: 'completed' },
            { id: 'first-reply', path: 'assistant.text', operator: 'contains', value: 'hello' },
          ],
        },
        {
          id: 'second',
          name: 'Second turn',
          input: 'follow-up',
          assertions: [
            { id: 'second-status', path: 'network[*].status', operator: 'contains', value: 200 },
            { id: 'second-reply', path: 'assistant.text', operator: 'equals', value: 'reply: follow-up' },
          ],
        },
      ],
      assertions: [
        { id: 'duration', path: 'metrics.totalDuration', operator: 'lessThan', value: 1_000 },
        { id: 'event-sequence', path: 'events.normalized[*].type', operator: 'sequenceEquals', value: ['content.text.delta', 'content.text.delta'] },
      ],
    };

    const result = await runScenario('profile-1', scenario, session);

    expect(result.passed).toBe(true);
    expect(session.calls.slice(0, 2)).toEqual(['controls', 'start']);
    expect(session.starts).toBe(1);
    expect(session.sent.map((item) => item.text)).toEqual(['hello', 'follow-up']);
    expect(session.sent.every((item) => item.interaction.kind === 'manual')).toBe(true);
    expect(session.controlsApplied).toEqual([{ actor: 'actor-a', mode: 'normal' }]);
    expect(session.snapshot.controls).toEqual({ actor: 'actor-a', mode: 'normal' });
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((step) => step.checks.every((check) => check.passed))).toBe(true);
    expect(result.steps.flatMap((step) => step.checks).map((check) => check.id)).toEqual(expect.arrayContaining(['first-state', 'first-reply', 'second-status', 'second-reply']));
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'duration', passed: true }),
      expect.objectContaining({ id: 'event-sequence', passed: true }),
    ]));
    expect(result.evidence.profileId).toBe('profile-1');
    expect(result.evidence.scenarioId).toBe('two-turn');
    expect(result.evidence.snapshot).not.toBe(session.snapshot);
    expect(result.evidence.snapshot.messages).toHaveLength(4);
    expect(result.evidence.networkEntries).toHaveLength(2);
    expect(result.evidence.requestPreview).toEqual(session.requestPreview);
  });

  it('aborts the active session when cancellation is requested between steps', async () => {
    const session = new FakeScenarioSession();
    const scenario: ScenarioDefinition = {
      id: 'cancelled',
      name: 'Cancelled scenario',
      steps: [{ id: 'first', input: 'hello' }, { id: 'second', input: 'never sent' }],
    };
    let requested = false;
    let notifyCancellation: (() => void) | undefined;
    const cancellation = {
      get isCancellationRequested(): boolean { return requested; },
      onCancellationRequested(listener: () => void): { dispose(): void } {
        notifyCancellation = listener;
        return { dispose: () => { notifyCancellation = undefined; } };
      },
    };
    session.afterSend = () => {
      if (session.sent.length === 1) {
        requested = true;
        notifyCancellation?.();
      }
    };

    const result = await runScenario('profile-1', scenario, session, cancellation);

    expect(session.starts).toBe(1);
    expect(session.sent).toHaveLength(1);
    expect(session.aborts).toBe(1);
    expect(session.calls.at(-1)).toBe('abort');
    expect(result.steps).toHaveLength(1);
    expect(result.passed).toBe(false);
    expect(result.evidence.snapshot.turnState).toBe('aborted');
  });
});
