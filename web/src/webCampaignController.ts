import type { HostPayload } from '../../src/shared/protocol';
import type { AdversarialOutcome, CampaignBaselineV1, CampaignCaseOutcome, CampaignCaseResultV1, CampaignDashboardV1, CampaignRunRecordV1, TurnStageProfile } from '../../src/shared/types';
import { attachCampaignBaseline, createCampaignPlan, createCampaignRunRecord, type CampaignCaseInput } from '../../src/extension/testing/campaign';
import { serializeCampaignResultsJsonl } from '../../src/extension/testing/adversarialJsonl';
import { isScenarioReady } from '../../src/extension/testing/scenarioCapture';
import { ArtifactStore } from './artifactStore';
import { WebTestController, webCaseUnsupportedReason, type WebScenarioEntry } from './webTestController';
import { browserUuid } from './browserCrypto';
import { resolveWebTestConcurrency } from '../../src/shared/testConcurrency';

export class WebCampaignController {
  private readonly store = new ArtifactStore();
  private readonly cancelled = new Set<string>();
  private readonly activeCases = new Map<string, number>();
  private readonly runningCampaigns = new Set<string>();

  constructor(private readonly profile: () => TurnStageProfile, private readonly tests: WebTestController, private readonly post: (payload: HostPayload, requestId?: string) => void) {}

  async postDashboard(): Promise<void> {
    const profile = this.profile();
    const stored = await this.store.list<CampaignRunRecordV1 | CampaignBaselineV1>('campaigns', profile.id);
    const campaigns: CampaignDashboardV1['campaigns'] = (profile.tests?.campaigns ?? []).map((definition) => {
      const runs = stored.filter((item) => item.kind === `campaign-run:${definition.id}`).map((item) => item.value as CampaignRunRecordV1).sort((left, right) => right.updatedAt - left.updatedAt);
      const baseline = stored.find((item) => item.kind === `campaign-baseline:${definition.id}`)?.value as CampaignBaselineV1 | undefined;
      const baselineRun = baseline ? runs.find((run) => run.id === baseline.runId) : undefined;
      const latest = runs[0];
      const activeCaseCount = latest ? this.activeCases.get(latest.id) : undefined;
      return { definition: structuredClone(definition), ...(latest ? { latest: baselineRun && latest.id !== baselineRun.id ? attachCampaignBaseline(latest, baselineRun) : latest } : {}), ...(baseline ? { baseline } : {}), ...(activeCaseCount === undefined ? {} : { activeCaseCount }) };
    });
    this.post({ type: 'campaign.dashboard', dashboard: { profileId: profile.id, campaigns } });
  }

  async preview(campaignId: string): Promise<void> {
    const { plan } = await this.prepare(campaignId);
    this.post({ type: 'campaign.preview', campaignId, selectedCases: plan.batch.selectedCases, plannedAttempts: plan.batch.plannedAttempts, plannedRequests: plan.batch.plannedRequests, maximumDurationMs: plan.batch.maximumDurationMs, maxConcurrency: plan.batch.maxConcurrency, warnings: plan.batch.issues.map((item) => item.message) });
  }

  async run(campaignId: string, resumeRunId?: string): Promise<void> {
    if (this.runningCampaigns.has(campaignId)) throw new Error('This campaign is already running.');
    this.runningCampaigns.add(campaignId);
    this.cancelled.delete(campaignId);
    try { await this.executeRun(campaignId, resumeRunId); }
    finally {
      this.runningCampaigns.delete(campaignId);
      this.cancelled.delete(campaignId);
    }
  }

  private async executeRun(campaignId: string, resumeRunId?: string): Promise<void> {
    const context = this.tests.captureRunContext();
    const { profile } = context;
    const { plan, entries } = await this.prepare(campaignId, profile);
    if (this.profile().id !== profile.id) throw new Error('The active profile changed before this campaign. No request was sent.');
    if (!plan.batch.valid || !plan.batch.withinBudget) throw new Error(plan.batch.issues.map((item) => item.message).join('\n'));
    for (const selected of plan.selected) {
      const scenario = entries.find((entry) => entry.itemId === selected.itemId)?.scenario;
      const reason = scenario && webCaseUnsupportedReason(scenario);
      if (reason) throw new Error(reason);
    }
    let record = resumeRunId ? await this.getRun(resumeRunId) : undefined;
    if (resumeRunId && !record) throw new Error('The browser-local campaign run to resume was not found.');
    if (record && (record.campaignId !== campaignId || record.sourceDigest !== plan.sourceDigest)) throw new Error('The saved campaign no longer matches the current profile or selectors.');
    record ??= createCampaignRunRecord(plan, profile.id, { id: browserUuid() });
    record = { ...record, plan: { ...record.plan, maxConcurrency: plan.batch.maxConcurrency }, status: 'running', updatedAt: Date.now() };
    await this.saveRun(record);
    await this.postDashboard();
    const byItemId = new Map(entries.map((item) => [item.itemId, item]));
    const pending = [...plan.batch.cases].filter((item) => !record!.cases.find((candidate) => candidate.key === item.key)?.sampleComplete);
    const runId = record.id;
    let activeCaseCount = 0;
    const workers = Array.from({ length: Math.min(plan.batch.maxConcurrency, pending.length) }, async () => {
      while (pending.length && !this.cancelled.has(campaignId)) {
        const item = pending.shift();
        if (!item) return;
        const entry = byItemId.get(item.id);
        if (!entry) continue;
        const attempts = [];
        const attemptEntry = entry.scenario.adversarial ? { ...entry, scenario: { ...entry.scenario, adversarial: { ...entry.scenario.adversarial, repetitions: 1 } } } : entry;
        this.activeCases.set(runId, ++activeCaseCount);
        try {
          await this.postDashboard();
          for (let index = 0; index < item.requestedAttempts && !this.cancelled.has(campaignId); index += 1) attempts.push(await this.tests.executeScenario(attemptEntry, false, context));
          const current = summarize(entry, item.requestedAttempts, attempts.map((attempt) => attempt.result));
          record = { ...record!, updatedAt: Date.now(), cases: record!.cases.map((candidate) => candidate.key === current.key ? current : candidate) };
          await this.saveRun(record);
        } finally {
          this.activeCases.set(runId, --activeCaseCount);
        }
        await this.postDashboard();
      }
    });
    const settled = await Promise.allSettled(workers);
    this.activeCases.delete(runId);
    const failure = settled.find((result) => result.status === 'rejected');
    record = { ...record, status: failure || this.cancelled.has(campaignId) || record.cases.some((item) => !item.sampleComplete) ? 'cancelled' : 'completed', updatedAt: Date.now() };
    const baseline = await this.getBaseline(campaignId);
    const baselineRun = baseline ? await this.getRun(baseline.runId) : undefined;
    if (baselineRun && baselineRun.id !== record.id) record = attachCampaignBaseline(record, baselineRun);
    await this.saveRun(record);
    await this.postDashboard();
    if (failure) throw failure.reason;
  }

  cancel(campaignId: string): void { this.cancelled.add(campaignId); }

  async acceptBaseline(campaignId: string, runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run || run.campaignId !== campaignId || run.status !== 'completed') throw new Error('Only a completed run from this campaign can be accepted as baseline.');
    const baseline: CampaignBaselineV1 = { campaignId, runId, acceptedAt: Date.now(), sourceDigest: run.sourceDigest };
    await this.store.put('campaigns', { id: `baseline:${run.profileId}:${campaignId}`, profileId: run.profileId, kind: `campaign-baseline:${campaignId}`, name: run.campaignName, updatedAt: baseline.acceptedAt, value: baseline });
    await this.postDashboard();
  }

  async exportResults(campaignId: string, runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run || run.campaignId !== campaignId) throw new Error('The browser-local campaign run was not found.');
    const name = `turnstage-campaign-${campaignId}-${runId}.jsonl`;
    download(name, serializeCampaignResultsJsonl(run), 'application/x-ndjson');
    this.post({ type: 'campaign.exported', path: name, artifactId: runId });
  }

  private async prepare(campaignId: string, profile = structuredClone(this.profile())): Promise<{ plan: ReturnType<typeof createCampaignPlan>; entries: WebScenarioEntry[] }> {
    const definition = profile.tests?.campaigns?.find((item) => item.id === campaignId);
    if (!definition) throw new Error(`Campaign ${campaignId} is not defined in this profile.`);
    const limit = resolveWebTestConcurrency(profile.tests?.runPolicy, definition.runPolicy?.maxConcurrency);
    const entries = (await this.tests.scenarioEntries(profile)).filter((item) => isScenarioReady(item.scenario));
    const cases: CampaignCaseInput[] = entries.map((item) => ({ key: item.key, itemId: item.itemId, profileId: profile.id, suiteId: item.suiteId, scenarioId: item.scenario.id, scenarioName: item.scenario.name, tags: item.scenario.tags, adversarial: Boolean(item.scenario.adversarial), repetitions: item.scenario.adversarial?.repetitions, plannedTurns: item.scenario.steps.length, requestsPerAttempt: item.scenario.steps.length, timeoutMs: item.scenario.adversarial?.timeoutMs }));
    return { plan: createCampaignPlan(definition, cases, undefined, limit), entries };
  }

  private async saveRun(run: CampaignRunRecordV1): Promise<void> { await this.store.put('campaigns', { id: `run:${run.profileId}:${run.id}`, profileId: run.profileId, kind: `campaign-run:${run.campaignId}`, name: run.campaignName, updatedAt: run.updatedAt, value: run }); }
  private async getRun(runId: string): Promise<CampaignRunRecordV1 | undefined> { return (await this.store.list<CampaignRunRecordV1>('campaigns', this.profile().id)).find((item) => item.id === `run:${this.profile().id}:${runId}`)?.value; }
  private async getBaseline(campaignId: string): Promise<CampaignBaselineV1 | undefined> { return (await this.store.list<CampaignBaselineV1>('campaigns', this.profile().id)).find((item) => item.kind === `campaign-baseline:${campaignId}`)?.value; }
}

function summarize(entry: WebScenarioEntry, requestedAttempts: number, results: Array<{ passed: boolean; durationMs: number; adversarial?: { outcome: AdversarialOutcome }; evidence: { snapshot: { metrics: { ttft?: number } } } }>): CampaignCaseResultV1 {
  const outcomes: CampaignCaseOutcome[] = results.map((result) => result.adversarial?.outcome ?? (result.passed ? 'passed' : 'failed'));
  const counts = outcomes.reduce<Record<string, number>>((values, outcome) => ({ ...values, [outcome]: (values[outcome] ?? 0) + 1 }), {});
  const outcome = worstOutcome(outcomes);
  const stable = new Set(outcomes).size === 1;
  return { key: entry.key, profileId: entry.key.split('/')[0]!, ...(entry.suiteId ? { suiteId: entry.suiteId } : {}), scenarioId: entry.scenario.id, scenarioName: entry.scenario.name, tags: entry.scenario.tags ?? [], requestedAttempts, completedAttempts: results.length, plannedTurns: entry.scenario.steps.length, outcome, ...(entry.scenario.adversarial ? { stability: results.length < requestedAttempts ? 'inconclusive' : stable ? outcome === 'resisted' ? 'stable-pass' : 'stable-fail' : 'unstable', counts: counts as Record<AdversarialOutcome, number> } : {}), sampleComplete: results.length === requestedAttempts, durationMs: results.reduce((sum, result) => sum + result.durationMs, 0), ttftP95Ms: percentile95(results.flatMap((result) => result.evidence.snapshot.metrics.ttft === undefined ? [] : [result.evidence.snapshot.metrics.ttft])) };
}

function worstOutcome(outcomes: CampaignCaseOutcome[]): CampaignCaseOutcome | undefined { return outcomes.sort((left, right) => severity(right) - severity(left))[0]; }
function severity(value: CampaignCaseOutcome): number { return value === 'attackSucceeded' || value === 'failed' ? 4 : value === 'infrastructureError' || value === 'error' ? 3 : value === 'indeterminate' ? 2 : 1; }
function percentile95(values: number[]): number | undefined { if (!values.length) return undefined; const sorted = values.sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)]; }
function download(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
