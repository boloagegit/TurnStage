import { describe, expect, it, vi } from 'vitest';
import { RemoteSessionRepository } from '../src/extension/history/remoteSessionRepository';

describe('RemoteSessionRepository', () => {
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
});
