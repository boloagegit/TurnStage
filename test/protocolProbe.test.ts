import { describe, expect, it } from 'vitest';
import { analyzeConnectionProbe, MAX_PROBE_EVENTS } from '../src/extension/connection/protocolProbe';

describe('bounded connection probe analyzer', () => {
  it('identifies SSE, successful HTTP, terminal mapping, and content timing', () => {
    const result = analyzeConnectionProbe({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      bodyPrefix: 'event: message\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
      timing: { headersLatencyMs: 120, firstChunkLatencyMs: 180, firstEventLatencyMs: 190, totalLatencyMs: 800 },
      rawEvents: [
        { sequence: 1, protocol: 'sse', sse: { event: 'message' }, data: { choices: [{ delta: { content: '你好' } }] }, mappingRuleId: 'content' },
        { sequence: 2, protocol: 'sse', sse: { event: undefined }, data: '[DONE]', mappingRuleId: 'done' },
      ],
      normalizedEvents: [{ sequence: 1, type: 'content.text.delta' }, { sequence: 2, type: 'stream.completed' }],
      mapping: { configured: true, mappedEventCount: 2, terminalMapped: true },
    });
    expect(result.fingerprint).toMatchObject({ protocol: 'sse', confidence: 'high', status: 200, terminalEventSeen: true, terminalMapped: true, rawEventCount: 2, mappedEventCount: 2 });
    expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['http-ok', 'terminal-observed']));
    expect(result.findings.some((finding) => finding.id === 'missing-terminal-event')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('你好');
  });

  it('distinguishes NDJSON, one-shot JSON, and plain text from bounded evidence', () => {
    expect(analyzeConnectionProbe({ status: 200, contentType: 'application/x-ndjson', bodyPrefix: '{"delta":"a"}\n{"done":true}\n' }).fingerprint.protocol).toBe('ndjson');
    expect(analyzeConnectionProbe({ status: 200, contentType: 'application/json', bodyPrefix: '{"answer":"ok"}' }).fingerprint.protocol).toBe('json');
    expect(analyzeConnectionProbe({ status: 200, contentType: 'text/plain', bodyPrefix: 'plain text response' }).fingerprint.protocol).toBe('text-stream');
  });

  it('reports auth/server errors, slow phases, parse/mapping gaps, and missing terminal event', () => {
    const result = analyzeConnectionProbe({
      status: 401,
      contentType: 'text/event-stream',
      bodyPrefix: 'event: message\ndata: {bad}\n\n',
      timing: { headersLatencyMs: 2_000, firstChunkLatencyMs: 3_000, firstEventLatencyMs: 4_000, totalLatencyMs: 30_000 },
      rawEvents: [
        { sequence: 7, protocol: 'sse', parseError: 'invalid JSON' },
        { sequence: 8, protocol: 'sse' },
      ],
      normalizedEvents: [],
      mapping: { configured: true, unmatchedEventCount: 1, mappingErrorCount: 1 },
    });
    expect(result.fingerprint).toMatchObject({ terminalEventSeen: false, parseErrorCount: 1, mappingErrorCount: 1, unmatchedEventCount: 1 });
    expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
      'http-auth-required', 'slow-headers', 'slow-first-chunk', 'slow-first-event', 'slow-total', 'event-parse-error',
      'mapping-error', 'unmatched-events', 'mapping-no-events', 'missing-terminal-event',
    ]));
    expect(result.safe).toBe(false);
  });

  it('does not claim an absent terminal when the inspected prefix is explicitly truncated', () => {
    const result = analyzeConnectionProbe({ status: 200, contentType: 'text/event-stream', bodyPrefix: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', bodyPrefixTruncated: true, rawEvents: [] });
    expect(result.fingerprint.bodyPrefixTruncated).toBe(true);
    expect(result.findings.some((finding) => finding.id === 'missing-terminal-event')).toBe(false);
  });

  it('bounds event and result metadata while retaining deterministic counts', () => {
    const rawEvents = Array.from({ length: MAX_PROBE_EVENTS + 20 }, (_, index) => ({ sequence: index + 1, protocol: 'sse' as const, mappingRuleId: 'content' }));
    const result = analyzeConnectionProbe({ status: 200, contentType: 'text/event-stream', bodyPrefix: 'data: {}\n\n', rawEvents });
    expect(result.fingerprint).toMatchObject({ rawEventCount: MAX_PROBE_EVENTS, inputEventsTruncated: true, mappedEventCount: MAX_PROBE_EVENTS });
    expect(result.findings.length).toBeLessThanOrEqual(32);
    expect(result.findings.find((finding) => finding.id === 'event-input-truncated')).toBeDefined();
  });

  it('reports unknown protocol and deterministic statuses for malformed probes', () => {
    const result = analyzeConnectionProbe({ status: 500, contentType: 'application/octet-stream', bodyPrefix: '\u0000\u0001' });
    expect(result.fingerprint.protocol).toBe('unknown');
    expect(result.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['http-server-error', 'protocol-unknown']));
    expect(result.safe).toBe(false);
  });
});
