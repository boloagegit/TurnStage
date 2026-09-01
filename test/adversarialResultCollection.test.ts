import { describe, expect, it } from 'vitest';
import type { AdversarialResultSummary } from '../src/shared/types';
import { filterAdversarialResults, normalizeAdversarialResultCollectionState } from '../src/webview/SettingsWorkspace';

function result(id: string, outcome: AdversarialResultSummary['outcome'], stability?: NonNullable<AdversarialResultSummary['repetitions']>['stability']): AdversarialResultSummary {
  return {
    profileId: 'profile', scenarioId: id, scenarioName: `Case ${id}`, outcome, durationMs: 10,
    attemptedTurns: 1, completedTurns: 1, plannedTurns: 1, findingCount: 0, issueCount: 0,
    evidenceId: `evidence-${id}`, primaryLocation: { kind: 'message' }, availableLocations: [],
    ...(stability ? { repetitions: { requestedAttempts: 2, completedAttempts: 2, skippedAttempts: 0, sampleComplete: true, stability, counts: { resisted: 2, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 } } } : {}),
  };
}

describe('adversarial result collection', () => {
  it('normalizes malformed and oversized persisted filters', () => {
    expect(normalizeAdversarialResultCollectionState({ query: 'x'.repeat(600), outcome: 'bad', stability: 'bad', page: 999, pageSize: 999 })).toEqual({ query: 'x'.repeat(512), outcome: 'all', stability: 'all', page: 19, pageSize: 25 });
  });

  it('filters by bounded identity text, outcome, and sample stability', () => {
    const results = [result('alpha', 'resisted', 'stable-pass'), result('beta', 'attackSucceeded', 'stable-fail'), result('gamma', 'indeterminate')];
    expect(filterAdversarialResults(results, { query: 'BETA', outcome: 'attackSucceeded', stability: 'stable-fail', page: 0, pageSize: 25 }).map((item) => item.scenarioId)).toEqual(['beta']);
    expect(filterAdversarialResults(results, { query: '', outcome: 'all', stability: 'single-run', page: 0, pageSize: 25 }).map((item) => item.scenarioId)).toEqual(['gamma']);
  });
});
