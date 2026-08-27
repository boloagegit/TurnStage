import { describe, expect, it, vi } from 'vitest';
import { RemoteSessionRepository } from '../src/extension/history/remoteSessionRepository';

describe('RemoteSessionRepository', () => {
  it('filters malformed global-state entries while retaining valid references', () => {
    const state = new Map<string, unknown>();
    const valid = { conversationId: 'valid', title: 'Valid', createdAt: 1, actorId: 'actor', environmentId: 'environment' };
    state.set('scope', [
      { conversationId: 42, title: 'Wrong id', createdAt: 1 },
      valid,
      { conversationId: 'bad-date', title: 'Bad date', createdAt: 'not-a-date' },
      { conversationId: 'bad-actor', title: 'Bad actor', createdAt: 2, actorId: { secret: true } },
      { conversationId: 'bad-title', title: 7, createdAt: 3 },
    ]);
    const repository = new RemoteSessionRepository({ globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: vi.fn() } } as never);

    expect(repository.list('scope')).toEqual([valid]);
    state.set('not-an-array', { conversationId: 'wrong-top-level', title: 'Wrong', createdAt: 1 });
    expect(repository.list('not-an-array')).toEqual([]);
  });

  it('upserts reference-only sessions by conversation id and bounds retention', async () => {
    const state = new Map<string, unknown>();
    const update = vi.fn(async (key: string, value: unknown) => { state.set(key, value); });
    const repository = new RemoteSessionRepository({ globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update } } as never);

    await repository.save('scope', { conversationId: 'one', title: 'First', createdAt: 1 });
    await repository.save('scope', { conversationId: 'one', title: 'Updated', createdAt: 2 });
    expect(repository.list('scope')).toEqual([{ conversationId: 'one', title: 'Updated', createdAt: 2 }]);
    for (let index = 0; index < 55; index++) await repository.save('scope', { conversationId: `conversation-${index}`, title: String(index), createdAt: index + 3 });

    const references = repository.list('scope');
    expect(references).toHaveLength(50);
    expect(references[0]?.conversationId).toBe('conversation-54');
    expect(references.filter((item) => item.conversationId === 'one')).toHaveLength(0);
    expect(update).toHaveBeenCalled();
  });

  it('serializes concurrent saves so every reference id is retained within retention', async () => {
    const state = new Map<string, unknown>();
    const update = vi.fn(async (key: string, value: unknown) => { state.set(key, value); });
    const repository = new RemoteSessionRepository({ globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update } } as never);

    await Promise.all(Array.from({ length: 12 }, (_, index) => repository.save('concurrent', { conversationId: `conversation-${index}`, title: String(index), createdAt: index })));

    const references = repository.list('concurrent');
    expect(references).toHaveLength(12);
    expect(new Set(references.map((item) => item.conversationId))).toEqual(new Set(Array.from({ length: 12 }, (_, index) => `conversation-${index}`)));
  });
});
