import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { createScenarioReport, serializeScenarioJson, serializeScenarioJUnit, type ScenarioExecutionRecord } from '../src/extension/testing/scenarioReport';
import type { ScenarioRunResult } from '../src/shared/types';

function record(status: ScenarioExecutionRecord['status'] = 'failed'): ScenarioExecutionRecord {
  const snapshot = createSnapshot(true);
  snapshot.rawEvents = [{ sequence: 1, receivedAt: 1, elapsedMs: 1, protocol: 'sse', raw: 'Bearer CI_SECRET_SHOULD_NOT_LEAK', data: 'CI_SECRET_SHOULD_NOT_LEAK' }];
  const result: ScenarioRunResult = {
    scenarioId: 'scenario', passed: status === 'passed', durationMs: 123, steps: [],
    checks: [{ id: 'assertion.safe-id', label: 'Contains CI_SECRET_SHOULD_NOT_LEAK', passed: false, kind: 'assertion', actual: 'CI_SECRET_SHOULD_NOT_LEAK', expected: 'private', location: { kind: 'rawEvent', sequence: 1 } }],
    evidence: { profileId: 'profile', scenarioId: 'scenario', snapshot, networkEntries: [], requestPreview: { method: 'POST', url: 'https://secret.test', variantId: 'default', headers: { authorization: 'CI_SECRET_SHOULD_NOT_LEAK' } } },
    comparison: { baselineLabel: 'secret baseline label', candidateLabel: 'secret candidate label', baselineDurationMs: 100, candidateDurationMs: 123, differenceCount: 1, differencePaths: ['messages[0].parts[0].text'] },
  };
  return { profileId: 'profile<&', profileName: 'Private name', scenarioId: 'scenario"', scenarioName: 'Private scenario', status, result };
}

describe('scenario CI reports', () => {
  it('creates a versioned summary projection without raw evidence or assertion values', () => {
    const report = createScenarioReport([record()], '2026-08-28T00:00:00.000Z');
    expect(report).toMatchObject({ format: 'turnstage-contract-report', version: 1, summary: { total: 1, failed: 1, durationMs: 123 } });
    expect(report.scenarios[0]?.comparison).toEqual({ baselineDurationMs: 100, candidateDurationMs: 123, differenceCount: 1, differencePaths: ['messages[0].parts[0].text'] });

    const json = serializeScenarioJson([record()], '2026-08-28T00:00:00.000Z');
    for (const forbidden of ['CI_SECRET_SHOULD_NOT_LEAK', 'secret.test', 'Private name', 'Private scenario', 'secret baseline label', 'actual', 'expected', 'rawEvents', 'requestPreview']) expect(json).not.toContain(forbidden);
  });

  it('serializes consistent JUnit counts, escaped identifiers, and failure ids only', () => {
    const xml = serializeScenarioJUnit([record(), { ...record('passed'), scenarioId: 'passed' }], '2026-08-28T00:00:00.000Z');
    expect(xml).toContain('tests="2" failures="1" errors="0" skipped="0"');
    expect(xml).toContain('profile&lt;&amp; / scenario&quot;');
    expect(xml).toContain('assertion.safe-id');
    expect(xml).not.toContain('CI_SECRET_SHOULD_NOT_LEAK');
    expect(xml).not.toContain('<system-out>');
  });
});
