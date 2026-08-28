import { describe, expect, it } from 'vitest';
import { extractNetworkCorrelation, mergeNetworkCorrelation } from '../src/extension/observability/correlation';

const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('network correlation extraction', () => {
  it('parses traceparent and request identifiers from Headers', () => {
    const correlation = extractNetworkCorrelation(new Headers({
      traceparent,
      'x-request-id': 'request-123',
      tracestate: 'vendor=private-value',
    }), 'request');

    expect(correlation).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: '01',
      traceSource: 'request',
      requestId: 'request-123',
      requestIdHeader: 'x-request-id',
    });
    expect(correlation).not.toHaveProperty('tracestate');
  });

  it('accepts a safe fallback request header while ignoring invalid identifiers', () => {
    expect(extractNetworkCorrelation({
      'x-request-id': 'contains whitespace',
      'request-id': 'fallback-request',
    }, 'response')).toEqual({
      requestId: 'fallback-request',
      requestIdHeader: 'request-id',
    });
    expect(extractNetworkCorrelation({ 'x-request-id': 'bad\nvalue' }, 'response')).toBeUndefined();
    expect(extractNetworkCorrelation({ 'x-request-id': 'x'.repeat(257) }, 'response')).toBeUndefined();
  });

  it('rejects malformed, reserved-version, and all-zero traceparents', () => {
    const invalidValues = [
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7',
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      '00-not-a-trace-id-00f067aa0ba902b7-01',
    ];

    for (const value of invalidValues) expect(extractNetworkCorrelation({ traceparent: value }, 'response')).toBeUndefined();
  });

  it('merges response identifiers without losing request correlation', () => {
    const request = extractNetworkCorrelation({ traceparent, 'x-request-id': 'request-id' }, 'request');
    const response = extractNetworkCorrelation({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
      'x-correlation-id': 'response-id',
    }, 'response');

    expect(mergeNetworkCorrelation(request, response)).toEqual({
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
      traceFlags: '00',
      traceSource: 'response',
      requestId: 'response-id',
      requestIdHeader: 'x-correlation-id',
    });
    expect(mergeNetworkCorrelation(request, undefined)).toEqual(request);
    expect(mergeNetworkCorrelation(undefined, response)).toEqual(response);
  });
});
