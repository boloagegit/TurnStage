import type * as vscode from 'vscode';
import type { RemoteSessionReference } from '../../shared/types';

type UnknownRecord = Record<string, unknown>;

const maxRemoteSessions = 50;
const remoteSaveQueues = new WeakMap<object, Map<string, Promise<void>>>();

export class RemoteSessionRepository {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(key: string): RemoteSessionReference[] {
    if (typeof key !== 'string' || key.length === 0) return [];
    try {
      return sanitizeRemoteSessions(this.context.globalState.get<unknown>(key, [])).slice(0, maxRemoteSessions);
    } catch {
      return [];
    }
  }

  async save(key: string, reference: RemoteSessionReference): Promise<RemoteSessionReference[]> {
    if (typeof key !== 'string' || key.length === 0) return [];
    const state = this.context.globalState as unknown as object;
    const queues = remoteSaveQueues.get(state) ?? new Map<string, Promise<void>>();
    remoteSaveQueues.set(state, queues);
    return withQueue(queues, key, async () => {
      const references = this.list(key);
      const safeReference = sanitizeRemoteSession(reference);
      if (!safeReference) return references;
      const next = [safeReference, ...references.filter((item) => item.conversationId !== safeReference.conversationId)].slice(0, maxRemoteSessions);
      await this.context.globalState.update(key, next);
      return next;
    });
  }
}

function withQueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return current.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}

function sanitizeRemoteSessions(value: unknown): RemoteSessionReference[] {
  if (!Array.isArray(value)) return [];
  const references: RemoteSessionReference[] = [];
  for (const item of value) {
    const reference = sanitizeRemoteSession(item);
    if (reference) references.push(reference);
  }
  return references;
}

function sanitizeRemoteSession(value: unknown): RemoteSessionReference | undefined {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.conversationId) || typeof record.title !== 'string' || !isTimestamp(record.createdAt)) return undefined;
  const reference: RemoteSessionReference = { conversationId: record.conversationId, title: record.title, createdAt: record.createdAt };
  for (const key of ['actorId', 'environmentId'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') return undefined;
      reference[key] = record[key];
    }
  }
  return reference;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isTimestamp(value: unknown): value is number { return isFiniteNumber(value) && value >= 0 && Number.isFinite(new Date(value).getTime()); }
