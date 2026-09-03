import type { PreparedRequest } from '../../shared/types';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';
import { fetchWithRedirectPolicy } from './fetchPolicy';
import { networkErrorCode } from './transport';
import type { InsecureTlsRoute } from '../connection/vscodeNetworkPath';
import { createRequestFetch, type RequestFetchHandle } from './requestFetch';

export interface BoundedFetchTextOptions {
  maxBytes: number;
  timeoutMs: number;
  controller?: AbortController;
  rejectOnTruncate?: boolean;
  timeoutMessage?: string;
  tooLargeMessage?: string;
  onHeaders?: (response: Response) => void;
  onChunk?: (totalBytes: number) => void;
  onTruncate?: (observedBytes: number) => void;
  insecureTlsRoute?: InsecureTlsRoute;
}

export interface BoundedFetchTextResult {
  response: Response;
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Keep the request deadline active through response-body consumption. */
export async function fetchBoundedText(request: PreparedRequest, options: BoundedFetchTextOptions): Promise<BoundedFetchTextResult> {
  const controller = options.controller ?? new AbortController();
  const timeoutError = new TurnStageError('TimeoutError', options.timeoutMessage ?? localize('The request timeout elapsed.'));
  let timedOut = false;
  let requestFetch: RequestFetchHandle | undefined;
  const timer = setTimeout(() => { timedOut = true; controller.abort(timeoutError); }, options.timeoutMs);
  try {
    requestFetch = await createRequestFetch(request, options.insecureTlsRoute);
    const response = await fetchWithRedirectPolicy(request, controller.signal, requestFetch.fetch);
    options.onHeaders?.(response);
    const body = await readBoundedText(response, options.maxBytes, options.onChunk);
    if (body.truncated) options.onTruncate?.(body.bytes);
    if (body.truncated && options.rejectOnTruncate) {
      throw new TurnStageError('ResponseTooLargeError', options.tooLargeMessage ?? localize('The response exceeded the maximum allowed size.'), { maxBytes: options.maxBytes, observedBytes: body.bytes });
    }
    return { response, ...body };
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof TurnStageError) throw reason;
      if (timedOut) throw timeoutError;
      throw new TurnStageError('UserAbortError', localize('The request was cancelled.'));
    }
    if (error instanceof TurnStageError) throw error;
    const code = networkErrorCode(error);
    throw new TurnStageError('NetworkError', error instanceof Error ? error.message : String(error), code ? { networkCode: code } : {});
  } finally {
    clearTimeout(timer);
    if (requestFetch) await requestFetch.dispose();
  }
}

async function readBoundedText(response: Response, maxBytes: number, onChunk?: (totalBytes: number) => void): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (bytes >= maxBytes) {
        bytes += value.byteLength;
        onChunk?.(bytes);
        truncated = true;
        break;
      }
      const remaining = maxBytes - bytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      bytes += value.byteLength;
      onChunk?.(bytes);
      if (value.byteLength > remaining) { truncated = true; break; }
    }
    text += decoder.decode();
    return { text, bytes, truncated };
  } finally {
    if (truncated) { try { await reader.cancel(); } catch { /* The bounded reader intentionally stops early. */ } }
    try { reader.releaseLock(); } catch { /* The response may already be closed. */ }
  }
}
