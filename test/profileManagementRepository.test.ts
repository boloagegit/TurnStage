import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.path.replace(/\/$/, '')}/${parts.join('/')}`.replace(/\/+/g, '/')); }
    with(change: { path: string }): Uri { return new Uri(change.path); }
    toString(): string { return `file://${this.path}`; }
  }
  const files = new Map<string, Uint8Array>();
  const workspace = {
    workspaceFolders: [{ name: 'workspace', index: 0, uri: new Uri('/workspace') }],
    textDocuments: [] as Array<{ uri: Uri; getText(): string }>,
    getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }),
    findFiles: async () => [...files.keys()].filter((path) => path.startsWith('/workspace/') && path.endsWith('.turnstage.jsonc')).map((path) => new Uri(path)),
    fs: {
      readFile: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('Not found'); return value; },
      writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.path, bytes); },
      createDirectory: async () => undefined,
      stat: async (uri: Uri) => { if (!files.has(uri.path)) throw new Error('Not found'); return { type: 1 }; },
    },
  };
  return { Uri, files, workspace };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, workspace: mock.workspace }));

import { ProfileRepository } from '../src/extension/config/profileRepository';

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
});
