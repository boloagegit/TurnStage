import * as vscode from 'vscode';
import type { AdversarialAttemptSummary, AdversarialOutcome, ScenarioRunGroupRecord } from '../../shared/types';
import { logAt } from '../logging';

export const RUN_GROUP_FORMAT = 'turnstage-run-group' as const;
export const RUN_GROUP_VERSION = 1 as const;
export const DEFAULT_RUN_GROUP_RETENTION = 20;
export const MAX_RUN_GROUP_RETENTION = 100;
export const MAX_RUN_GROUP_BYTES = 20 * 1024 * 1024;

const outcomes = new Set<AdversarialOutcome>(['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError']);
const saveQueues = new Map<string, Promise<void>>();

/**
 * Workspace-scoped run-group history. VS Code's storageUri is local to the
 * workspace and keeps the records out of the source tree; globalStorageUri is
 * used only for profiles that run without a workspace (or old test hosts).
 */
export class ScenarioRunGroupRepository {
  private readonly root: vscode.Uri;
  private readonly warnedReads = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly output?: Pick<vscode.OutputChannel, 'appendLine'>) {
    const storageUri = (context as vscode.ExtensionContext & { storageUri?: vscode.Uri }).storageUri;
    this.root = storageUri ?? context.globalStorageUri;
  }

  async list(profileId: string): Promise<ScenarioRunGroupRecord[]> {
    if (!safeString(profileId)) return [];
    try {
      const uri = this.uri(profileId);
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_RUN_GROUP_BYTES) { this.warnRead(profileId, 'size-limit'); return []; }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_RUN_GROUP_BYTES) { this.warnRead(profileId, 'size-limit'); return []; }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(value)) { this.warnRead(profileId, 'unsupported-format'); return []; }
      const records = value.flatMap((item) => {
        const record = sanitizeRecord(item, profileId);
        return record ? [record] : [];
      });
      if (records.length !== value.length) this.warnRead(profileId, 'invalid-records-discarded');
      else this.warnedReads.delete(profileId);
      return records;
    } catch (error) {
      if (!isMissingRunGroupFile(error)) this.warnRead(profileId, 'read-failed');
      return [];
    }
  }

  private warnRead(profileId: string, reason: string): void {
    if (!this.output || this.warnedReads.has(profileId)) return;
    this.warnedReads.add(profileId);
    logAt(this.output, 'warn', () => `[storage] run-group history unavailable profile=${safeFilePart(profileId)} reason=${reason}`);
  }

  async get(profileId: string, id: string): Promise<ScenarioRunGroupRecord | undefined> {
    if (!safeString(id)) return undefined;
    return (await this.list(profileId)).find((record) => record.id === id);
  }

  async save(record: ScenarioRunGroupRecord, retention = DEFAULT_RUN_GROUP_RETENTION): Promise<void> {
    const profileId = safeString(record?.profileId) ? record.profileId : undefined;
    if (!profileId) return;
    const uri = this.uri(profileId);
    await withQueue(saveQueues, uri.toString(), async () => {
      const safeRecord = sanitizeRecord(record, profileId);
      if (!safeRecord) return;
      const max = normalizeRetention(retention);
      const records = [safeRecord, ...(await this.list(profileId)).filter((item) => item.id !== safeRecord.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
        .slice(0, max);
      const bytes = new TextEncoder().encode(JSON.stringify(records));
      if (bytes.byteLength > MAX_RUN_GROUP_BYTES) throw new Error(`Run-group history exceeds the ${MAX_RUN_GROUP_BYTES} byte safety limit.`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, 'run-groups'));
      await vscode.workspace.fs.writeFile(uri, bytes);
    });
  }

  async remove(profileId: string, id: string, retention = DEFAULT_RUN_GROUP_RETENTION): Promise<void> {
    if (!safeString(profileId) || !safeString(id)) return;
    const uri = this.uri(profileId);
    await withQueue(saveQueues, uri.toString(), async () => {
      const records = (await this.list(profileId)).filter((record) => record.id !== id).slice(0, normalizeRetention(retention));
      if (!records.length) {
        try { await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true }); } catch { /* already absent */ }
        return;
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(records)));
    });
  }

  private uri(profileId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'run-groups', `${safeFilePart(profileId)}.json`);
  }
}

function sanitizeRecord(value: unknown, profileId: string): ScenarioRunGroupRecord | undefined {
  if (!record(value) || value.format !== RUN_GROUP_FORMAT || value.version !== RUN_GROUP_VERSION || value.profileId !== profileId) return undefined;
  if (!safeString(value.id) || !safeString(value.scenarioId) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return undefined;
  if (!positiveInteger(value.requestedAttempts) || !nonNegativeInteger(value.completedAttempts) || value.completedAttempts > value.requestedAttempts || !nonNegativeInteger(value.plannedTurns) || !nonNegativeInteger(value.plannedRequests) || !nonNegativeInteger(value.maximumDurationMs) || typeof value.sampleComplete !== 'boolean' || value.sampleComplete !== (value.completedAttempts === value.requestedAttempts) || !outcomes.has(value.outcome as AdversarialOutcome) || !stability(value.stability) || !record(value.counts) || !Array.isArray(value.attempts)) return undefined;
  if (value.attempts.length > value.requestedAttempts || value.completedAttempts !== value.attempts.length) return undefined;
  const attempts = value.attempts.flatMap((item) => { const safe = sanitizeAttempt(item); return safe ? [safe] : []; });
  if (attempts.length !== value.attempts.length || new Set(attempts.map((item) => item.attempt)).size !== attempts.length) return undefined;
  if (attempts.some((attempt, index) => attempt.attempt !== index + 1)) return undefined;
  const counts = emptyCounts();
  for (const attempt of attempts) counts[attempt.outcome] += 1;
  for (const outcome of Object.keys(counts) as AdversarialOutcome[]) if (value.counts[outcome] !== counts[outcome]) return undefined;
  const safe: ScenarioRunGroupRecord = {
    format: RUN_GROUP_FORMAT,
    version: RUN_GROUP_VERSION,
    id: value.id.slice(0, 256),
    profileId,
    scenarioId: value.scenarioId.slice(0, 256),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    requestedAttempts: value.requestedAttempts,
    completedAttempts: value.completedAttempts,
    plannedTurns: value.plannedTurns,
    plannedRequests: value.plannedRequests,
    maximumDurationMs: value.maximumDurationMs,
    sampleComplete: value.sampleComplete,
    outcome: value.outcome as AdversarialOutcome,
    stability: value.stability as ScenarioRunGroupRecord['stability'],
    counts,
    attempts,
  };
  if (typeof value.suiteId === 'string' && value.suiteId.trim()) safe.suiteId = value.suiteId.slice(0, 256);
  if (typeof value.scenarioName === 'string') safe.scenarioName = value.scenarioName.slice(0, 512);
  return safe;
}

function sanitizeAttempt(value: unknown): AdversarialAttemptSummary | undefined {
  if (!record(value) || !positiveInteger(value.attempt) || !outcomes.has(value.outcome as AdversarialOutcome) || !nonNegativeInteger(value.durationMs) || !nonNegativeInteger(value.attemptedTurns) || !nonNegativeInteger(value.completedTurns) || value.completedTurns > value.attemptedTurns || !timestamp(value.startedAt) || !timestamp(value.completedAt) || value.completedAt < value.startedAt) return undefined;
  const attempt: AdversarialAttemptSummary = { attempt: value.attempt, outcome: value.outcome as AdversarialOutcome, durationMs: value.durationMs, attemptedTurns: value.attemptedTurns, completedTurns: value.completedTurns, startedAt: value.startedAt, completedAt: value.completedAt };
  if (value.ttftMs !== undefined) {
    if (!nonNegativeFinite(value.ttftMs)) return undefined;
    attempt.ttftMs = value.ttftMs;
  }
  if (value.evidenceId !== undefined) {
    if (!safeString(value.evidenceId)) return undefined;
    attempt.evidenceId = value.evidenceId.slice(0, 256);
  }
  return attempt;
}

function withQueue<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(key, tail);
  return current.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
}

function record(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function safeString(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512; }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function nonNegativeFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function stability(value: unknown): value is ScenarioRunGroupRecord['stability'] { return value === 'stable-pass' || value === 'stable-fail' || value === 'unstable' || value === 'inconclusive'; }
function emptyCounts(): ScenarioRunGroupRecord['counts'] { return { resisted: 0, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 }; }
function normalizeRetention(value: number): number { return Number.isInteger(value) ? Math.max(1, Math.min(MAX_RUN_GROUP_RETENTION, value)) : DEFAULT_RUN_GROUP_RETENTION; }
function safeFilePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100) || 'profile'; }
function isMissingRunGroupFile(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return value.code === 'FileNotFound' || value.code === 'ENOENT' || value.name === 'EntryNotFound (FileSystemError)' || /\bENOENT\b/.test(String(value.message ?? ''));
}
