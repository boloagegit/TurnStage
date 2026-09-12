// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOfficialCatalog, mergeCatalogEntries } from '../web/src/catalog';
import { loadProfiles, saveProfiles, type StoredProfile } from '../web/src/storage';

const bundledProfile = JSON.stringify({ version: 1, id: 'example', name: 'Example', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] } });
const bundledEnvironment = JSON.stringify({ version: 1, id: 'local', name: 'Local', variables: {} });
const bundledProfiles = new Map([['example', bundledProfile]]);
const bundledEnvironments = new Map([['local', bundledEnvironment]]);
const parseProfile = (raw: string) => parseNamed(raw, 'conversation');
const parseEnvironment = (raw: string) => parseNamed(raw, 'variables');

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
});

describe('TurnStage Web official catalog', () => {
  it('loads deployment-provided inline and bundled presets with immutable origin metadata', async () => {
    const catalog = {
      format: 'turnstage-web-catalog', version: 1, id: 'company', revision: '2026.09',
      profiles: [
        { bundled: 'example', version: '1', category: 'Examples', tags: ['sse'] },
        { id: 'sit', version: '4', category: 'Payments', tags: ['sit'], profile: { version: 1, id: 'sit', name: 'Payments SIT', environment: 'sit', conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat' } }, stream: { transport: 'sse', mappings: [] } } },
      ],
      environments: [
        { bundled: 'local' },
        { id: 'sit', environment: { version: 1, id: 'sit', name: 'SIT', variables: { baseUrl: 'https://sit.example.test' }, secretReferences: { apiToken: 'payments-sit-api-token' } } },
      ],
    };
    const result = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async () => new Response(JSON.stringify(catalog)) });

    expect(result).toMatchObject({ catalogId: 'company', revision: '2026.09', source: 'configured' });
    expect(result.profiles.map((item) => item.id)).toEqual(['example', 'sit']);
    expect(result.profiles[1]).toMatchObject({ builtIn: true, official: { catalogId: 'company', catalogRevision: '2026.09', entryId: 'sit', entryVersion: '4', category: 'Payments', tags: ['sit'] } });
    expect(result.environments[1]).toMatchObject({ builtIn: true, official: { entryId: 'sit' } });
  });

  it('fails closed to bundled defaults for malformed, duplicate, or oversized configured catalogs', async () => {
    const duplicate = { format: 'turnstage-web-catalog', version: 1, id: 'company', revision: '1', profiles: [{ bundled: 'example' }, { bundled: 'example' }], environments: [{ bundled: 'local' }] };
    const result = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async () => new Response(JSON.stringify(duplicate)) });
    expect(result).toMatchObject({ source: 'fallback', catalogId: 'turnstage-bundled' });
    expect(result.warning).toContain('duplicate profile id');
    expect(result.profiles.map((item) => item.id)).toEqual(['example']);

    const oversized = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async () => new Response(' '.repeat(1_048_577)) });
    expect(oversized.source).toBe('fallback');
    expect(oversized.warning).toContain('exceeds 1 MiB');

  });

  it('preserves plaintext authentication values in deployment-provided presets', async () => {
    const catalog = {
      format: 'turnstage-web-catalog', version: 1, id: 'company', revision: '1',
      profiles: [{ profile: { version: 1, id: 'shared', name: 'Shared', environment: 'shared', conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat', headers: { Authorization: 'Bearer shared-test-token' } } }, stream: { transport: 'sse', mappings: [] } } }],
      environments: [{ environment: { version: 1, id: 'shared', name: 'Shared', variables: { baseUrl: 'https://example.test', apiKey: 'shared-test-api-key' } } }],
    };
    const result = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async () => new Response(JSON.stringify(catalog)) });

    expect(result.source).toBe('configured');
    expect(result.profiles[0]?.raw).toContain('Bearer shared-test-token');
    expect(result.environments[0]?.raw).toContain('shared-test-api-key');
  });

  it('keeps browser-local collisions deterministic and strips forged official state from storage', () => {
    const official = { id: 'example', name: 'Official', raw: bundledProfile, builtIn: true, updatedAt: 0 } satisfies StoredProfile;
    const local = { id: 'example', name: 'Local override', raw: bundledProfile, updatedAt: 2 } satisfies StoredProfile;
    expect(mergeCatalogEntries([official], [local])).toEqual([local]);

    localStorage.setItem('turnstage.web.profiles.v1', JSON.stringify([{ ...local, builtIn: true, official: { catalogId: 'forged', catalogRevision: '1', entryId: 'example' }, basedOn: { catalogId: 'company', catalogRevision: '1', entryId: 'example' } }]));
    expect(loadProfiles()).toEqual([{ ...local, basedOn: { catalogId: 'company', catalogRevision: '1', entryId: 'example' } }]);

    saveProfiles([{ ...local, builtIn: true, official: { catalogId: 'forged', catalogRevision: '1', entryId: 'example' } }]);
    expect(JSON.parse(localStorage.getItem('turnstage.web.profiles.v1') ?? '[]')).toEqual([local]);
  });
});

function parseNamed(raw: string, requiredKey: string): { id: string; name: string } | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value.id === 'string' && typeof value.name === 'string' && requiredKey in value ? { id: value.id, name: value.name } : undefined;
  } catch { return undefined; }
}
