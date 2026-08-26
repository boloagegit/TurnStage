import { describe, expect, it } from 'vitest';
import { isWorkspaceSection, WORKSPACE_SECTIONS } from '../src/shared/protocol';

describe('workspace section protocol', () => {
  it('accepts every section exposed by the profile tree', () => {
    expect(WORKSPACE_SECTIONS.every(isWorkspaceSection)).toBe(true);
  });

  it('rejects legacy workspace tabs and untrusted values', () => {
    expect(isWorkspaceSection('Settings')).toBe(false);
    expect(isWorkspaceSection('runs')).toBe(false);
    expect(isWorkspaceSection({ section: 'test' })).toBe(false);
  });
});
