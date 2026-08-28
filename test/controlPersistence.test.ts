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
    mock.workspace.isTrusted = true;
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
    });
    expect(controllerB.snapshot.controls).not.toHaveProperty('secret-value');
    controllerB.addBuiltInFixture([{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'fixture', raw: 'secret', data: 'secret' }]);
    expect(JSON.stringify(controllerB.getRuns()[0]?.snapshot)).not.toContain('secret');
  });

  it('ignores persisted values when another profile revision reuses an id with an incompatible control schema', async () => {
    const extensionContext = context(new Map());
    const textController = controller('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc', extensionContext);
    await textController.setControl('global-value', 'text-from-another-revision');

    const changedProfile = structuredClone(profile);
    changedProfile.controls = [{ id: 'global-value', type: 'boolean', label: 'Global flag', default: false, persist: 'global' }];
    const booleanController = controller('/workspace-b/.vscode/turnstage/profiles/shared.turnstage.jsonc', context(new Map()), changedProfile);
    await booleanController.loadRuns();

    expect(booleanController.snapshot.controls['global-value']).toBe(false);
    await booleanController.setControl('global-value', 'not-a-boolean');
    expect(booleanController.snapshot.controls['global-value']).toBe(false);
  });

  it('drops a persisted select value that is no longer one of the configured options', async () => {
    globalState.set('turnstage.control.global.shared-profile.mode', { version: 1, controlType: 'select', value: 'removed' });
    const selectProfile = structuredClone(profile);
    selectProfile.controls = [{ id: 'mode', type: 'select', label: 'Mode', default: 'safe', persist: 'global', options: [{ label: 'Safe', value: 'safe' }] }];
    const instance = controller('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc', context(new Map()), selectProfile);
    await instance.loadRuns();
    expect(instance.snapshot.controls.mode).toBe('safe');
  });

  it('does not read or write secret controls in an untrusted workspace', async () => {
    mock.workspace.isTrusted = false;
    secrets.set('turnstage.control.secret.shared-profile.secret-value', JSON.stringify('stored-secret'));
    const extensionContext = context(new Map());
    const getSecret = vi.fn(extensionContext.secrets.get);
    const storeSecret = vi.fn(extensionContext.secrets.store);
    const deleteSecret = vi.fn(extensionContext.secrets.delete);
    extensionContext.secrets.get = getSecret;
    extensionContext.secrets.store = storeSecret;
    extensionContext.secrets.delete = deleteSecret;
    const controllerInstance = controller('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc', extensionContext);

    await controllerInstance.loadRuns();
    await controllerInstance.setControl('secret-value', 'attempted-secret');
    await controllerInstance.setControl('global-value', 'allowed-global');

    expect(getSecret).not.toHaveBeenCalled();
    expect(storeSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(controllerInstance.snapshot.controls).toMatchObject({ 'global-value': 'allowed-global' });
    expect(controllerInstance.snapshot.controls).not.toHaveProperty('secret-value');
    expect(secrets.get('turnstage.control.secret.shared-profile.secret-value')).toBe(JSON.stringify('stored-secret'));
  });

  it('does not expose persisted legacy runs in an untrusted workspace', async () => {
    mock.workspace.isTrusted = false;
    const list = vi.fn(async () => [{ id: 'legacy', profileId: profile.id, createdAt: 1, request: { method: 'GET', url: 'https://example.test/leaked-secret', headers: {} }, metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, result: { type: 'completed' as const } }]);
    const controllerInstance = new SessionController(
      profile,
      new mock.Uri('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc') as never,
      environment,
      context(new Map()) as never,
      { get: vi.fn() } as never,
      { list, save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );

    await controllerInstance.loadRuns();

    expect(list).not.toHaveBeenCalled();
    expect(controllerInstance.getRuns()).toEqual([]);
    controllerInstance.addBuiltInFixture([{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'fixture', raw: 'safe fixture', data: {} }]);
    expect(controllerInstance.getRuns()).toHaveLength(1);
  });

  it('keeps trusted secret controls host-only while resolving request templates', async () => {
    const trustedProfile = {
      ...profile,
      opening: {
        mode: 'request' as const,
        request: { method: 'POST' as const, url: 'https://example.test/opening', body: { credential: { $value: 'controls.secret-value' } } },
        response: { messagePath: '$.message' },
      },
    } as TurnStageProfile;
    const extensionContext = context(new Map());
    const savedRuns: unknown[] = [];
    const controllerInstance = controller('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc', extensionContext, trustedProfile, savedRuns);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'ready' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await controllerInstance.setControl('secret-value', 'trusted-secret');
      await controllerInstance.startSession();

      expect(fetchMock).toHaveBeenCalledWith('https://example.test/opening', expect.objectContaining({ body: JSON.stringify({ credential: 'trusted-secret' }) }));
      expect(controllerInstance.requestPreview).toMatchObject({ body: { credential: '••••••••' } });
      expect(controllerInstance.snapshot.controls).not.toHaveProperty('secret-value');
      expect(JSON.stringify(controllerInstance.snapshot)).not.toContain('trusted-secret');

      (controllerInstance as unknown as { finalized: boolean }).finalized = false;
      controllerInstance.snapshot.turnState = 'streaming';
      controllerInstance.snapshot.rawEvents = [{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'fixture', raw: 'trusted-secret', data: 'trusted-secret' }];
      controllerInstance.snapshot.normalizedEvents = [{ version: 1, type: 'content.text.delta', sequence: 1, receivedAt: 1, text: 'trusted-secret' }];
      await controllerInstance.finalizeTurn({ type: 'completed' });
      const saved = savedRuns[0] as { snapshot?: { controls: Record<string, unknown> } } | undefined;
      expect(saved?.snapshot?.controls).not.toHaveProperty('secret-value');
      expect(JSON.stringify(saved)).not.toContain('trusted-secret');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('redacts legacy run payloads using secret values stored by older versions', async () => {
    const extensionContext = context(new Map());
    const legacySnapshot = {
      sessionId: 'legacy', sessionState: 'ready', turnState: 'completed', messages: [], rawEvents: [{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'fixture', raw: 'old-secret', data: { token: 'old-secret' } }], normalizedEvents: [{ version: 1, type: 'content.text.delta', sequence: 1, receivedAt: 1, text: 'old-secret' }], metrics: { eventCount: 1, byteCount: 10, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [], droppedEventCount: 0, trusted: true, controls: { 'secret-value': 'old-secret' },
    } as const;
    const controllerInstance = new SessionController(
      profile,
      new mock.Uri('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc') as never,
      environment,
      extensionContext as never,
      { get: vi.fn() } as never,
      { list: vi.fn(async () => [{ id: 'legacy-run', profileId: profile.id, createdAt: 1, snapshot: legacySnapshot, rawEvents: legacySnapshot.rawEvents, normalizedEvents: legacySnapshot.normalizedEvents, metrics: legacySnapshot.metrics, result: { type: 'completed' as const } }]), save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );

    await controllerInstance.loadRuns();

    const serialized = JSON.stringify(controllerInstance.getRuns()[0]);
    expect(serialized).not.toContain('old-secret');
    expect(controllerInstance.getRuns()[0]?.snapshot?.controls).not.toHaveProperty('secret-value');
  });

  it('redacts environment SecretStorage values from opening content and backend event echoes', async () => {
    const environmentSecret = 'environment-secret-value';
    const selectedProfile = {
      ...profile,
      opening: {
        mode: 'request' as const,
        request: { method: 'GET' as const, url: 'https://example.test/${secret.apiToken}', headers: { 'X-Custom': '${secret.apiToken}' } },
        response: { messagePath: '$.message', startersPath: '$.options' },
      },
    } as TurnStageProfile;
    const selectedEnvironment: TurnStageEnvironment = { ...environment, secretReferences: { apiToken: 'machine-token' } };
    const extensionContext = context(new Map());
    const log = { appendLine: vi.fn() };
    const controllerInstance = new SessionController(
      selectedProfile,
      new mock.Uri('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc') as never,
      selectedEnvironment,
      extensionContext as never,
      { get: vi.fn(async (name: string) => name === 'machine-token' ? environmentSecret : undefined) } as never,
      { list: vi.fn(async () => []), save: vi.fn() } as never,
      vi.fn(),
      log as never,
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: `echo ${environmentSecret}`, options: [{ id: 'one', label: 'One', prompt: environmentSecret, behavior: 'fill' }] }), { status: 200 })));
    try {
      await controllerInstance.startSession();
      controllerInstance.addBuiltInFixture([{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'sse', raw: environmentSecret, data: { custom: environmentSecret }, sse: { event: environmentSecret, id: environmentSecret }, parseError: environmentSecret, mappingError: environmentSecret }]);

      expect(JSON.stringify(controllerInstance.requestPreview)).not.toContain(environmentSecret);
      expect(JSON.stringify(controllerInstance.snapshot)).not.toContain(environmentSecret);
      expect(JSON.stringify(controllerInstance.getRuns())).not.toContain(environmentSecret);
      expect(JSON.stringify(log.appendLine.mock.calls)).not.toContain(environmentSecret);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the mapped SecretStorage name when an environment secret is missing', async () => {
    const selectedProfile = {
      ...profile,
      conversation: { send: { method: 'POST' as const, url: 'https://example.test/${secret.apiToken}' } },
    } as TurnStageProfile;
    const selectedEnvironment: TurnStageEnvironment = { ...environment, secretReferences: { apiToken: 'machine-token' } };
    const controllerInstance = new SessionController(
      selectedProfile,
      new mock.Uri('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc') as never,
      selectedEnvironment,
      context(new Map()) as never,
      { get: vi.fn(async () => undefined) } as never,
      { list: vi.fn(async () => []), save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );

    await controllerInstance.send('hello', { kind: 'manual' });

    expect(controllerInstance.snapshot.errors).toContainEqual(expect.objectContaining({
      type: 'MissingSecretError',
      message: 'Secret "machine-token" is not configured.',
    }));
  });

  it('hydrates declared environment secrets before exposing legacy runs', async () => {
    const environmentSecret = 'legacy-environment-secret';
    const selectedEnvironment: TurnStageEnvironment = { ...environment, secretReferences: { apiToken: 'machine-token' } };
    const legacyRun = {
      id: 'legacy-environment-run', profileId: profile.id, createdAt: 1,
      request: { method: 'GET', url: `https://example.test/${environmentSecret}`, headers: { 'X-Custom': environmentSecret } },
      snapshot: { sessionId: 'legacy-environment', sessionState: 'ready', turnState: 'failed', messages: [{ id: 'message', role: 'assistant', status: 'failed', createdAt: 1, parts: [{ type: 'error', text: environmentSecret }], citations: [], actions: [], followups: [] }], rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [{ type: 'RemoteStopWarning', message: environmentSecret }], droppedEventCount: 0, trusted: true, controls: {} },
      metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, result: { type: 'failed', error: { type: 'NetworkError', message: environmentSecret } },
    } as const;
    const controllerInstance = new SessionController(
      profile,
      new mock.Uri('/workspace-a/.vscode/turnstage/profiles/shared.turnstage.jsonc') as never,
      selectedEnvironment,
      context(new Map()) as never,
      { get: vi.fn(async (name: string) => name === 'machine-token' ? environmentSecret : undefined) } as never,
      { list: vi.fn(async () => [legacyRun]), save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );

    await controllerInstance.loadRuns();

    expect(JSON.stringify(controllerInstance.getRuns())).not.toContain(environmentSecret);
    expect(JSON.stringify(controllerInstance.getRuns())).toContain('••••••••');
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

  function controller(path: string, extensionContext: ReturnType<typeof context>, selectedProfile: TurnStageProfile = profile, savedRuns?: unknown[]): SessionController {
    return new SessionController(
      selectedProfile,
      new mock.Uri(path) as never,
      environment,
      extensionContext as never,
      { get: vi.fn() } as never,
      { list: vi.fn(async () => []), save: vi.fn(async (run: unknown) => { savedRuns?.push(run); }) } as never,
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
