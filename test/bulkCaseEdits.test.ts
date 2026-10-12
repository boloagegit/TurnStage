import { describe, expect, it } from 'vitest';
import { applyCaseEdit, MAX_CASE_TAGS, planCaseEdits } from '../src/webview/bulkCaseEdits';
import type { ScenarioDefinition, TurnStageProfile } from '../src/shared/types';

const scenario = (id: string, extra: Partial<ScenarioDefinition> = {}): ScenarioDefinition => ({ id, name: id, steps: [{ id: 'turn', input: 'Hi' }], ...extra });

describe('bulk case edits', () => {
  it('applies each edit only when it changes the case', () => {
    expect(applyCaseEdit(scenario('a', { tags: ['x'] }), { type: 'tag', tag: ' y ' })).toMatchObject({ tags: ['x', 'y'] });
    expect(applyCaseEdit(scenario('a', { tags: ['x'] }), { type: 'tag', tag: 'x' })).toBeUndefined();
    expect(applyCaseEdit(scenario('a', { tags: Array.from({ length: MAX_CASE_TAGS }, (_, index) => `t${index}`) }), { type: 'tag', tag: 'new' })).toBeUndefined();
    expect(applyCaseEdit(scenario('a', { tags: ['needs-review', 'captured'], capture: { status: 'needsReview' } as ScenarioDefinition['capture'] }), { type: 'markReady' })).toMatchObject({ tags: ['captured'], capture: { status: 'ready' } });
    expect(applyCaseEdit(scenario('a'), { type: 'markReady' })).toBeUndefined();
    expect(applyCaseEdit(scenario('a'), { type: 'delete' })).toBe('delete');
  });

  it('patches Profile cases once and queues linked cases one by one', () => {
    const profile = { id: 'p', tests: { scenarios: [scenario('keep'), scenario('drop'), scenario('red', { adversarial: { forbid: {} } } as Partial<ScenarioDefinition>)] } } as unknown as TurnStageProfile;
    const plan = planCaseEdits(profile, [
      { profileId: 'p', kind: 'contract', scenarioId: 'drop' },
      { profileId: 'p', kind: 'contract', scenarioId: 'gone' },
      { profileId: 'p', kind: 'contract', suiteId: 'suite', scenarioId: 'linked' },
      { profileId: 'p', kind: 'contract', suiteId: 'suite', scenarioId: 'missing' },
    ], { type: 'delete' }, { contract: { entries: [{ sourcePath: 'tests/s.tests.jsonc', suiteId: 'suite', scenarioId: 'linked' }], total: 1, truncated: false, issues: [] } as never });
    expect(plan.inlineScenarios?.map((item) => item.id)).toEqual(['keep', 'red']);
    expect(plan.inlineChanged).toEqual([{ profileId: 'p', kind: 'contract', scenarioId: 'drop' }]);
    expect(plan.jobs).toEqual([{ kind: 'contract', sourcePath: 'tests/s.tests.jsonc', scenarioId: 'linked', identity: { profileId: 'p', kind: 'contract', suiteId: 'suite', scenarioId: 'linked' } }]);
    expect(plan.missing).toBe(2);
  });

  it('does not touch a Red Team case that shares an id with a General case', () => {
    const profile = { id: 'p', tests: { scenarios: [scenario('same', { adversarial: { forbid: {} } } as Partial<ScenarioDefinition>)] } } as unknown as TurnStageProfile;
    const plan = planCaseEdits(profile, [{ profileId: 'p', kind: 'contract', scenarioId: 'same' }], { type: 'tag', tag: 'x' }, {});
    expect(plan.inlineScenarios).toBeUndefined();
    expect(plan.missing).toBe(1);
  });
});
