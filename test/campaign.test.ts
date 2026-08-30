import { describe, expect, it } from 'vitest';
import type { CampaignCaseResultV1, TestCampaignDefinition } from '../src/shared/types';
import { attachCampaignBaseline, compareCampaignRuns, createCampaignPlan, createCampaignRunRecord, selectCampaignCases, type CampaignCaseInput } from '../src/extension/testing/campaign';

const cases: CampaignCaseInput[] = [
  { key: 'demo/inline/basic', itemId: 'basic-item', profileId: 'demo', scenarioId: 'basic', scenarioName: 'Basic', tags: ['smoke'], riskTags: ['quality'], plannedTurns: 1, repetitions: 1 },
  { key: 'demo/red/jailbreak', itemId: 'jailbreak-item', profileId: 'demo', suiteId: 'red', scenarioId: 'jailbreak', scenarioName: 'Jailbreak', tags: ['security'], riskTags: ['prompt-boundary'], adversarial: true, plannedTurns: 3, repetitions: 2, timeoutMs: 10_000 },
  { key: 'demo/red/leak', itemId: 'leak-item', profileId: 'demo', suiteId: 'red', scenarioId: 'leak', scenarioName: 'Leak', tags: ['security', 'privacy'], adversarial: true, plannedTurns: 2 },
];

function definition(overrides: Partial<TestCampaignDefinition> = {}): TestCampaignDefinition {
  return { id: 'release', name: 'Release safety', coverageTags: ['security', 'prompt-boundary', 'missing'], ...overrides };
}

describe('test campaigns', () => {
  it('selects deterministically across ids, suites, and tag modes', () => {
    expect(selectCampaignCases(definition({ selectors: { suiteIds: ['red'], tags: ['security', 'privacy'], tagMode: 'all' } }), cases).map((item) => item.scenarioId)).toEqual(['leak']);
    expect(selectCampaignCases(definition({ selectors: { caseIds: ['jailbreak-item'] } }), cases).map((item) => item.scenarioId)).toEqual(['jailbreak']);
  });

  it('builds a bounded plan without expanding repeated attempts and reports coverage gaps', () => {
    const campaign = definition({ runPolicy: { repetitions: 5, maxConcurrency: 2, maxRequests: 100 } });
    const plan = createCampaignPlan(campaign, cases);
    expect(plan.batch).toMatchObject({ selectedCases: 3, plannedAttempts: 11, maxConcurrency: 2, valid: true, withinBudget: true });
    expect(plan.batch.cases).toHaveLength(3);
    expect(plan.coverage).toMatchObject({ coveredTags: ['prompt-boundary', 'security'], missingTags: ['missing'], percent: 66.67 });
    expect(plan.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a campaign exceeds its request budget', () => {
    const plan = createCampaignPlan(definition({ runPolicy: { repetitions: 10, maxRequests: 10 } }), cases);
    expect(plan.batch.withinBudget).toBe(false);
    expect(plan.batch.issues).toContainEqual(expect.objectContaining({ code: 'request-cap' }));
  });

  it('fails closed and reports zero coverage when selectors match no cases', () => {
    const plan = createCampaignPlan(definition({ selectors: { caseIds: ['missing-case'] } }), cases);
    expect(plan.batch).toMatchObject({ selectedCases: 0, valid: false, withinBudget: false });
    expect(plan.batch.issues).toContainEqual(expect.objectContaining({ code: 'selection', message: expect.stringContaining('selected no test cases') }));
    expect(plan.coverage).toMatchObject({ coveredTags: [], percent: 0 });
  });

  it('classifies resistant-to-attack as a regression and ignores evidence ids in metadata copies', () => {
    const plan = createCampaignPlan(definition(), cases.slice(0, 2));
    const baseCases: CampaignCaseResultV1[] = plan.selected.map((item) => result(item, 'resisted', 'evidence-secret'));
    const currentCases = [result(plan.selected[0]!, 'passed'), result(plan.selected[1]!, 'attackSucceeded')];
    const baseline = { ...createCampaignRunRecord(plan, 'demo', { id: 'base', now: 1, status: 'completed', cases: baseCases }), status: 'completed' as const };
    const current = { ...createCampaignRunRecord(plan, 'demo', { id: 'current', now: 2, status: 'completed', cases: currentCases }), status: 'completed' as const };
    const diff = compareCampaignRuns(baseline, current);
    expect(diff).toMatchObject({ regressions: 1, improvements: 0, changed: 1 });
    expect(diff.entries.find((item) => item.scenarioId === 'jailbreak')).toMatchObject({ transition: 'regressed', baselineOutcome: 'resisted', currentOutcome: 'attackSucceeded' });
    expect(baseline.cases[0]).not.toHaveProperty('evidenceId');
    expect(attachCampaignBaseline(current, baseline)).toMatchObject({ baselineRunId: 'base', diff: { regressions: 1 } });
  });

  it('rejects a baseline from another campaign', () => {
    const plan = createCampaignPlan(definition(), cases.slice(0, 1));
    const otherPlan = createCampaignPlan(definition({ id: 'other' }), cases.slice(0, 1));
    const current = createCampaignRunRecord(plan, 'demo', { id: 'current' });
    const baseline = createCampaignRunRecord(otherPlan, 'demo', { id: 'base' });
    expect(() => attachCampaignBaseline(current, baseline)).toThrow('different profile or campaign');
  });

  it('plans 500 cases at the aggregate safety ceiling without expanding 10,000 attempts', () => {
    const bulk = Array.from({ length: 500 }, (_, index): CampaignCaseInput => ({ key: `demo/red/case-${index}`, itemId: `item-${index}`, profileId: 'demo', suiteId: 'red', scenarioId: `case-${index}`, scenarioName: `Case ${index}`, adversarial: true, tags: ['bulk'], plannedTurns: 10, requestsPerAttempt: 10, timeoutMs: 1000 }));
    const startedAt = performance.now();
    const plan = createCampaignPlan(definition({ runPolicy: { repetitions: 20, maxConcurrency: 8, maxRequests: 100_000, maxDurationMs: 10_000_000 } }), bulk);
    expect(plan.batch).toMatchObject({ selectedCases: 500, plannedAttempts: 10_000, plannedRequests: 100_000, valid: true, withinBudget: true });
    expect(plan.batch.cases).toHaveLength(500);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});

function result(item: CampaignCaseInput, outcome: CampaignCaseResultV1['outcome'], evidenceId?: string): CampaignCaseResultV1 {
  return {
    key: item.key, profileId: item.profileId, suiteId: item.suiteId, scenarioId: item.scenarioId, scenarioName: item.scenarioName,
    tags: [...(item.tags ?? [])], requestedAttempts: item.repetitions ?? 1, completedAttempts: item.repetitions ?? 1, plannedTurns: item.plannedTurns,
    outcome, sampleComplete: true, evidenceId,
  };
}
