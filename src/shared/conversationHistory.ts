import type { ChatMessage, ConversationDirectory, ConversationSummary, HistoryConsistencyResult, JsonObject, SessionSnapshot, TurnStageProfile } from './types';
import { getPath } from '../extension/request/templateResolver';

export const DEFAULT_MAX_CONVERSATIONS = 20;
export const MAX_CONVERSATIONS = 100;
export const MAX_STORED_CONVERSATION_MESSAGES = 200;
export const MAX_REMOTE_CONVERSATIONS = 100;
export const MAX_HISTORY_MESSAGES = 500;
const MAX_TITLE_LENGTH = 120;
const MAX_PREVIEW_LENGTH = 160;
const MAX_CHECK_TEXT_LENGTH = 4_000;
const MAX_HISTORY_TEXT_LENGTH = 256 * 1024;
const CHECKED_MESSAGES_PER_ROLE = 3;

export const HISTORY_SOURCE_SERVER = 'server';

export interface StoredConversation {
  key: string;
  conversationId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  opening?: SessionSnapshot['opening'];
}

export interface RemoteConversation {
  conversationId: string;
  title: string;
  updatedAt: number;
}

export interface ConversationStorage {
  load(): Promise<StoredConversation[]>;
  save(items: StoredConversation[]): Promise<void>;
}

export interface RestoredConversation {
  key: string;
  conversationId?: string;
  title?: string;
  opening?: SessionSnapshot['opening'];
  messages: ChatMessage[];
}

export interface ConversationHostAdapter {
  /** Omitted when the host cannot persist (the archive then lives only in memory). */
  storage?: ConversationStorage;
  /** Performs the configured list/history request and returns the parsed JSON body. */
  fetchJson?: (kind: 'list' | 'history', conversationId?: string) => Promise<unknown>;
  createId: () => string;
  now?: () => number;
}

export function localConversationKey(id: string): string { return `local:${id}`; }
export function remoteConversationKey(conversationId: string): string { return `remote:${conversationId}`; }

export function conversationArchiveEnabled(profile: TurnStageProfile): boolean { return profile.history?.conversations?.enabled !== false; }
export function conversationArchiveLimit(profile: TurnStageProfile): number {
  const value = profile.history?.conversations?.maxConversations;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_CONVERSATIONS, Math.max(1, Math.floor(value))) : DEFAULT_MAX_CONVERSATIONS;
}

/** Plain text of a message: concatenated text and markdown parts. */
export function messageText(message: Pick<ChatMessage, 'parts'>): string {
  return message.parts.filter((part) => typeof part.text === 'string' && (part.type === 'text' || part.type === 'markdown')).map((part) => part.text as string).join('');
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function isHistoryMessage(message: ChatMessage): boolean {
  return message.metadata?.historySource === HISTORY_SOURCE_SERVER;
}

export function conversationTitle(snapshot: Pick<SessionSnapshot, 'title' | 'messages'>): string {
  if (snapshot.title?.trim()) return clip(snapshot.title, MAX_TITLE_LENGTH);
  const firstUser = snapshot.messages.find((message) => message.role === 'user');
  return firstUser ? clip(messageText(firstUser), MAX_TITLE_LENGTH) : '';
}

function settledMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.status !== 'pending' && message.status !== 'streaming').slice(-MAX_STORED_CONVERSATION_MESSAGES);
}

/** Builds an archive entry for the current conversation, or undefined when nothing was said yet. */
export function storedConversationFromSnapshot(snapshot: SessionSnapshot, key: string, now: number, previous?: StoredConversation): StoredConversation | undefined {
  const messages = settledMessages(snapshot.messages);
  if (!messages.some((message) => message.role === 'user')) return undefined;
  return {
    key,
    ...(snapshot.conversationId ? { conversationId: snapshot.conversationId } : {}),
    title: conversationTitle({ title: snapshot.title, messages }),
    createdAt: previous?.createdAt ?? messages[0]?.createdAt ?? now,
    updatedAt: now,
    messages: structuredClone(messages),
    ...(snapshot.opening ? { opening: structuredClone(snapshot.opening) } : {}),
  };
}

export function summarizeStoredConversation(item: StoredConversation): ConversationSummary {
  const lastReply = [...item.messages].reverse().find((message) => message.role === 'assistant' || message.role === 'user');
  const preview = lastReply ? clip(messageText(lastReply), MAX_PREVIEW_LENGTH) : '';
  return {
    key: item.key,
    source: 'local',
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    title: item.title,
    ...(preview ? { preview } : {}),
    updatedAt: item.updatedAt,
    messageCount: item.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
  };
}

export function upsertStoredConversation(items: readonly StoredConversation[], item: StoredConversation, limit: number): StoredConversation[] {
  return [item, ...items.filter((existing) => existing.key !== item.key)].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

/** Local entries first (most recent first), then server-only conversations not already archived locally. */
export function mergeConversationSummaries(local: readonly StoredConversation[], remote: readonly RemoteConversation[]): ConversationSummary[] {
  const localSummaries = local.map(summarizeStoredConversation);
  const known = new Set(localSummaries.flatMap((item) => item.conversationId ? [item.conversationId] : []));
  const remoteSummaries = remote.filter((item) => !known.has(item.conversationId)).map((item): ConversationSummary => ({ key: remoteConversationKey(item.conversationId), source: 'remote', conversationId: item.conversationId, title: item.title, updatedAt: item.updatedAt }));
  return [...localSummaries, ...remoteSummaries].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function sanitizeStoredConversations(value: unknown, limit = MAX_CONVERSATIONS): StoredConversation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: StoredConversation[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const { key, title, createdAt, updatedAt, conversationId, messages, opening } = candidate;
    if (typeof key !== 'string' || !key.startsWith('local:') || key.length > 2048 || seen.has(key)) continue;
    if (typeof title !== 'string' || !isTimestamp(createdAt) || !isTimestamp(updatedAt) || !Array.isArray(messages)) continue;
    const safeMessages = messages.filter(isChatMessageLike).slice(-MAX_STORED_CONVERSATION_MESSAGES);
    if (!safeMessages.length) continue;
    seen.add(key);
    items.push({
      key,
      title: title.slice(0, MAX_TITLE_LENGTH),
      createdAt,
      updatedAt,
      messages: safeMessages,
      ...(typeof conversationId === 'string' && conversationId && conversationId.length <= 2048 ? { conversationId } : {}),
      ...(isRecord(opening) && typeof opening.message === 'string' && Array.isArray(opening.starters) ? { opening: opening as unknown as NonNullable<SessionSnapshot['opening']> } : {}),
    });
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

function isChatMessageLike(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && ['user', 'assistant', 'system', 'tool'].includes(String(value.role)) && ['completed', 'failed', 'aborted'].includes(String(value.status))
    && isTimestamp(value.createdAt) && Array.isArray(value.parts) && value.parts.every((part) => isRecord(part) && typeof part.type === 'string')
    && Array.isArray(value.citations) && Array.isArray(value.actions) && Array.isArray(value.followups);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function firstArray(data: unknown, path: string | undefined, fallbacks: readonly string[]): unknown[] {
  if (path) { const value = getPath(data, path); return Array.isArray(value) ? value : []; }
  if (Array.isArray(data)) return data;
  for (const candidate of fallbacks) { const value = getPath(data, candidate); if (Array.isArray(value)) return value; }
  return [];
}

function firstValue(item: unknown, path: string | undefined, fallbacks: readonly string[]): unknown {
  if (path) return getPath(item, path);
  for (const candidate of fallbacks) { const value = getPath(item, candidate); if (value !== undefined && value !== null) return value; }
  return undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && value.length <= 2048) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Accepts epoch milliseconds, epoch seconds, or an ISO date string. */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return parseTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseRemoteConversationList(data: unknown, response: NonNullable<NonNullable<TurnStageProfile['conversations']>['list']>['response'] = {}): RemoteConversation[] {
  const items = firstArray(data, response.itemsPath, ['data', 'items', 'conversations', 'results']);
  const seen = new Set<string>();
  const result: RemoteConversation[] = [];
  for (const item of items) {
    const conversationId = identifier(firstValue(item, response.idPath, ['id', 'conversationId', 'conversation_id', 'uuid']));
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    const title = firstValue(item, response.titlePath, ['title', 'name', 'summary']);
    result.push({ conversationId, title: typeof title === 'string' ? clip(title, MAX_TITLE_LENGTH) : '', updatedAt: parseTimestamp(firstValue(item, response.updatedAtPath, ['updatedAt', 'updated_at', 'lastMessageAt', 'last_message_at', 'createdAt', 'created_at'])) ?? 0 });
    if (result.length >= MAX_REMOTE_CONVERSATIONS) break;
  }
  return result;
}

/** Text of a persisted message: a string, an array of content parts, or an object with `text`/`value`. */
export function persistedContentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_HISTORY_TEXT_LENGTH);
  if (Array.isArray(value)) {
    const parts = value.map((part) => typeof part === 'string' ? part : isRecord(part) ? persistedContentText(part.text ?? part.content ?? part.value) ?? '' : '').filter(Boolean);
    return parts.length ? parts.join('').slice(0, MAX_HISTORY_TEXT_LENGTH) : undefined;
  }
  if (isRecord(value)) return persistedContentText(value.text ?? value.content ?? value.value);
  return undefined;
}

function persistedRole(value: unknown): ChatMessage['role'] | undefined {
  const role = typeof value === 'string' ? value.toLowerCase() : '';
  if (['user', 'human', 'customer'].includes(role)) return 'user';
  if (['assistant', 'ai', 'bot', 'model', 'agent'].includes(role)) return 'assistant';
  if (role === 'system') return 'system';
  return undefined;
}

export function parseRemoteHistory(data: unknown, response: NonNullable<NonNullable<TurnStageProfile['conversations']>['history']>['response'] = {}, conversationId = ''): ChatMessage[] {
  const items = firstArray(data, response.messagesPath, ['messages', 'data', 'items', 'history']);
  const messages: ChatMessage[] = [];
  items.slice(-MAX_HISTORY_MESSAGES).forEach((item, index) => {
    const role = persistedRole(firstValue(item, response.rolePath, ['role', 'sender', 'author.role', 'type']));
    const text = persistedContentText(firstValue(item, response.textPath, ['content', 'text', 'message', 'body']));
    if (!role || text === undefined) return;
    const remoteId = identifier(firstValue(item, response.idPath, ['id', 'messageId', 'message_id']));
    const createdAt = parseTimestamp(firstValue(item, response.createdAtPath, ['createdAt', 'created_at', 'timestamp', 'time'])) ?? 0;
    const metadata: JsonObject = { historySource: HISTORY_SOURCE_SERVER, ...(remoteId ? { historyMessageId: remoteId } : {}) };
    messages.push({ id: `history-${encodeURIComponent(conversationId)}-${remoteId ?? index}`, role, status: 'completed', createdAt, completedAt: createdAt, parts: [{ type: role === 'assistant' ? 'markdown' : 'text', text }], citations: [], actions: [], followups: [], metadata });
  });
  return messages;
}

export function normalizeComparableText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/\s+/gu, ' ').trim();
}

/**
 * Compares the newest settled user and assistant messages streamed in this session with the newest
 * persisted messages of the same role. Messages loaded from history are never compared with themselves.
 */
export function compareWithPersisted(sessionMessages: readonly ChatMessage[], persisted: readonly ChatMessage[], perRole = CHECKED_MESSAGES_PER_ROLE): HistoryConsistencyResult[] {
  const results: HistoryConsistencyResult[] = [];
  for (const role of ['user', 'assistant'] as const) {
    const streamed = sessionMessages.filter((message) => message.role === role && message.status === 'completed' && !isHistoryMessage(message)).slice(-perRole).reverse();
    const stored = persisted.filter((message) => message.role === role).reverse();
    streamed.forEach((message, index) => {
      const persistedMessage = stored[index];
      const streamedText = messageText(message);
      if (!persistedMessage) { results.push({ messageId: message.id, role, status: 'missing' }); return; }
      const persistedText = messageText(persistedMessage);
      if (normalizeComparableText(streamedText) === normalizeComparableText(persistedText)) results.push({ messageId: message.id, role, status: 'match' });
      else results.push({ messageId: message.id, role, status: 'mismatch', streamedText: streamedText.slice(0, MAX_CHECK_TEXT_LENGTH), persistedText: persistedText.slice(0, MAX_CHECK_TEXT_LENGTH) });
    });
  }
  return results;
}

export type TextDiffSegment = { kind: 'same' | 'removed' | 'added'; text: string };
const DIFF_TOKEN = /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const MAX_DIFF_TOKENS = 1_500;

/** Word-level diff (character-level for CJK). Falls back to replace-all for very long inputs. */
export function diffText(before: string, after: string): TextDiffSegment[] {
  const left = before.match(DIFF_TOKEN) ?? [];
  const right = after.match(DIFF_TOKEN) ?? [];
  if (left.length > MAX_DIFF_TOKENS || right.length > MAX_DIFF_TOKENS) return [...(before ? [{ kind: 'removed' as const, text: before }] : []), ...(after ? [{ kind: 'added' as const, text: after }] : [])];
  const rows = left.length + 1; const columns = right.length + 1;
  const table = new Uint16Array(rows * columns);
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) table[i * columns + j] = left[i] === right[j] ? table[(i + 1) * columns + j + 1]! + 1 : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
  const segments: TextDiffSegment[] = [];
  const push = (kind: TextDiffSegment['kind'], text: string) => { const last = segments.at(-1); if (last?.kind === kind) last.text += text; else segments.push({ kind, text }); };
  let i = 0; let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { push('same', left[i]!); i += 1; j += 1; }
    else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) { push('removed', left[i]!); i += 1; }
    else { push('added', right[j]!); j += 1; }
  }
  while (i < left.length) push('removed', left[i++]!);
  while (j < right.length) push('added', right[j++]!);
  return segments;
}

/**
 * Host-agnostic conversation archive and server history client. Hosts own the session snapshot and
 * apply what this returns; this class owns the drawer state that is posted to the Webview.
 */
export class ConversationManager {
  private stored: StoredConversation[] = [];
  private remote: RemoteConversation[] = [];
  private state: ConversationDirectory;
  private saveChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly profile: TurnStageProfile, private readonly adapter: ConversationHostAdapter, private readonly changed: (directory: ConversationDirectory) => void) {
    this.state = {
      enabled: conversationArchiveEnabled(profile),
      currentKey: localConversationKey(adapter.createId()),
      items: [],
      remote: { configured: Boolean(profile.conversations?.list && adapter.fetchJson), status: 'idle' },
      history: { configured: Boolean(profile.conversations?.history && adapter.fetchJson) },
    };
  }

  get directory(): ConversationDirectory { return structuredClone(this.state); }
  get currentKey(): string { return this.state.currentKey; }
  /** True when starting a new conversation keeps the current one reachable from the drawer. */
  get preservesConversations(): boolean { return this.state.enabled; }
  private now(): number { return this.adapter.now?.() ?? Date.now(); }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.state.enabled && this.adapter.storage) {
      try { this.stored = sanitizeStoredConversations(await this.adapter.storage.load(), conversationArchiveLimit(this.profile)); }
      catch { this.stored = []; }
    }
    this.publish();
  }

  /** Saves the current conversation after a turn so it survives reloads and appears in the drawer. */
  async record(snapshot: SessionSnapshot): Promise<void> {
    if (!this.state.enabled) return;
    const previous = this.stored.find((item) => item.key === this.state.currentKey);
    const item = storedConversationFromSnapshot(snapshot, this.state.currentKey, this.now(), previous);
    if (!item) return;
    this.stored = upsertStoredConversation(this.stored, item, conversationArchiveLimit(this.profile));
    this.publish();
    await this.persist();
  }

  /** Starts a fresh conversation key; callers reset their snapshot. */
  beginNew(): void {
    this.state.currentKey = localConversationKey(this.adapter.createId());
    this.state.check = undefined;
    this.state.openError = undefined;
    this.publish();
  }

  async open(key: string): Promise<RestoredConversation | undefined> {
    const local = this.stored.find((item) => item.key === key);
    if (local) {
      this.state.currentKey = local.key;
      this.state.check = undefined;
      this.state.openError = undefined;
      this.publish();
      return { key: local.key, conversationId: local.conversationId, title: local.title || undefined, opening: local.opening ? structuredClone(local.opening) : undefined, messages: structuredClone(local.messages) };
    }
    if (!key.startsWith('remote:') || !this.state.history.configured) return undefined;
    const conversationId = key.slice('remote:'.length);
    return this.openRemote(conversationId, this.remote.find((item) => item.conversationId === conversationId)?.title);
  }

  /** Loads a server conversation's persisted messages into a new local archive entry. */
  async openRemote(conversationId: string, title?: string): Promise<RestoredConversation | undefined> {
    if (!this.state.history.configured || !this.adapter.fetchJson) return undefined;
    const key = remoteConversationKey(conversationId);
    this.state.opening = key;
    this.state.openError = undefined;
    this.publish();
    try {
      const data = await this.adapter.fetchJson('history', conversationId);
      const messages = parseRemoteHistory(data, this.profile.conversations?.history?.response, conversationId);
      const existing = this.stored.find((item) => item.conversationId === conversationId);
      this.state.currentKey = existing?.key ?? localConversationKey(this.adapter.createId());
      this.state.check = undefined;
      return { key: this.state.currentKey, conversationId, title: title || existing?.title || undefined, messages };
    } catch (error) {
      this.state.openError = errorMessage(error);
      return undefined;
    } finally {
      this.state.opening = undefined;
      this.publish();
    }
  }

  async remove(key: string): Promise<boolean> {
    if (key === this.state.currentKey || !this.stored.some((item) => item.key === key)) return false;
    this.stored = this.stored.filter((item) => item.key !== key);
    this.publish();
    await this.persist();
    return true;
  }

  async refreshRemote(): Promise<void> {
    if (!this.state.remote.configured || !this.adapter.fetchJson || this.state.remote.status === 'loading') return;
    this.state.remote = { ...this.state.remote, status: 'loading', error: undefined };
    this.publish();
    try {
      this.remote = parseRemoteConversationList(await this.adapter.fetchJson('list'), this.profile.conversations?.list?.response);
      this.state.remote = { configured: true, status: 'ready' };
    } catch (error) {
      this.state.remote = { configured: true, status: 'failed', error: errorMessage(error) };
    }
    this.publish();
  }

  /** Re-reads the server history and compares it with what this session streamed. */
  async verify(snapshot: SessionSnapshot): Promise<void> {
    if (!this.state.history.configured || !this.adapter.fetchJson || !snapshot.conversationId) return;
    if (!snapshot.messages.some((message) => message.status === 'completed' && !isHistoryMessage(message) && (message.role === 'user' || message.role === 'assistant'))) return;
    const key = this.state.currentKey;
    this.state.check = { status: 'checking', results: this.state.check?.results ?? [] };
    this.publish();
    try {
      const data = await this.adapter.fetchJson('history', snapshot.conversationId);
      if (key !== this.state.currentKey) return;
      const persisted = parseRemoteHistory(data, this.profile.conversations?.history?.response, snapshot.conversationId);
      this.state.check = { status: 'done', checkedAt: this.now(), results: compareWithPersisted(snapshot.messages, persisted) };
    } catch (error) {
      if (key !== this.state.currentKey) return;
      this.state.check = { status: 'failed', checkedAt: this.now(), error: errorMessage(error), results: [] };
    }
    this.publish();
  }

  shouldVerifyAfterTurn(): boolean { return this.state.history.configured && this.profile.conversations?.history?.verifyAfterTurn !== false; }

  private publish(): void {
    this.state.items = this.state.enabled ? mergeConversationSummaries(this.stored, this.remote) : mergeConversationSummaries([], this.remote);
    this.changed(this.directory);
  }

  private persist(): Promise<void> {
    const storage = this.adapter.storage;
    if (!storage) return Promise.resolve();
    const items = structuredClone(this.stored);
    this.saveChain = this.saveChain.then(() => storage.save(items)).catch(() => undefined);
    return this.saveChain;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
