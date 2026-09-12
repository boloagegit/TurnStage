const sensitiveHeaders = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);

export const SECRET_REDACTION = '••••••••';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitiveHeaders.has(key.toLowerCase()) ? redactValue(value) : value]));
}

function redactValue(value: string): string {
  const prefix = value.match(/^\S+\s+/)?.[0] ?? '';
  return `${prefix}${SECRET_REDACTION}`;
}

export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    sensitiveHeaders.has(key.toLowerCase()) || /secret|token|password/i.test(key) ? SECRET_REDACTION : redactDeep(child),
  ]));
}

export function redactKnownSecrets(value: unknown, secrets: readonly unknown[]): unknown {
  if (value === undefined || value === null || !secrets.length) return value;
  if (typeof value === 'string') return secretRepresentations(secrets).reduce((result, secret) => result.split(secret).join(SECRET_REDACTION), value);
  if (typeof value === 'number' || typeof value === 'boolean') return secrets.some((secret) => Object.is(secret, value)) ? SECRET_REDACTION : value;
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, secrets));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactKnownSecrets(item, secrets)]));
  return value;
}

/** Include URL-encoded variants because URL templates encode secret placeholders. */
export function secretRepresentations(secrets: readonly unknown[]): string[] {
  const values = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  return [...new Set(values.flatMap((secret) => {
    let encoded: string | undefined;
    try { encoded = encodeURIComponent(secret); } catch { encoded = undefined; }
    return encoded && encoded !== secret ? [secret, encoded] : [secret];
  }))].sort((left, right) => right.length - left.length);
}
