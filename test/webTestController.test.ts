import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { WebTestController } from '../web/src/webTestController';

afterEach(() => vi.unstubAllGlobals());

describe('WebTestController', () => {
  it('runs configured adversarial repetitions in isolated browser sessions', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `red-team-${crypto.randomUUID()}`, name: 'Red Team Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
    };
    const scenario = { id: 'resistance', name: 'Resistance', steps: [{ id: 'turn', input: 'attack' }], adversarial: { mode: 'singleTurn' as const, maxTurns: 1, timeoutMs: 5_000, repetitions: 2, forbid: { content: ['forbidden'] } } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => new Response('event: message\ndata: {"text":"safe"}\n\nevent: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), () => undefined);

    const execution = await controller.executeScenario({ key: `${profile.id}/inline/${scenario.id}`, itemId: `inline:${scenario.id}`, scenario });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(execution.result.adversarial?.outcome).toBe('resisted');
    expect(execution.result.repetitions).toMatchObject({ requestedAttempts: 2, completedAttempts: 2, sampleComplete: true, stability: 'stable-pass' });
  });
});
