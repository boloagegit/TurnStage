import { describe, expect, it } from 'vitest';
import type { AdversarialSuiteDefinition, CampaignRunRecordV1 } from '../src/shared/types';
import { parseAdversarialJsonl, parseCampaignResultsJsonl, serializeAdversarialJsonl, serializeCampaignResultsJsonl } from '../src/extension/testing/adversarialJsonl';

const suite: AdversarialSuiteDefinition = {
  format: 'turnstage-adversarial-suite', version: 1, id: 'bulk', name: 'Bulk',
  cases: [{ id: 'multi', name: 'Multi', mode: 'multiTurn', maxTurns: 2, timeoutMs: 10_000, forbid: { urls: true }, turns: [{ id: 'one', input: 'one' }, { id: 'two', input: 'two' }] }],
};

const run: CampaignRunRecordV1 = {
  format: 'turnstage-campaign-run', version: 1, id: 'run', campaignId: 'release', campaignName: 'Release', profileId: 'demo', createdAt: 1, updatedAt: 2, status: 'completed', sourceDigest: 'a'.repeat(64),
  plan: { selectedCases: 1, plannedAttempts: 2, plannedTurns: 4, plannedRequests: 4, maximumDurationMs: 20_000, maxConcurrency: 2 },
  cases: [{ key: 'demo/red/multi', profileId: 'demo', suiteId: 'red', scenarioId: 'multi', scenarioName: 'Multi', tags: ['security'], requestedAttempts: 2, completedAttempts: 2, plannedTurns: 4, outcome: 'resisted', stability: 'stable-pass', sampleComplete: true, counts: { resisted: 2, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 }, evidenceId: 'private' }],
  coverage: { requiredTags: ['security'], coveredTags: ['security'], missingTags: [], caseCountByTag: { security: 1 }, percent: 100 },
};

describe('adversarial JSONL', () => {
  it('round trips multi-turn suites with one case per line', () => {
    const text = serializeAdversarialJsonl(suite);
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(parseAdversarialJsonl(text)).toEqual({ suite, issues: [] });
  });

  it('reports a precise malformed line without accepting partial data', () => {
    const text = `${serializeAdversarialJsonl(suite)}{bad}\n`;
    const parsed = parseAdversarialJsonl(text);
    expect(parsed.suite).toBeUndefined();
    expect(parsed.issues).toContainEqual({ line: 3, message: 'Record is not valid JSON.' });
  });

  it('round trips sanitized campaign results and omits ephemeral evidence ids', () => {
    const text = serializeCampaignResultsJsonl(run);
    expect(text).not.toContain('private');
    const parsed = parseCampaignResultsJsonl(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.run).toMatchObject({ id: 'run', cases: [{ outcome: 'resisted' }] });
    expect(parsed.run?.cases[0]).not.toHaveProperty('evidenceId');
  });

  it('rejects oversized inputs before parsing', () => {
    expect(parseAdversarialJsonl('x'.repeat(5 * 1024 * 1024 + 1)).issues[0]?.message).toContain('5 MB');
  });

  it('rejects malformed untrusted result records instead of throwing', () => {
    const lines = serializeCampaignResultsJsonl(run).trim().split('\n');
    lines[1] = JSON.stringify({ type: 'result', result: { key: { nested: true }, requestedAttempts: 1 } });
    expect(() => parseCampaignResultsJsonl(`${lines.join('\n')}\n`)).not.toThrow();
    expect(parseCampaignResultsJsonl(`${lines.join('\n')}\n`).issues).toContainEqual(expect.objectContaining({ line: 2, message: expect.stringContaining('bounded result') }));
  });
});
