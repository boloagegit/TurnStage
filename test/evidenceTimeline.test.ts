import { describe, expect, it } from 'vitest';
import type { ScenarioRunResult } from '../src/shared/types';
import { buildEvidenceTimeline, clusterFailures, fingerprintFailure, MAX_EVIDENCE_TIMELINE_ENTRIES } from '../src/extension/testing/evidenceTimeline';

function result(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    scenarioId: 'case-1', passed: false, durationMs: 900, steps: [], checks: [],
    evidence: {
      profileId: 'profile', scenarioId: 'case-1',
      networkEntries: [{ id: 'network-1', kind: 'stream', attempt: 1, method: 'POST', url: 'https://secret.example/chat?token=never', state: 'completed', startedAt: 1_000, completedAt: 1_900, status: 200, requestHeaders: { Authorization: 'Bearer never-copy' }, requestBody: { prompt: 'private' }, responseHeaders: { 'set-cookie': 'secret' }, responseBodyPreview: 'private answer', timing: { headers: 100, firstChunk: 160, total: 900, timeout: 2_000 }, transferredBytes: 99, eventCount: 2, correlation: { requestId: 'request-1' } }],
      snapshot: {
        sessionId: 'session', sessionState: 'ready', turnState: 'completed', trusted: true, controls: {}, messages: [{ id: 'assistant-1', role: 'assistant', status: 'completed', createdAt: 1_000, completedAt: 1_900, parts: [{ type: 'text', text: 'private answer' }], citations: [], actions: [], followups: [], timing: { ttft: 300, totalDuration: 900 } }],
        rawEvents: [{ sequence: 1, receivedAt: 1_170, elapsedMs: 170, protocol: 'sse', sse: { event: 'delta' }, raw: 'data: private', data: { text: 'private answer' }, mappingRuleId: 'content' }, { sequence: 2, receivedAt: 1_880, elapsedMs: 880, protocol: 'sse', sse: { event: 'done' }, raw: 'data: done', data: {}, mappingRuleId: 'done' }],
        normalizedEvents: [{ version: 1, type: 'content.text.delta', sequence: 1, receivedAt: 1_180, rawSequence: 1, mappingRuleId: 'content' }, { version: 1, type: 'stream.completed', sequence: 2, receivedAt: 1_880, rawSequence: 2, mappingRuleId: 'done' }],
        metrics: { requestStartedAt: 1_000, headersLatency: 100, firstChunkLatency: 160, firstEventLatency: 170, ttft: 300, totalDuration: 900, eventCount: 2, byteCount: 99, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [], droppedEventCount: 0,
      },
    },
    adversarial: { outcome: 'attackSucceeded', attemptedTurns: 1, completedTurns: 1, plannedTurns: 1, maxTurns: 1, timeoutMs: 2_000, findings: [{ id: 'forbidden', category: 'content', turnId: 'turn-1', turnIndex: 0, ruleId: 'no-secret', label: 'private content', locations: [{ kind: 'message', messageId: 'assistant-1' }] }], issues: [] },
    ...overrides,
  };
}

describe('causal evidence timeline', () => {
  it('orders causal phases and carries references without copying payloads or secrets', () => {
    const timeline = buildEvidenceTimeline(result());
    expect(timeline.completeness).toBe('complete');
    expect(timeline.entries.map((entry) => entry.phase)).toEqual(['request', 'headers', 'firstChunk', 'firstEvent', 'firstMappedEvent', 'ttft', 'terminal', 'finding']);
    expect(timeline.entries.map((entry) => entry.elapsedMs)).toEqual([0, 100, 160, 170, 180, 300, 900, 880].sort((a, b) => a - b));
    const serialized = JSON.stringify(timeline);
    for (const forbidden of ['never-copy', 'secret.example', 'private answer', 'data: private', 'set-cookie', 'Authorization']) expect(serialized).not.toContain(forbidden);
    expect(timeline.entries.find((entry) => entry.phase === 'headers')?.location).toEqual({ kind: 'network', networkId: 'network-1' });
  });

  it('is deterministic for timestamp ties and reports missing evidence without inventing phases', () => {
    const input = result();
    input.evidence.snapshot.metrics = { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 };
    input.evidence.snapshot.rawEvents = [];
    input.evidence.snapshot.normalizedEvents = [];
    input.evidence.networkEntries = [];
    input.evidence.snapshot.messages = [];
    input.adversarial = { ...input.adversarial!, findings: [], issues: [] };
    const first = buildEvidenceTimeline(input);
    const second = buildEvidenceTimeline(input);
    expect(first).toEqual(second);
    expect(first.completeness).toBe('missing');
    expect(first.entries).toEqual([]);
    expect(first.missingPhases).toContain('ttft');
  });

  it('labels timeout evidence by safe error type and remains bounded', () => {
    const input = result();
    input.evidence.networkEntries[0]!.state = 'failed';
    input.evidence.networkEntries[0]!.error = { type: 'IdleTimeoutError', message: 'Bearer top-secret https://private.example', status: 504 };
    input.evidence.snapshot.errors = Array.from({ length: 400 }, (_, index) => ({ type: `Timeout-${index}`, message: 'private body' }));
    const full = buildEvidenceTimeline(input);
    const timeline = buildEvidenceTimeline(input, 10);
    expect(timeline.entries.length).toBeLessThanOrEqual(MAX_EVIDENCE_TIMELINE_ENTRIES);
    expect(timeline.truncated).toBe(true);
    expect(full.entries.some((entry) => entry.metadata?.errorType === 'IdleTimeoutError')).toBe(true);
    expect(JSON.stringify(full)).not.toContain('top-secret');
  });

  it('places findings at the run fallback time when a network entry has no completion timestamp', () => {
    const input = result();
    delete input.evidence.networkEntries[0]!.completedAt;
    delete input.evidence.networkEntries[0]!.timing.total;

    const finding = buildEvidenceTimeline(input).entries.find((entry) => entry.phase === 'finding');

    expect(finding).toMatchObject({ at: 1_900, elapsedMs: 900 });
  });

  it('produces stable safe fingerprints and deterministic clusters', () => {
    const first = result();
    const second = result();
    second.evidence.networkEntries[0]!.requestBody = { prompt: 'different private text' };
    expect(fingerprintFailure(first)).toEqual(fingerprintFailure(second));
    const clusters = clusterFailures([{ caseId: 'b', result: first }, { caseId: 'a', result: second }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ count: 2 });
    expect(clusters[0]!.caseIds).toEqual(['b', 'a']);
    expect(JSON.stringify(clusters)).not.toContain('private text');
  });
});
