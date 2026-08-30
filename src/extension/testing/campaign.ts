import type {
  CampaignCaseOutcome,
  CampaignCaseResultV1,
  CampaignCoverageV1,
  CampaignDiffEntryV1,
  CampaignDiffV1,
  CampaignRunRecordV1,
  TestCampaignDefinition,
} from '../../shared/types';
import { createBatchRunPlan, type BatchProgressV1, type BatchRunPlanV1 } from './batchRun';
import { digestValue } from './provenance';

export const CAMPAIGN_RUN_FORMAT = 'turnstage-campaign-run' as const;
export const CAMPAIGN_RUN_VERSION = 1 as const;
export const MAX_CAMPAIGNS_PER_PROFILE = 50;
export const MAX_CAMPAIGN_COVERAGE_TAGS = 100;

export interface CampaignCaseInput {
  key: string;
  itemId: string;
  profileId: string;
  suiteId?: string;
  scenarioId: string;
  scenarioName: string;
  tags?: readonly string[];
  riskTags?: readonly string[];
  adversarial?: boolean;
  repetitions?: number;
  plannedTurns: number;
  requestsPerAttempt?: number;
  timeoutMs?: number;
}

export interface CampaignPlanV1 {
  campaign: TestCampaignDefinition;
  sourceDigest: string;
  batch: BatchRunPlanV1;
  selected: CampaignCaseInput[];
  coverage: CampaignCoverageV1;
}

export function createCampaignPlan(
  campaign: TestCampaignDefinition,
  cases: readonly CampaignCaseInput[],
  progress?: BatchProgressV1,
): CampaignPlanV1 {
  const selected = selectCampaignCases(campaign, cases);
  const repetitions = campaign.runPolicy?.repetitions;
  const batch = createBatchRunPlan(selected.map((item) => ({
    id: item.itemId,
    key: item.key,
    profileId: item.profileId,
    suiteId: item.suiteId,
    tags: combinedTags(item),
    requestedAttempts: item.adversarial ? repetitions ?? item.repetitions ?? 1 : 1,
    turnsPerAttempt: item.plannedTurns,
    requestsPerAttempt: item.requestsPerAttempt ?? item.plannedTurns,
    timeoutMs: item.timeoutMs ?? 120_000,
  })), {
    planKey: `campaign:${campaign.id}`,
    progress,
    maxConcurrency: campaign.runPolicy?.maxConcurrency,
    maxRequests: campaign.runPolicy?.maxRequests,
    maxDurationMs: campaign.runPolicy?.maxDurationMs,
  });
  const executableBatch: BatchRunPlanV1 = selected.length > 0 ? batch : {
    ...batch,
    valid: false,
    withinBudget: false,
    issues: [...batch.issues, {
      code: 'selection',
      message: 'The campaign selected no test cases. Check its case, suite, and tag selectors.',
    }],
  };
  const sourceDigest = digestValue({
    campaign: canonicalCampaign(campaign),
    cases: selected.map((item) => ({
      key: item.key,
      profileId: item.profileId,
      suiteId: item.suiteId,
      scenarioId: item.scenarioId,
      tags: combinedTags(item),
      repetitions: item.adversarial ? repetitions ?? item.repetitions ?? 1 : 1,
      plannedTurns: item.plannedTurns,
    })),
  });
  return { campaign, sourceDigest, batch: executableBatch, selected, coverage: createCampaignCoverage(campaign.coverageTags ?? [], selected) };
}

export function selectCampaignCases(campaign: TestCampaignDefinition, cases: readonly CampaignCaseInput[]): CampaignCaseInput[] {
  const selectors = campaign.selectors;
  const caseIds = new Set(selectors?.caseIds ?? []);
  const suiteIds = new Set(selectors?.suiteIds ?? []);
  const tags = selectors?.tags ?? [];
  return cases.filter((item) => {
    if (caseIds.size && !caseIds.has(item.scenarioId) && !caseIds.has(item.key) && !caseIds.has(item.itemId)) return false;
    if (suiteIds.size && (!item.suiteId || !suiteIds.has(item.suiteId))) return false;
    if (tags.length) {
      const available = new Set(combinedTags(item));
      const matches = selectors?.tagMode === 'any' ? tags.some((tag) => available.has(tag)) : tags.every((tag) => available.has(tag));
      if (!matches) return false;
    }
    return true;
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function createCampaignCoverage(requiredTags: readonly string[], cases: readonly CampaignCaseInput[]): CampaignCoverageV1 {
  const required = uniqueTags(requiredTags).slice(0, MAX_CAMPAIGN_COVERAGE_TAGS);
  const counts: Record<string, number> = {};
  for (const item of cases) for (const tag of combinedTags(item)) counts[tag] = (counts[tag] ?? 0) + 1;
  const coveredTags = required.filter((tag) => (counts[tag] ?? 0) > 0);
  const missingTags = required.filter((tag) => !coveredTags.includes(tag));
  return {
    requiredTags: required,
    coveredTags,
    missingTags,
    caseCountByTag: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    percent: cases.length === 0 ? 0 : required.length ? Math.round((coveredTags.length / required.length) * 10_000) / 100 : 100,
  };
}

export function createCampaignRunRecord(
  plan: CampaignPlanV1,
  profileId: string,
  options: { id: string; now?: number; status?: CampaignRunRecordV1['status']; cases?: CampaignCaseResultV1[] } ,
): CampaignRunRecordV1 {
  const now = options.now ?? Date.now();
  const byKey = new Map((options.cases ?? []).map((item) => [item.key, item]));
  const cases = plan.selected.map((item) => {
    const existing = byKey.get(item.key);
    return existing ? sanitizeCampaignCase(existing) : {
      key: item.key,
      profileId: item.profileId,
      ...(item.suiteId ? { suiteId: item.suiteId } : {}),
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName,
      tags: combinedTags(item),
      requestedAttempts: item.adversarial ? plan.campaign.runPolicy?.repetitions ?? item.repetitions ?? 1 : 1,
      completedAttempts: 0,
      plannedTurns: item.plannedTurns,
      sampleComplete: false,
    };
  });
  return {
    format: CAMPAIGN_RUN_FORMAT,
    version: CAMPAIGN_RUN_VERSION,
    id: options.id,
    campaignId: plan.campaign.id,
    campaignName: plan.campaign.name,
    profileId,
    createdAt: now,
    updatedAt: now,
    status: options.status ?? 'planned',
    sourceDigest: plan.sourceDigest,
    plan: {
      selectedCases: plan.batch.selectedCases,
      plannedAttempts: plan.batch.plannedAttempts,
      plannedTurns: plan.batch.plannedTurns,
      plannedRequests: plan.batch.plannedRequests,
      maximumDurationMs: plan.batch.maximumDurationMs,
      maxConcurrency: plan.batch.maxConcurrency,
    },
    cases,
    coverage: plan.coverage,
  };
}

export function compareCampaignRuns(baseline: CampaignRunRecordV1, current: CampaignRunRecordV1): CampaignDiffV1 {
  const baselineCases = new Map(baseline.cases.map((item) => [item.key, item]));
  const currentCases = new Map(current.cases.map((item) => [item.key, item]));
  const keys = [...new Set([...baselineCases.keys(), ...currentCases.keys()])].sort();
  const entries: CampaignDiffEntryV1[] = keys.map((key) => {
    const before = baselineCases.get(key);
    const after = currentCases.get(key);
    const common = after ?? before!;
    const transition = classifyTransition(before?.outcome, after?.outcome, Boolean(before), Boolean(after));
    return {
      key,
      profileId: common.profileId,
      ...(common.suiteId ? { suiteId: common.suiteId } : {}),
      scenarioId: common.scenarioId,
      scenarioName: common.scenarioName,
      ...(before?.outcome ? { baselineOutcome: before.outcome } : {}),
      ...(after?.outcome ? { currentOutcome: after.outcome } : {}),
      transition,
    };
  });
  return {
    baselineRunId: baseline.id,
    currentRunId: current.id,
    regressions: entries.filter((item) => item.transition === 'regressed').length,
    improvements: entries.filter((item) => item.transition === 'improved').length,
    changed: entries.filter((item) => item.transition !== 'unchanged').length,
    entries,
  };
}

export function attachCampaignBaseline(current: CampaignRunRecordV1, baseline: CampaignRunRecordV1): CampaignRunRecordV1 {
  if (current.campaignId !== baseline.campaignId || current.profileId !== baseline.profileId) throw new Error('Campaign baseline belongs to a different profile or campaign.');
  return { ...current, baselineRunId: baseline.id, diff: compareCampaignRuns(baseline, current) };
}

export function sanitizeCampaignCase(value: CampaignCaseResultV1): CampaignCaseResultV1 {
  return {
    key: value.key.slice(0, 512),
    profileId: value.profileId.slice(0, 256),
    ...(value.suiteId ? { suiteId: value.suiteId.slice(0, 256) } : {}),
    scenarioId: value.scenarioId.slice(0, 256),
    scenarioName: value.scenarioName.slice(0, 512),
    tags: uniqueTags(value.tags).slice(0, 100),
    requestedAttempts: value.requestedAttempts,
    completedAttempts: value.completedAttempts,
    plannedTurns: value.plannedTurns,
    ...(value.outcome ? { outcome: value.outcome } : {}),
    ...(value.stability ? { stability: value.stability } : {}),
    sampleComplete: value.sampleComplete,
    ...(value.counts ? { counts: { ...value.counts } } : {}),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
    ...(value.ttftP95Ms !== undefined ? { ttftP95Ms: value.ttftP95Ms } : {}),
  };
}

function classifyTransition(before: CampaignCaseOutcome | undefined, after: CampaignCaseOutcome | undefined, hadBefore: boolean, hasAfter: boolean): CampaignDiffEntryV1['transition'] {
  if (!hadBefore && hasAfter) return 'added';
  if (hadBefore && !hasAfter) return 'removed';
  if (before === after || outcomeClass(before) === outcomeClass(after)) return 'unchanged';
  const beforeSeverity = outcomeSeverity(before);
  const afterSeverity = outcomeSeverity(after);
  if (afterSeverity > beforeSeverity) return 'regressed';
  if (afterSeverity < beforeSeverity) return 'improved';
  return 'changed';
}

function outcomeClass(value: CampaignCaseOutcome | undefined): string | undefined {
  if (value === 'resisted' || value === 'passed') return 'pass';
  if (value === 'attackSucceeded' || value === 'failed') return 'failure';
  if (value === 'infrastructureError' || value === 'error') return 'infrastructure';
  return value;
}

function outcomeSeverity(value: CampaignCaseOutcome | undefined): number {
  if (value === 'resisted' || value === 'passed') return 0;
  if (value === 'indeterminate') return 1;
  if (value === 'infrastructureError') return 2;
  if (value === 'attackSucceeded' || value === 'failed') return 3;
  if (value === 'error') return 2;
  return 1;
}

function combinedTags(item: CampaignCaseInput): string[] { return uniqueTags([...(item.tags ?? []), ...(item.riskTags ?? [])]); }
function uniqueTags(values: readonly string[]): string[] { return [...new Set(values.filter((value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 64))].sort(); }
function canonicalCampaign(value: TestCampaignDefinition): unknown {
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    selectors: value.selectors ? {
      caseIds: [...(value.selectors.caseIds ?? [])].sort(),
      suiteIds: [...(value.selectors.suiteIds ?? [])].sort(),
      tags: [...(value.selectors.tags ?? [])].sort(),
      tagMode: value.selectors.tagMode ?? 'all',
    } : undefined,
    runPolicy: value.runPolicy,
    coverageTags: [...(value.coverageTags ?? [])].sort(),
  };
}
