import { describe, expect, it } from 'vitest';
import {
  analyzeRepetitions,
  buildTimingLadder,
  diagnoseRun,
  explainBaselineCandidate,
  type DiagnosticInput,
} from '../src/extension/copilot/diagnostics';

describe('deterministic Copilot diagnostics', () => {
  it('keeps the timing ladder ordered and marks missing stages explicitly', () => {
    const ladder = buildTimingLadder(undefined, {
      requestStartedAt: 1_700_000_000_000,
      headersLatency: 120,
      firstChunkLatency: 240,
      firstEventLatency: 260,
      ttft: 390,
      totalDuration: 1_200,
    });

    expect(ladder.stages.map((stage) => stage.stage)).toEqual([
      'request',
      'headers',
      'firstChunk',
      'firstRawEvent',
      'firstNormalizedContent',
      'firstVisibleText',
      'terminal',
    ]);
    expect(ladder.stages.filter((stage) => stage.observed).map((stage) => stage.elapsedMs)).toEqual([0, 120, 240, 260, 390, 1_200]);
    expect(ladder.missingStages).toEqual(['firstNormalizedContent']);
    expect(ladder.orderingValid).toBe(true);
    expect(ladder.stages.find((stage) => stage.stage === 'firstNormalizedContent')).toMatchObject({ observed: false, note: 'missing' });
  });

  it('reports invalid and out-of-order timings without inventing values', () => {
    const ladder = buildTimingLadder({ headers: 200, firstChunk: -1, firstRawEvent: 100, terminal: Number.NaN }, {});
    expect(ladder.orderingValid).toBe(false);
    expect(ladder.anomalies).toEqual(['invalid-stage:firstChunk', 'timing-order:firstRawEvent', 'invalid-stage:terminal']);
    expect(ladder.stages.find((stage) => stage.stage === 'firstChunk')).toMatchObject({ observed: false, note: 'invalid' });
    expect(ladder.stages.find((stage) => stage.stage === 'terminal')).toMatchObject({ observed: false, note: 'invalid' });
    expect(ladder.missingStages).toEqual(['firstChunk', 'firstNormalizedContent', 'firstVisibleText', 'terminal']);
  });

  it('identifies direct auth, parser, mapping, timeout, and contract signals with evidence levels', () => {
    const result = diagnoseRun({
      runId: 'run-auth-1',
      caseId: 'case-1',
      outcome: 'failed',
      timeoutMs: 1_000,
      metrics: { requestStartedAt: 10, headersLatency: 100, totalDuration: 1_000, parseErrorCount: 2, mappingErrorCount: 1, unmatchedEventCount: 1 },
      transport: { protocol: 'sse', status: 401, terminalState: 'failed', timeout: true },
      errors: [{ type: 'parse_error', code: 'parser-json', message: 'Bearer ghp_NEVER_COPY_THIS https://private.example/api/secret', retrySafe: false }],
      assertions: [{ id: 'expected-safe-output', passed: false }],
      evidence: [{ kind: 'network', id: 'network-1' }, { kind: 'rawEvent', id: 'event-1', stage: 'firstRawEvent' }],
    });

    expect(result.version).toBe('DiagnosisResultV1');
    expect(result.focus).toBe('failure');
    expect(result.capsule.version).toBe('DiagnosticCapsuleV1');
    expect(result.capsule.sanitized).toBe(true);
    expect(result.findings.map((finding) => finding.category)).toEqual(['auth', 'timeout', 'parser', 'mapping', 'assertion']);
    expect(result.findings[0]?.evidenceLevel).toBe('strong');
    expect(result.findings.every((finding) => ['strong', 'moderate', 'limited'].includes(finding.evidenceLevel))).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghp_NEVER_COPY_THIS');
    expect(serialized).not.toContain('https://private.example');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('NEVER_COPY');
    expect(serialized).not.toContain('confidence');
    expect(result.capsule.evidence).toEqual([
      { kind: 'network', id: 'network-1' },
      { kind: 'event', id: 'event-1', stage: 'firstRawEvent' },
    ]);
  });

  it('distinguishes proxy buffering and cancellation from generic incompleteness', () => {
    const proxy = diagnoseRun({
      runId: 'run-proxy',
      outcome: 'indeterminate',
      timing: { request: 0, headers: 30, firstChunk: 800 },
      transport: { protocol: 'sse', state: 'streaming', proxyBuffered: true, terminalState: 'pending' },
    });
    expect(proxy.findings.map((finding) => finding.category)).toEqual(['proxy', 'incomplete']);
    expect(proxy.findings[0]?.evidenceLevel).toBe('strong');

    const cancelled = diagnoseRun({
      runId: 'run-cancel',
      outcome: 'cancelled',
      transport: { state: 'aborted', terminalState: 'aborted' },
    });
    expect(cancelled.findings.map((finding) => finding.category)).toEqual(['cancel']);
    expect(cancelled.status).toBe('complete');
  });

  it('keeps all-empty and malformed input safe and explicitly insufficient', () => {
    const result = diagnoseRun({
      runId: 'https://secret.invalid/path',
      outcome: '???',
      metrics: { headersLatency: -1, eventCount: Number.POSITIVE_INFINITY },
      transport: { protocol: 'https://secret.invalid', status: 999, variantId: 'Bearer secret-token' },
      evidence: [{ kind: 'network', id: 'https://secret.invalid' }, { kind: 'profile', id: 'profile-1', path: '../secret' }],
      configIssues: [null, { secret: 'do-not-copy' }, 'bad setting'],
    });
    expect(result.status).toBe('partial');
    expect(result.capsule.runId).toBe('unknown-run');
    expect(result.capsule.outcome).toBe('indeterminate');
    expect(result.capsule.metrics).toEqual({});
    expect(result.capsule.evidence).toEqual([{ kind: 'profile', id: 'profile-1' }]);
    expect(result.capsule.configIssues).toEqual(['config.invalid']);
    expect(result.summary).toContain('Profile configuration');
  });

  it('does not throw when bounded arrays contain malformed entries', () => {
    const result = diagnoseRun({
      runId: 'run-malformed',
      outcome: 'indeterminate',
      errors: [null as never, 'not-an-error' as never],
      evidence: [null as never, 42 as never],
      assertions: [null as never, 'not-an-assertion' as never],
      repetition: { requestedAttempts: 2, attempts: [null as never, 42 as never] },
    });
    expect(result.capsule.errors).toEqual([]);
    expect(result.capsule.evidence).toEqual([]);
    expect(result.capsule.assertions).toMatchObject({ total: 2, passed: 0, failed: 2 });
    expect(result.repetition?.counts.indeterminate).toBe(2);
  });

  it('classifies complete stable, flaky, and partial repeated samples deterministically', () => {
    const stable = analyzeRepetitions({ requestedAttempts: 3, attempts: [{ attempt: 3, outcome: 'resisted' }, { attempt: 1, outcome: 'resisted' }, { attempt: 2, outcome: 'resisted' }] });
    expect(stable).toMatchObject({ requestedAttempts: 3, completedAttempts: 3, skippedAttempts: 0, sampleComplete: true, status: 'stable', evidenceLevel: 'strong', dominantOutcome: 'resisted' });
    expect(stable.counts).toMatchObject({ resisted: 3, attackSucceeded: 0 });

    const flaky = analyzeRepetitions({ requestedAttempts: 4, attempts: [{ attempt: 1, outcome: 'resisted' }, { attempt: 2, outcome: 'attackSucceeded' }, { attempt: 3, outcome: 'passed' }, { attempt: 4, outcome: 'failed' }] });
    expect(flaky).toMatchObject({ sampleComplete: true, status: 'flaky', evidenceLevel: 'moderate' });

    const partial = analyzeRepetitions({ requestedAttempts: 5, attempts: [{ attempt: 1, outcome: 'resisted' }, { attempt: 2, outcome: 'resisted' }], sampleComplete: false });
    expect(partial).toMatchObject({ requestedAttempts: 5, completedAttempts: 2, skippedAttempts: 3, sampleComplete: false, status: 'inconclusive' });
  });

  it('uses the requested diagnostic focus in the returned explanation', () => {
    const result = diagnoseRun({
      runId: 'run-stability',
      focus: 'stability',
      outcome: 'resisted',
      repetition: { requestedAttempts: 2, attempts: [{ outcome: 'resisted' }, { outcome: 'resisted' }] },
    });
    expect(result.focus).toBe('stability');
    expect(result.summary).toContain('All 2 completed attempts');
  });

  it('treats indeterminate and infrastructure attempts as inconclusive rather than pass', () => {
    const result = analyzeRepetitions({ requestedAttempts: 3, attempts: [{ outcome: 'resisted' }, { outcome: 'indeterminate' }, { outcome: 'infrastructureError' }] });
    expect(result.status).toBe('inconclusive');
    expect(result.evidenceLevel).toBe('moderate');
    expect(result.counts.indeterminate).toBe(1);
    expect(result.counts.infrastructureError).toBe(1);
    expect(result.dominantOutcome).toBe('resisted');
  });

  it('explains baseline and candidate timing and variant changes without judging content', () => {
    const comparison = explainBaselineCandidate(
      { outcome: 'resisted', variantId: 'model-a', metrics: { firstVisibleTextLatencyMs: 400, terminalLatencyMs: 900 } },
      { outcome: 'attackSucceeded', variantId: 'model-b', metrics: { firstVisibleTextLatencyMs: 600, terminalLatencyMs: 850, streamDurationMs: 100 } },
    );
    expect(comparison).toMatchObject({ outcomeChanged: true, baselineOutcome: 'resisted', candidateOutcome: 'attackSucceeded', variantChanged: true, evidenceLevel: 'strong' });
    expect(comparison.differences).toEqual([
      { metric: 'firstVisibleTextLatencyMs', baselineMs: 400, candidateMs: 600, deltaMs: 200, direction: 'regressed', evidenceLevel: 'strong' },
      { metric: 'terminalLatencyMs', baselineMs: 900, candidateMs: 850, deltaMs: -50, direction: 'improved', evidenceLevel: 'strong' },
      { metric: 'streamDurationMs', candidateMs: 100, direction: 'unknown', evidenceLevel: 'limited' },
    ]);
  });

  it('bounds large input and remains linear for diagnostic metadata', () => {
    const evidence = Array.from({ length: 10_000 }, (_, index) => ({ kind: 'event', id: `event-${index}` }));
    const attempts = Array.from({ length: 10_000 }, (_, index) => ({ attempt: index + 1, outcome: index % 2 ? 'resisted' : 'attackSucceeded' }));
    const input: DiagnosticInput = { runId: 'run-large', outcome: 'indeterminate', evidence, repetition: { requestedAttempts: 100, attempts } };
    const started = Date.now();
    const result = diagnoseRun(input);
    const elapsed = Date.now() - started;
    expect(result.capsule.evidence.length).toBeLessThanOrEqual(64);
    expect(result.capsule.repetition?.completedAttempts).toBe(100);
    expect(result.capsule.repetition?.requestedAttempts).toBe(100);
    expect(result.capsule.repetition?.status).toBe('flaky');
    expect(elapsed).toBeLessThan(500);
  });
});
