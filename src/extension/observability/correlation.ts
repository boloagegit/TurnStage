import type { NetworkCorrelation } from '../../shared/types';

const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id', 'correlation-id'] as const;
const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(?:-[\da-f-]+)?$/i;

/** Extract bounded correlation identifiers without retaining baggage or tracestate values. */
export function extractNetworkCorrelation(headers: Headers | Record<string, string> | undefined, source: 'request' | 'response'): NetworkCorrelation | undefined {
  const values = normalizeHeaders(headers);
  const trace = parseTraceparent(values.traceparent);
  const requestHeader = REQUEST_ID_HEADERS.find((name) => isSafeIdentifier(values[name]));
  if (!trace && !requestHeader) return undefined;
  return {
    ...(trace ? { ...trace, traceSource: source } : {}),
    ...(requestHeader ? { requestId: values[requestHeader]!.slice(0, 256), requestIdHeader: requestHeader } : {}),
  };
}

export function mergeNetworkCorrelation(current: NetworkCorrelation | undefined, next: NetworkCorrelation | undefined): NetworkCorrelation | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    ...current,
    ...(next.traceId ? { traceId: next.traceId, spanId: next.spanId, traceFlags: next.traceFlags, traceSource: next.traceSource } : {}),
    ...(next.requestId ? { requestId: next.requestId, requestIdHeader: next.requestIdHeader } : {}),
  };
}

function parseTraceparent(value: string | undefined): Pick<NetworkCorrelation, 'traceId' | 'spanId' | 'traceFlags'> | undefined {
  const match = value?.trim().match(TRACEPARENT);
  if (!match || match[1] === 'ff' || /^0+$/.test(match[2]!) || /^0+$/.test(match[3]!)) return undefined;
  return { traceId: match[2]!.toLowerCase(), spanId: match[3]!.toLowerCase(), traceFlags: match[4]!.toLowerCase() };
}

function normalizeHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function isSafeIdentifier(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value);
}
