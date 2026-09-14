// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProfileOrganization, normalizeProfileOrganization, saveProfileOrganization } from '../web/src/profileOrganization';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
});

describe('Web profile folders', () => {
  it('starts empty and persists folders without changing profiles or official catalog data', () => {
    expect(loadProfileOrganization()).toEqual({ folders: [], assignments: {}, collapsed: [] });
    saveProfileOrganization({ folders: [{ id: 'team-sit', name: 'SIT' }], assignments: { official: 'team-sit', local: 'team-sit' }, collapsed: ['folder:team-sit'] });
    expect(loadProfileOrganization()).toEqual({ folders: [{ id: 'team-sit', name: 'SIT' }], assignments: { official: 'team-sit', local: 'team-sit' }, collapsed: ['folder:team-sit'] });
    expect(localStorage.getItem('turnstage.web.profiles.v1')).toBeNull();
  });

  it('discards malformed, duplicate and deleted folder references', () => {
    const normalized = normalizeProfileOrganization({
      folders: [{ id: 'one', name: ' Team ' }, { id: 'one', name: 'Duplicate' }, { id: '../bad', name: 'Unsafe' }, { id: 'blank', name: '   ' }],
      assignments: { alice: 'one', bob: 'missing' }, collapsed: ['folder:one', 'folder:one', 'folder:missing', 'local'],
    });
    expect(normalized).toEqual({ folders: [{ id: 'one', name: 'Team' }], assignments: { alice: 'one' }, collapsed: ['folder:one', 'local'] });
    localStorage.setItem('turnstage.web.profileOrganization.v1', '{bad');
    expect(loadProfileOrganization()).toEqual({ folders: [], assignments: {}, collapsed: [] });
  });

  it('persists nested folders in sibling order and repairs cycles or missing parents', () => {
    const folders = [{ id: 'team', name: 'Team' }, { id: 'sit', name: 'SIT', parentId: 'team' }, { id: 'uat', name: 'UAT', parentId: 'team' }];
    saveProfileOrganization({ folders, assignments: { demo: 'sit' }, collapsed: ['folder:team', 'folder:sit'] });
    expect(loadProfileOrganization().folders).toEqual(folders);
    expect(normalizeProfileOrganization({ folders: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'gone' }], assignments: {}, collapsed: [] }).folders).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C' }]);
  });
});
