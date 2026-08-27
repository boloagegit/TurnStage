import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation, TurnStageProfile } from '../src/shared/types';

const mock = vi.hoisted(() => {
  class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;

    constructor(scheme: string, path: string, authority = '') {
      this.scheme = scheme;
      this.path = path;
      this.authority = authority;
    }

    static file(path: string): Uri { return new Uri('file', path); }

    static parse(value: string): Uri {
      const parsed = new URL(value);
      return new Uri(parsed.protocol.slice(0, -1), parsed.pathname || '/', parsed.host);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments = `${base.path.replace(/\/+$/, '')}/${parts.join('/')}`.split('/');
      const normalized: string[] = [];
      for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') { normalized.pop(); continue; }
        normalized.push(segment);
      }
      return new Uri(base.scheme, `/${normalized.join('/')}`, base.authority);
    }

    toString(): string { return `${this.scheme}://${this.authority}${this.path}`; }
  }

  const openExternal = vi.fn(async () => true);
  const executeCommand = vi.fn(async () => undefined);
  const workspace = {
    isTrusted: true,
    getWorkspaceFolder: vi.fn((uri: Uri) => uri.path.startsWith('/workspace/') ? { uri: new Uri('file', '/workspace') } : undefined),
    asRelativePath: vi.fn((uri: Uri) => {
      const root = '/workspace';
      if (uri.path === root) return '';
      if (uri.path.startsWith(`${root}/`)) return uri.path.slice(root.length + 1);
      return `../${uri.path.replace(/^\/+/, '')}`;
    }),
    openTextDocument: vi.fn(async (uri: Uri) => ({ uri })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: unknown) => fallback) })),
  };

  return {
    Uri,
    workspace,
    env: { openExternal, clipboard: { writeText: vi.fn(async () => undefined) } },
    commands: { executeCommand },
    window: { showTextDocument: vi.fn(async (document: unknown) => document) },
  };
});

vi.mock('vscode', () => mock);

import { SecretService, UriPolicy, redactDeep, redactHeaders } from '../src/extension/security/security';
import { TurnStageEditorProvider } from '../src/extension/editors/turnstageEditorProvider';

const profileUri = new mock.Uri('file', '/workspace/.vscode/turnstage/profiles/demo.turnstage.jsonc');

function profile(security?: TurnStageProfile['security']): TurnStageProfile {
  return {
    version: 1,
    id: 'security-test',
    name: 'Security test',
    conversation: { send: { method: 'POST', url: 'https://example.test' } },
    stream: { transport: 'sse', mappings: [] },
    ...(security ? { security } : {}),
  };
}

function citation(value: Partial<Citation>): Citation {
  return { id: 'citation-1', ...value };
}

beforeEach(() => {
  mock.workspace.isTrusted = true;
  mock.workspace.getWorkspaceFolder.mockImplementation((uri: InstanceType<typeof mock.Uri>) => uri.path.startsWith('/workspace/') ? { uri: new mock.Uri('file', '/workspace') } : undefined);
  vi.clearAllMocks();
});

describe('UriPolicy', () => {
  const policy = new UriPolicy();

  it('allows HTTPS by default and opens it through VS Code', async () => {
    await policy.open(citation({ kind: 'url', uri: 'https://api.example.test/docs' }), profile(), profileUri as never);

    expect(mock.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'https', authority: 'api.example.test', path: '/docs' }));
  });

  it('requires explicit opt-in for HTTP and allows an explicitly configured scheme', async () => {
    await expect(policy.open(citation({ kind: 'url', uri: 'http://api.example.test/docs' }), profile(), profileUri as never)).rejects.toThrow('URI scheme http is not allowed.');

    await policy.open(citation({ kind: 'url', uri: 'http://api.example.test/docs' }), profile({ allowedUriSchemes: ['http'] }), profileUri as never);
    expect(mock.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it.each(['javascript:alert(1)', 'command:workbench.action.files.openFile', 'data:text/plain,secret'])('rejects dangerous URI scheme %s even when configured', async (uri) => {
    await expect(policy.open(citation({ kind: 'url', uri }), profile({ allowedUriSchemes: ['javascript', 'command', 'data'] }), profileUri as never)).rejects.toThrow(/URI scheme .* is not allowed\./);
    expect(mock.env.openExternal).not.toHaveBeenCalled();
  });

  it('matches an allowlisted domain exactly', async () => {
    const restricted = profile({ allowedDomains: ['api.example.test'] });

    await policy.open(citation({ kind: 'url', uri: 'https://api.example.test/docs' }), restricted, profileUri as never);
    await expect(policy.open(citation({ kind: 'url', uri: 'https://api.example.test.evil/docs' }), restricted, profileUri as never)).rejects.toThrow('Domain api.example.test.evil is not allowed.');

    expect(mock.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it('rejects URL and file citations when the workspace is untrusted', async () => {
    mock.workspace.isTrusted = false;

    await expect(policy.open(citation({ kind: 'url', uri: 'https://api.example.test/docs' }), profile(), profileUri as never)).rejects.toThrow('This workspace is not trusted. Network requests are disabled.');
    await expect(policy.open(citation({ kind: 'file', path: 'docs/readme.md' }), profile(), profileUri as never)).rejects.toThrow('This workspace is not trusted. Network requests are disabled.');
    expect(mock.env.openExternal).not.toHaveBeenCalled();
    expect(mock.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('opens a workspace-relative file citation through the text editor', async () => {
    await policy.open(citation({ kind: 'file', path: 'docs/readme.md' }), profile(), profileUri as never);

    const document = await mock.workspace.openTextDocument.mock.results[0]?.value;
    expect(mock.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ path: '/workspace/docs/readme.md' }));
    expect(mock.window.showTextDocument).toHaveBeenCalledWith(await document);
  });

  it.each(['../outside.txt', '../../etc/passwd', '../workspace-evil/secret.txt'])('rejects a path outside the workspace: %s', async (path) => {
    await expect(policy.open(citation({ kind: 'file', path }), profile(), profileUri as never)).rejects.toThrow('Files outside the workspace are not allowed.');
    expect(mock.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(mock.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('rejects file citations whose profile is not in a workspace folder', async () => {
    const externalProfileUri = new mock.Uri('file', '/outside/profile.turnstage.jsonc');

    await expect(policy.open(citation({ kind: 'file', path: 'readme.md' }), profile(), externalProfileUri as never)).rejects.toThrow('The profile is not inside a workspace folder.');
  });
});

describe('SecretService', () => {
  it('wraps SecretStorage with a prefixed key and maintains a sorted, de-duplicated name index', async () => {
    const globalValues = new Map<string, unknown>();
    const secretValues = new Map<string, string>();
    const context = {
      globalState: {
        get: (key: string, fallback?: unknown) => globalValues.get(key) ?? fallback,
        update: vi.fn(async (key: string, value: unknown) => { globalValues.set(key, value); }),
      },
      secrets: {
        get: vi.fn(async (key: string) => secretValues.get(key)),
        store: vi.fn(async (key: string, value: string) => { secretValues.set(key, value); }),
        delete: vi.fn(async (key: string) => { secretValues.delete(key); }),
      },
    };
    const service = new SecretService(context as never);

    await service.set('zeta', 'zeta-secret');
    await service.set('alpha', 'alpha-secret');
    await service.set('zeta', 'updated-zeta-secret');

    expect(context.secrets.store).toHaveBeenCalledWith('turnstage.zeta', 'zeta-secret');
    expect(context.secrets.store).toHaveBeenCalledWith('turnstage.alpha', 'alpha-secret');
    expect(await service.get('zeta')).toBe('updated-zeta-secret');
    expect(service.names()).toEqual(['alpha', 'zeta']);
    expect(globalValues.get('turnstage.secretNames')).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify([...globalValues.values()])).not.toContain('secret');

    await service.remove('alpha');
    expect(context.secrets.delete).toHaveBeenCalledWith('turnstage.alpha');
    expect(service.names()).toEqual(['zeta']);
    expect(await service.get('alpha')).toBeUndefined();
  });
});

describe('redaction helpers', () => {
  it('masks Set-Cookie, Proxy-Authorization, and empty sensitive headers', () => {
    expect(redactHeaders({
      'Set-Cookie': 'session=abc',
      'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      'X-API-Key': '',
      Accept: 'application/json',
    })).toEqual({
      'Set-Cookie': '••••••••',
      'Proxy-Authorization': 'Basic ••••••••',
      'X-API-Key': '••••••••',
      Accept: 'application/json',
    });
  });

  it('masks case-insensitive sensitive body keys at every nested level while preserving safe values', () => {
    const body = {
      headers: { 'SET-COOKIE': 'session=abc', 'proxy-AUTHORIZATION': 'Basic abc' },
      credentials: { apiToken: 'token-value', PASSWORD: 'password-value', displayName: 'visible' },
      records: [{ 'x-api-key': 'key-value', note: 'visible note' }],
    };

    expect(redactDeep(body)).toEqual({
      headers: { 'SET-COOKIE': '••••••••', 'proxy-AUTHORIZATION': '••••••••' },
      credentials: { apiToken: '••••••••', PASSWORD: '••••••••', displayName: 'visible' },
      records: [{ 'x-api-key': '••••••••', note: 'visible note' }],
    });
    expect(body.credentials.apiToken).toBe('token-value');
  });
});

describe('profile command allowlist', () => {
  type ActionProvider = { invokeAction: (actionId: string, sourceMessageId: string | undefined, controller: unknown) => Promise<void> };

  function invoke(actionId: string, controller: unknown): Promise<void> {
    const provider = Object.create(TurnStageEditorProvider.prototype) as ActionProvider;
    return provider.invokeAction(actionId, 'message-1', controller);
  }

  function controller(allowedCommands: string[], actionId = 'workbench.action.test') {
    return {
      profile: profile({ allowedCommands }),
      snapshot: { messages: [{ id: 'message-1', actions: [{ id: 'run-command', label: 'Run', actionId: `vscodeCommand.invoke:${actionId}` }] }] },
    };
  }

  it('executes a command only when the exact command is allowlisted', async () => {
    await invoke('run-command', controller(['workbench.action.test']));

    expect(mock.commands.executeCommand).toHaveBeenCalledWith('workbench.action.test');
  });

  it('rejects a non-allowlisted command without executing it', async () => {
    await expect(invoke('run-command', controller(['workbench.action.other']))).rejects.toThrow('Command workbench.action.test is not allowlisted.');

    expect(mock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('requires workspace trust even for an allowlisted command', async () => {
    mock.workspace.isTrusted = false;

    await expect(invoke('run-command', controller(['workbench.action.test']))).rejects.toThrow('Profile commands are disabled in untrusted workspaces.');
    expect(mock.commands.executeCommand).not.toHaveBeenCalled();
  });
});
