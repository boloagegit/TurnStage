import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const uri = (path: string) => ({ path });
  const workspace: { workspaceFolders?: Array<{ uri: { path: string } }>; getWorkspaceFolder: ReturnType<typeof vi.fn> } = { workspaceFolders: undefined, getWorkspaceFolder: vi.fn() };
  return { uri, workspace, vscode: { workspace, Uri: { file: uri, joinPath: (base: { path: string }, ...segments: string[]) => uri([base.path.replace(/\/$/, ''), ...segments].join('/')) } } };
});

vi.mock('vscode', () => mock.vscode);
vi.mock('node:os', () => ({ homedir: () => '/home/tester' }));

import { defaultExportUri } from '../src/extension/exportLocation';

describe('defaultExportUri', () => {
  beforeEach(() => {
    mock.workspace.workspaceFolders = undefined;
    mock.workspace.getWorkspaceFolder.mockReset();
  });

  it('prefers the workspace folder that owns the related document', () => {
    mock.workspace.workspaceFolders = [{ uri: mock.uri('/first') }];
    mock.workspace.getWorkspaceFolder.mockReturnValue({ uri: mock.uri('/owner') });
    expect(defaultExportUri('run.json', mock.uri('/owner/profile.turnstage.jsonc') as never).path).toBe('/owner/run.json');
  });

  it('falls back to the first workspace folder, then the home directory, never the filesystem root', () => {
    mock.workspace.workspaceFolders = [{ uri: mock.uri('/first') }];
    expect(defaultExportUri('report.html').path).toBe('/first/report.html');
    mock.workspace.workspaceFolders = undefined;
    expect(defaultExportUri('report.html').path).toBe('/home/tester/report.html');
  });
});
