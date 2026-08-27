import type { InteractionContext, PreparedRequest, RequestDefinition, RequestVariant } from '../../shared/types';
import { redactDeep, redactHeaders, redactKnownSecrets } from '../security/security';
import { errors } from '../errors';
import { getPath, resolveTemplate, type ResolutionContext } from './templateResolver';
import { localize } from '../l10n';

function matches(variant: RequestVariant, context: ResolutionContext): boolean {
  if (!variant.when) return true;
  const { path = '', operator = 'equals', value } = variant.when;
  const actual = getPath(context, path);
  switch (operator) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'equals': return actual === value;
    case 'notEquals': return actual !== value;
    case 'oneOf': return Array.isArray(value) && value.includes(actual);
    case 'contains': return Array.isArray(actual) ? actual.includes(value) : String(actual ?? '').includes(String(value));
    case 'startsWith': return String(actual ?? '').startsWith(String(value));
    case 'endsWith': return String(actual ?? '').endsWith(String(value));
    case 'regex': {
      if (typeof value !== 'string' || value.length > 256 || /\([^)]*[+*][^)]*\)[+*]/.test(value)) return false;
      try { return new RegExp(value).test(String(actual ?? '').slice(0, 4096)); } catch { return false; }
    }
    default: return false;
  }
}

export class RequestBuilder {
  constructor(private readonly getSecret: (name: string) => Promise<string | undefined>) {}
  async build(definition: RequestDefinition, context: ResolutionContext): Promise<PreparedRequest> {
    const secretValues: string[] = [];
    const resolveSecret = async (name: string): Promise<string | undefined> => {
      const value = await this.getSecret(name);
      if (value) secretValues.push(value);
      return value;
    };
    const variant = definition.variants?.find((candidate) => matches(candidate, context));
    if (definition.variants?.length && !variant) throw errors.request(localize('No request variant matched the current interaction.'));
    const url = String(await resolveTemplate(definition.url, context, resolveSecret));
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw errors.request(localize('Invalid request URL: {url}', { url: String(redactKnownSecrets(url, secretValues)) })); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw errors.request(localize('Unsupported request scheme: {scheme}', { scheme: parsed.protocol }));
    const headers = await resolveTemplate({ ...definition.headers, ...variant?.headers }, context, resolveSecret) as Record<string, string>;
    const resolvedBody = await resolveTemplate(variant?.body ?? definition.body, context, resolveSecret);
    const body = resolvedBody === undefined ? undefined : JSON.stringify(resolvedBody);
    const knownSecrets = [...new Set(secretValues)];
    const redacted = redactKnownSecrets({ method: definition.method, url, headers: redactHeaders(headers), body: redactDeep(resolvedBody), variantId: variant?.id }, knownSecrets) as PreparedRequest['redacted'];
    return { method: definition.method, url, headers, body, timeoutMs: definition.timeoutMs, idleTimeoutMs: definition.idleTimeoutMs, reconnect: definition.reconnect, redirectPolicy: definition.redirectPolicy, maxRedirects: definition.maxRedirects, secretValues: knownSecrets, redacted };
  }
}

export function interactionContext(interaction: InteractionContext): Record<string, unknown> { return { ...interaction }; }
