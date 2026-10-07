import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConversationDirectory, SessionSnapshot, TurnStageProfile } from '../src/shared/types';
import {
  ConversationManager,
  compareWithPersisted,
  conversationArchiveLimit,
  diffText,
  localConversationKey,
  mergeConversationSummaries,
  parseRemoteConversationList,
  parseRemoteHistory,
  parseTimestamp,
  persistedContentText,
  sanitizeStoredConversations,
  storedConversationFromSnapshot,
  type StoredConversation,
} from '../src/shared/conversationHistory';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { isWebviewMessage, isHostMessage, PROTOCOL_VERSION } from '../src/shared/protocol';

const baseProfile: TurnStageProfile = {
  version: 1,
  id: 'history',
  name: 'History',
  conversation: { send: { method: 'POST', url: 'https://example.test/chat' } },
  stream: { transport: 'sse', mappings: [] },
};

function chat(id: string, role: ChatMessage['role'], text: string, createdAt = 1_000, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, status: 'completed', createdAt, completedAt: createdAt, parts: [{ type: role === 'assistant' ? 'markdown' : 'text', text }], citations: [], actions: [], followups: [], ...extra };
}

function snapshotWith(messages: ChatMessage[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...createSnapshot(true, () => 'session-1'), sessionState: 'ready', messages, ...extra };
}

describe('server conversation list and history parsing', () => {
  it('reads common list shapes, ids, titles, and timestamps without configuration', () => {
    expect(parseRemoteConversationList({ data: [
      { id: 'c1', title: 'Refund follow-up', updated_at: '2026-09-22T05:58:00Z' },
      { conversation_id: 42, name: 'Numeric id', updatedAt: 1_758_520_680 },
      { id: 'c1', title: 'duplicate is ignored' },
      { title: 'no id is ignored' },
    ] })).toEqual([
      { conversationId: 'c1', title: 'Refund follow-up', updatedAt: Date.parse('2026-09-22T05:58:00Z') },
      { conversationId: '42', title: 'Numeric id', updatedAt: 1_758_520_680_000 },
    ]);
  });

  it('honours configured paths for nested list responses', () => {
    expect(parseRemoteConversationList({ result: { rows: [{ key: { value: 'k1' }, meta: { label: 'Labelled' }, at: 5_000_000_000_000 }] } }, { itemsPath: '$.result.rows', idPath: 'key.value', titlePath: 'meta.label', updatedAtPath: 'at' }))
      .toEqual([{ conversationId: 'k1', title: 'Labelled', updatedAt: 5_000_000_000_000 }]);
    expect(parseRemoteConversationList({ unexpected: true }, { itemsPath: '$.missing' })).toEqual([]);
  });

  it('maps persisted roles and content parts into read-only history messages', () => {
    const messages = parseRemoteHistory({ messages: [
      { id: 'm1', role: 'human', content: 'Where is my refund?', created_at: 1_758_520_000 },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Refunds take ' }, { type: 'text', text: '3–5 days.' }] },
      { id: 'm3', role: 'tool', content: 'ignored tool output' },
      { id: 'm4', role: 'user' },
    ] }, {}, 'conv/1');
    expect(messages.map((item) => [item.id, item.role, item.parts[0]?.text, item.metadata?.historySource])).toEqual([
      ['history-conv%2F1-m1', 'user', 'Where is my refund?', 'server'],
      ['history-conv%2F1-m2', 'assistant', 'Refunds take 3–5 days.', 'server'],
    ]);
    expect(messages[0]?.createdAt).toBe(1_758_520_000_000);
    expect(persistedContentText({ value: 'object value' })).toBe('object value');
    expect(parseTimestamp('not a date')).toBeUndefined();
  });
});

describe('history consistency', () => {
  it('reports matches, text differences, and messages missing from the server copy', () => {
    const session = [
      chat('history-x-1', 'user', 'old', 1, { metadata: { historySource: 'server' } }),
      chat('user-1', 'user', 'How long does a refund take?'),
      chat('assistant-1', 'assistant', 'Refunds  arrive in\n3–5 business days.'),
      chat('user-2', 'user', 'Thanks'),
      chat('assistant-2', 'assistant', 'You are welcome.'),
    ];
    const persisted = [
      chat('p1', 'user', 'How long does a refund take?'),
      chat('p2', 'assistant', 'Refunds arrive in 3–5 business days.'),
      chat('p3', 'user', 'Thanks'),
      chat('p4', 'assistant', 'Refunds arrive in 7 business days.'),
    ];
    const results = compareWithPersisted(session, persisted);
    expect(results.map((result) => [result.messageId, result.status])).toEqual([
      ['user-2', 'match'],
      ['user-1', 'match'],
      ['assistant-2', 'mismatch'],
      ['assistant-1', 'match'],
    ]);
    expect(results.find((result) => result.messageId === 'assistant-2')).toMatchObject({ streamedText: 'You are welcome.', persistedText: 'Refunds arrive in 7 business days.' });
    expect(compareWithPersisted(session, []).every((result) => result.status === 'missing')).toBe(true);
  });

  it('diffs CJK text by character and Latin text by word', () => {
    expect(diffText('退款會在 3–5 個工作天', '退款會在 7 個工作天')).toEqual([
      { kind: 'same', text: '退款會在 ' },
      { kind: 'removed', text: '3–5' },
      { kind: 'added', text: '7' },
      { kind: 'same', text: ' 個工作天' },
    ]);
    expect(diffText('a quick fox', 'a slow fox')).toEqual([{ kind: 'same', text: 'a ' }, { kind: 'removed', text: 'quick' }, { kind: 'added', text: 'slow' }, { kind: 'same', text: ' fox' }]);
    const long = 'word '.repeat(2_000);
    expect(diffText(long, 'other')).toEqual([{ kind: 'removed', text: long }, { kind: 'added', text: 'other' }]);
  });
});

describe('conversation archive', () => {
  it('stores settled messages only once something was said and titles from the first user message', () => {
    expect(storedConversationFromSnapshot(snapshotWith([]), 'local:a', 10)).toBeUndefined();
    const stored = storedConversationFromSnapshot(snapshotWith([
      chat('user-1', 'user', '  Explain   a sample topic  '),
      chat('assistant-1', 'assistant', 'Sure.'),
      chat('assistant-2', 'assistant', '', 2_000, { status: 'streaming' }),
    ], { conversationId: 'server-1' }), 'local:a', 10);
    expect(stored).toMatchObject({ key: 'local:a', conversationId: 'server-1', title: 'Explain a sample topic', createdAt: 1_000, updatedAt: 10 });
    expect(stored?.messages.map((item) => item.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('merges local and server entries without duplicating a conversation already archived', () => {
    const local: StoredConversation[] = [{ key: 'local:a', conversationId: 'c1', title: 'Local', createdAt: 1, updatedAt: 50, messages: [chat('u', 'user', 'hi')] }];
    const items = mergeConversationSummaries(local, [{ conversationId: 'c1', title: 'Server copy', updatedAt: 10 }, { conversationId: 'c2', title: 'Server only', updatedAt: 100 }]);
    expect(items.map((item) => [item.key, item.source, item.title])).toEqual([['remote:c2', 'remote', 'Server only'], ['local:a', 'local', 'Local']]);
  });

  it('drops malformed stored entries and bounds the archive size setting', () => {
    const valid = { key: 'local:ok', title: 'ok', createdAt: 1, updatedAt: 2, messages: [chat('u', 'user', 'hi')] };
    expect(sanitizeStoredConversations([valid, { ...valid, key: 'remote:x' }, { ...valid, key: 'local:bad', messages: [{ id: 'x' }] }, null, { ...valid }]).map((item) => item.key)).toEqual(['local:ok']);
    expect(conversationArchiveLimit(baseProfile)).toBe(20);
    expect(conversationArchiveLimit({ ...baseProfile, history: { conversations: { maxConversations: 500 } } })).toBe(100);
  });
});

describe('ConversationManager', () => {
  function setup(profile: TurnStageProfile = baseProfile, fetchJson?: (kind: 'list' | 'history', id?: string) => Promise<unknown>) {
    let saved: StoredConversation[] = [];
    let counter = 0;
    const states: ConversationDirectory[] = [];
    const storage = { load: vi.fn(async () => saved), save: vi.fn(async (items: StoredConversation[]) => { saved = items; }) };
    const manager = new ConversationManager(profile, { storage, fetchJson, createId: () => `id-${++counter}`, now: () => 1_000 + counter }, (state) => states.push(state));
    return { manager, storage, states, saved: () => saved };
  }

  it('archives each conversation, switches between them, and refuses to delete the open one', async () => {
    const { manager, storage, states, saved } = setup();
    await manager.load();
    const first = manager.currentKey;
    await manager.record(snapshotWith([chat('u1', 'user', 'First question'), chat('a1', 'assistant', 'First answer')]));
    manager.beginNew();
    const second = manager.currentKey;
    await manager.record(snapshotWith([chat('u2', 'user', 'Second question'), chat('a2', 'assistant', 'Second answer')]));
    expect(saved().map((item) => item.key).sort()).toEqual([first, second].sort());
    expect(states.at(-1)?.items.map((item) => item.title).sort()).toEqual(['First question', 'Second question']);
    expect(manager.preservesConversations).toBe(true);

    const restored = await manager.open(first);
    expect(restored?.messages.map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(manager.currentKey).toBe(first);
    expect(await manager.remove(first)).toBe(false);
    expect(await manager.remove(second)).toBe(true);
    expect(saved().map((item) => item.key)).toEqual([first]);
    expect(storage.save).toHaveBeenCalledTimes(3);
  });

  it('keeps nothing when the archive is disabled for the Profile', async () => {
    const { manager, storage } = setup({ ...baseProfile, history: { conversations: { enabled: false } } });
    await manager.load();
    await manager.record(snapshotWith([chat('u1', 'user', 'hello')]));
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(manager.directory.items).toEqual([]);
    expect(manager.preservesConversations).toBe(false);
  });

  it('lists server conversations, loads one into a new archive key, and verifies after a turn', async () => {
    const profile: TurnStageProfile = { ...baseProfile, conversations: { list: { request: { method: 'GET', url: 'https://example.test/conversations' } }, history: { request: { method: 'GET', url: 'https://example.test/conversations/${conversation.id}/messages' } } } };
    const fetchJson = vi.fn(async (kind: 'list' | 'history', id?: string) => kind === 'list'
      ? [{ id: 'c9', title: 'From server', updatedAt: 1_758_000_000_000 }]
      : { messages: [{ id: 'm1', role: 'user', content: 'Hi' }, { id: 'm2', role: 'assistant', content: id === 'c9' ? 'Hello there' : 'Saved differently' }] });
    const { manager, states } = setup(profile, fetchJson);
    await manager.load();
    await manager.refreshRemote();
    expect(states.at(-1)?.remote).toEqual({ configured: true, status: 'ready' });
    expect(states.at(-1)?.items).toEqual([{ key: 'remote:c9', source: 'remote', conversationId: 'c9', title: 'From server', updatedAt: 1_758_000_000_000 }]);
    expect(states.some((state) => state.remote.status === 'loading')).toBe(true);

    const restored = await manager.open('remote:c9');
    expect(fetchJson).toHaveBeenLastCalledWith('history', 'c9');
    expect(restored).toMatchObject({ conversationId: 'c9', title: 'From server' });
    expect(restored?.key).toBe(manager.currentKey);
    expect(restored?.key.startsWith('local:')).toBe(true);
    expect(states.some((state) => state.opening === 'remote:c9')).toBe(true);

    await manager.verify(snapshotWith([chat('user-1', 'user', 'Hi'), chat('assistant-1', 'assistant', 'Hello there!')], { conversationId: 'other' }));
    expect(manager.directory.check).toMatchObject({ status: 'done', results: [{ messageId: 'user-1', status: 'match' }, { messageId: 'assistant-1', status: 'mismatch', persistedText: 'Saved differently' }] });
    expect(manager.shouldVerifyAfterTurn()).toBe(true);
  });

  it('reports server failures without throwing', async () => {
    const profile: TurnStageProfile = { ...baseProfile, conversations: { list: { request: { method: 'GET', url: 'https://example.test/c' } }, history: { request: { method: 'GET', url: 'https://example.test/c/${conversation.id}' }, verifyAfterTurn: false } } };
    const { manager } = setup(profile, async () => { throw new Error('HTTP 503'); });
    await manager.refreshRemote();
    expect(manager.directory.remote).toEqual({ configured: true, status: 'failed', error: 'HTTP 503' });
    expect(await manager.openRemote('c1')).toBeUndefined();
    expect(manager.directory.openError).toBe('HTTP 503');
    await manager.verify(snapshotWith([chat('u', 'user', 'x')], { conversationId: 'c1' }));
    expect(manager.directory.check).toMatchObject({ status: 'failed', error: 'HTTP 503' });
    expect(manager.shouldVerifyAfterTurn()).toBe(false);
  });

  it('ignores a verification that finishes after the user switched conversations', async () => {
    const profile: TurnStageProfile = { ...baseProfile, conversations: { history: { request: { method: 'GET', url: 'https://example.test/c/${conversation.id}' } } } };
    let release: (value: unknown) => void = () => undefined;
    const { manager } = setup(profile, () => new Promise((resolve) => { release = resolve; }));
    const pending = manager.verify(snapshotWith([chat('u', 'user', 'x')], { conversationId: 'c1' }));
    manager.beginNew();
    release({ messages: [] });
    await pending;
    expect(manager.directory.check).toBeUndefined();
  });

  it('uses a stable local key format', () => {
    expect(localConversationKey('abc')).toBe('local:abc');
  });
});

describe('conversation protocol', () => {
  const envelope = { protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'editor', requestId: 'r1' };
  it('accepts bounded conversation messages and rejects malformed ones', () => {
    expect(isWebviewMessage({ ...envelope, type: 'conversation.open', key: 'local:abc' }, 'editor')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'conversation.delete', key: 'x'.repeat(3000) }, 'editor')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'conversation.list.refresh' }, 'editor')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'conversation.history.verify' }, 'editor')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'conversation.open' }, 'editor')).toBe(false);
  });

  it('lets the Webview receive conversation directory updates', () => {
    const state: ConversationDirectory = { enabled: true, currentKey: 'local:a', items: [], remote: { configured: false, status: 'idle' }, history: { configured: false } };
    expect(isHostMessage({ ...envelope, type: 'conversations.state', state }, 'editor')).toBe(true);
  });
});
