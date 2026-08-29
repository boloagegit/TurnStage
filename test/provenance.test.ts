import { describe, expect, it } from 'vitest';
import { createProvenanceManifest, digestValue, ProvenanceInputError, sanitizeForManifest, stableStringify, verifyProvenanceManifest } from '../src/extension/testing/provenance';

function input() {
  return {
    runId: 'run-1',
    generatedAt: '2026-08-29T00:00:00.000Z',
    runnerVersion: '0.11.0',
    runnerKind: 'cli' as const,
    extensionVersion: '0.11.0',
    gitSha: 'abc123',
    selectedTestIds: ['profile/chat', 'suite/prompt-boundary'],
    policy: { timeoutMs: 60_000, authorization: 'Bearer TOP_SECRET' },
    suite: { cases: [{ id: 'prompt-boundary', body: 'do not persist this' }], defaults: { repetitions: 3 } },
    profile: { id: 'profile', controls: { apiToken: 'TOP_SECRET' } },
    result: { status: 'failed', message: 'TOP_SECRET appeared' },
    evidence: { rawEvents: [{ raw: 'TOP_SECRET', data: { content: 'private response' } }], network: { url: 'https://private.example' } },
    environmentIdentity: { id: 'local', name: 'Local', provider: 'fixture', fingerprint: 'env-1' },
    secretValues: ['TOP_SECRET'],
    evidenceFiles: [
      { path: 'report.json', contents: '{"status":"failed"}' },
      { path: 'events.csv', contents: 'sequence,type\n1,content.text.delta\n' },
    ],
  };
}

describe('provenance manifests', () => {
  it('produces stable canonical digests independent of object insertion order', () => {
    expect(stableStringify({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
    expect(digestValue({ z: 1, a: 2 })).toBe(digestValue({ a: 2, z: 1 }));
    const first = createProvenanceManifest(input());
    const secondInput = input();
    secondInput.policy = { authorization: 'Bearer TOP_SECRET', timeoutMs: 60_000 };
    const second = createProvenanceManifest(secondInput);
    expect(first.digests).toEqual(second.digests);
    expect(first.manifestDigest).toBe(second.manifestDigest);
  });

  it('keeps secrets and payload content outside the manifest boundary', () => {
    const manifest = createProvenanceManifest(input());
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('TOP_SECRET');
    expect(serialized).not.toContain('private response');
    expect(serialized).not.toContain('private.example');
    expect(manifest.redaction).toMatchObject({ level: 'metadata-only', secretsExcluded: true });
    expect(sanitizeForManifest({ token: 'TOP_SECRET', body: { text: 'private response' } }, ['TOP_SECRET'])).toEqual({ body: expect.stringContaining('[PAYLOAD_DIGEST]'), token: '[REDACTED]' });
  });

  it('verifies the complete manifest and detects manifest or evidence tampering', () => {
    const original = input();
    const manifest = createProvenanceManifest(original);
    const verified = verifyProvenanceManifest(manifest, original);
    expect(verified.valid).toBe(true);
    expect(verified.checks).toMatchObject({ manifest: true, suite: true, profile: true, result: true, evidence: true, evidenceManifest: true, files: true, redaction: true });

    const manifestTampered = structuredClone(manifest);
    manifestTampered.resultDigest = 'f'.repeat(64);
    expect(verifyProvenanceManifest(manifestTampered, original)).toMatchObject({ valid: false, manifestValid: false });

    const changedEvidence = { ...original, evidenceFiles: [{ path: 'report.json', contents: '{"status":"changed"}' }, original.evidenceFiles![1]!] };
    const evidenceTampered = verifyProvenanceManifest(manifest, changedEvidence);
    expect(evidenceTampered.valid).toBe(false);
    expect(evidenceTampered.checks).toMatchObject({ manifest: true, evidenceManifest: false, files: false });
  });

  it('rejects unsafe file paths, cycles, and non-finite values', () => {
    expect(() => createProvenanceManifest({ ...input(), evidenceFiles: [{ path: '../report.json', contents: 'x' }] })).toThrow(ProvenanceInputError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => digestValue(cycle)).toThrow(ProvenanceInputError);
    expect(() => digestValue({ value: Number.NaN })).toThrow(ProvenanceInputError);
  });
});
