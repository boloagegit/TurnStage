import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { copyFileName, copyProfileId, duplicateProfileGroups, duplicateProfileText, importedProfileFileName } from '../src/extension/config/profileManagement';

describe('profile management', () => {
  it('groups every entry that shares an exact non-empty profile id', () => {
    const first = { uri: 'workspace-a/profile.turnstage.jsonc' };
    const second = { uri: 'workspace-b/profile.turnstage.jsonc' };
    const groups = duplicateProfileGroups([
      { item: first, id: 'shared' },
      { item: second, id: 'shared' },
      { item: { uri: 'unique' }, id: 'unique' },
      { item: { uri: 'empty' }, id: '  ' },
    ]);

    expect(groups).toEqual([{ id: 'shared', items: [first, second] }]);
  });

  it('does not silently canonicalize distinct ids', () => {
    expect(duplicateProfileGroups([
      { item: 1, id: 'profile' },
      { item: 2, id: ' profile ' },
    ])).toEqual([]);
  });

  it('generates stable duplicate-safe file names without losing the compound extension', () => {
    expect(copyFileName('agent.turnstage.jsonc')).toBe('agent-copy.turnstage.jsonc');
    expect(copyFileName('agent.turnstage.jsonc', 3)).toBe('agent-copy-3.turnstage.jsonc');
    expect(copyProfileId('agent')).toBe('agent-copy');
    expect(copyProfileId('agent', 3)).toBe('agent-copy-3');
  });

  it('normalizes imported JSON and JSONC names to discoverable profile names', () => {
    expect(importedProfileFileName('agent.json')).toBe('agent.turnstage.jsonc');
    expect(importedProfileFileName('agent.jsonc')).toBe('agent.turnstage.jsonc');
    expect(importedProfileFileName('agent.turnstage.jsonc')).toBe('agent.turnstage.jsonc');
    expect(importedProfileFileName('AGENT.TURNSTAGE.JSONC')).toBe('AGENT.turnstage.jsonc');
  });

  it('updates duplicate identity safely even when the source has no name property', () => {
    const result = duplicateProfileText('{\n  // keep comments\n  "version": 1,\n  "id": "agent"\n}', 'agent-copy', 'Agent Copy');

    expect(parse(result)).toMatchObject({ id: 'agent-copy', name: 'Agent Copy' });
    expect(result).toContain('// keep comments');
  });
});
