import * as vscode from 'vscode';
import type { TestRunHistoryRecord } from '../../shared/testRunHistory';
import { clearTestRunHistoryKind, TEST_RUN_HISTORY_FORMAT, TEST_RUN_HISTORY_VERSION } from '../../shared/testRunHistory';
import { testCaseKey } from '../../shared/testSelection';
import { sha256Hex } from '../../shared/sha256';

const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
const RETAIN_RUNS = 20;
const queue = new Map<string, Promise<void>>();

interface StoredHistory {
  format: 'turnstage-test-history-store';
  version: 1;
  runs: TestRunHistoryRecord[];
  baselineRunId?: string;
}

/** Workspace-local, bounded, metadata-only manual test history. */
export class TestRunHistoryRepository {
  private readonly root: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.root = context.storageUri ?? context.globalStorageUri;
  }

  async list(profileId: string): Promise<TestRunHistoryRecord[]> {
    return (await this.read(profileId)).runs.sort((left, right) => right.startedAt - left.startedAt);
  }

  async baseline(profileId: string): Promise<TestRunHistoryRecord | undefined> {
    const history = await this.read(profileId);
    return history.runs.find((run) => run.id === history.baselineRunId);
  }

  async acceptBaseline(profileId: string, runId: string): Promise<void> {
    await this.update(profileId, (history) => {
      const run = history.runs.find((item) => item.id === runId);
      if (!run || run.status !== 'completed') throw new Error('Only a completed run from this profile can be used as a baseline.');
      return { ...history, baselineRunId: runId };
    });
  }

  async save(record: TestRunHistoryRecord): Promise<void> {
    if (!validRun(record) || record.profileId !== record.cases[0]?.profileId) throw new Error('Test run history metadata is invalid.');
    await this.update(record.profileId, (history) => {
      const ordered = [record, ...history.runs.filter((item) => item.id !== record.id)].sort((left, right) => right.startedAt - left.startedAt);
      const retained = ordered.slice(0, RETAIN_RUNS);
      const baseline = ordered.find((item) => item.id === history.baselineRunId);
      if (baseline && !retained.some((item) => item.id === baseline.id)) retained.push(baseline);
      return { ...history, runs: retained };
    });
  }

  async clear(profileId: string, kind: 'contract' | 'adversarial'): Promise<void> {
    await this.update(profileId, (history) => ({ format: history.format, version: history.version, ...clearTestRunHistoryKind(history.runs, kind, history.baselineRunId) }));
  }

  private async read(profileId: string): Promise<StoredHistory> {
    if (!safeId(profileId)) throw new Error('Profile ID is invalid for test history.');
    const uri = this.uri(profileId);
    try {
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_HISTORY_BYTES) throw new Error('Test history is larger than the safety limit.');
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_HISTORY_BYTES) throw new Error('Test history is larger than the safety limit.');
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(parsed) || parsed.format !== 'turnstage-test-history-store' || parsed.version !== 1 || !Array.isArray(parsed.runs)) throw new Error('Test history has an unsupported format.');
      const runs = parsed.runs.filter((value): value is TestRunHistoryRecord => validRun(value) && value.profileId === profileId).slice(0, RETAIN_RUNS + 1);
      return { format: 'turnstage-test-history-store', version: 1, runs, ...(typeof parsed.baselineRunId === 'string' && runs.some((item) => item.id === parsed.baselineRunId) ? { baselineRunId: parsed.baselineRunId } : {}) };
    } catch (error) {
      if (isMissing(error)) return emptyHistory();
      throw error;
    }
  }

  private async update(profileId: string, change: (history: StoredHistory) => StoredHistory): Promise<void> {
    const uri = this.uri(profileId);
    const key = uri.toString();
    const previous = queue.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(change(await this.read(profileId))));
      if (bytes.byteLength > MAX_HISTORY_BYTES) throw new Error('Test history would exceed its safety limit.');
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, 'test-history'));
      const temporary = vscode.Uri.joinPath(this.root, 'test-history', `${safeFilePart(profileId)}.json.tmp`);
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
    });
    const tail = pending.then(() => undefined, () => undefined);
    queue.set(key, tail);
    await pending.finally(() => { if (queue.get(key) === tail) queue.delete(key); });
  }

  private uri(profileId: string): vscode.Uri { return vscode.Uri.joinPath(this.root, 'test-history', `${safeFilePart(profileId)}.json`); }
}

function emptyHistory(): StoredHistory { return { format: 'turnstage-test-history-store', version: 1, runs: [] }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function safeFilePart(value: string): string { return `${value.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 60)}-${sha256Hex(value).slice(0, 16)}`; }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function validRun(value: unknown): value is TestRunHistoryRecord {
  if (!isRecord(value) || value.format !== TEST_RUN_HISTORY_FORMAT || value.version !== TEST_RUN_HISTORY_VERSION || !safeId(value.id) || !safeId(value.profileId) || (value.sourceRunId !== undefined && !safeId(value.sourceRunId)) || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.finishedAt) || Number(value.finishedAt) < Number(value.startedAt) || !['completed', 'cancelled', 'failed'].includes(String(value.status)) || !['web', 'vscode', 'cli'].includes(String(value.runner)) || value.evaluatorVersion !== 1 || !isDigest(value.profileDigest) || !isDigest(value.environmentDigest) || !Array.isArray(value.cases) || value.cases.length < 1) return false;
  const validCases = value.cases.every((item) => isRecord(item) && item.profileId === value.profileId && safeId(item.scenarioId) && (item.suiteId === undefined || safeId(item.suiteId)) && (item.kind === 'contract' || item.kind === 'adversarial') && item.key === testCaseKey(item as unknown as TestRunHistoryRecord['cases'][number]) && typeof item.name === 'string' && item.name.length <= 512 && isDigest(item.definitionDigest) && (item.environmentDigest === undefined || isDigest(item.environmentDigest)) && Number.isSafeInteger(item.requestedAttempts) && Number(item.requestedAttempts) >= 1 && Number.isSafeInteger(item.completedAttempts) && Number(item.completedAttempts) >= 0 && Number(item.completedAttempts) <= Number(item.requestedAttempts) && (item.outcome === undefined || ['passed', 'failed', 'error', 'resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'].includes(String(item.outcome))) && (item.durationMs === undefined || Number.isFinite(item.durationMs)) && (item.evidenceId === undefined || safeId(item.evidenceId)));
  return validCases && new Set(value.cases.map((item) => item.key)).size === value.cases.length;
}
function isMissing(error: unknown): boolean { return isRecord(error) && (error.code === 'ENOENT' || error.code === 'FileNotFound' || /ENOENT|EntryNotFound/u.test(String(error.message ?? ''))); }
