import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.path.replace(/\/$/, '')}/${parts.join('/')}`.replace(/\/+/g, '/')); }
    with(change: { path: string }): Uri { return new Uri(change.path); }
    toString(): string { return `file://${this.path}`; }
  }
  class RelativePattern {
    constructor(readonly base: unknown, readonly pattern: string) {}
    toString(): string { return this.pattern; }
  }
  const files = new Map<string, Uint8Array>();
  const workspace = {
    workspaceFolders: [{ name: 'workspace', index: 0, uri: new Uri('/workspace') }],
    textDocuments: [] as Array<{ uri: Uri; getText(): string }>,
    getWorkspaceFolder: (uri: Uri) => uri.path.startsWith('/workspace/') ? workspace.workspaceFolders[0] : undefined,
    getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }),
    findFiles: async (include: unknown) => {
      const suffix = String(include).includes('environment') ? '.environment.jsonc' : '.turnstage.jsonc';
      return [...files.keys()].filter((path) => path.startsWith('/workspace/') && path.endsWith(suffix)).map((path) => new Uri(path));
    },
    fs: {
      readFile: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('Not found'); return value; },
      writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.path, bytes); },
      createDirectory: async () => undefined,
      readDirectory: async (uri: Uri) => [...files.keys()]
        .filter((path) => path.startsWith(`${uri.path.replace(/\/$/, '')}/`) && !path.slice(uri.path.length + 1).includes('/'))
        .map((path) => [path.slice(path.lastIndexOf('/') + 1), 1] as [string, number]),
      stat: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('Not found'); return { type: 1, size: value.byteLength }; },
    },
  };
  return { Uri, RelativePattern, files, workspace, FileType: { File: 1 } };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, RelativePattern: mock.RelativePattern, workspace: mock.workspace, FileType: mock.FileType }));

import { EnvironmentRepository, ProfileRepository } from '../src/extension/config/profileRepository';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

describe('ProfileRepository management', () => {
  beforeEach(() => {
    mock.files.clear();
    mock.workspace.textDocuments.length = 0;
  });

  it('imports through workspace.fs and chooses a safe discoverable target name', async () => {
    const source = new mock.Uri('/downloads/agent.json');
    mock.files.set(source.path, encode('{ "version": 1, "id": "agent", "name": "Agent" }'));
    mock.files.set('/workspace/.vscode/turnstage/profiles/agent.turnstage.jsonc', encode('{}'));

    const target = await new ProfileRepository().import(source as never, mock.workspace.workspaceFolders[0] as never);

    expect(target.path).toBe('/workspace/.vscode/turnstage/profiles/agent-copy.turnstage.jsonc');
    expect(parse(decode(mock.files.get(target.path)))).toMatchObject({ id: 'agent', name: 'Agent' });
  });

  it('duplicates a profile without overwriting and assigns an unused workspace-wide id', async () => {
    const source = new mock.Uri('/workspace/.vscode/turnstage/profiles/agent.turnstage.jsonc');
    mock.files.set(source.path, encode('{\n  // preserved\n  "version": 1,\n  "id": "agent",\n  "name": "Agent"\n}'));
    mock.files.set('/workspace/.vscode/turnstage/profiles/existing.turnstage.jsonc', encode('{ "version": 1, "id": "agent-copy", "name": "Existing" }'));

    const target = await new ProfileRepository().duplicate(source as never);
    const duplicated = decode(mock.files.get(target.path));

    expect(target.path).toBe('/workspace/.vscode/turnstage/profiles/agent-copy.turnstage.jsonc');
    expect(parse(duplicated)).toMatchObject({ id: 'agent-copy-2', name: 'Agent Copy 2' });
    expect(duplicated).toContain('// preserved');
    expect(parse(decode(mock.files.get(source.path)))).toMatchObject({ id: 'agent', name: 'Agent' });
  });

  it('discovers user and workspace profiles with explicit scopes', async () => {
    mock.files.set('/workspace/.vscode/turnstage/profiles/shared.turnstage.jsonc', encode('{ "version": 1, "id": "shared", "name": "Workspace" }'));
    mock.files.set('/global/configuration/profiles/shared.turnstage.jsonc', encode('{ "version": 1, "id": "shared", "name": "User" }'));

    const entries = await new ProfileRepository(new mock.Uri('/global') as never).discover();

    expect(entries.map((entry) => ({ id: entry.profile?.id, scope: entry.scope, overridden: entry.overridden ?? false }))).toEqual([
      { id: 'shared', scope: 'workspace', overridden: false },
      { id: 'shared', scope: 'user', overridden: true },
    ]);
  });

  it('imports a profile into user storage without requiring a workspace target', async () => {
    const source = new mock.Uri('/downloads/shared.json');
    mock.files.set(source.path, encode('{ "version": 1, "id": "shared", "name": "Shared" }'));

    const target = await new ProfileRepository(new mock.Uri('/global') as never).import(source as never, 'user');

    expect(target.path).toBe('/global/configuration/profiles/shared.turnstage.jsonc');
  });

  it('rejects oversized profile input before parsing or copying it', async () => {
    const source = new mock.Uri('/downloads/oversized.json');
    mock.files.set(source.path, new Uint8Array(5 * 1024 * 1024 + 1));
    const repository = new ProfileRepository();
    await expect(repository.import(source as never, mock.workspace.workspaceFolders[0] as never)).rejects.toThrow(/5 MB/i);
    await expect(repository.read(source as never)).resolves.toMatchObject({ error: expect.stringMatching(/5 MB/i) });
  });

  it('uses a workspace environment before a user environment with the same id', async () => {
    mock.files.set('/workspace/.vscode/turnstage/environments/local.environment.jsonc', encode('{ "version": 1, "id": "local", "name": "Workspace Local", "variables": {} }'));
    mock.files.set('/global/configuration/environments/local.environment.jsonc', encode('{ "version": 1, "id": "local", "name": "User Local", "variables": {} }'));

    const entries = await new EnvironmentRepository(new mock.Uri('/global') as never).discover();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'workspace', environment: { id: 'local', name: 'Workspace Local' } });
  });

  it('keeps a user profile on user environments in a multi-root-safe way', async () => {
    mock.files.set('/workspace/.vscode/turnstage/environments/local.environment.jsonc', encode('{ "version": 1, "id": "local", "name": "Workspace Local", "variables": {} }'));
    mock.files.set('/global/configuration/environments/local.environment.jsonc', encode('{ "version": 1, "id": "local", "name": "User Local", "variables": {} }'));

    const entries = await new EnvironmentRepository(new mock.Uri('/global') as never).discover(new mock.Uri('/global/configuration/profiles/shared.turnstage.jsonc') as never);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: 'user', environment: { id: 'local', name: 'User Local' } });
  });

  it('allows the same profile id in user and workspace scopes as an explicit layer override', () => {
    const repository = new ProfileRepository(new mock.Uri('/global') as never);
    const groups = repository.duplicateGroups([
      { uri: new mock.Uri('/workspace/.vscode/turnstage/profiles/shared.turnstage.jsonc'), scope: 'workspace', profile: { id: 'shared' } },
      { uri: new mock.Uri('/global/configuration/profiles/shared.turnstage.jsonc'), scope: 'user', profile: { id: 'shared' } },
    ] as never);

    expect(groups).toEqual([]);
  });
});
