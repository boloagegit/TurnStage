import { describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { serializeScenarioHtml, type ScenarioExecutionRecord } from '../src/extension/testing/scenarioReport';
import type { NetworkExchange, ScenarioRunResult } from '../src/shared/types';

const secret = 'DO_NOT_RENDER_THIS_SECRET';

function record(): ScenarioExecutionRecord {
  const snapshot = createSnapshot(true);
  snapshot.rawEvents = [{
    sequence: 1,
    receivedAt: 1,
    elapsedMs: 1,
    protocol: 'sse',
    raw: secret,
    data: { payload: secret },
  }];
  const network: NetworkExchange = {
    id: 'network-1',
    kind: 'stream',
    attempt: 1,
    method: 'POST',
    url: 'https://example.test/chat',
    state: 'failed',
    startedAt: 1,
    requestHeaders: { authorization: secret },
    responseHeaders: { 'x-request-id': 'request<&' },
    error: { type: 'NetworkError', message: secret },
    timing: {},
    transferredBytes: 0,
    eventCount: 1,
    correlation: {
      traceId: 'trace<&"',
      spanId: 'span-1',
      requestId: 'request<&',
    },
  };
  const result: ScenarioRunResult = {
    scenarioId: 'scenario<&',
    passed: false,
    durationMs: 42,
    steps: [],
    checks: [{
      id: 'check<&',
      label: secret,
      passed: false,
      kind: 'assertion',
      actual: secret,
      expected: 'safe',
      location: { kind: 'rawEvent', sequence: 1 },
    }],
    evidence: {
      profileId: '<script>alert("x")</script>&',
      scenarioId: '<img src=x onerror=alert(1)>',
      snapshot,
      networkEntries: [network],
      requestPreview: {
        method: 'POST',
        url: 'https://example.test/chat',
        headers: { authorization: secret },
      },
      faults: { corruptEventAt: 1, disconnectAfterEvents: 2 },
    },
  };
  return {
    profileId: '<script>alert("x")</script>&',
    profileName: 'Private profile name is not serialized',
    scenarioId: '<img src=x onerror=alert(1)>',
    scenarioName: 'Private scenario name is not serialized',
    status: 'failed',
    result,
  };
}

describe('HTML scenario reports', () => {
  it('escapes identifiers and includes only bounded fault/correlation summaries', () => {
    const html = serializeScenarioHtml([record()], '2026-08-28T00:00:00.000Z');

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('corruptEventAt=1, disconnectAfterEvents=2');
    expect(html).toContain('trace&lt;&amp;&quot;');
    expect(html).not.toContain(secret);
    expect(html).not.toContain('rawEvents');
    expect(html).not.toContain('requestPreview');
    expect(html).not.toContain('https://example.test/chat');
  });
});
