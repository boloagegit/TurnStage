import { describe, expect, it } from 'vitest';
import { decodeWebProfileBundle, encodeWebProfileBundle, WEB_PROFILE_BUNDLE_FORMAT } from '../web/src/profileBundle';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';

const profile: TurnStageProfile = {
  version: 1,
  id: 'shared-sit',
  name: 'Shared SIT',
  environment: 'shared-sit',
  conversation: {
    send: {
      method: 'POST',
      url: '${env.baseUrl}/chat',
      headers: { Authorization: 'Bearer portable-test-token' },
    },
  },
  stream: { transport: 'sse', mappings: [] },
};
const environment: TurnStageEnvironment = {
  version: 1,
  id: 'shared-sit',
  name: 'Shared SIT',
  variables: { baseUrl: 'https://sit.example.test', apiKey: 'portable-test-api-key' },
};

describe('TurnStage Web portable Profile bundle', () => {
  it('round trips a Profile, its Environment, and plaintext credentials in one file', () => {
    const source = encodeWebProfileBundle(profile, environment, new Date('2026-09-12T00:00:00.000Z'));
    const bundle = decodeWebProfileBundle(source);

    expect(bundle).toMatchObject({ format: WEB_PROFILE_BUNDLE_FORMAT, version: 1, exportedAt: '2026-09-12T00:00:00.000Z' });
    expect(bundle?.profile).toEqual(profile);
    expect(bundle?.environment).toEqual(environment);
    expect(source).toContain('portable-test-token');
    expect(source).toContain('portable-test-api-key');
  });

  it('leaves legacy Profile JSON and JSONC inputs to the existing importer', () => {
    expect(decodeWebProfileBundle(JSON.stringify(profile))).toBeUndefined();
    expect(decodeWebProfileBundle('{ // legacy JSONC\n "version": 1 }')).toBeUndefined();
  });

  it('rejects malformed, unsupported, and oversized portable bundles', () => {
    expect(() => decodeWebProfileBundle(JSON.stringify({ format: WEB_PROFILE_BUNDLE_FORMAT, version: 2 }))).toThrow('Unsupported');
    expect(() => decodeWebProfileBundle(JSON.stringify({ format: WEB_PROFILE_BUNDLE_FORMAT, version: 1, exportedAt: 'bad', profile: {}, environment: {} }))).toThrow('timestamp');
    expect(() => decodeWebProfileBundle(' '.repeat(1024 * 1024 + 1))).toThrow('exceeds 1 MiB');
  });

  it('always binds the exported Profile to the included Environment', () => {
    const mismatched = { ...profile, environment: 'old-environment' };
    const bundle = decodeWebProfileBundle(encodeWebProfileBundle(mismatched, environment));
    expect(bundle?.profile.environment).toBe(environment.id);
  });
});
