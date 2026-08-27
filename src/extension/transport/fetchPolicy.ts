import type { PreparedRequest } from '../../shared/types';
import { TurnStageError } from '../errors';
import { localize } from '../l10n';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

/** Fetch a prepared request while enforcing TurnStage's bounded redirect policy. */
export async function fetchWithRedirectPolicy(request: PreparedRequest, signal: AbortSignal): Promise<Response> {
  const policy = request.redirectPolicy ?? 'same-origin';
  const maxRedirects = Math.min(10, Math.max(0, request.maxRedirects ?? 5));
  let url = validatedHttpUrl(request.url);
  let method = request.method.toUpperCase();
  let body = request.body;
  let headers = new Headers(request.headers);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await cancelResponseBody(response);
    if (policy === 'error') throw redirectError('RedirectRejectedError', localize('The request was redirected, but this profile rejects redirects.'), response.status, url);
    if (redirects >= maxRedirects) throw redirectError('TooManyRedirectsError', localize('The request exceeded the maximum of {count} redirects.', { count: maxRedirects }), response.status, url);

    const location = response.headers.get('location');
    if (!location) throw redirectError('InvalidRedirectError', localize('The redirect response did not include a Location header.'), response.status, url);
    const nextUrl = validatedHttpUrl(location, url);
    const crossesOrigin = nextUrl.origin !== url.origin;
    if (crossesOrigin && policy === 'same-origin') {
      throw redirectError('CrossOriginRedirectError', localize('The request was blocked from redirecting to a different origin.'), response.status, nextUrl);
    }
    if (crossesOrigin) headers = stripSensitiveHeaders(headers, request.secretValues ?? []);
    if (shouldSwitchToGet(response.status, method)) {
      method = 'GET';
      body = undefined;
      headers.delete('content-length');
      headers.delete('content-type');
      headers.delete('transfer-encoding');
    }
    url = nextUrl;
  }
}

function validatedHttpUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch { throw new TurnStageError('InvalidRedirectError', localize('The redirect target is not a valid URL.')); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TurnStageError('InvalidRedirectError', localize('Redirects are limited to HTTP and HTTPS URLs.'), { url: url.toString() });
  }
  if (url.username || url.password) {
    throw new TurnStageError('InvalidRedirectError', localize('Redirect URLs must not contain embedded credentials.'), { url: redactUrl(url) });
  }
  return url;
}

function stripSensitiveHeaders(source: Headers, secretValues: string[]): Headers {
  const result = new Headers();
  for (const [name, value] of source.entries()) {
    const containsKnownSecret = secretValues.some((secret) => secret.length > 0 && value.includes(secret));
    if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) && !containsKnownSecret) result.append(name, value);
  }
  return result;
}

function shouldSwitchToGet(status: number, method: string): boolean {
  return status === 303 && method !== 'HEAD' || (status === 301 || status === 302) && method === 'POST';
}

function redirectError(type: string, message: string, status: number, url: URL): TurnStageError {
  return new TurnStageError(type, message, { status, url: redactUrl(url) });
}

function redactUrl(url: URL): string {
  const safe = new URL(url);
  safe.username = '';
  safe.password = '';
  return safe.toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A redirect body is intentionally discarded. */ }
}
