import type { NetworkExchange } from './types';

/** Placeholder written in place of credential values; the copied command never carries a secret. */
export const CURL_SECRET_PLACEHOLDER = '<redacted>';

export function isSensitiveHeaderName(name: string): boolean {
  return /^(?:authorization|proxy-authorization|cookie2?|set-cookie|x-api-key|api-key)$/iu.test(name)
    || /(?:^|[-_])(?:token|secret|credential|password|api[-_]?key)(?:$|[-_])/iu.test(name);
}

/** POSIX shell single-quoting: the only character that needs care inside single quotes is the quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Build a copyable cURL command for a captured request. Header values that
 * look like credentials are replaced with a placeholder, so the command can be
 * pasted into a ticket or chat without leaking the secret the host already hid.
 */
export function networkCurlCommand(entry: Pick<NetworkExchange, 'method' | 'url' | 'requestHeaders' | 'requestBody' | 'protocol' | 'kind'>): string {
  const parts = ['curl', shellQuote(entry.url)];
  const streams = entry.kind === 'stream' || entry.protocol === 'sse' || Object.entries(entry.requestHeaders).some(([name, value]) => name.toLocaleLowerCase() === 'accept' && /event-stream/iu.test(value));
  if (streams) parts.push('-N');
  if (entry.method.toUpperCase() !== 'GET' || entry.requestBody !== undefined) parts.push('-X', shellQuote(entry.method.toUpperCase()));
  for (const [name, value] of Object.entries(entry.requestHeaders)) {
    if (name.startsWith(':') || name.toLocaleLowerCase() === 'content-length') continue;
    parts.push('-H', shellQuote(`${name}: ${isSensitiveHeaderName(name) ? CURL_SECRET_PLACEHOLDER : value}`));
  }
  const body = requestBodyText(entry.requestBody);
  if (body !== undefined) parts.push('--data-raw', shellQuote(body));
  return parts.reduce((command, part, index) => index === 0 ? part : part.startsWith('-') ? `${command} \\\n  ${part}` : `${command} ${part}`, '');
}

function requestBodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return undefined; }
}
