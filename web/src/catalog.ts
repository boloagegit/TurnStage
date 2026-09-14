import type { StoredEnvironment, StoredProfile } from './storage';

export const WEB_CATALOG_FORMAT = 'turnstage-web-catalog';
export const WEB_CATALOG_VERSION = 1;
export const DEFAULT_WEB_CATALOG_URL = './turnstage-catalog.json';
const MAX_CATALOG_BYTES = 1_048_576;
const MAX_CATALOG_ENTRIES = 100;
const MAX_ENTRY_BYTES = 524_288;
const CATALOG_TIMEOUT_MS = 5_000;

export interface CatalogReference {
  catalogId: string;
  catalogRevision: string;
  entryId: string;
  entryVersion?: string;
  category?: string;
  tags?: string[];
  folderPath?: string[];
}

export interface OfficialCatalogResult {
  catalogId: string;
  revision: string;
  profiles: StoredProfile[];
  environments: StoredEnvironment[];
  source: 'configured' | 'fallback';
  warning?: string;
}

interface CatalogOptions {
  url?: string;
  bundledProfiles: ReadonlyMap<string, string>;
  bundledEnvironments: ReadonlyMap<string, string>;
  parseProfile(raw: string): { id: string; name: string } | undefined;
  parseEnvironment(raw: string): { id: string; name: string } | undefined;
  validateProfile?(raw: string, environmentRaws: readonly string[]): boolean;
  fetcher?: typeof fetch;
}

interface CatalogEntry {
  id?: string;
  bundled?: string;
  file?: string;
  profile?: unknown;
  environment?: unknown;
  version?: string;
  category?: string;
  tags?: string[];
}

interface CatalogDocument {
  format: typeof WEB_CATALOG_FORMAT;
  version: typeof WEB_CATALOG_VERSION;
  id: string;
  revision: string;
  profiles: CatalogEntry[];
  environments: CatalogEntry[];
}

export async function loadOfficialCatalog(options: CatalogOptions): Promise<OfficialCatalogResult> {
  const fallback = await bundledCatalog(options);
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return { ...fallback, warning: 'The official catalog could not be loaded because Fetch is unavailable.' };

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const response = await fetcher(options.url ?? DEFAULT_WEB_CATALOG_URL, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_CATALOG_BYTES) throw new Error('catalog exceeds 1 MiB');
    const document = parseCatalogDocument(text);
    const environments = await materializeEntries(document.environments, 'environment', document, options, fetcher, controller.signal);
    const profiles = await materializeEntries(document.profiles, 'profile', document, options, fetcher, controller.signal);
    if (options.validateProfile && profiles.some((profile) => !options.validateProfile!(profile.raw, environments.map((environment) => environment.raw)))) throw new Error('catalog contains an invalid profile');
    return { catalogId: document.id, revision: document.revision, profiles, environments, source: 'configured' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...fallback, warning: `The configured official catalog was unavailable (${detail}). Bundled defaults are active.` };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function mergeCatalogEntries<T extends { id: string }>(official: readonly T[], local: readonly T[]): T[] {
  const localIds = new Set(local.map((item) => item.id));
  return [...official.filter((item) => !localIds.has(item.id)), ...local];
}

async function bundledCatalog(options: CatalogOptions): Promise<OfficialCatalogResult> {
  const document: CatalogDocument = {
    format: WEB_CATALOG_FORMAT,
    version: WEB_CATALOG_VERSION,
    id: 'turnstage-bundled',
    revision: '1',
    profiles: [...options.bundledProfiles.keys()].map((bundled) => ({ bundled })),
    environments: [...options.bundledEnvironments.keys()].map((bundled) => ({ bundled })),
  };
  return {
    catalogId: document.id,
    revision: document.revision,
    profiles: await materializeEntries(document.profiles, 'profile', document, options),
    environments: await materializeEntries(document.environments, 'environment', document, options),
    source: 'fallback',
  };
}

function parseCatalogDocument(text: string): CatalogDocument {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error('catalog root must be an object');
  if (value.format !== WEB_CATALOG_FORMAT || value.version !== WEB_CATALOG_VERSION) throw new Error('unsupported catalog format or version');
  const id = boundedIdentifier(value.id, 'catalog id');
  const revision = boundedText(value.revision, 'catalog revision', 120);
  if (!Array.isArray(value.profiles) || value.profiles.length < 1 || value.profiles.length > MAX_CATALOG_ENTRIES) throw new Error('catalog profiles must contain 1 to 100 entries');
  if (!Array.isArray(value.environments) || value.environments.length < 1 || value.environments.length > MAX_CATALOG_ENTRIES) throw new Error('catalog environments must contain 1 to 100 entries');
  return { format: WEB_CATALOG_FORMAT, version: WEB_CATALOG_VERSION, id, revision, profiles: value.profiles as CatalogEntry[], environments: value.environments as CatalogEntry[] };
}

async function materializeEntries(
  entries: CatalogEntry[],
  kind: 'profile' | 'environment',
  document: CatalogDocument,
  options: CatalogOptions,
  fetcher?: typeof fetch,
  signal?: AbortSignal,
): Promise<Array<StoredProfile | StoredEnvironment>> {
  const seen = new Set<string>();
  return Promise.all(entries.map(async (entry, index) => {
    if (!isRecord(entry)) throw new Error(`${kind} entry ${index + 1} must be an object`);
    const bundled = typeof entry.bundled === 'string' ? entry.bundled : undefined;
    const file = typeof entry.file === 'string' ? entry.file : undefined;
    const inline = kind === 'profile' ? entry.profile : entry.environment;
    if (Number(Boolean(bundled)) + Number(file !== undefined) + Number(inline !== undefined) !== 1) throw new Error(`${kind} entry ${index + 1} must define exactly one bundled key, file, or inline value`);
    const bundledSources = kind === 'profile' ? options.bundledProfiles : options.bundledEnvironments;
    const raw = bundled ? bundledSources.get(bundled) : file !== undefined ? await readCatalogFile(file, kind, fetcher, signal) : JSON.stringify(inline, null, 2);
    if (!raw) throw new Error(`${kind} entry ${index + 1} references an unknown bundled key`);
    if (new TextEncoder().encode(raw).byteLength > MAX_ENTRY_BYTES) throw new Error(`${kind} entry ${index + 1} exceeds 512 KiB`);
    const parsed = kind === 'profile' ? options.parseProfile(raw) : options.parseEnvironment(raw);
    if (!parsed) throw new Error(`${kind} entry ${index + 1} is invalid`);
    if (entry.id !== undefined && entry.id !== parsed.id) throw new Error(`${kind} entry ${index + 1} id does not match its content`);
    if (seen.has(parsed.id)) throw new Error(`duplicate ${kind} id ${parsed.id}`);
    seen.add(parsed.id);
    const reference: CatalogReference = {
      catalogId: document.id,
      catalogRevision: document.revision,
      entryId: parsed.id,
      ...(typeof entry.version === 'string' ? { entryVersion: boundedText(entry.version, `${kind} version`, 120) } : {}),
      ...(typeof entry.category === 'string' ? { category: boundedText(entry.category, `${kind} category`, 80) } : {}),
      ...(entry.tags !== undefined ? { tags: boundedTags(entry.tags, kind) } : {}),
      ...(file && kind === 'profile' ? { folderPath: catalogFolderPath(file) } : {}),
    };
    return { id: parsed.id, name: parsed.name, raw, builtIn: true, official: reference, updatedAt: 0 };
  }));
}

async function readCatalogFile(file: string, kind: 'profile' | 'environment', fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  const folder = kind === 'profile' ? './profiles/' : './environments/';
  const suffix = kind === 'profile' ? '.turnstage.jsonc' : '.environment.jsonc';
  const segments = safeCatalogSegments(file, folder);
  const filename = segments?.at(-1) ?? '';
  if (!filename.endsWith(suffix) || filename.length <= suffix.length) {
    throw new Error(`${kind} file path is not a supported local JSONC path`);
  }
  if (!fetcher) throw new Error(`${kind} file cannot be loaded because Fetch is unavailable`);
  const response = await fetcher(file, {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json, text/plain' },
  });
  if (!response.ok) throw new Error(`${kind} file ${file} returned HTTP ${response.status}`);
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ENTRY_BYTES) throw new Error(`${kind} file ${file} exceeds 512 KiB`);
  return raw;
}

function catalogFolderPath(file: string): string[] {
  return safeCatalogSegments(file, './profiles/')?.slice(0, -1) ?? [];
}

function safeCatalogSegments(file: string, prefix: string): string[] | undefined {
  if (!file.startsWith(prefix) || file.length > 1024) return undefined;
  const encoded = file.slice(prefix.length).split('/');
  if (encoded.length < 1 || encoded.length > 9) return undefined;
  const decoded: string[] = [];
  for (const segment of encoded) {
    if (!/^[A-Za-z0-9._~%-]+$/u.test(segment)) return undefined;
    let value: string;
    try { value = decodeURIComponent(segment); } catch { return undefined; }
    if (!value || value === '.' || value === '..' || value.length > 200 || [...value].some((character) => character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined;
    decoded.push(value);
  }
  return decoded;
}

function boundedIdentifier(value: unknown, label: string): string {
  const text = boundedText(value, label, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} must be 1 to ${maximum} characters`);
  return value.trim();
}

function boundedTags(value: unknown, kind: string): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) throw new Error(`${kind} tags must contain at most 20 short strings`);
  return [...new Set(value.map((tag) => tag.trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
