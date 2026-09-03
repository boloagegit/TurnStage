import type { Dispatcher } from 'undici';
import type { PreparedRequest } from '../../shared/types';
import type { InsecureTlsRoute } from '../connection/vscodeNetworkPath';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';

export type TurnStageFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface RequestFetchHandle {
  readonly fetch: TurnStageFetch;
  readonly mode: 'vscode' | 'insecure-direct' | 'insecure-manual-proxy';
  dispose(): Promise<void>;
}

export async function createRequestFetch(request: PreparedRequest, insecureTlsRoute?: InsecureTlsRoute): Promise<RequestFetchHandle> {
  if (request.tls?.allowInvalidCertificates !== true) return { fetch: globalThis.fetch, mode: 'vscode', dispose: async () => undefined };
  let target: URL;
  try { target = new URL(request.url); } catch { throw new TurnStageError('InsecureTlsConfigurationError', localize('Invalid HTTPS URL for insecure TLS mode.')); }
  if (target.protocol !== 'https:') throw new TurnStageError('InsecureTlsConfigurationError', localize('Invalid certificate bypass is available only for HTTPS requests.'));
  if (!insecureTlsRoute || insecureTlsRoute.mode === 'unknown') {
    throw new TurnStageError('InsecureTlsRouteError', localize('TurnStage cannot preserve this system-managed proxy route while certificate verification is disabled. Configure an explicit proxy or NO_PROXY rule, or turn off invalid-certificate access.'));
  }

  let dispatcher: Dispatcher;
  let mode: RequestFetchHandle['mode'];
  let insecureFetch: typeof import('undici').fetch;
  try {
    // Keep the larger alternate HTTP stack out of ordinary extension requests.
    // It is loaded only after this request explicitly opts into unsafe TLS.
    const { Agent, ProxyAgent, fetch } = await import('undici');
    insecureFetch = fetch;
    if (insecureTlsRoute.mode === 'manual-proxy') {
      const proxy = validatedProxyUrl(insecureTlsRoute.proxyUrl);
      dispatcher = new ProxyAgent({ uri: proxy.toString(), requestTls: { rejectUnauthorized: false } });
      mode = 'insecure-manual-proxy';
    } else {
      dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      mode = 'insecure-direct';
    }
  } catch {
    throw new TurnStageError('InsecureTlsConfigurationError', localize('The explicit proxy cannot be used for this invalid-certificate request.'));
  }
  let disposed = false;
  return {
    mode,
    fetch: async (input, init) => await insecureFetch(input, { ...(init as Parameters<typeof insecureFetch>[1]), dispatcher }) as unknown as Response,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try { await dispatcher.close(); }
      catch { try { await dispatcher.destroy(); } catch { /* Best-effort cleanup must not replace the request outcome. */ } }
    },
  };
}

function validatedProxyUrl(value: string): URL {
  let proxy: URL;
  try { proxy = new URL(value); } catch { throw new Error('invalid proxy'); }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new Error('unsupported proxy');
  return proxy;
}
