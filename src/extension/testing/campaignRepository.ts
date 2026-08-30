import * as vscode from 'vscode';
import type { CampaignBaselineV1, CampaignRunRecordV1 } from '../../shared/types';
import { CAMPAIGN_RUN_FORMAT, CAMPAIGN_RUN_VERSION, sanitizeCampaignCase } from './campaign';
import { logAt } from '../logging';

export const CAMPAIGN_STORE_FORMAT = 'turnstage-campaign-store' as const;
export const CAMPAIGN_STORE_VERSION = 1 as const;
export const DEFAULT_CAMPAIGN_RETENTION = 20;
export const MAX_CAMPAIGN_RETENTION = 100;
export const MAX_CAMPAIGN_STORE_BYTES = 20 * 1024 * 1024;

interface CampaignStoreV1 {
  format: typeof CAMPAIGN_STORE_FORMAT;
  version: typeof CAMPAIGN_STORE_VERSION;
  runs: CampaignRunRecordV1[];
  baselines: CampaignBaselineV1[];
}

const queues = new Map<string, Promise<void>>();

/** Workspace-scoped, metadata-only persistence. Raw prompts and evidence never enter this store. */
export class CampaignRepository {
  private readonly root: vscode.Uri;
  private readonly warnedReads = new Set<string>();

  constructor(context: vscode.ExtensionContext, private readonly output?: Pick<vscode.OutputChannel, 'appendLine'>) {
    const storageUri = (context as vscode.ExtensionContext & { storageUri?: vscode.Uri }).storageUri;
    this.root = storageUri ?? context.globalStorageUri;
  }

  async listRuns(profileId: string, campaignId?: string): Promise<CampaignRunRecordV1[]> {
    const store = await this.read(profileId);
    return store.runs.filter((run) => !campaignId || run.campaignId === campaignId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
  }

  async getRun(profileId: string, runId: string): Promise<CampaignRunRecordV1 | undefined> {
    return (await this.listRuns(profileId)).find((run) => run.id === runId);
  }

  async getAcceptedBaseline(profileId: string, campaignId: string): Promise<{ baseline: CampaignBaselineV1; run: CampaignRunRecordV1 } | undefined> {
    const store = await this.read(profileId);
    const baseline = store.baselines.find((item) => item.campaignId === campaignId);
    const run = baseline ? store.runs.find((item) => item.id === baseline.runId && item.campaignId === campaignId) : undefined;
    return baseline && run ? { baseline, run } : undefined;
  }

  async saveRun(record: CampaignRunRecordV1, retention = DEFAULT_CAMPAIGN_RETENTION): Promise<void> {
    const safe = sanitizeRun(record);
    if (!safe) throw new Error('Campaign run record is invalid or exceeds a safety boundary.');
    await this.update(record.profileId, (store) => {
      const maximum = normalizeRetention(retention);
      const candidates = [safe, ...store.runs.filter((item) => item.id !== safe.id && item.campaignId === safe.campaignId)]
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      const sameCampaign = candidates.slice(0, maximum);
      const baselineId = store.baselines.find((item) => item.campaignId === safe.campaignId)?.runId;
      const pinnedBaseline = baselineId && !sameCampaign.some((item) => item.id === baselineId) ? candidates.find((item) => item.id === baselineId) : undefined;
      if (pinnedBaseline) sameCampaign.push(pinnedBaseline);
      const otherCampaigns = store.runs.filter((item) => item.campaignId !== safe.campaignId);
      const ordered = [...sameCampaign, ...otherCampaigns];
      const capped = ordered.slice(0, MAX_CAMPAIGN_RETENTION * 50);
      const pinnedIds = new Set(store.baselines.map((item) => item.runId));
      for (const pinned of ordered) {
        if (pinnedIds.has(pinned.id) && !capped.some((item) => item.id === pinned.id)) capped.push(pinned);
      }
      return { ...store, runs: capped };
    });
  }

  async acceptBaseline(profileId: string, campaignId: string, runId: string, acceptedAt = Date.now()): Promise<CampaignBaselineV1> {
    let result: CampaignBaselineV1 | undefined;
    await this.update(profileId, (store) => {
      const run = store.runs.find((item) => item.id === runId && item.campaignId === campaignId);
      if (!run) throw new Error('The campaign run was not found.');
      if (run.status !== 'completed' || run.cases.length === 0 || run.cases.some((item) => !item.sampleComplete)) throw new Error('Only a completed, non-empty campaign sample can be accepted as baseline.');
      result = { campaignId, runId, acceptedAt, sourceDigest: run.sourceDigest };
      return { ...store, baselines: [result, ...store.baselines.filter((item) => item.campaignId !== campaignId)] };
    });
    return result!;
  }

  private async read(profileId: string): Promise<CampaignStoreV1> {
    if (!safeId(profileId)) return emptyStore();
    try {
      const uri = this.uri(profileId);
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_CAMPAIGN_STORE_BYTES) { this.warnRead(profileId, 'size-limit'); return emptyStore(); }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_CAMPAIGN_STORE_BYTES) { this.warnRead(profileId, 'size-limit'); return emptyStore(); }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!object(parsed) || parsed.format !== CAMPAIGN_STORE_FORMAT || parsed.version !== CAMPAIGN_STORE_VERSION) { this.warnRead(profileId, 'unsupported-format'); return emptyStore(); }
      const runs = Array.isArray(parsed.runs) ? parsed.runs.flatMap((value) => { const run = sanitizeRun(value); return run && run.profileId === profileId ? [run] : []; }) : [];
      const runIds = new Set(runs.map((item) => item.id));
      const baselines = Array.isArray(parsed.baselines) ? parsed.baselines.flatMap((value) => {
        if (!object(value) || !safeId(value.campaignId) || !safeId(value.runId) || !timestamp(value.acceptedAt) || !safeDigest(value.sourceDigest) || !runIds.has(value.runId)) return [];
        return [{ campaignId: value.campaignId, runId: value.runId, acceptedAt: value.acceptedAt, sourceDigest: value.sourceDigest }];
      }) : [];
      if ((Array.isArray(parsed.runs) && runs.length !== parsed.runs.length) || (Array.isArray(parsed.baselines) && baselines.length !== parsed.baselines.length)) this.warnRead(profileId, 'invalid-records-discarded');
      else this.warnedReads.delete(profileId);
      return { format: CAMPAIGN_STORE_FORMAT, version: CAMPAIGN_STORE_VERSION, runs, baselines };
    } catch (error) {
      if (!isMissingFile(error)) this.warnRead(profileId, 'read-failed');
      return emptyStore();
    }
  }

  private warnRead(profileId: string, reason: string): void {
    if (!this.output || this.warnedReads.has(profileId)) return;
    this.warnedReads.add(profileId);
    logAt(this.output, 'warn', () => `[storage] campaign history unavailable profile=${safeFilePart(profileId)} reason=${reason}`);
  }

  private async update(profileId: string, mutate: (store: CampaignStoreV1) => CampaignStoreV1): Promise<void> {
    if (!safeId(profileId)) throw new Error('Campaign profile id is invalid.');
    const uri = this.uri(profileId);
    const key = uri.toString();
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(mutate(await this.read(profileId))));
      if (bytes.byteLength > MAX_CAMPAIGN_STORE_BYTES) throw new Error(`Campaign history exceeds the ${MAX_CAMPAIGN_STORE_BYTES} byte safety limit.`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, 'campaigns'));
      await vscode.workspace.fs.writeFile(uri, bytes);
    });
    const tail = current.then(() => undefined, () => undefined);
    queues.set(key, tail);
    await current.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  }

  private uri(profileId: string): vscode.Uri { return vscode.Uri.joinPath(this.root, 'campaigns', `${safeFilePart(profileId)}.json`); }
}

function sanitizeRun(value: unknown): CampaignRunRecordV1 | undefined {
  if (!object(value) || value.format !== CAMPAIGN_RUN_FORMAT || value.version !== CAMPAIGN_RUN_VERSION) return undefined;
  if (!safeId(value.id) || !safeId(value.campaignId) || !safeText(value.campaignName, 512) || !safeId(value.profileId) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt || !['planned', 'running', 'cancelled', 'completed'].includes(String(value.status)) || !safeDigest(value.sourceDigest)) return undefined;
  if (!object(value.plan) || !boundedInteger(value.plan.selectedCases, 0, 500) || !boundedInteger(value.plan.plannedAttempts, 0, 10_000) || !boundedInteger(value.plan.plannedTurns, 0, 100_000) || !boundedInteger(value.plan.plannedRequests, 0, 100_000) || !boundedInteger(value.plan.maximumDurationMs, 0, Number.MAX_SAFE_INTEGER) || !boundedInteger(value.plan.maxConcurrency, 1, 8)) return undefined;
  if (!Array.isArray(value.cases) || value.cases.length !== value.plan.selectedCases || value.cases.length > 500 || !object(value.coverage)) return undefined;
  const cases = value.cases.flatMap((item) => validCase(item) ? [sanitizeCampaignCase(item as CampaignRunRecordV1['cases'][number])] : []);
  if (cases.length !== value.cases.length || new Set(cases.map((item) => item.key)).size !== cases.length) return undefined;
  const coverage = sanitizeCoverage(value.coverage);
  if (!coverage) return undefined;
  const run: CampaignRunRecordV1 = {
    format: CAMPAIGN_RUN_FORMAT, version: CAMPAIGN_RUN_VERSION,
    id: value.id, campaignId: value.campaignId, campaignName: value.campaignName, profileId: value.profileId,
    createdAt: value.createdAt, updatedAt: value.updatedAt, status: value.status as CampaignRunRecordV1['status'], sourceDigest: value.sourceDigest,
    plan: { selectedCases: value.plan.selectedCases, plannedAttempts: value.plan.plannedAttempts, plannedTurns: value.plan.plannedTurns, plannedRequests: value.plan.plannedRequests, maximumDurationMs: value.plan.maximumDurationMs, maxConcurrency: value.plan.maxConcurrency },
    cases, coverage,
  };
  if (safeId(value.baselineRunId)) run.baselineRunId = value.baselineRunId;
  // Diff is derived again from stored runs by callers; reject untrusted persisted detail.
  return run;
}

function validCase(value: unknown): boolean {
  if (!object(value) || !safeText(value.key, 512) || !safeId(value.profileId) || !safeId(value.scenarioId) || !safeText(value.scenarioName, 512) || !Array.isArray(value.tags)) return false;
  if (!boundedInteger(value.requestedAttempts, 1, 10_000) || !boundedInteger(value.completedAttempts, 0, value.requestedAttempts) || !boundedInteger(value.plannedTurns, 0, 100_000) || typeof value.sampleComplete !== 'boolean' || value.sampleComplete !== (value.completedAttempts === value.requestedAttempts)) return false;
  if (value.outcome !== undefined && !['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError', 'passed', 'failed', 'error'].includes(String(value.outcome))) return false;
  if (value.stability !== undefined && !['stable-pass', 'stable-fail', 'unstable', 'inconclusive'].includes(String(value.stability))) return false;
  if (value.durationMs !== undefined && (!Number.isFinite(value.durationMs) || value.durationMs < 0)) return false;
  if (value.ttftP95Ms !== undefined && (!Number.isFinite(value.ttftP95Ms) || value.ttftP95Ms < 0)) return false;
  if (value.counts !== undefined) {
    if (!object(value.counts)) return false;
    const outcomes = ['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'];
    if (outcomes.some((outcome) => !boundedInteger(value.counts[outcome], 0, value.requestedAttempts))) return false;
    if (outcomes.reduce((sum, outcome) => sum + value.counts[outcome], 0) !== value.completedAttempts) return false;
  }
  return value.tags.length <= 100 && value.tags.every((tag) => safeText(tag, 64));
}

function sanitizeCoverage(value: Record<string, any>) {
  if (!Array.isArray(value.requiredTags) || !Array.isArray(value.coveredTags) || !Array.isArray(value.missingTags) || !object(value.caseCountByTag) || typeof value.percent !== 'number' || !Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100) return undefined;
  const arrays = [value.requiredTags, value.coveredTags, value.missingTags];
  if (arrays.some((items) => items.length > 100 || items.some((tag: unknown) => !safeText(tag, 64)))) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.caseCountByTag)) {
    if (!safeText(key, 64) || !boundedInteger(count, 0, 500)) return undefined;
    counts[key] = count as number;
  }
  return { requiredTags: [...value.requiredTags], coveredTags: [...value.coveredTags], missingTags: [...value.missingTags], caseCountByTag: counts, percent: value.percent };
}

function emptyStore(): CampaignStoreV1 { return { format: CAMPAIGN_STORE_FORMAT, version: CAMPAIGN_STORE_VERSION, runs: [], baselines: [] }; }
function isMissingFile(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  return value.code === 'FileNotFound' || value.code === 'ENOENT' || value.name === 'EntryNotFound (FileSystemError)' || /\bENOENT\b/.test(String(value.message ?? ''));
}
function object(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function safeDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function safeText(value: unknown, max: number): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= max; }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function boundedInteger(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function normalizeRetention(value: number): number { return Number.isSafeInteger(value) ? Math.max(1, Math.min(MAX_CAMPAIGN_RETENTION, value)) : DEFAULT_CAMPAIGN_RETENTION; }
function safeFilePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100) || 'profile'; }
