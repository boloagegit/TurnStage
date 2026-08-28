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
  const showOpenDialog = vi.fn();
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
      stat: async (uri: Uri) => ({ type: 1, ctime: 0, mtime: 0, size: files.get(uri.path)?.byteLength ?? 0 }),
    },
  };

  return { Uri, files, directories, writes, showSaveDialog, showOpenDialog, workspace, window: { showSaveDialog, showOpenDialog } };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, workspace: mock.workspace, window: mock.window }));

import { LOCAL_RUN_EXPORT_FORMAT, LOCAL_RUN_EXPORT_VERSION, MAX_RUN_IMPORT_BYTES, LocalRunRepository } from '../src/extension/history/localRunRepository';
import { SessionController } from '../src/extension/runtime/sessionController';

describe('LocalRunRepository', () => {
  beforeEach(() => {
    mock.files.clear();
    mock.directories.length = 0;
    mock.writes.length = 0;
    mock.showSaveDialog.mockReset();
    mock.showOpenDialog.mockReset();
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
    expect(JSON.parse(storedText('/exports/run-7.turnstage-run.json'))).toEqual({
      format: LOCAL_RUN_EXPORT_FORMAT,
      version: LOCAL_RUN_EXPORT_VERSION,
      exportedAt: expect.any(Number),
      run: selected,
    });
  });

  it('does not write anything when export is cancelled', async () => {
    const repository = makeRepository();
    mock.showSaveDialog.mockResolvedValue(undefined);

    expect(await repository.export(run('run-8'))).toBeUndefined();
    expect(mock.writes).toEqual([]);
  });

  it('imports versioned and legacy exports into matching profile history', async () => {
    const repository = makeRepository();
    const versionedUri = new mock.Uri('/imports/versioned.turnstage-run.json');
    const legacyUri = new mock.Uri('/imports/legacy.turnstage-run.json');
    const versionedRun = run('versioned', 'profile-a');
    const legacyRun = run('legacy', 'profile-a');
    mock.files.set(versionedUri.path, new TextEncoder().encode(JSON.stringify({ format: LOCAL_RUN_EXPORT_FORMAT, version: LOCAL_RUN_EXPORT_VERSION, exportedAt: 1, run: versionedRun })));
    mock.files.set(legacyUri.path, new TextEncoder().encode(JSON.stringify(legacyRun)));
    mock.showOpenDialog.mockResolvedValueOnce([versionedUri]).mockResolvedValueOnce([legacyUri]);

    expect(await repository.import('profile-a', 10)).toMatchObject({ run: versionedRun, uri: versionedUri, duplicate: false });
    expect(await repository.import('profile-a', 10)).toMatchObject({ run: legacyRun, uri: legacyUri, duplicate: false });
    expect((await repository.list('profile-a')).map((item) => item.id)).toEqual(['legacy', 'versioned']);
  });

  it('preserves assistant timing and mapped message metrics across import', async () => {
    const repository = makeRepository();
    const context = extensionContext();
    const controller = controllerFor(profileWithHistory({}), context, new LocalRunRepository(context as never));
    const recorded = structuredClone(controller.snapshot);
    recorded.turnState = 'completed';
    recorded.metrics = { ...recorded.metrics, ttft: 125, totalDuration: 480 };
    recorded.messages = [{
      id: 'assistant-timed', role: 'assistant', status: 'completed', createdAt: 1, completedAt: 481,
      parts: [{ type: 'text', text: 'Measured response' }], citations: [], actions: [], followups: [],
      timing: { ttft: 125, totalDuration: 480 },
      metrics: [{ id: 'tokens', label: 'Tokens', value: 42, format: 'number', aggregation: 'sum', sampleCount: 2 }],
    }];
    const importedRun = run('timed-run', controller.profile.id, { snapshot: recorded, metrics: recorded.metrics });
    const uri = new mock.Uri('/imports/timed.turnstage-run.json');
    mock.files.set(uri.path, new TextEncoder().encode(JSON.stringify({ format: LOCAL_RUN_EXPORT_FORMAT, version: LOCAL_RUN_EXPORT_VERSION, exportedAt: 1, run: importedRun })));
    mock.showOpenDialog.mockResolvedValue([uri]);

    const imported = await repository.import(controller.profile.id, 10);

    expect(imported?.run.snapshot?.messages[0]).toMatchObject({
      timing: { ttft: 125, totalDuration: 480 },
      metrics: [{ id: 'tokens', value: 42, aggregation: 'sum', sampleCount: 2 }],
    });
  });

  it('creates a new id instead of overwriting an imported duplicate', async () => {
    const repository = makeRepository();
    const original = run('same-id', 'profile-a', { createdAt: 1 });
    await repository.save(original, 10);
    const uri = new mock.Uri('/imports/duplicate.turnstage-run.json');
    mock.files.set(uri.path, new TextEncoder().encode(JSON.stringify({ ...original, createdAt: 2 })));
    mock.showOpenDialog.mockResolvedValue([uri]);

    const imported = await repository.import('profile-a', 10);

    expect(imported?.duplicate).toBe(true);
    expect(imported?.run.id).not.toBe(original.id);
    expect(await repository.list('profile-a')).toHaveLength(2);
    expect((await repository.list('profile-a')).find((item) => item.id === original.id)?.createdAt).toBe(1);
  });

  it('serializes concurrent imports so duplicate ids remain distinct', async () => {
    const repository = makeRepository();
    const firstUri = new mock.Uri('/imports/concurrent-1.turnstage-run.json');
    const secondUri = new mock.Uri('/imports/concurrent-2.turnstage-run.json');
    const sharedRun = run('concurrent-import', 'profile-a');
    mock.files.set(firstUri.path, new TextEncoder().encode(JSON.stringify(sharedRun)));
    mock.files.set(secondUri.path, new TextEncoder().encode(JSON.stringify(sharedRun)));
    mock.showOpenDialog.mockResolvedValueOnce([firstUri]).mockResolvedValueOnce([secondUri]);

    const imported = await Promise.all([repository.import('profile-a', 10), repository.import('profile-a', 10)]);

    expect(imported.map((item) => item?.duplicate).sort()).toEqual([false, true]);
    const stored = await repository.list('profile-a');
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((item) => item.id)).size).toBe(2);
  });

  it('rejects unsupported, mismatched, malformed, and oversized imports without writing history', async () => {
    const repository = makeRepository();
    const unsupported = new mock.Uri('/imports/unsupported.json');
    const mismatch = new mock.Uri('/imports/mismatch.json');
    const malformed = new mock.Uri('/imports/malformed.json');
    const oversized = new mock.Uri('/imports/oversized.json');
    mock.files.set(unsupported.path, new TextEncoder().encode(JSON.stringify({ format: LOCAL_RUN_EXPORT_FORMAT, version: 99, run: run('run-1') })));
    mock.files.set(mismatch.path, new TextEncoder().encode(JSON.stringify(run('run-2', 'profile-b'))));
    mock.files.set(malformed.path, new TextEncoder().encode('{broken'));
    mock.files.set(oversized.path, new Uint8Array(MAX_RUN_IMPORT_BYTES + 1));
    mock.showOpenDialog.mockResolvedValueOnce([unsupported]).mockResolvedValueOnce([mismatch]).mockResolvedValueOnce([malformed]).mockResolvedValueOnce([oversized]);

    await expect(repository.import('profile-a', 10)).rejects.toThrow('version 99');
    await expect(repository.import('profile-a', 10)).rejects.toThrow('profile profile-b');
    await expect(repository.import('profile-a', 10)).rejects.toThrow('not valid JSON');
    await expect(repository.import('profile-a', 10)).rejects.toThrow('larger than 20 MB');
    expect(await repository.list('profile-a')).toEqual([]);
    expect(mock.writes).toEqual([]);
  });

  it('does not write anything when import is cancelled', async () => {
    mock.showOpenDialog.mockResolvedValue(undefined);

    expect(await makeRepository().import('profile-a', 10)).toBeUndefined();
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

  it('restores conversation context through the last user message before rebuilding the assistant reply', async () => {
    const context = extensionContext();
    const repository = new LocalRunRepository(context as never);
    const profile = profileWithHistory({});
    profile.stream.mappings = [{ id: 'text', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } }];
    const controller = controllerFor(profile, context, repository);
    const recordedSnapshot = structuredClone(controller.snapshot);
    recordedSnapshot.opening = { message: 'Welcome', starters: [] };
    recordedSnapshot.conversationId = 'conversation-1';
    recordedSnapshot.messages = [
      { id: 'prior-assistant', role: 'assistant', status: 'completed', createdAt: 1, completedAt: 1, parts: [{ type: 'text', text: 'Earlier answer' }], citations: [], actions: [], followups: [] },
      { id: 'current-user', role: 'user', status: 'completed', createdAt: 2, completedAt: 2, parts: [{ type: 'text', text: 'Replay this' }], citations: [], actions: [], followups: [] },
      { id: 'recorded-assistant', role: 'assistant', status: 'completed', createdAt: 3, completedAt: 3, parts: [{ type: 'text', text: 'Recorded answer' }], citations: [], actions: [], followups: [] },
    ];
    const replayRun = run('replay-1', profile.id, {
      metrics: { eventCount: 1, byteCount: 25, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0, ttft: 120, totalDuration: 360 },
      snapshot: recordedSnapshot,
      rawEvents: [{ sequence: 1, receivedAt: 3, elapsedMs: 0, protocol: 'sse', raw: '{"text":"Rebuilt answer"}', data: { text: 'Rebuilt answer' } }],
    });
    (controller as unknown as { runs: LocalRun[] }).runs = [replayRun];

    expect(controller.replay(replayRun.id)).toBe('started');
    await vi.waitFor(() => expect(controller.snapshot.turnState).toBe('completed'));

    expect(controller.snapshot.opening).toEqual(recordedSnapshot.opening);
    expect(controller.snapshot.conversationId).toBe('conversation-1');
    expect(controller.snapshot.messages.map((message) => message.id)).toEqual(['prior-assistant', 'current-user', 'assistant-1']);
    expect(controller.snapshot.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Rebuilt answer' }]);
    expect(controller.snapshot.messages.at(-1)?.timing).toEqual({ ttft: 120, totalDuration: 360 });
    expect(controller.snapshot.replay).toMatchObject({ runId: replayRun.id, status: 'completed', index: 1, total: 1 });
  });

  it('refuses unavailable or active replay without replacing the visible snapshot', () => {
    const context = extensionContext();
    const repository = new LocalRunRepository(context as never);
    const controller = controllerFor(profileWithHistory({}), context, repository);
    const unavailable = run('no-raw-events', controller.profile.id, { rawEvents: [] });
    (controller as unknown as { runs: LocalRun[] }).runs = [unavailable];
    controller.snapshot.messages = [{ id: 'visible', role: 'user', status: 'completed', createdAt: 1, completedAt: 1, parts: [{ type: 'text', text: 'Keep me' }], citations: [], actions: [], followups: [] }];
    const visibleSnapshot = controller.snapshot;

    expect(controller.replay(unavailable.id)).toBe('unavailable');
    expect(controller.snapshot).toBe(visibleSnapshot);
    controller.snapshot.turnState = 'streaming';
    expect(controller.replay(unavailable.id)).toBe('active');
    expect(controller.snapshot).toBe(visibleSnapshot);
  });

  it('publishes bounded run summaries while keeping replay payloads host-side', () => {
    const context = extensionContext();
    const controller = controllerFor(profileWithHistory({}), context, new LocalRunRepository(context as never));
    const fullRun = run('summary-run', controller.profile.id, { request: { method: 'POST', url: 'https://example.test', headers: {}, body: { secret: 'host-only' } }, rawEvents: [{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'sse', raw: '{"large":true}', data: { large: true } }], snapshot: structuredClone(controller.snapshot) });
    (controller as unknown as { runs: LocalRun[] }).runs = [fullRun];

    expect(controller.getRunSummaries()).toEqual([{
      id: fullRun.id,
      profileId: fullRun.profileId,
      createdAt: fullRun.createdAt,
      metrics: fullRun.metrics,
      result: fullRun.result,
      replayable: true,
      hasSnapshot: true,
      rawEventCount: 1,
      normalizedEventCount: 0,
      messageCount: 0,
      errorCount: 0,
      request: { method: 'POST', url: 'https://example.test', variantId: undefined },
    }]);
    expect(controller.getRunSummaries()[0]).not.toHaveProperty('rawEvents');
    expect(controller.getRunSummaries()[0]).not.toHaveProperty('snapshot');
    expect(controller.getRunSummaries()[0]?.request).not.toHaveProperty('headers');
    expect(controller.getRunSummaries()[0]?.request).not.toHaveProperty('body');
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
