import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const state = { glob: '.vscode/turnstage/profiles/*.turnstage.jsonc', patterns: [] as string[], disposed: [] as string[] };
  const listeners: { configuration?: (event: { affectsConfiguration(section: string): boolean }) => void; folders?: () => void } = {};
  class RelativePattern { constructor(readonly base: { uri?: { path: string }; path?: string }, readonly pattern: string) {} }
  const vscode = {
    RelativePattern,
    workspace: {
      workspaceFolders: [{ uri: { path: '/workspace' } }] as Array<{ uri: { path: string } }>,
      getConfiguration: () => ({ get: () => state.glob }),
      createFileSystemWatcher: (pattern: RelativePattern) => {
        state.patterns.push(pattern.pattern);
        const subscription = () => ({ dispose: vi.fn() });
        return { onDidCreate: subscription, onDidChange: subscription, onDidDelete: subscription, dispose: () => { state.disposed.push(pattern.pattern); } };
      },
      onDidChangeConfiguration: (listener: typeof listeners.configuration) => { listeners.configuration = listener; return { dispose: vi.fn() }; },
      onDidChangeWorkspaceFolders: (listener: typeof listeners.folders) => { listeners.folders = listener; return { dispose: vi.fn() }; },
    },
  };
  return { state, listeners, vscode };
});

vi.mock('vscode', () => mock.vscode);

import { ProfileFileWatcher } from '../src/extension/config/profileFileWatcher';

describe('ProfileFileWatcher', () => {
  beforeEach(() => {
    mock.state.glob = '.vscode/turnstage/profiles/*.turnstage.jsonc';
    mock.state.patterns.length = 0;
    mock.state.disposed.length = 0;
  });

  it('rebuilds its watchers and notifies when turnstage.profileGlob changes', () => {
    const onChange = vi.fn();
    const watcher = new ProfileFileWatcher({ userProfileDirectory: () => ({ path: '/user/profiles' }) } as never, onChange);
    expect(mock.state.patterns).toEqual(['.vscode/turnstage/profiles/*.turnstage.jsonc', '*.turnstage.jsonc']);

    mock.state.glob = 'profiles/**/*.turnstage.jsonc';
    mock.listeners.configuration?.({ affectsConfiguration: (section) => section === 'turnstage.logLevel' });
    expect(onChange).not.toHaveBeenCalled();
    mock.listeners.configuration?.({ affectsConfiguration: (section) => section === 'turnstage.profileGlob' });

    expect(mock.state.disposed).toEqual(['.vscode/turnstage/profiles/*.turnstage.jsonc', '*.turnstage.jsonc']);
    expect(mock.state.patterns.slice(2)).toEqual(['profiles/**/*.turnstage.jsonc', '*.turnstage.jsonc']);
    expect(onChange).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it('watches folders added to the workspace', () => {
    const onChange = vi.fn();
    const watcher = new ProfileFileWatcher({ userProfileDirectory: () => undefined } as never, onChange);
    mock.vscode.workspace.workspaceFolders = [{ uri: { path: '/workspace' } }, { uri: { path: '/second' } }];
    mock.listeners.folders?.();
    expect(mock.state.patterns).toHaveLength(3);
    expect(onChange).toHaveBeenCalledOnce();
    watcher.dispose();
    mock.vscode.workspace.workspaceFolders = [{ uri: { path: '/workspace' } }];
  });
});
