import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string; enablement?: string }>;
    views: Record<string, Array<{ id: string; name: string; icon?: string }>>;
    configuration: { properties: Record<string, { default?: unknown; description?: string; scope?: string; enum?: string[] }> };
    submenus: Array<{ id: string; label: string }>;
    menus: Record<string, Array<{ command?: string; submenu?: string; when?: string; group?: string }>>;
    walkthroughs: Array<{ id: string; title: string; description: string; steps: Array<{ id: string; title: string; description: string; media: { markdown: string }; completionEvents?: string[] }> }>;
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
    expect(manifest.contributes.menus['turnstage.profileTools']).toHaveLength(5);
    expect(manifest.contributes.menus['turnstage.profileManagement']).toHaveLength(2);
    expect(manifest.contributes.menus['turnstage.profileTools']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'turnstage.replayRun' }),
      expect.objectContaining({ command: 'turnstage.exportRun', when: 'isWorkspaceTrusted' }),
    ]));
  });

  it('backs every native menu action and icon with a command title tooltip', () => {
    const commands = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items) {
        if (!item.command) continue;
        expect(commands.get(item.command)?.title, `${item.command} must resolve to a titled command`).toBeTruthy();
      }
    }
    for (const command of manifest.contributes.commands.filter((item) => item.icon)) {
      expect(command.title, `${command.command} icon must have a tooltip title`).toBeTruthy();
    }
  });

  it('uses native custom-editor title actions for document commands', () => {
    const titleActions = manifest.contributes.menus['editor/title'] ?? [];
    expect(titleActions).toEqual([
      expect.objectContaining({ command: 'turnstage.newConversation', group: 'navigation@1', when: expect.stringContaining('!turnstage.turnActive') }),
      expect.objectContaining({ command: 'turnstage.openAsText', group: '1_modification@1' }),
    ]);
    expect(titleActions.filter((item) => item.group?.startsWith('navigation'))).toHaveLength(1);
  });

  it('keeps profile navigation native without command-only child rows', () => {
    expect(manifest.contributes.views.turnstage).toEqual([
      expect.objectContaining({ id: 'turnstage.profiles', icon: 'media/activity.svg' }),
    ]);
    const profileItems = manifest.contributes.menus['view/item/context'];
    expect(profileItems).toContainEqual(expect.objectContaining({ command: 'turnstage.configureProfile', group: 'inline@3' }));
    expect(profileItems).toContainEqual(expect.objectContaining({ command: 'turnstage.duplicateProfile', group: 'inline@4', when: expect.stringContaining('isWorkspaceTrusted') }));
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: 'turnstage.configureProfile', icon: '$(settings)' }));
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: 'turnstage.duplicateProfile', icon: '$(copy)' }));

    const english = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const traditionalChinese = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.zh-tw.json'), 'utf8')) as Record<string, string>;
    expect(english['command.createProfile']).toBe('Create Empty Profile');
    expect(traditionalChinese['command.createProfile']).toBe('建立空白 Profile');
  });

  it('uses a theme-aware, square Activity Bar icon that remains legible at native size', () => {
    const icon = readFileSync(resolve(import.meta.dirname, '..', 'media', 'activity.svg'), 'utf8');
    expect(icon).toContain('viewBox="0 0 24 24"');
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).toContain('fill="currentColor"');
    expect(icon).toContain('<rect x="2.5" y="2.5" width="19" height="19"');
    expect(icon).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('uses one native VS Code walkthrough with a persistent sidebar entry', () => {
    expect(manifest.contributes.walkthroughs).toHaveLength(1);
    const walkthrough = manifest.contributes.walkthroughs[0]!;
    expect(walkthrough).toMatchObject({ id: 'gettingStarted', title: '%walkthrough.title%' });
    expect(walkthrough.steps.map((step) => step.id)).toEqual(['tryDemo', 'createProfile', 'configureFlow', 'inspectRun']);
    expect(walkthrough.steps).toHaveLength(4);
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: 'turnstage.openGuide', icon: '$(book)' }));
    expect(manifest.contributes.menus['view/title']).toContainEqual(expect.objectContaining({ command: 'turnstage.openGuide', group: 'navigation@4' }));

    const english = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const traditionalChinese = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.nls.zh-tw.json'), 'utf8')) as Record<string, string>;
    for (const step of walkthrough.steps) {
      const key = step.media.markdown.slice(1, -1);
      expect(existsSync(resolve(import.meta.dirname, '..', english[key]!))).toBe(true);
      expect(existsSync(resolve(import.meta.dirname, '..', traditionalChinese[key]!))).toBe(true);
    }
  });

  it('provides an enabled user-level notification preference', () => {
    expect(manifest.contributes.configuration.properties['turnstage.notifications.enabled']).toMatchObject({ default: true });
  });

  it('provides an application-wide TurnStage editor language preference', () => {
    expect(manifest.contributes.configuration.properties['turnstage.displayLanguage']).toMatchObject({
      default: 'auto',
      scope: 'application',
      enum: ['auto', 'zh-tw', 'en'],
    });
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: 'turnstage.changeDisplayLanguage' }));
  });

  it('disables trust-sensitive native actions before invocation', () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'turnstage.startSession', enablement: 'isWorkspaceTrusted' }),
      expect.objectContaining({ command: 'turnstage.newConversation', enablement: 'isWorkspaceTrusted' }),
      expect.objectContaining({ command: 'turnstage.importRun', enablement: 'isWorkspaceTrusted' }),
      expect.objectContaining({ command: 'turnstage.exportRun', enablement: 'isWorkspaceTrusted' }),
      expect.objectContaining({ command: 'turnstage.exportEvidenceBundle', enablement: 'isWorkspaceTrusted' }),
    ]));
    expect(manifest.contributes.menus['view/item/context']).toContainEqual(expect.objectContaining({
      command: 'turnstage.runProfile',
      when: expect.stringContaining('isWorkspaceTrusted'),
    }));
  });

  it('offers failure evidence from the native test-message toolbar and context menu', () => {
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({
      command: 'turnstage.openTestEvidence',
      icon: '$(go-to-file)',
    }));
    for (const menu of ['testing/message/content', 'testing/message/context']) {
      expect(manifest.contributes.menus[menu]).toContainEqual({
        command: 'turnstage.openTestEvidence',
        when: 'testMessage =~ /^turnstage\\.evidence\\./',
        group: 'navigation@1',
      });
    }
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: 'turnstage.openTestEvidence',
      when: 'false',
    });
  });

  it('exposes sanitized contract report export as a native command', () => {
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({
      command: 'turnstage.runContractTests',
      icon: '$(run-all)',
      enablement: 'isWorkspaceTrusted',
    }));
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({
      command: 'turnstage.exportTestReport',
      icon: '$(export)',
    }));
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({
      command: 'turnstage.exportEvidenceBundle',
      icon: '$(package)',
      enablement: 'isWorkspaceTrusted',
    }));
  });
});
