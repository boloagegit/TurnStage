import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    submenus: Array<{ id: string; label: string }>;
    menus: Record<string, Array<{ command?: string; submenu?: string; when?: string; group?: string }>>;
  };
};

describe('VS Code contribution UX', () => {
  it('keeps profile context commands grouped into three contextual submenus', () => {
    const profileItems = manifest.contributes.menus['view/item/context']
      ?.filter((item) => item.when?.includes('viewItem == turnstageProfile') && !item.when.includes('turnstageProfileScope') && !item.group?.startsWith('inline')) ?? [];

    expect(profileItems).toEqual([
      expect.objectContaining({ submenu: 'turnstage.profileSession' }),
      expect.objectContaining({ submenu: 'turnstage.profileTools' }),
      expect.objectContaining({ submenu: 'turnstage.profileManagement' }),
    ]);
    expect(manifest.contributes.submenus.map((submenu) => submenu.id)).toEqual([
      'turnstage.profileSession',
      'turnstage.profileTools',
      'turnstage.profileManagement',
    ]);
  });

  it('keeps direct profile menu groups bounded', () => {
    expect(manifest.contributes.menus['turnstage.profileSession']).toHaveLength(3);
    expect(manifest.contributes.menus['turnstage.profileTools']).toHaveLength(4);
    expect(manifest.contributes.menus['turnstage.profileManagement']).toHaveLength(2);
  });

  it('uses native custom-editor title actions for document commands', () => {
    expect(manifest.contributes.menus['editor/title']).toEqual([
      expect.objectContaining({ command: 'turnstage.newConversation', group: 'navigation@1' }),
      expect.objectContaining({ command: 'turnstage.openAsText', group: 'navigation@2' }),
    ]);
  });
});
