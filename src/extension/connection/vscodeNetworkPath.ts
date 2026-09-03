import * as vscode from 'vscode';
import type { ConnectionNetworkPathSummary } from '../../shared/types';
import { assessNetworkPath, matchesNoProxy, type NetworkPathInput } from './networkPath';

export type NetworkPathObservation = Pick<NetworkPathInput, 'status' | 'viaHeaderObserved' | 'errorCode' | 'timing' | 'tlsVerificationDisabled'>;
export interface VSCodeNetworkPathInspector { assess(observation?: NetworkPathObservation): ConnectionNetworkPathSummary }
export type InsecureTlsRoute = { mode: 'direct' } | { mode: 'manual-proxy'; proxyUrl: string } | { mode: 'unknown' };

/** Read configuration once per request/analysis and return only non-secret facts. */
export function inspectVSCodeNetworkPath(requestUrl?: string, observation: NetworkPathObservation = {}): ConnectionNetworkPathSummary {
  return captureVSCodeNetworkPath(requestUrl).assess(observation);
}

/** Capture the non-secret configuration once, then add response evidence later. */
export function captureVSCodeNetworkPath(requestUrl?: string): VSCodeNetworkPathInspector {
  const configuration = vscode.workspace.getConfiguration('http');
  const configuredNoProxy = configuration.get<unknown>('noProxy');
  const environmentNoProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  const remoteName = 'env' in vscode ? vscode.env.remoteName : undefined;
  const input: NetworkPathInput = {
    requestUrl,
    runtime: remoteName ? 'remote' : 'local',
    proxySupport: configuration.get<unknown>('proxySupport'),
    proxyConfigured: nonEmptyString(configuration.get<unknown>('proxy')),
    environmentProxyConfigured: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((name) => nonEmptyString(process.env[name])),
    noProxyRules: [...normalizeNoProxy(configuredNoProxy), ...normalizeNoProxy(environmentNoProxy)],
    systemCertificates: configuration.get<boolean>('systemCertificates', true),
    proxyStrictSSL: configuration.get<boolean>('proxyStrictSSL', true),
    useLocalProxyConfiguration: configuration.get<boolean>('useLocalProxyConfiguration', false),
  };
  return { assess: (observation = {}) => assessNetworkPath({ ...input, ...observation }) };
}

/**
 * Resolve only explicit routes for insecure TLS. System/PAC routing is left as
 * unknown because a custom dispatcher cannot safely inherit VS Code's private
 * proxy resolver.
 */
export function resolveVSCodeInsecureTlsRoute(requestUrl: string): InsecureTlsRoute {
  const configuration = vscode.workspace.getConfiguration('http');
  const proxySupport = configuration.get<unknown>('proxySupport');
  const rules = [...normalizeNoProxy(configuration.get<unknown>('noProxy')), ...normalizeNoProxy(process.env.NO_PROXY ?? process.env.no_proxy)];
  if (matchesNoProxy(requestUrl, rules) === true || proxySupport === 'off') return { mode: 'direct' };
  const configuredProxy = configuration.get<unknown>('proxy');
  if (nonEmptyString(configuredProxy)) return { mode: 'manual-proxy', proxyUrl: configuredProxy };
  const targetProtocol = safeProtocol(requestUrl);
  const environmentProxy = targetProtocol === 'https:'
    ? firstNonEmpty(process.env.https_proxy, process.env.HTTPS_PROXY, process.env.http_proxy, process.env.HTTP_PROXY, process.env.all_proxy, process.env.ALL_PROXY)
    : firstNonEmpty(process.env.http_proxy, process.env.HTTP_PROXY, process.env.all_proxy, process.env.ALL_PROXY);
  return environmentProxy ? { mode: 'manual-proxy', proxyUrl: environmentProxy } : { mode: 'unknown' };
}

function normalizeNoProxy(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return typeof value === 'string' ? value.split(',') : [];
}

function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function firstNonEmpty(...values: unknown[]): string | undefined { return values.find(nonEmptyString) as string | undefined; }
function safeProtocol(value: string): string | undefined { try { return new URL(value).protocol; } catch { return undefined; } }
