import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    toString(): string { return `file://${this.path}`; }
  }
  return {
    Uri,
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      getWorkspaceFolder: (uri: Uri) => ({ uri: new Uri(uri.path.startsWith('/workspace-b/') ? '/workspace-b' : '/workspace-a') }),
    },
  };
});

vi.mock('vscode', () => mock);

import { SessionController } from '../src/extension/runtime/sessionController';

describe('control persistence scopes', () => {
  const profile = {
    version: 1,
    id: 'shared-profile',
    name: 'Shared profile',
    controls: [
      { id: 'global-value', type: 'text', label: 'Global', default: 'global-default', persist: 'global' },
      { id: 'workspace-value', type: 'text', label: 'Workspace', default: 'workspace-default', persist: 'workspace' },
      { id: 'secret-value', type: 'text', label: 'Secret', default: '', persist: 'secret' },
    ],
    opening: { mode: 'disabled' },
    conversation: { send: { method: 'POST', url: 'https://example.test' } },
    stream: { transport: 'sse', mappings: [] },
  } as TurnStageProfile;
  const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
  let globalState: Map<string, unknown>;
  let secrets: Map<string, string>;

  beforeEach(() => {
    globalState = new Map();
    secrets = new Map();
  });

  it('shares global and secret controls while isolating workspace controls', async () => {
    const contextA = context(new Map());
    const controllerA = controller('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc', contextA);
    await controllerA.setControl('global-value', 'shared');
    await controllerA.setControl('workspace-value', 'workspace-a');
    await controllerA.setControl('secret-value', 'secret');

    const contextB = context(new Map());
    const controllerB = controller('/workspace-b/.vscode/turnstage/profiles/shared.turnstage.jsonc', contextB);
    await controllerB.loadRuns();

    expect(controllerB.snapshot.controls).toMatchObject({
      'global-value': 'shared',
      'workspace-value': 'workspace-default',
      'secret-value': 'secret',
    });
  });

  function context(workspaceState: Map<string, unknown>) {
    return {
      globalState: state(globalState),
      workspaceState: state(workspaceState),
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    };
  }

  function controller(path: string, extensionContext: ReturnType<typeof context>): SessionController {
    return new SessionController(
      profile,
      new mock.Uri(path) as never,
      environment,
      extensionContext as never,
      { get: vi.fn() } as never,
      { list: vi.fn(async () => []), save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );
  }
});

function state(values: Map<string, unknown>) {
  return {
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
}
