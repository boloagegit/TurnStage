import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { compareScenarioEvidence, isValidComparisonPath } from '../src/extension/testing/scenarioComparison';
import type { ScenarioRunEvidence } from '../src/shared/types';

function evidence(text: string, id: string, createdAt: number, title = 'Conversation'): ScenarioRunEvidence {
  const snapshot = createSnapshot(true);
  snapshot.sessionState = 'ready';
  snapshot.turnState = 'completed';
  snapshot.title = title;
  snapshot.messages = [{
    id,
    role: 'assistant',
    status: 'completed',
    createdAt,
    completedAt: createdAt + 10,
    parts: [{ type: 'text', text }],
    citations: [],
    actions: [],
    followups: [],
    metadata: { clientRequestId: `request-${id}` },
  }];
  snapshot.normalizedEvents = [{ version: 1, type: 'content.text.delta', sequence: createdAt, receivedAt: createdAt, rawSequence: createdAt, text }];
  return { profileId: 'profile', scenarioId: 'scenario', snapshot, networkEntries: [] };
}

describe('scenario semantic comparison', () => {
  it('ignores built-in dynamic ids and timestamps', () => {
    const result = compareScenarioEvidence(evidence('same', 'baseline-id', 100), evidence('same', 'candidate-id', 900), { baseline: {}, candidate: {} });

    expect(result.differenceCount).toBe(0);
    expect(result.checks).toEqual([expect.objectContaining({ id: 'comparison.semantic-equivalence', passed: true })]);
  });

  it('uses explicit ignore paths without hiding stable content changes', () => {
    const ignored = compareScenarioEvidence(evidence('baseline', 'a', 1, 'Old title'), evidence('candidate', 'b', 2, 'New title'), {
      baseline: {}, candidate: {}, ignorePaths: ['session.title', 'messages[*].parts', 'events.normalized[*].text'],
    });
    expect(ignored.differenceCount).toBe(0);

    const changed = compareScenarioEvidence(evidence('baseline', 'a', 1), evidence('candidate', 'b', 2), { baseline: {}, candidate: {} });
    expect(changed.differenceCount).toBeGreaterThan(0);
    expect(changed.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ passed: false, kind: 'comparison', location: expect.objectContaining({ kind: 'message' }) }),
    ]));
  });

  it('accepts only bounded semantic comparison paths', () => {
    expect(isValidComparisonPath('messages[*].parts[0].text')).toBe(true);
    expect(isValidComparisonPath('network[0].status')).toBe(true);
    expect(isValidComparisonPath('request.headers.authorization')).toBe(false);
    expect(isValidComparisonPath('__proto__.polluted')).toBe(false);
    expect(isValidComparisonPath('messages.__proto__.polluted')).toBe(false);
    expect(isValidComparisonPath(`messages.${'segment.'.repeat(30)}value`)).toBe(false);
  });
});
