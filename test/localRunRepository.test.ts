import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalRun, MetricsSnapshot, NormalizedEvent, RawStreamEvent, TurnStageProfile } from '../src/shared/types';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}

    static file(path: string): Uri { return new Uri(path); }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments: string[] = [];
      for (const segment of `${base.path}/${parts.join('/')}`.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
      }
      return new Uri(`/${segments.join('/')}`);
    }

    toString(): string { return `file://${this.path}`; }
  }

  const files = new Map<string, Uint8Array>();
  const directories: string[] = [];
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const showSaveDialog = vi.fn();
  const workspace = {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    getWorkspaceFolder: () => undefined,
    fs: {
      readFile: async (uri: Uri) => {
        const bytes = files.get(uri.path);
        if (!bytes) throw new Error(`File not found: ${uri.path}`);
        return bytes;
      },
      writeFile: async (uri: Uri, bytes: Uint8Array) => {
        files.set(uri.path, bytes);
        writes.push({ path: uri.path, bytes });
      },
      createDirectory: async (uri: Uri) => { directories.push(uri.path); },
    },
  };

  return { Uri, files, directories, writes, showSaveDialog, workspace, window: { showSaveDialog } };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, workspace: mock.workspace, window: mock.window }));

import { LocalRunRepository } from '../src/extension/history/localRunRepository';
import { SessionController } from '../src/extension/runtime/sessionController';

describe('LocalRunRepository', () => {
  beforeEach(() => {
    mock.files.clear();
    mock.directories.length = 0;
    mock.writes.length = 0;
    mock.showSaveDialog.mockReset();
  });

  it('returns an empty list for missing or malformed profile history', async () => {
    const repository = makeRepository();

    expect(await repository.list('missing')).toEqual([]);
    mock.files.set('/global-storage/runs/broken.json', new TextEncoder().encode('{ not valid json'));
    expect(await repository.list('broken')).toEqual([]);
    mock.files.set('/global-storage/runs/object.json', new TextEncoder().encode(JSON.stringify({ id: 'not-an-array' })));
    expect(await repository.list('object')).toEqual([]);
  });

  it('saves and lists runs in profile-scoped global storage', async () => {
    const repository = makeRepository();
    const first = run('run-1', 'profile-a');

    await repository.save(first, 10);

    expect(await repository.list('profile-a')).toEqual([first]);
    expect(await repository.list('profile-b')).toEqual([]);
    expect(mock.directories).toEqual(['/global-storage/runs']);
    expect(mock.writes.map((write) => write.path)).toEqual(['/global-storage/runs/profile-a.json']);
  });

  it('upserts by run id and keeps newest entries within retention', async () => {
    const repository = makeRepository();
    await repository.save(run('run-1', 'profile-a', { createdAt: 1 }), 2);
    await repository.save(run('run-2', 'profile-a', { createdAt: 2 }), 2);
    await repository.save(run('run-3', 'profile-a', { createdAt: 3 }), 2);
    await repository.save(run('run-2', 'profile-a', { createdAt: 20, result: { type: 'failed', error: { type: 'NetworkError', message: 'offline' } } }), 2);

    expect(await repository.list('profile-a')).toEqual([
      expect.objectContaining({ id: 'run-2', createdAt: 20 }),
      expect.objectContaining({ id: 'run-3', createdAt: 3 }),
    ]);
  });

  it('filters malformed entries while retaining valid persisted runs', async () => {
    const valid = run('valid');
    const malformed = [
      { ...valid, id: 42 },
      { ...valid, id: 'wrong-profile', profileId: 'profile-b' },
      { ...valid, id: 'invalid-date', createdAt: 'not-a-date' },
      { ...valid, id: 'invalid-metrics', metrics: { ...valid.metrics, eventCount: '0' } },
      { ...valid, id: 'invalid-events', rawEvents: { sequence: 1 } },
      { ...valid, id: 'invalid-result', result: { type: 'failed', error: 'not-an-error' } },
    ];
    mock.files.set('/global-storage/runs/profile-a.json', new TextEncoder().encode(JSON.stringify([malformed[0], valid, ...malformed.slice(1)])));

    expect(await makeRepository().list('profile-a')).toEqual([valid]);
  });

  it('serializes concurrent saves so every run id is retained', async () => {
    const repository = makeRepository();
    await Promise.all(Array.from({ length: 12 }, (_, index) => repository.save(run(`concurrent-${index}`, 'profile-a', { createdAt: index }), 20)));

    const ids = (await repository.list('profile-a')).map((item) => item.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: 12 }, (_, index) => `concurrent-${index}`)));
  });

  it('exports the selected run as readable JSON and suggests a stable filename', async () => {
    const repository = makeRepository();
    const selected = run('run-7', 'profile-a', { rawEvents: undefined, normalizedEvents: undefined });
    const target = new mock.Uri('/exports/run-7.turnstage-run.json');
    mock.showSaveDialog.mockResolvedValue(target);

    const exported = await repository.export(selected);

    expect(exported).toBe(target);
    expect(mock.showSaveDialog).toHaveBeenCalledWith({
      defaultUri: expect.objectContaining({ path: 'profile-a-run-7.turnstage-run.json' }),
      filters: { 'TurnStage Run': ['json'] },
    });
    expect(storedText('/exports/run-7.turnstage-run.json')).toBe(JSON.stringify(selected, null, 2));
    expect(JSON.parse(storedText('/exports/run-7.turnstage-run.json'))).toEqual(selected);
  });

  it('does not write anything when export is cancelled', async () => {
    const repository = makeRepository();
    mock.showSaveDialog.mockResolvedValue(undefined);

    expect(await repository.export(run('run-8'))).toBeUndefined();
    expect(mock.writes).toEqual([]);
  });
});

describe('SessionController local-run recording', () => {
  beforeEach(() => {
    mock.files.clear();
    mock.directories.length = 0;
    mock.writes.length = 0;
  });

  it('records only the enabled event and snapshot fields', async () => {
    const context = extensionContext();
    const repository = new LocalRunRepository(context as never);
    const profile = profileWithHistory({ maxRuns: 3, recordRawEvents: false, recordNormalizedEvents: true, recordChatSnapshot: false });
    const controller = controllerFor(profile, context, repository);
    const normalized: NormalizedEvent = { version: 1, type: 'content.text.delta', sequence: 2, receivedAt: 2, text: 'hello' };
    prepareForFinalization(controller, normalized);

    await controller.finalizeTurn({ type: 'completed' });
    const [saved] = await repository.list(profile.id);

    expect(saved).toMatchObject({ profileId: profile.id, result: { type: 'completed' }, normalizedEvents: [normalized] });
    expect(saved?.rawEvents).toBeUndefined();
    expect(saved?.snapshot).toBeUndefined();
  });

  it('records raw events, normalized events, and a snapshot by default', async () => {
    const context = extensionContext();
    const repository = new LocalRunRepository(context as never);
    const profile = profileWithHistory({});
    const controller = controllerFor(profile, context, repository);
    const normalized: NormalizedEvent = { version: 1, type: 'content.text.delta', sequence: 2, receivedAt: 2, text: 'hello' };
    prepareForFinalization(controller, normalized);

    await controller.finalizeTurn({ type: 'completed' });
    const [saved] = await repository.list(profile.id);

    expect(saved?.rawEvents).toEqual(controller.snapshot.rawEvents);
    expect(saved?.normalizedEvents).toEqual([normalized]);
    expect(saved?.snapshot).toMatchObject({ turnState: 'completed', normalizedEvents: [normalized] });
  });

  it('does not persist a run when local history is disabled', async () => {
    const context = extensionContext();
    const repository = new LocalRunRepository(context as never);
    const profile = profileWithHistory({ enabled: false });
    const controller = controllerFor(profile, context, repository);
    prepareForFinalization(controller, { version: 1, type: 'stream.completed', sequence: 1, receivedAt: 1 });

    await controller.finalizeTurn({ type: 'completed' });

    expect(await repository.list(profile.id)).toEqual([]);
    expect(mock.writes).toEqual([]);
  });
});

function makeRepository(): LocalRunRepository {
  return new LocalRunRepository(extensionContext() as never);
}

function extensionContext() {
  const state = new Map<string, unknown>();
  return {
    globalStorageUri: new mock.Uri('/global-storage'),
    globalState: { get: (key: string, fallback?: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } },
    workspaceState: { get: (key: string, fallback?: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  };
}

function profileWithHistory(localRuns: NonNullable<TurnStageProfile['history']>['localRuns']): TurnStageProfile {
  return {
    version: 1,
    id: 'recording-profile',
    name: 'Recording profile',
    conversation: { send: { method: 'POST', url: 'https://example.test' } },
    stream: { transport: 'sse', mappings: [] },
    history: { localRuns },
  };
}

function controllerFor(profile: TurnStageProfile, context: ReturnType<typeof extensionContext>, repository: LocalRunRepository): SessionController {
  return new SessionController(profile, new mock.Uri('/profiles/recording.turnstage.jsonc') as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, context as never, { get: vi.fn() } as never, repository, vi.fn(), { appendLine: vi.fn() } as never);
}

function prepareForFinalization(controller: SessionController, normalized: NormalizedEvent): void {
  const raw: RawStreamEvent = { sequence: normalized.sequence, receivedAt: normalized.receivedAt, elapsedMs: 0, protocol: 'sse', raw: JSON.stringify(normalized), data: normalized };
  controller.snapshot.rawEvents = [raw];
  controller.snapshot.normalizedEvents = [normalized];
  controller.snapshot.turnState = 'streaming';
  (controller as unknown as { finalized: boolean }).finalized = false;
}

function run(id: string, profileId = 'profile-a', overrides: Partial<LocalRun> = {}): LocalRun {
  const metrics: MetricsSnapshot = { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 };
  return {
    id,
    profileId,
    createdAt: 1,
    metrics,
    result: { type: 'completed' },
    ...overrides,
  };
}

function storedText(path: string): string {
  const bytes = mock.files.get(path);
  if (!bytes) throw new Error(`Expected stored file: ${path}`);
  return new TextDecoder().decode(bytes);
}
