import { describe, expect, it } from 'vitest';
import { assessNetworkPath, isPossibleProxyBuffering, matchesNoProxy, networkPathDebugLine, networkPathInfoLine } from '../src/extension/connection/networkPath';

describe('network path diagnostics', () => {
  it('reports a configured proxy as likely without claiming certainty', () => {
    const result = assessNetworkPath({
      requestUrl: 'https://api.example.test/chat',
      runtime: 'local',
      proxySupport: 'override',
      proxyConfigured: true,
      noProxyRules: ['localhost', '*.internal.test'],
    });

    expect(result).toMatchObject({ route: 'likely-proxied', confidence: 'medium', noProxyMatch: false, proxyConfigured: true });
  });

  it('reports only that a direct route is possible when proxy support is off or NO_PROXY matches', () => {
    expect(assessNetworkPath({ requestUrl: 'https://api.example.test/chat', runtime: 'remote', proxySupport: 'off', proxyConfigured: true }).route).toBe('direct-possible');
    expect(assessNetworkPath({ requestUrl: 'https://api.internal.test:8443/chat', runtime: 'local', proxySupport: 'override', proxyConfigured: true, noProxyRules: ['*.internal.test:8443'] })).toMatchObject({ route: 'direct-possible', noProxyMatch: true });
  });

  it('uses response metadata as strong intermediary evidence and detects proxy authentication', () => {
    expect(assessNetworkPath({ runtime: 'local', status: 200, viaHeaderObserved: true })).toMatchObject({ route: 'likely-proxied', confidence: 'strong' });
    expect(assessNetworkPath({ runtime: 'local', status: 407 })).toMatchObject({ route: 'likely-proxied', confidence: 'strong', findings: ['proxy-authentication-required'] });
  });

  it('recognizes bounded TLS trust and buffering evidence without reading payloads', () => {
    const result = assessNetworkPath({
      runtime: 'local',
      errorCode: 'SELF_SIGNED_CERT_IN_CHAIN',
      timing: { firstChunkLatencyMs: 680, firstEventLatencyMs: 681, ttftMs: 683 },
    });
    expect(result.findings).toEqual(['corporate-ca-not-trusted', 'possible-proxy-buffering']);
    expect(isPossibleProxyBuffering({ firstChunkLatencyMs: 20, firstEventLatencyMs: 21, ttftMs: 22 })).toBe(false);
    expect(isPossibleProxyBuffering({ firstChunkLatencyMs: Number.NaN, firstEventLatencyMs: 1, ttftMs: 1 })).toBe(false);
  });

  it('matches exact, suffix, wildcard, port, and IPv6 NO_PROXY rules conservatively', () => {
    expect(matchesNoProxy('https://api.example.test/path', ['api.example.test'])).toBe(true);
    expect(matchesNoProxy('https://api.example.test/path', ['.example.test'])).toBe(true);
    expect(matchesNoProxy('https://api.example.test:8443/path', ['*.example.test:443'])).toBe(false);
    expect(matchesNoProxy('http://[::1]:3000/path', ['[::1]:3000'])).toBe(true);
    expect(matchesNoProxy('https://api.example.test/path', ['10.0.0.0/8'])).toBeUndefined();
    expect(matchesNoProxy('not a URL', ['*'])).toBeUndefined();
  });

  it('never includes proxy URLs, credentials, hosts, or bypass rules in log lines', () => {
    const secret = 'https://user:password@secret-proxy.corp:8443';
    const host = 'private-api.corp';
    const summary = assessNetworkPath({ requestUrl: `https://${host}/chat`, runtime: 'local', proxySupport: 'override', proxyConfigured: Boolean(secret), noProxyRules: [host] });
    const output = `${JSON.stringify(summary)} ${networkPathInfoLine(summary)} ${networkPathDebugLine(summary)}`;
    expect(output).not.toContain(secret);
    expect(output).not.toContain('password');
    expect(output).not.toContain(host);
  });
});
