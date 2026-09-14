// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOfficialCatalog, mergeCatalogEntries } from '../web/src/catalog';
import { loadProfiles, saveProfiles, type StoredProfile } from '../web/src/storage';
import { ProfileCodec } from '../src/extension/config/profileCodec';

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

  it('loads original VSIX JSONC files from the generated folder catalog', async () => {
    const profileRaw = `{
      // This comment is valid in a VSIX profile.
      "version": 1, "id": "sit", "name": "SIT", "environment": "sit",
      "conversation": { "send": { "method": "POST", "url": "${'${env.baseUrl}'}/chat" } },
      "stream": { "transport": "sse", "mappings": [] },
    }`;
    const environmentRaw = '{ /* VSIX environment */ "version": 1, "id": "sit", "name": "SIT", "variables": { "baseUrl": "https://sit.example.test" }, }';
    const catalog = {
      format: 'turnstage-web-catalog', version: 1, id: 'turnstage-folder-catalog', revision: 'abc',
      profiles: [{ file: './profiles/SIT%20%E4%B8%AD%E6%96%87.turnstage.jsonc', version: '123' }],
      environments: [{ file: './environments/sit.environment.jsonc', version: '456' }],
    };
    const requested: string[] = [];
    const result = await loadOfficialCatalog({
      bundledProfiles, bundledEnvironments,
      parseProfile: (raw) => new ProfileCodec().parse(raw).profile,
      parseEnvironment: (raw) => new ProfileCodec().parse(raw).profile,
      fetcher: async (input) => {
        requested.push(String(input));
        const source = String(input) === './turnstage-catalog.json' ? JSON.stringify(catalog)
          : String(input) === './profiles/SIT%20%E4%B8%AD%E6%96%87.turnstage.jsonc' ? profileRaw
            : String(input) === './environments/sit.environment.jsonc' ? environmentRaw : undefined;
        return source === undefined ? new Response('', { status: 404 }) : new Response(source);
      },
    });
    expect(result.source).toBe('configured');
    expect(result.profiles[0]).toMatchObject({ id: 'sit', raw: profileRaw, builtIn: true, official: { entryVersion: '123' } });
    expect(result.environments[0]).toMatchObject({ id: 'sit', raw: environmentRaw, builtIn: true });
    expect(requested).toEqual(['./turnstage-catalog.json', './environments/sit.environment.jsonc', './profiles/SIT%20%E4%B8%AD%E6%96%87.turnstage.jsonc']);
  });

  it('retains nested server folder paths and rejects path traversal at every level', async () => {
    const catalog = { format: 'turnstage-web-catalog', version: 1, id: 'company', revision: '1', profiles: [{ file: './profiles/Team%20A/SIT/demo.turnstage.jsonc' }], environments: [{ bundled: 'local' }] };
    const loaded = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async (input) => new Response(String(input) === './turnstage-catalog.json' ? JSON.stringify(catalog) : bundledProfile) });
    expect(loaded.profiles[0]?.official?.folderPath).toEqual(['Team A', 'SIT']);
    for (const path of ['./profiles/../demo.turnstage.jsonc', './profiles/Team%2FA/demo.turnstage.jsonc', './profiles/Team/%5Cdemo.turnstage.jsonc']) {
      const result = await loadOfficialCatalog({ bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment, fetcher: async (input) => new Response(String(input) === './turnstage-catalog.json' ? JSON.stringify({ ...catalog, profiles: [{ file: path }] }) : bundledProfile) });
      expect(result.source).toBe('fallback');
    }
  });

  it('rejects unsafe, unavailable, and oversized folder files without exposing a partial catalog', async () => {
    const base = {
      format: 'turnstage-web-catalog', version: 1, id: 'company', revision: '1',
      profiles: [{ file: './profiles/sit.turnstage.jsonc' }], environments: [{ bundled: 'local' }],
    };
    for (const [file, response, expected] of [
      ['https://external.test/sit.turnstage.jsonc', new Response(bundledProfile), 'not a supported local JSONC path'],
      ['../sit.turnstage.jsonc', new Response(bundledProfile), 'not a supported local JSONC path'],
      ['./profiles/sit%2Fother.turnstage.jsonc', new Response(bundledProfile), 'not a supported local JSONC path'],
      ['./profiles/sit.turnstage.jsonc', new Response('', { status: 404 }), 'returned HTTP 404'],
      ['./profiles/sit.turnstage.jsonc', new Response('x'.repeat(524_289)), 'exceeds 512 KiB'],
    ] as const) {
      const result = await loadOfficialCatalog({
        bundledProfiles, bundledEnvironments, parseProfile, parseEnvironment,
        fetcher: async (input) => String(input) === './turnstage-catalog.json'
          ? new Response(JSON.stringify({ ...base, profiles: [{ file }] })) : response,
      });
      expect(result.source).toBe('fallback');
      expect(result.warning).toContain(expected);
      expect(result.profiles.map((item) => item.id)).toEqual(['example']);
    }
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
