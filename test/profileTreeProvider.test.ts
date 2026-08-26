import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    toString(): string { return `file://${this.path}`; }
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
    TreeItem,
    ThemeIcon,
    MarkdownString,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: { workspaceFolders: [] },
  };
});

vi.mock('vscode', () => mock);

import {
  PROFILE_SECTIONS,
  ProfileSectionTreeItem,
  ProfileTreeItem,
  ProfileTreeProvider,
} from '../src/extension/views/profileTreeProvider';

describe('ProfileTreeProvider', () => {
  it('exposes the profile sections as native tree children', async () => {
    const uri = new mock.Uri('/workspace/.vscode/turnstage/profiles/basic.turnstage.jsonc') as never;
    const entry = {
      uri,
      profile: { id: 'basic', name: 'Basic SSE Chat', environment: 'local', stream: { transport: 'sse' } },
    };
    const provider = new ProfileTreeProvider({ discover: vi.fn(async () => [entry]) } as never);

    const roots = await provider.getChildren();
    expect(roots).toHaveLength(1);
    const profile = roots[0];
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
});
