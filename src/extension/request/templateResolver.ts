import { errors } from '../errors';
import { localize } from '../l10n';

export interface ResolutionContext { [key: string]: unknown }
export interface TemplateResolutionOptions { encodeSecrets?: boolean }

export function getPath(root: unknown, path: string): unknown {
  const normalized = path.replace(/^\$\.?/, '');
  if (!normalized) return root;
  return normalized.split('.').reduce<unknown>((value, segment) => value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined, root);
}

function applyTransform(value: unknown, transform: string, argument?: unknown): unknown {
  switch (transform) {
    case 'trim': return String(value ?? '').trim();
    case 'lowercase': return String(value ?? '').toLowerCase();
    case 'uppercase': return String(value ?? '').toUpperCase();
    case 'number': return Number(value);
    case 'boolean': return value === true || value === 'true' || value === 1;
    case 'json': return JSON.stringify(value);
    case 'default': return value ?? argument;
    case 'join': return Array.isArray(value) ? value.join(String(argument ?? ',')) : value;
    default: throw errors.request(localize('Unsupported transform: {transform}.', { transform }));
  }
}

export async function resolveTemplate(value: unknown, context: ResolutionContext, secretProvider?: (name: string) => Promise<string | undefined>, options: TemplateResolutionOptions = {}): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveTemplate(item, context, secretProvider, options)));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.$value === 'string') {
      let resolved = getPath(context, object.$value);
      for (const transform of Array.isArray(object.$transforms) ? object.$transforms : []) {
        if (typeof transform === 'string') resolved = applyTransform(resolved, transform);
        else if (transform && typeof transform === 'object') resolved = applyTransform(resolved, String((transform as any).name), (transform as any).value);
      }
      return resolved;
    }
    return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await resolveTemplate(child, context, secretProvider, options)])));
  }
  if (typeof value !== 'string') return value;
  const matches = [...value.matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)];
  let result = value;
  for (const match of matches) {
    const path = match[1]!;
    let replacement: unknown;
    const secret = path.startsWith('secret.');
    if (secret) {
      const name = path.slice(7);
      replacement = await secretProvider?.(name);
      if (replacement === undefined) throw errors.missingSecret(name);
    } else replacement = getPath(context, path);
    if (replacement === undefined) throw errors.request(localize('Template path "{path}" was not found.', { path }));
    const text = String(replacement);
    result = result.replace(match[0], secret && options.encodeSecrets ? encodeURIComponent(text) : text);
  }
  return result;
}
