import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { createScenarioReport, serializeAdversarialEventsCsv, serializeAdversarialFindingsCsv, serializeAdversarialNetworkCsv, serializeAdversarialSummaryCsv, serializeAdversarialTurnsCsv, serializeScenarioHtml, serializeScenarioJson, serializeScenarioJUnit, type ScenarioExecutionRecord } from '../src/extension/testing/scenarioReport';
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
    expect(report).toMatchObject({ format: 'turnstage-contract-report', version: 2, summary: { total: 1, failed: 1, durationMs: 123, resisted: 0, attackSucceeded: 0, indeterminate: 0, infrastructureErrors: 0 } });
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

  it('exports adversarial outcomes and detailed structural CSVs without raw content or URLs', () => {
    const attack = record('failed');
    attack.result!.adversarial = {
      outcome: 'attackSucceeded', attemptedTurns: 1, completedTurns: 1, plannedTurns: 2, maxTurns: 2, timeoutMs: 60_000,
      findings: [{ id: 'content-1', category: 'content', turnId: 'turn-1', turnIndex: 0, ruleId: 'protected-marker', label: 'CI_SECRET_SHOULD_NOT_LEAK', locations: [{ kind: 'message', messageId: 'assistant-1' }, { kind: 'network', networkId: 'network-1' }] }],
      issues: [],
    };
    attack.result!.steps = [{ stepId: 'turn-1', name: 'private prompt', durationMs: 40, checks: [{ id: 'content-1', label: 'CI_SECRET_SHOULD_NOT_LEAK', passed: false, kind: 'adversarial', location: { kind: 'message', messageId: 'assistant-1' } }] }];
    attack.result!.repetitions = { requestedAttempts: 2, completedAttempts: 2, skippedAttempts: 0, sampleComplete: true, outcome: 'attackSucceeded', stability: 'unstable', counts: { resisted: 1, attackSucceeded: 1, indeterminate: 0, infrastructureError: 0 }, attempts: [
      { attempt: 1, outcome: 'resisted', durationMs: 100, ttftMs: 20, attemptedTurns: 1, completedTurns: 1, startedAt: 1, completedAt: 101 },
      { attempt: 2, outcome: 'attackSucceeded', durationMs: 200, ttftMs: 40, attemptedTurns: 1, completedTurns: 1, startedAt: 102, completedAt: 302 },
    ] };
    attack.result!.evidence.snapshot.normalizedEvents = [{ version: 1, type: 'content.text.delta', sequence: 1, receivedAt: 1, rawSequence: 1, text: 'CI_SECRET_SHOULD_NOT_LEAK' }];
    const outputs = [serializeAdversarialSummaryCsv([attack]), serializeAdversarialTurnsCsv([attack]), serializeAdversarialFindingsCsv([attack]), serializeAdversarialNetworkCsv([attack]), serializeAdversarialEventsCsv([attack])];
    expect(outputs.join('\n')).toContain('attackSucceeded');
    expect(outputs.join('\n')).toContain('content.text.delta');
    for (const forbidden of ['CI_SECRET_SHOULD_NOT_LEAK', 'secret.test', 'private prompt', 'authorization']) expect(outputs.join('\n')).not.toContain(forbidden);
    expect(serializeScenarioJUnit([attack])).toContain('Adversarial attack succeeded');
    const report = createScenarioReport([attack]);
    expect(report.failureClusters).toHaveLength(1);
    expect(report.scenarios[0]?.adversarial?.timeline).toMatchObject({ version: 1 });
    expect(report.scenarios[0]?.adversarial?.reliability).toMatchObject({ verdict: 'doesNotMeetTarget', resistanceRate: 0.5, duration: { p95: 195 } });
    const html = serializeScenarioHtml([attack]);
    expect(html).toContain('Failure clusters');
    expect(html).toContain('Causal timeline');
    expect(html).not.toContain('CI_SECRET_SHOULD_NOT_LEAK');
  });
});
