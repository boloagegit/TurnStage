import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { ProfileMigrator } from '../src/extension/config/profileMigration';

describe('ProfileMigrator', () => {
  it.each([
    ['an explicit version 0', '{\n  "version": 0,\n  "id": "demo",\n  "name": "Demo"\n}'],
    ['a missing version', '{\n  "id": "demo",\n  "name": "Demo"\n}'],
  ])('migrates $0 profiles to version 1', (_label, text) => {
    const result = new ProfileMigrator().migrate(text);

    expect(result).toMatchObject({
      changed: true,
      fromVersion: 0,
      toVersion: 1,
      notes: ['Set profile version to 1. Review the profile against the current schema.'],
    });
    expect(parse(result.text)).toMatchObject({ version: 1, id: 'demo', name: 'Demo' });
    expect(text).not.toContain('"version": 1');
  });

  it('applies a structured version patch without rewriting JSONC comments or formatting', () => {
    const text = `{
  // Keep this explanation next to the profile identity.
  "version": 0,
  "id": "demo",
  "name": "Demo",
}`;

    const result = new ProfileMigrator().migrate(text);

    expect(result.text).toBe(`{
  // Keep this explanation next to the profile identity.
  "version": 1,
  "id": "demo",
  "name": "Demo",
}`);
    expect(result.text).toContain('// Keep this explanation next to the profile identity.');
    expect(parse(result.text)).toMatchObject({ version: 1, id: 'demo', name: 'Demo' });
  });

  it('does not change an already current version 1 profile', () => {
    const text = `{
  // Preserve current JSONC byte-for-byte.
  "version": 1,
  "id": "demo",
}`;

    const result = new ProfileMigrator().migrate(text);

    expect(result).toEqual({ changed: false, fromVersion: 1, toVersion: 1, text, notes: [] });
  });

  it('rejects unsupported source versions', () => {
    expect(() => new ProfileMigrator().migrate('{ "version": 2, "id": "demo" }')).toThrow(
      'No migration is available for version 2.',
    );
  });
});
