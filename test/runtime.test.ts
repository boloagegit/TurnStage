import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RawStreamEvent, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { EventBatcher } from '../src/extension/runtime/eventBatcher';
import { EventBuffer } from '../src/extension/runtime/eventBuffer';
import { MetricsCollector } from '../src/extension/runtime/metrics';

function rawEvent(receivedAt: number, parseError?: string): RawStreamEvent {
  return {
    sequence: receivedAt,
    receivedAt,
    elapsedMs: receivedAt,
    protocol: 'sse',
    raw: '{}',
    data: {},
    ...(parseError ? { parseError } : {}),
  };
}

describe('EventBuffer', () => {
  it('evicts the oldest entries when the event limit is exceeded', () => {
    const buffer = new EventBuffer<{ id: number }>(2, 10_000);

    buffer.push({ id: 1 });
    buffer.push({ id: 2 });
    buffer.push({ id: 3 });

    expect(buffer.all()).toEqual([{ id: 2 }, { id: 3 }]);
    expect(buffer.dropped).toBe(1);
  });

  it('accounts for UTF-8 JSON bytes and can evict an oversized newest entry', () => {
    const first = { text: 'é' };
    const second = { text: '漢' };
    const maxBytes = Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second)) - 1;
    const buffer = new EventBuffer<typeof first>(10, maxBytes);

    buffer.push(first);
    buffer.push(second);

    expect(buffer.all()).toEqual([second]);
    expect(buffer.dropped).toBe(1);

    const tiny = new EventBuffer<{ text: string }>(10, 2);
    tiny.push({ text: 'too large' });
    expect(tiny.all()).toEqual([]);
    expect(tiny.dropped).toBe(1);
  });

  it('clears retained values and the drop counter', () => {
    const buffer = new EventBuffer<string>(1, 100);
    buffer.push('one');
    buffer.push('two');
    buffer.clear();

    expect(buffer.all()).toEqual([]);
    expect(buffer.dropped).toBe(0);
  });
});

describe('EventBatcher', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes pending values after the interval as one batch', () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const batcher = new EventBatcher<number>((batch) => batches.push(batch), 50, 10);

    batcher.add(1);
    batcher.add(2);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([[1, 2]]);
  });

  it('flushes immediately at the max batch size and on disposal', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const batcher = new EventBatcher<string>((batch) => batches.push(batch), 1000, 2);

    batcher.add('a');
    batcher.add('b');
    expect(batches).toEqual([['a', 'b']]);
    batcher.add('c', true);
    batcher.dispose();
    expect(batches).toEqual([['a', 'b'], ['c']]);
    batcher.add('ignored');
    batcher.flush();
    expect(batches).toEqual([['a', 'b'], ['c']]);
  });
});

describe('MetricsCollector', () => {
  afterEach(() => vi.useRealTimers());

  it('records first timings, event gaps, errors, and terminal durations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const metrics = new MetricsCollector();
    metrics.start();
    metrics.headers(25);
    metrics.headers(99);
    metrics.chunk(4, 15);
    metrics.chunk(6, 0);

    metrics.raw(rawEvent(1_050, 'invalid json'));
    metrics.raw(rawEvent(1_070));
    const normalized: NormalizedEvent = { version: 1, type: 'content.text.delta', sequence: 2, receivedAt: 1_080 };
    metrics.normalized(normalized);
    metrics.mappingError(2);
    metrics.unmatched();
    vi.setSystemTime(1_100);
    metrics.finish('user_cancel');

    expect(metrics.value).toEqual({
      requestStartedAt: 1_000,
      headersLatency: 25,
      firstChunkLatency: 15,
      firstEventLatency: 50,
      ttft: 80,
      streamDuration: 75,
      totalDuration: 100,
      eventCount: 2,
      byteCount: 10,
      averageEventGap: 20,
      maxEventGap: 20,
      parseErrorCount: 1,
      mappingErrorCount: 2,
      unmatchedEventCount: 1,
      reconnectCount: 0,
      abortReason: 'user_cancel',
    });
  });

  it('starts with zero reconnects and records the highest transport count', () => {
    const metrics = new MetricsCollector();
    expect(metrics.value.reconnectCount).toBe(0);
    metrics.reconnectCount(1);
    metrics.reconnectCount(3);
    metrics.reconnectCount(2);
    expect(metrics.value.reconnectCount).toBe(3);
  });
});

describe('isActive and SessionController.finalizeTurn', () => {
  it('finalizes an assistant message and closes in-flight parts without vscode runtime services', async () => {
    vi.mock('vscode', () => ({
      workspace: {
        isTrusted: true,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        getWorkspaceFolder: () => undefined,
      },
    }));

    const { SessionController, isActive } = await import('../src/extension/runtime/sessionController');
    const profile = {
      version: 1,
      id: 'finalizer-test',
      name: 'Finalizer test',
      conversation: { send: { method: 'POST', url: 'https://example.test' } },
      stream: { transport: 'sse', mappings: [] },
    } as TurnStageProfile;
    const environment: TurnStageEnvironment = { version: 1, id: 'env', name: 'Environment', variables: {} };
    const changed = vi.fn();
    const controller = new SessionController(
      profile,
      {} as never,
      environment,
      {} as never,
      { get: vi.fn() } as never,
      { save: vi.fn() } as never,
      changed,
      { appendLine: vi.fn() } as never,
    );
    controller.snapshot.turnState = 'streaming';
    (controller as unknown as { finalized: boolean }).finalized = false;
    controller.snapshot.messages.push({
      id: 'assistant-1',
      role: 'assistant',
      status: 'streaming',
      createdAt: 1,
      parts: [
        { type: 'text', text: 'partial' },
        { type: 'progress', text: 'working', status: 'running' },
        { type: 'tool-call', toolCallId: 'tool-1', status: 'pending' },
      ],
      citations: [],
      actions: [],
      followups: [],
    });

    expect(isActive('streaming')).toBe(true);
    expect(isActive('completed')).toBe(false);
    await controller.finalizeTurn({ type: 'completed' }, false);

    expect(controller.snapshot.turnState).toBe('completed');
    expect(controller.snapshot.messages[0]).toMatchObject({
      status: 'completed',
      parts: [
        { type: 'text', text: 'partial' },
        { type: 'progress', status: 'completed' },
        { type: 'tool-call', status: 'completed' },
      ],
    });
    expect(controller.snapshot.errors).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('adds an error part and preserves failed terminal state', async () => {
    vi.mock('vscode', () => ({
      workspace: {
        isTrusted: true,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        getWorkspaceFolder: () => undefined,
      },
    }));

    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = {
      version: 1,
      id: 'failed-finalizer-test',
      name: 'Failed finalizer test',
      conversation: { send: { method: 'POST', url: 'https://example.test' } },
      stream: { transport: 'sse', mappings: [] },
    } as TurnStageProfile;
    const controller = new SessionController(
      profile,
      {} as never,
      { version: 1, id: 'env', name: 'Environment', variables: {} },
      {} as never,
      { get: vi.fn() } as never,
      { save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );
    (controller as unknown as { finalized: boolean }).finalized = false;
    controller.snapshot.messages.push({ id: 'assistant-1', role: 'assistant', status: 'pending', createdAt: 1, parts: [], citations: [], actions: [], followups: [] });

    await controller.finalizeTurn({ type: 'failed', error: { type: 'NetworkError', message: 'offline', retrySafe: true } }, false);

    expect(controller.snapshot.turnState).toBe('failed');
    expect(controller.snapshot.messages[0]?.status).toBe('failed');
    expect(controller.snapshot.messages[0]?.parts).toEqual([{ type: 'error', text: 'offline' }]);
    expect(controller.snapshot.errors).toEqual([{ type: 'NetworkError', message: 'offline', retrySafe: true }]);
  });

  it('ignores raw events that arrive after the turn has finalized', async () => {
    vi.mock('vscode', () => ({
      workspace: {
        isTrusted: true,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        getWorkspaceFolder: () => undefined,
      },
    }));

    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = {
      version: 1,
      id: 'terminal-boundary-test',
      name: 'Terminal boundary test',
      conversation: { send: { method: 'POST', url: 'https://example.test' } },
      stream: {
        transport: 'sse',
        mappings: [{ id: 'late-delta', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }],
      },
    } as TurnStageProfile;
    const changed = vi.fn();
    const controller = new SessionController(
      profile,
      {} as never,
      { version: 1, id: 'env', name: 'Environment', variables: {} },
      {} as never,
      { get: vi.fn() } as never,
      { save: vi.fn() } as never,
      changed,
      { appendLine: vi.fn() } as never,
    );
    controller.snapshot.turnState = 'completed';
    controller.snapshot.messages.push({ id: 'assistant-1', role: 'assistant', status: 'completed', createdAt: 1, completedAt: 2, parts: [{ type: 'text', text: 'final' }], citations: [], actions: [], followups: [] });

    await (controller as unknown as { acceptRaw: (raw: RawStreamEvent) => Promise<void> }).acceptRaw({
      sequence: 99,
      receivedAt: 99,
      elapsedMs: 99,
      protocol: 'sse',
      sse: { event: 'message' },
      raw: '{"text":"late"}',
      data: { text: 'late' },
    });

    expect(controller.snapshot.rawEvents).toEqual([]);
    expect(controller.snapshot.normalizedEvents).toEqual([]);
    expect(controller.snapshot.messages[0]?.parts).toEqual([{ type: 'text', text: 'final' }]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('bounds normalized events, messages, and errors while recording drop counts', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const controller = new SessionController(
      { version: 1, id: 'bounds-test', name: 'Bounds', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] } },
      {} as never,
      { version: 1, id: 'env', name: 'Environment', variables: {} },
      {} as never,
      { get: vi.fn() } as never,
      { save: vi.fn() } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );
    const bounded = controller as unknown as { maxBufferedEvents: number; maxConversationMessages: number; boundSnapshotCollections: () => void };
    bounded.maxBufferedEvents = 2;
    bounded.maxConversationMessages = 2;
    controller.snapshot.normalizedEvents = [1, 2, 3].map((sequence) => ({ version: 1, type: 'event', sequence, receivedAt: sequence }));
    controller.snapshot.messages = [1, 2, 3].map((sequence) => ({ id: `m-${sequence}`, role: 'system' as const, status: 'completed' as const, createdAt: sequence, parts: [], citations: [], actions: [], followups: [] }));
    controller.snapshot.errors = Array.from({ length: 503 }, (_, index) => ({ type: 'Error', message: String(index) }));

    bounded.boundSnapshotCollections();

    expect(controller.snapshot.normalizedEvents.map((event) => event.sequence)).toEqual([2, 3]);
    expect(controller.snapshot.messages.map((message) => message.id)).toEqual(['m-2', 'm-3']);
    expect(controller.snapshot.errors).toHaveLength(500);
    expect(controller.snapshot.droppedNormalizedEventCount).toBe(1);
    expect(controller.snapshot.droppedMessageCount).toBe(1);
  });

  it('lets extension deactivation await active-turn finalization and run persistence', async () => {
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    let releaseSave: (() => void) | undefined;
    const save = vi.fn(() => new Promise<void>((resolve) => { releaseSave = resolve; }));
    const controller = new SessionController(
      { version: 1, id: 'dispose-write-test', name: 'Dispose write', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] } },
      {} as never,
      { version: 1, id: 'env', name: 'Environment', variables: {} },
      {} as never,
      { get: vi.fn() } as never,
      { save } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );
    controller.snapshot.turnState = 'streaming';
    (controller as unknown as { finalized: boolean }).finalized = false;
    const settled = vi.fn();
    const disposal = controller.disposeAndWait().then(settled);
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    releaseSave?.();
    await disposal;
    expect(settled).toHaveBeenCalledOnce();
    expect(controller.snapshot.turnState).toBe('aborted');
  });

  it('applies failed-turn partial-content and conversation-id policies', async () => {
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = { version: 1, id: 'error-policy-test', name: 'Error policy', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] }, errorPolicy: { preservePartialContent: false, keepConversationId: false, showErrorPart: true } } as TurnStageProfile;
    const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, {} as never, { get: vi.fn() } as never, { save: vi.fn() } as never, vi.fn(), { appendLine: vi.fn() } as never);
    (controller as unknown as { finalized: boolean }).finalized = false;
    controller.snapshot.conversationId = 'conversation-1';
    controller.snapshot.messages.push({ id: 'assistant-1', role: 'assistant', status: 'streaming', createdAt: 1, parts: [{ type: 'text', text: 'partial' }], citations: [], actions: [], followups: [] });

    await controller.finalizeTurn({ type: 'failed', error: { type: 'NetworkError', message: 'offline' } }, false);

    expect(controller.snapshot.conversationId).toBeUndefined();
    expect(controller.snapshot.messages[0]?.parts).toEqual([{ type: 'error', text: 'offline' }]);
  });

  it('hydrates secret controls, resets opted-in controls, and honors run recording switches', async () => {
    vi.mock('vscode', () => ({
      workspace: {
        isTrusted: true,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        getWorkspaceFolder: () => undefined,
      },
    }));

    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const stored = new Map<string, string>([['turnstage.control.no-workspace.persistence-test.token', JSON.stringify('stored-token')]]);
    const state = new Map<string, unknown>([['turnstage.control.no-workspace.persistence-test.shared', 'legacy-global']]);
    const context = {
      globalState: { get: (key: string) => state.get(key), update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }) },
      workspaceState: { get: (key: string) => state.get(key), update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }) },
      secrets: { get: vi.fn(async (key: string) => stored.get(key)), store: vi.fn(async (key: string, value: string) => { stored.set(key, value); }), delete: vi.fn(async (key: string) => { stored.delete(key); }) },
    };
    const save = vi.fn(async (...args: [unknown, number]) => { expect(args).toHaveLength(2); });
    const profile = {
      version: 1,
      id: 'persistence-test',
      name: 'Persistence test',
      controls: [
        { id: 'token', type: 'text', label: 'Token', default: '', persist: 'secret' },
        { id: 'shared', type: 'text', label: 'Shared', default: '', persist: 'global' },
        { id: 'temporary', type: 'text', label: 'Temporary', default: 'default', persist: 'workspace', resetOnNewConversation: true },
      ],
      opening: { mode: 'disabled' },
      conversation: { send: { method: 'POST', url: 'https://example.test' } },
      stream: { transport: 'sse', mappings: [] },
      history: { localRuns: { enabled: true, recordRawEvents: false, recordNormalizedEvents: false, recordChatSnapshot: false } },
    } as TurnStageProfile;
    const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, context as never, { get: vi.fn() } as never, { list: vi.fn(async () => []), save } as never, vi.fn(), { appendLine: vi.fn() } as never);

    await controller.loadRuns();
    expect(controller.snapshot.controls).not.toHaveProperty('token');
    expect(controller.snapshot.controls.shared).toBe('legacy-global');
    expect(context.globalState.update).toHaveBeenCalledWith('turnstage.control.global.persistence-test.shared', { version: 1, controlType: 'text', value: 'legacy-global' });
    await controller.setControl('token', 'changed-token');
    await controller.setControl('shared', 'changed-global');
    await controller.setControl('temporary', 'changed');
    await controller.newConversation();
    expect(controller.snapshot.controls.temporary).toBe('default');
    expect(context.secrets.store).toHaveBeenCalledWith('turnstage.control.secret.persistence-test.token', JSON.stringify({ version: 1, controlType: 'text', value: 'changed-token' }));
    expect(context.globalState.update).toHaveBeenCalledWith('turnstage.control.global.persistence-test.shared', { version: 1, controlType: 'text', value: 'changed-global' });

    controller.snapshot.remoteSessions = [{ conversationId: 'remote-1', title: 'Remote run', createdAt: 1, actorId: 'actor-a', environmentId: 'env' }];
    controller.applyRemoteSession('remote-1');
    expect(controller.snapshot.conversationId).toBe('remote-1');
    expect(controller.snapshot.messages[0]?.parts[0]?.text).toMatch(/Previous messages were not loaded/);

    (controller as unknown as { finalized: boolean }).finalized = false;
    controller.snapshot.turnState = 'streaming';
    controller.snapshot.rawEvents = [rawEvent(1)];
    controller.snapshot.normalizedEvents = [{ version: 1, type: 'content.text.delta', sequence: 1, receivedAt: 1, text: 'x' }];
    await controller.finalizeTurn({ type: 'completed' });
    const saved = save.mock.calls[0]?.[0] as { rawEvents?: unknown; normalizedEvents?: unknown; snapshot?: unknown };
    expect(saved.rawEvents).toBeUndefined();
    expect(saved.normalizedEvents).toBeUndefined();
    expect(saved.snapshot).toBeUndefined();
  });

  it('loads a request-backed opening and resolves its message and starters', async () => {
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      payload: {
        greeting: 'Opening loaded from the server.',
        starters: [{ id: 'starter-1', label: 'Begin', prompt: 'Begin', behavior: 'send' }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { SessionController } = await import('../src/extension/runtime/sessionController');
      const profile = {
        version: 1,
        id: 'opening-request-test',
        name: 'Opening request test',
        opening: {
          mode: 'request',
          request: { method: 'POST', url: 'https://example.test/opening', body: { actor: { $value: 'controls.actor' } } },
          response: { messagePath: '$.payload.greeting', startersPath: '$.payload.starters' },
        },
        controls: [{ id: 'actor', type: 'text', label: 'Actor', default: 'user-a' }],
        conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
        stream: { transport: 'sse', mappings: [] },
      } as TurnStageProfile;
      const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, {} as never, { get: vi.fn() } as never, { list: vi.fn(async () => []), save: vi.fn(async () => undefined) } as never, vi.fn(), { appendLine: vi.fn() } as never);

      await controller.startSession();

      expect(controller.snapshot.sessionState).toBe('ready');
      expect(controller.snapshot.opening).toEqual({
        message: 'Opening loaded from the server.',
        starters: [{ id: 'starter-1', label: 'Begin', prompt: 'Begin', behavior: 'send' }],
      });
      expect(fetchMock).toHaveBeenCalledWith('https://example.test/opening', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ actor: 'user-a' }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the configured opening fallback when the server returns a matching error', async () => {
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'OPENING_NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { SessionController } = await import('../src/extension/runtime/sessionController');
      const profile = {
        version: 1,
        id: 'opening-fallback-test',
        name: 'Opening fallback test',
        opening: {
          mode: 'request',
          request: { method: 'GET', url: 'https://example.test/opening' },
          fallbacks: [{ match: { path: '$.code', operator: 'equals', value: 'OPENING_NOT_FOUND' }, message: 'Local fallback', starters: [] }],
        },
        conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
        stream: { transport: 'sse', mappings: [] },
      } as TurnStageProfile;
      const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, {} as never, { get: vi.fn() } as never, { list: vi.fn(async () => []) } as never, vi.fn(), { appendLine: vi.fn() } as never);

      await controller.startSession();

      expect(controller.snapshot.sessionState).toBe('ready');
      expect(controller.snapshot.opening).toEqual({ message: 'Local fallback', starters: [] });
      expect(controller.snapshot.errors).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts locally and sends the configured remote stop request with conversation context', async () => {
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stopped: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { SessionController } = await import('../src/extension/runtime/sessionController');
      const profile = {
        version: 1,
        id: 'remote-stop-test',
        name: 'Remote stop test',
        conversation: {
          send: { method: 'POST', url: 'https://example.test/stream' },
          stop: {
            strategy: 'abortThenRequest',
            requiredContext: ['conversation.id'],
            request: { method: 'POST', url: 'https://example.test/stop', body: { conversationId: { $value: 'conversation.id' } } },
          },
        },
        stream: { transport: 'sse', mappings: [] },
      } as TurnStageProfile;
      const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, {} as never, { get: vi.fn() } as never, { list: vi.fn(async () => []), save: vi.fn(async () => undefined) } as never, vi.fn(), { appendLine: vi.fn() } as never);
      controller.snapshot.conversationId = 'conversation-42';
      controller.snapshot.turnState = 'streaming';
      (controller as unknown as { finalized: boolean }).finalized = false;
      (controller as unknown as { abortController: AbortController }).abortController = new AbortController();

      await controller.abort();

      expect(fetchMock).toHaveBeenCalledWith('https://example.test/stop', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 'conversation-42' }),
      }));
      expect(controller.snapshot.turnState).toBe('aborted');
      expect(controller.snapshot.errors).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds a hanging remote stop request with its configured timeout', async () => {
    vi.useFakeTimers();
    vi.mock('vscode', () => ({ workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), getWorkspaceFolder: () => undefined } }));
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { SessionController } = await import('../src/extension/runtime/sessionController');
      const profile = {
        version: 1,
        id: 'remote-stop-timeout-test',
        name: 'Remote stop timeout test',
        conversation: {
          send: { method: 'POST', url: 'https://example.test/stream' },
          stop: {
            strategy: 'abortThenRequest',
            requiredContext: ['conversation.id'],
            request: { method: 'POST', url: 'https://example.test/stop', timeoutMs: 25, body: { conversationId: { $value: 'conversation.id' } } },
          },
        },
        stream: { transport: 'sse', mappings: [] },
      } as TurnStageProfile;
      const controller = new SessionController(profile, {} as never, { version: 1, id: 'env', name: 'Environment', variables: {} }, {} as never, { get: vi.fn() } as never, { list: vi.fn(async () => []), save: vi.fn(async () => undefined) } as never, vi.fn(), { appendLine: vi.fn() } as never);
      controller.snapshot.conversationId = 'conversation-timeout';
      controller.snapshot.turnState = 'streaming';
      (controller as unknown as { finalized: boolean }).finalized = false;
      (controller as unknown as { abortController: AbortController }).abortController = new AbortController();

      const abortPromise = controller.abort();
      await vi.advanceTimersByTimeAsync(25);
      await abortPromise;

      expect(controller.snapshot.turnState).toBe('aborted');
      expect(controller.snapshot.errors).toEqual([expect.objectContaining({
        type: 'RemoteStopWarning',
        message: expect.stringContaining('remote stop failed'),
      })]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
