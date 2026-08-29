import { describe, expect, it } from 'vitest';
import {
  PROFILE_PATCH_DRAFT_FORMAT,
  PROFILE_PATCH_DRAFT_VERSION,
  ProfilePatchError,
  applyProfilePatchEdits,
  assertExpectedProfileDigest,
  canonicalProfileDigest,
  createProfilePatchDraft,
  isAllowedProfilePatchPath,
  validateProfilePatchDraft,
  verifyProfilePatchDraft,
} from '../src/extension/copilot/remediation';

const profile = {
  version: 1,
  id: 'demo',
  name: 'Demo',
  conversation: {
    send: {
      method: 'POST',
      url: 'https://private.example.test/chat',
      timeoutMs: 20_000,
      idleTimeoutMs: 30_000,
    },
  },
  stream: {
    transport: 'sse',
    dataFormat: 'json',
    mappings: [{
      id: 'message',
      match: { event: 'message', path: '$.delta.text', operator: 'exists' },
      emit: { type: 'content.text.delta', text: { path: '$.delta.text' } },
    }],
  },
};

const source = `{
  // Keep this profile comment.
  "version": 1,
  "id": "demo",
  "name": "Demo",
  "conversation": {
    "send": {
      "method": "POST",
      "url": "https://private.example.test/chat",
      "timeoutMs": 20000,
      "idleTimeoutMs": 30000,
    },
  },
  "stream": {
    "transport": "sse",
    "dataFormat": "json",
    "mappings": [{
      "id": "message",
      // Mapping comment must survive a local edit.
      "match": { "event": "message", "path": "$.delta.text", "operator": "exists" },
      "emit": { "type": "content.text.delta", "text": { "path": "$.delta.text" } },
    }],
  },
}
`;

function draft(operations: Parameters<typeof createProfilePatchDraft>[0]['operations']) {
  return createProfilePatchDraft({ profile, sourceText: source, operations, expectedProfileDigest: canonicalProfileDigest(profile) });
}

describe('Copilot profile remediation core', () => {
  it('keeps the allowlist narrow and excludes network credentials and arbitrary profile fields', () => {
    const allowed: Array<readonly (string | number)[]> = [
      ['conversation', 'send', 'timeoutMs'],
      ['conversation', 'send', 'idleTimeoutMs'],
      ['conversation', 'send', 'reconnect', 'maxAttempts'],
      ['opening', 'request', 'timeoutMs'],
      ['stream', 'transport'],
      ['stream', 'mappingMode'],
      ['stream', 'doneValue'],
      ['stream', 'mappings', 0, 'match', 'path'],
      ['stream', 'mappings', 0, 'emit', 'text', 'path'],
      ['stream', 'mappings', 0, 'continue'],
    ];
    for (const path of allowed) expect(isAllowedProfilePatchPath(path), path.join('.')).toBe(true);

    const rejected: Array<readonly (string | number)[]> = [
      ['conversation', 'send', 'url'],
      ['conversation', 'send', 'headers'],
      ['conversation', 'send', 'body'],
      ['conversation', 'send', 'authorization'],
      ['conversation', 'send', 'proxy'],
      ['security', 'allowedDomains'],
      ['ui', 'messageActionVisibility'],
      ['stream', 'mappings', 0, 'id'],
      ['stream', 'mappings', 0, 'emit', 'text'],
      ['stream', 'mappings', 0, '__proto__', 'path'],
      ['stream', 'mappings', 0, 'match', 'path', '__proto__'],
      ['stream', 'mappings', 101, 'match', 'path'],
    ];
    for (const path of rejected) expect(isAllowedProfilePatchPath(path), path.join('.')).toBe(false);
  });

  it('creates deterministic local JSONC edits, retains comments, and provides an inverse plan', () => {
    const result = draft([
      { path: ['conversation', 'send', 'timeoutMs'], value: 45_000, reason: 'Increase the request budget after a delayed-header observation.' },
      { path: ['stream', 'mappings', 0, 'match', 'path'], value: '$.delta.content', reason: 'Align the mapping with the observed normalized field.' },
    ]);
    expect(result.format).toBe(PROFILE_PATCH_DRAFT_FORMAT);
    expect(result.version).toBe(PROFILE_PATCH_DRAFT_VERSION);
    expect(result.changes.map((change) => change.pathLabel)).toEqual([
      'conversation.send.timeoutMs',
      'stream.mappings[0].match.path',
    ]);
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.edits.every((edit) => edit.offset >= 0 && edit.length >= 0)).toBe(true);
    const updated = applyProfilePatchEdits(source, result.edits);
    expect(updated).toContain('// Keep this profile comment.');
    expect(updated).toContain('// Mapping comment must survive a local edit.');
    expect(updated).toContain('"timeoutMs": 45000');
    expect(updated).toContain('"path": "$.delta.content"');
    expect(applyProfilePatchEdits(updated, result.inverseEdits)).toBe(source);
    expect(JSON.stringify(result)).not.toContain('private.example.test');
    expect(result.changes[0]?.before).toMatchObject({ kind: 'number', value: 20000 });
    expect(result.changes[0]?.after).toMatchObject({ kind: 'number', value: 45000 });
    expect(result.safety).toEqual({ allowlisted: true, networkSettingsChanged: false, secretSettingsChanged: false, requiresConfirmation: true, contentRedacted: true });
  });

  it('adds a missing optional reconnect object without copying the URL or dropping comments', () => {
    const noReconnectProfile = structuredClone(profile);
    Reflect.deleteProperty(noReconnectProfile.conversation.send, 'idleTimeoutMs');
    const noReconnectSource = source.replace('      "idleTimeoutMs": 30000,\n', '');
    const result = createProfilePatchDraft({
      profile: noReconnectProfile,
      sourceText: noReconnectSource,
      operations: [{ path: ['conversation', 'send', 'reconnect', 'maxAttempts'], value: 2 }],
      expectedProfileDigest: canonicalProfileDigest(noReconnectProfile),
    });
    const updated = applyProfilePatchEdits(noReconnectSource, result.edits);
    expect(updated).toContain('// Keep this profile comment.');
    expect(updated).toContain('"reconnect": {"maxAttempts":2}');
    expect(result.edits.map((edit) => edit.content).join('')).not.toContain('private.example.test');
    expect(applyProfilePatchEdits(updated, result.inverseEdits)).toBe(noReconnectSource);
  });

  it('supports safe removal and preserves unrelated neighboring properties', () => {
    const result = draft([{ path: ['conversation', 'send', 'idleTimeoutMs'], operation: 'remove', reason: 'Remove the duplicate idle limit.' }]);
    const updated = applyProfilePatchEdits(source, result.edits);
    expect(updated).not.toContain('"idleTimeoutMs"');
    expect(updated).toContain('"timeoutMs": 20000');
    expect(updated).toContain('"url": "https://private.example.test/chat"');
    expect(applyProfilePatchEdits(updated, result.inverseEdits)).toBe(source);
  });

  it('validates stream.doneValue as a bounded printable string and keeps the schema sentinel semantics', () => {
    const result = draft([{ path: ['stream', 'doneValue'], value: '[END]', reason: 'Use the server completion sentinel observed in the stream.' }]);
    const updated = applyProfilePatchEdits(source, result.edits);
    expect(updated).toContain('"doneValue": "[END]"');
    expect(result.changes.at(-1)?.after).toMatchObject({ kind: 'string', value: '[END]' });
    expect(applyProfilePatchEdits(updated, result.inverseEdits)).toBe(source);

    expect(() => draft([{ path: ['stream', 'doneValue'], value: 42 }])).toThrow(/doneValue/);
    expect(() => draft([{ path: ['stream', 'doneValue'], value: 'x'.repeat(257) }])).toThrow(/doneValue/);
    expect(() => draft([{ path: ['stream', 'doneValue'], value: 'https://private.example/done' }])).toThrow(/doneValue/);
    expect(() => draft([{ path: ['stream', 'doneValue'], value: 'Bearer secret-token-value' }])).toThrow(/doneValue/);
    expect(() => draft([{ path: ['stream', 'doneValue'], value: 'line\nend' }])).toThrow(/doneValue/);
    expect(() => draft([{ path: ['stream', 'doneValue'], value: '' }])).not.toThrow();
  });

  it('rejects malformed values, no-ops, duplicates, ancestor conflicts, and oversized input', () => {
    expect(() => draft([{ path: ['conversation', 'send', 'timeoutMs'], value: 0 }])).toThrow(ProfilePatchError);
    expect(() => draft([{ path: ['stream', 'mappings', 0, 'match', 'path'], value: 'https://evil.example/payload' }])).toThrow(ProfilePatchError);
    expect(() => draft([{ path: ['stream', 'mappings', 0, 'match', 'value'], value: { unsafe: true } }])).toThrow(ProfilePatchError);
    expect(() => draft([{ path: ['conversation', 'send', 'timeoutMs'], value: 20_000 }])).toThrow(/already has/);
    expect(() => draft([
      { path: ['conversation', 'send', 'timeoutMs'], value: 40_000 },
      { path: ['conversation', 'send', 'timeoutMs'], value: 50_000 },
    ])).toThrow(/Duplicate/);
    expect(() => draft([
      { path: ['stream', 'mappings', 0, 'match', 'path'], value: '$.one' },
      { path: ['stream', 'mappings', 0, 'match', 'path', 'nested'], value: '$.two' },
    ])).toThrow(ProfilePatchError);
    expect(() => createProfilePatchDraft({ profile, sourceText: `${source}${' '.repeat(2 * 1024 * 1024)}`, operations: [{ path: ['stream', 'transport'], value: 'ndjson' }] })).toThrow(ProfilePatchError);
  });

  it('fails closed on digest mismatch and verifies source/profile/serialized-result TOCTOU locks', () => {
    expect(() => assertExpectedProfileDigest(profile, 'f'.repeat(64))).toThrow(/changed/);
    const result = draft([{ path: ['stream', 'transport'], value: 'ndjson' }]);
    expect(verifyProfilePatchDraft({ profile, sourceText: source, draft: result }).valid).toBe(true);
    expect(verifyProfilePatchDraft({ profile, sourceText: `${source}\n`, draft: result }).valid).toBe(false);
    const tampered = { ...result, edits: result.edits.map((edit) => ({ ...edit, content: edit.content.replace('ndjson', 'json') })) };
    expect(verifyProfilePatchDraft({ profile, sourceText: source, draft: tampered }).valid).toBe(false);
    const changedProfile = { ...profile, name: 'Changed' };
    expect(verifyProfilePatchDraft({ profile: changedProfile, sourceText: source, draft: result }).valid).toBe(false);
  });

  it('validates drafts strictly and keeps reasons bounded and sanitized', () => {
    const result = draft([{ path: ['stream', 'transport'], value: 'ndjson', reason: 'Observed https://private.example.test/token and Bearer super-secret-value; use parser evidence.' }]);
    expect(result.changes[0]?.reason).not.toContain('https://');
    expect(result.changes[0]?.reason).not.toContain('Bearer super-secret-value');
    expect(validateProfilePatchDraft(result)).toEqual({ valid: true, errors: [] });
    expect(validateProfilePatchDraft({ ...result, unexpected: true })).toMatchObject({ valid: false });
    expect(validateProfilePatchDraft({ ...result, edits: [{ offset: 0, length: 0, content: 'https://secret.example' }] })).toMatchObject({ valid: false });
    expect(validateProfilePatchDraft({ ...result, safety: { ...result.safety, requiresConfirmation: false } })).toMatchObject({ valid: false });
  });

  it('rejects malformed JSONC and duplicate object keys before planning', () => {
    expect(() => createProfilePatchDraft({ profile, sourceText: '{ "version": 1,', operations: [{ path: ['stream', 'transport'], value: 'ndjson' }] })).toThrow(ProfilePatchError);
    const duplicate = source.replace('  "id": "demo",', '  "id": "demo",\n  "id": "other",');
    expect(() => createProfilePatchDraft({ profile, sourceText: duplicate, operations: [{ path: ['stream', 'transport'], value: 'ndjson' }] })).toThrow(/duplicate/i);
  });
});
