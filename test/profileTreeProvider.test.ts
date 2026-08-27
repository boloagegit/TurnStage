import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    toString(): string { return `file://${this.path}`; }
  }

  class RelativePattern {
    constructor(readonly base: unknown, readonly pattern: string) {}
  }

  class TreeItem {
    label?: string;
    collapsibleState: number;
    id?: string;
    description?: string;
    resourceUri?: Uri;
    iconPath?: unknown;
    tooltip?: unknown;
    command?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  class MarkdownString {
    constructor(readonly value: string) {}
  }

  class EventEmitter {
    readonly event = vi.fn(() => ({ dispose: vi.fn() }));
    readonly fire = vi.fn(() => undefined);
    readonly dispose = vi.fn();
  }

  return {
    Uri,
    RelativePattern,
    TreeItem,
    ThemeIcon,
    MarkdownString,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    l10n: { t: (value: string) => value },
    workspace: {
      workspaceFolders: [{ uri: new Uri('/workspace') }],
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      createFileSystemWatcher: () => ({ onDidCreate: vi.fn(), onDidChange: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn() }),
    },
  };
});

vi.mock('vscode', () => mock);

import {
  PROFILE_SECTIONS,
  ProfileSectionTreeItem,
  ProfileScopeTreeItem,
  ProfileTreeItem,
  ProfileTreeProvider,
} from '../src/extension/views/profileTreeProvider';

describe('ProfileTreeProvider', () => {
  it('exposes the profile sections as native tree children', async () => {
    const uri = new mock.Uri('/workspace/.vscode/turnstage/profiles/basic.turnstage.jsonc') as never;
    const entry = {
      uri,
      scope: 'workspace',
      profile: { id: 'basic', name: 'Basic SSE Chat', environment: 'local', stream: { transport: 'sse' } },
    };
    const provider = new ProfileTreeProvider({ discover: vi.fn(async () => [entry]), userProfileDirectory: () => undefined } as never);

    const roots = await provider.getChildren();
    expect(roots).toHaveLength(2);
    expect(roots.every((item) => item instanceof ProfileScopeTreeItem)).toBe(true);
    const profiles = await provider.getChildren(roots[0]);
    const profile = profiles[0];
    expect(profile).toBeInstanceOf(ProfileTreeItem);
    expect(profile?.collapsibleState).toBe(mock.TreeItemCollapsibleState.Collapsed);

    const children = await provider.getChildren(profile);
    expect(children.map((item) => item.label)).toEqual(PROFILE_SECTIONS.map((section) => section.label));
    expect(children.every((item) => item instanceof ProfileSectionTreeItem)).toBe(true);
  });

  it('opens each child with its profile URI and section id', () => {
    const uri = new mock.Uri('/workspace/.vscode/turnstage/profiles/basic.turnstage.jsonc') as never;

    for (const section of PROFILE_SECTIONS) {
      const child = new ProfileSectionTreeItem(uri, section);
      expect(child.contextValue).toBe('turnstageProfileSection');
      expect(child.iconPath).toMatchObject({ id: section.icon });
      expect(child.command).toEqual({
        command: 'turnstage.openProfileSection',
        title: `Open ${section.label}`,
        arguments: [uri, section.id],
      });
    }
  });

  it('returns an empty root so the native VS Code welcome view remains available', async () => {
    const provider = new ProfileTreeProvider({ discover: vi.fn(async () => []), userProfileDirectory: () => undefined } as never);

    expect(await provider.getChildren()).toEqual([]);
  });
});
