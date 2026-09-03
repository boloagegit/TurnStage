import type { ConnectionNetworkPathSummary, NetworkPathFinding } from '../../shared/types';

export interface NetworkPathInput {
  readonly requestUrl?: string;
  readonly runtime: 'local' | 'remote';
  readonly proxySupport?: unknown;
  readonly proxyConfigured?: boolean;
  readonly environmentProxyConfigured?: boolean;
  readonly noProxyRules?: readonly string[];
  readonly systemCertificates?: boolean;
  readonly proxyStrictSSL?: boolean;
  readonly useLocalProxyConfiguration?: boolean;
  readonly status?: number;
  readonly viaHeaderObserved?: boolean;
  readonly tlsVerificationDisabled?: boolean;
  readonly errorCode?: string;
  readonly timing?: {
    readonly firstChunkLatencyMs?: number;
    readonly firstEventLatencyMs?: number;
    readonly ttftMs?: number;
  };
}

const MAX_NO_PROXY_RULES = 256;
const MAX_NO_PROXY_RULE_LENGTH = 512;
const TLS_TRUST_ERROR_CODES = new Set([
  'CERT_AUTHORITY_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * Classify only what bounded configuration and response metadata support. A
 * transparent proxy can exist even when a direct route is allowed, so this
 * function intentionally never returns a definitive "direct" state.
 */
export function assessNetworkPath(input: NetworkPathInput): ConnectionNetworkPathSummary {
  const proxySupport = normalizeProxySupport(input.proxySupport);
  const noProxyRules = (input.noProxyRules ?? []).slice(0, MAX_NO_PROXY_RULES);
  const noProxyConfigured = noProxyRules.some((rule) => typeof rule === 'string' && rule.trim().length > 0);
  const noProxyMatch = noProxyConfigured ? matchesNoProxy(input.requestUrl, noProxyRules) : undefined;
  const proxyConfigured = input.proxyConfigured === true;
  const environmentProxyConfigured = input.environmentProxyConfigured === true;
  const viaHeaderObserved = input.viaHeaderObserved === true;

  let route: ConnectionNetworkPathSummary['route'];
  let confidence: ConnectionNetworkPathSummary['confidence'];
  if (input.status === 407 || viaHeaderObserved) {
    route = 'likely-proxied'; confidence = 'strong';
  } else if (proxySupport === 'off' || noProxyMatch === true) {
    route = 'direct-possible'; confidence = 'medium';
  } else if (proxyConfigured || environmentProxyConfigured) {
    route = 'likely-proxied'; confidence = 'medium';
  } else {
    route = 'unknown'; confidence = 'low';
  }

  const findings: NetworkPathFinding[] = [];
  if (input.tlsVerificationDisabled === true) findings.push('tls-verification-disabled');
  if (input.status === 407) findings.push('proxy-authentication-required');
  if (isTlsTrustError(input.errorCode)) findings.push('corporate-ca-not-trusted');
  if (isPossibleProxyBuffering(input.timing)) findings.push('possible-proxy-buffering');

  return {
    runtime: input.runtime,
    proxySupport,
    proxyConfigured,
    environmentProxyConfigured,
    noProxyConfigured,
    ...(noProxyMatch === undefined ? {} : { noProxyMatch }),
    systemCertificates: input.systemCertificates !== false,
    proxyStrictSSL: input.proxyStrictSSL !== false,
    useLocalProxyConfiguration: input.useLocalProxyConfiguration === true,
    viaHeaderObserved,
    tlsVerification: input.tlsVerificationDisabled === true ? 'disabled' : 'strict',
    route,
    confidence,
    findings,
  };
}

export function isPossibleProxyBuffering(timing: NetworkPathInput['timing']): boolean {
  const firstChunk = finiteLatency(timing?.firstChunkLatencyMs);
  const firstEvent = finiteLatency(timing?.firstEventLatencyMs);
  const ttft = finiteLatency(timing?.ttftMs);
  return firstChunk !== undefined && firstChunk >= 250
    && firstEvent !== undefined && ttft !== undefined
    && Math.abs(firstEvent - firstChunk) <= 20
    && Math.abs(ttft - firstChunk) <= 20;
}

/** Return undefined when a rule is unsupported, so callers do not overclaim. */
export function matchesNoProxy(requestUrl: string | undefined, rules: readonly string[]): boolean | undefined {
  let url: URL;
  try { url = new URL(requestUrl ?? ''); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol)) return undefined;
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return undefined;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  let supportedRuleSeen = false;
  let unsupportedRuleSeen = rules.length > MAX_NO_PROXY_RULES;

  for (const untrustedRule of rules.slice(0, MAX_NO_PROXY_RULES)) {
    const rule = String(untrustedRule).trim();
    if (!rule) continue;
    if (rule.length > MAX_NO_PROXY_RULE_LENGTH) { unsupportedRuleSeen = true; continue; }
    if (rule === '*') return true;
    const parsed = parseNoProxyRule(rule);
    if (!parsed) { unsupportedRuleSeen = true; continue; }
    supportedRuleSeen = true;
    if (parsed.port && parsed.port !== port) continue;
    if (parsed.kind === 'suffix') {
      if (hostname === parsed.hostname || hostname.endsWith(`.${parsed.hostname}`)) return true;
    } else if (hostname === parsed.hostname) return true;
  }
  if (!supportedRuleSeen || unsupportedRuleSeen) return undefined;
  return false;
}

export function networkPathInfoLine(summary: ConnectionNetworkPathSummary): string {
  return `network-path runtime=${summary.runtime} route=${summary.route} confidence=${summary.confidence} proxyConfigured=${yesNo(summary.proxyConfigured || summary.environmentProxyConfigured)} tlsVerification=${summary.tlsVerification}`;
}

export function networkPathDebugLine(summary: ConnectionNetworkPathSummary): string {
  return `network-path-detail proxySupport=${summary.proxySupport} vscodeProxyConfigured=${yesNo(summary.proxyConfigured)} environmentProxyConfigured=${yesNo(summary.environmentProxyConfigured)} noProxyConfigured=${yesNo(summary.noProxyConfigured)} noProxyMatch=${summary.noProxyMatch === undefined ? 'unknown' : yesNo(summary.noProxyMatch)} systemCertificates=${enabledDisabled(summary.systemCertificates)} proxyStrictSSL=${enabledDisabled(summary.proxyStrictSSL)} localProxyConfiguration=${enabledDisabled(summary.useLocalProxyConfiguration)} viaHeader=${yesNo(summary.viaHeaderObserved)}`;
}

function normalizeProxySupport(value: unknown): ConnectionNetworkPathSummary['proxySupport'] {
  return value === 'off' || value === 'on' || value === 'fallback' || value === 'override' ? value : 'unknown';
}

function isTlsTrustError(value: string | undefined): boolean {
  return typeof value === 'string' && TLS_TRUST_ERROR_CODES.has(value.toUpperCase());
}

function finiteLatency(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLocaleLowerCase();
}

function parseNoProxyRule(rule: string): { hostname: string; port?: string; kind: 'exact' | 'suffix' } | undefined {
  if (/[/?#]/.test(rule) || rule.includes('@')) return undefined;
  let value = rule.toLocaleLowerCase();
  let port: string | undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 1) return undefined;
    const tail = value.slice(end + 1);
    if (tail && !/^:\d{1,5}$/.test(tail)) return undefined;
    port = tail ? tail.slice(1) : undefined;
    value = value.slice(1, end);
  } else {
    const colon = value.lastIndexOf(':');
    if (colon > -1) {
      if (value.indexOf(':') !== colon || !/^\d{1,5}$/.test(value.slice(colon + 1))) return undefined;
      port = value.slice(colon + 1);
      value = value.slice(0, colon);
    }
  }
  if (port && Number(port) > 65_535) return undefined;
  const kind = value.startsWith('*.') || value.startsWith('.') ? 'suffix' : 'exact';
  value = value.replace(/^\*?\./, '').replace(/\.$/, '');
  if (!value || value.includes('*') || !/^[a-z0-9._:-]+$/.test(value)) return undefined;
  return { hostname: normalizeHostname(value), ...(port ? { port } : {}), kind };
}

function yesNo(value: boolean): 'yes' | 'no' { return value ? 'yes' : 'no'; }
function enabledDisabled(value: boolean): 'enabled' | 'disabled' { return value ? 'enabled' : 'disabled'; }
