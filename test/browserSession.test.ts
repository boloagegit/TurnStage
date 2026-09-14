import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalRun, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { BrowserSession, type BrowserSessionState } from '../web/src/browserSession';

const profile: TurnStageProfile = {
  version: 1,
  id: 'web-test',
  name: 'Web test',
  environment: 'local',
  opening: { mode: 'static', message: 'Ready', starters: [] },
  conversation: { send: { method: 'POST', url: '${env.baseUrl}/stream', headers: { 'content-type': 'application/json' }, body: { message: { $value: 'input.text' } } } },
  stream: {
    transport: 'sse',
    mappings: [
      { id: 'start', match: { event: 'start' }, emit: { type: 'conversation.started', conversationId: { path: '$.conversationId' } } },
      { id: 'progress', match: { event: 'status' }, emit: { type: 'progress.updated', text: { path: '$.text' } } },
      { id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
      { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } },
    ],
  },
};
const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: { baseUrl: 'https://example.test' } };

afterEach(() => vi.unstubAllGlobals());

describe('BrowserSession', () => {
  it('uses the shared request, SSE mapping, and reducer path to complete a browser turn', async () => {
    const body = [
      'event: start\ndata: {"conversationId":"browser-conversation"}\n\n',
      'event: status\ndata: {"text":"Working"}\n\n',
      'event: message\ndata: {"text":"Browser result"}\n\n',
      'event: done\ndata: {"ok":true}\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const states: BrowserSessionState[] = [];
    const session = new BrowserSession(profile, environment, new Map(), (state) => states.push(structuredClone(state)));
    session.start();

    await session.send('Hello', { kind: 'manual' });

    const state = session.current;
    expect(state.snapshot.turnState).toBe('completed');
    expect(state.snapshot.conversationId).toBe('browser-conversation');
    expect(state.snapshot.messages.find((message) => message.role === 'assistant')?.parts).toContainEqual({ type: 'text', text: 'Browser result' });
    expect(state.snapshot.rawEvents).toHaveLength(4);
    expect(state.snapshot.normalizedEvents.map((event) => event.type)).toEqual(['conversation.started', 'progress.updated', 'content.text.delta', 'stream.completed']);
    expect(state.snapshot.messages.find((message) => message.role === 'assistant')?.parts).toContainEqual({ type: 'progress', text: 'Working', status: 'completed' });
    expect(state.networkEntries[0]).toMatchObject({ status: 200, state: 'completed', eventCount: 4 });
    expect(state.networkEntries[0]?.responseBodyPreview).toContain('Browser result');
    expect(states.length).toBeGreaterThan(3);
  });

  it('reports browser fetch failures without assuming that CORS is the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const session = new BrowserSession(profile, environment, new Map(), () => undefined);
    session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('did not provide an HTTP response');
    expect(session.current.snapshot.errors[0]?.message).not.toContain('CORS');
  });

  it('does not silently use another environment when the selected Profile environment is missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const session = new BrowserSession({ ...profile, environment: 'company-uat' }, environment, new Map(), () => undefined);

    await session.start();
    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.sessionState).toBe('failed');
    expect(session.current.snapshot.errors[0]).toMatchObject({ type: 'MissingEnvironment' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores an old opening response after changing the Profile', async () => {
    let resolveOld: (response: Response) => void = () => undefined;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Response('{"message":"New opening"}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const oldProfile = { ...profile, opening: { mode: 'request' as const, request: { method: 'GET' as const, url: 'https://example.test/old' } } };
    const newProfile = { ...oldProfile, opening: { mode: 'request' as const, request: { method: 'GET' as const, url: 'https://example.test/new' } } };
    const session = new BrowserSession(oldProfile, environment, new Map(), () => undefined);

    const first = session.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    session.updateProfile(newProfile, environment);
    await session.start();
    resolveOld(new Response('{"message":"Old opening"}', { status: 200 }));
    await first;

    expect(session.current.snapshot.opening?.message).toBe('New opening');
    expect(session.current.networkEntries).toHaveLength(1);
  });

  it('records a failed stream response and redacts known secrets and sensitive headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad test-secret"}', { status: 400, headers: { 'set-cookie': 'session=test-secret', 'x-debug': 'test-secret' } })));
    const session = new BrowserSession(profile, environment, new Map([['api', 'test-secret']]), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.networkEntries[0]?.responseBodyPreview).toContain('bad ••••••••');
    expect(session.current.networkEntries[0]?.responseHeaders?.['set-cookie']).not.toContain('test-secret');
    expect(session.current.networkEntries[0]?.responseHeaders?.['x-debug']).not.toContain('test-secret');
  });

  it('never publishes a known secret echoed across response chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: message\ndata: {"text":"test-'));
      controller.enqueue(new TextEncoder().encode('secret"}\n\nevent: done\ndata: {}\n\n'));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const states: BrowserSessionState[] = [];
    const session = new BrowserSession(profile, environment, new Map([['api', 'test-secret']]), (state) => states.push(state));
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(JSON.stringify(states)).not.toContain('test-secret');
    expect(JSON.stringify(session.current)).not.toContain('test-secret');
    expect(session.current.networkEntries[0]?.responseBodyPreview).toContain('••••••••');
  });

  it('retries configured pre-stream HTTP failures within the configured limit', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const retryProfile: TurnStageProfile = { ...profile, conversation: { send: { ...profile.conversation.send, reconnect: { maxAttempts: 1, baseDelayMs: 0, retryOnStatuses: [503] } } } };
    const session = new BrowserSession(retryProfile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.current.snapshot.turnState).toBe('completed');
    expect(session.current.networkEntries[0]?.attempt).toBe(2);
    expect(session.current.snapshot.metrics.reconnectCount).toBe(1);
  });

  it('sends the configured remote stop after aborting an active stream', async () => {
    const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
      .mockResolvedValueOnce(new Response('{"stopped":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const stopProfile: TurnStageProfile = { ...profile, conversation: { ...profile.conversation, stop: { strategy: 'abortThenRequest', request: { method: 'POST', url: '${env.baseUrl}/stop' }, requiredContext: ['turn.clientRequestId'] } } };
    const session = new BrowserSession(stopProfile, environment, new Map(), () => undefined);
    await session.start();
    const running = session.send('Hello', { kind: 'manual' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await session.abort();
    await running;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.current.networkEntries.at(-1)).toMatchObject({ kind: 'stop', status: 200, state: 'completed' });
    expect(session.current.snapshot.turnState).toBe('aborted');
  });

  it('persists non-secret controls by Profile, resets requested values, and never exposes secret controls', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    const controlProfile: TurnStageProfile = { ...profile, controls: [
      { id: 'mode', type: 'select', label: 'Mode', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], default: 'a', persist: 'global' },
      { id: 'fresh', type: 'text', label: 'Fresh', default: 'base', persist: 'workspace', resetOnNewConversation: true },
      { id: 'token', type: 'text', label: 'Token', persist: 'secret' },
    ] };
    const session = new BrowserSession(controlProfile, environment, new Map(), () => undefined);
    session.setControl('mode', 'b');
    session.setControl('fresh', 'changed');
    session.setControl('token', 'private-token');
    expect(session.current.snapshot.controls).toEqual({ mode: 'b', fresh: 'changed' });
    expect(JSON.stringify([...values.values()])).not.toContain('private-token');

    await session.newConversation();

    expect(session.current.snapshot.controls).toEqual({ mode: 'b', fresh: 'base' });
    const reloaded = new BrowserSession(controlProfile, environment, new Map(), () => undefined);
    expect(reloaded.current.snapshot.controls).toEqual({ mode: 'b', fresh: 'base' });
    expect(values.size).toBe(1);
  });

  it('persists an object-valued user choice and sends its fields in Web requests', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    const fetch = vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const selected = { custid: 'C002', bdcun: 'B002' };
    const controlProfile: TurnStageProfile = { ...profile,
      controls: [{ id: 'user', type: 'select', label: 'User', persist: 'global', default: { custid: 'C001', bdcun: 'B001' }, options: [
        { label: 'A', value: { custid: 'C001', bdcun: 'B001' } }, { label: 'B', value: selected },
      ] }],
      conversation: { send: { method: 'POST', url: '${env.baseUrl}/stream', variants: [{ id: 'first', body: { custid: { $value: 'controls.user.custid' }, bdcun: { $value: 'controls.user.bdcun' } } }] } },
    };
    const session = new BrowserSession(controlProfile, environment, new Map(), () => undefined);
    session.setControl('user', { bdcun: 'B002', custid: 'C002' });
    expect(session.current.snapshot.controls.user).toEqual(selected);
    session.setControl('user', { custid: 'forged', bdcun: 'B002' });
    expect(session.current.snapshot.controls.user).toEqual(selected);
    const reloaded = new BrowserSession(controlProfile, environment, new Map(), () => undefined);
    expect(reloaded.current.snapshot.controls.user).toEqual(selected);
    await reloaded.start();
    await reloaded.send('Hello', { kind: 'manual' });
    expect(fetch).toHaveBeenCalledWith('https://example.test/stream', expect.objectContaining({ body: JSON.stringify(selected) }));
  });

  it('bounds long-lived raw event history without resetting per-turn sequence numbers', async () => {
    const body = `${'event: unused\ndata: {}\n\n'.repeat(5001)}event: done\ndata: {}\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const session = new BrowserSession(profile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('completed');
    expect(session.current.snapshot.rawEvents).toHaveLength(5000);
    expect(session.current.snapshot.droppedEventCount).toBe(2);
    expect(session.current.snapshot.rawEvents.at(-1)?.turnSequence).toBe(5002);
  });

  it('uses a legacy VS Code invalid-certificate flag without blocking browser opening or messages', async () => {
    const tlsProfile: TurnStageProfile = {
      ...profile,
      opening: { mode: 'request', request: { method: 'GET', url: 'http://127.0.0.1:9095/api/opening', tls: { allowInvalidCertificates: true } } },
      conversation: { send: { ...profile.conversation.send, url: 'http://127.0.0.1:9095/api/stream', tls: { allowInvalidCertificates: true } } },
    };
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/opening')
      ? new Response(JSON.stringify({ message: 'Remote opening' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const states: BrowserSessionState[] = [];
    const session = new BrowserSession(tlsProfile, environment, new Map(), (state) => states.push(structuredClone(state)));

    await session.start();
    expect(session.current.snapshot.opening?.message).toBe('Remote opening');
    expect(states.some((state) => state.networkEntries[0]?.state === 'pending')).toBe(true);
    await session.send('Hello', { kind: 'manual' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.current.snapshot.turnState).toBe('completed');
    expect(session.current.networkEntries).toHaveLength(2);
    expect(session.current.networkEntries.map((entry) => entry.state)).toEqual(['completed', 'completed']);
    expect(session.current.requestPreview).not.toHaveProperty('tls');
  });

  it('records a bounded opening response and renders VS Code-compatible starters and response blocks', async () => {
    const openingProfile: TurnStageProfile = {
      ...profile,
      opening: {
        mode: 'request', request: { method: 'GET', url: 'http://127.0.0.1:9095/api/opening' },
        response: { blocks: [{ id: 'status', kind: 'status', path: '$.status', valuePath: '$.message' }] },
      },
    };
    const body = JSON.stringify({ message: 'Welcome', options: ['First question', { label: 'Second question', prompt: 'Ask second' }], status: { message: 'Available' }, debugEcho: 'test-secret' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'session=value' } })));
    const session = new BrowserSession(openingProfile, environment, new Map([['api', 'test-secret']]), () => undefined);

    await session.start();

    expect(session.current.snapshot.sessionState).toBe('ready');
    expect(session.current.snapshot.opening).toMatchObject({
      message: 'Welcome',
      starters: [{ label: 'First question', prompt: 'First question', behavior: 'send' }, { label: 'Second question', prompt: 'Ask second', behavior: 'send' }],
      blocks: [{ id: 'status', kind: 'status', value: 'Available' }],
    });
    expect(session.current.networkEntries[0]).toMatchObject({ kind: 'opening', state: 'completed', status: 200, transferredBytes: new TextEncoder().encode(body).length });
    expect(session.current.networkEntries[0]?.responseBodyPreview).toContain('Welcome');
    expect(session.current.networkEntries[0]?.responseBodyPreview).not.toContain('test-secret');
    expect(session.current.networkEntries[0]?.responseHeaders?.['set-cookie']).not.toContain('session=value');
  });

  it('keeps the opening error response visible in Network when the upstream returns HTTP 400', async () => {
    const openingProfile: TurnStageProfile = {
      ...profile,
      opening: { mode: 'request', request: { method: 'POST', url: 'http://127.0.0.1:9095/api/opening' } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid request"}', { status: 400, headers: { 'content-type': 'application/json' } })));
    const session = new BrowserSession(openingProfile, environment, new Map(), () => undefined);

    await session.start();

    expect(session.current.snapshot.sessionState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('HTTP 400');
    expect(session.current.networkEntries[0]).toMatchObject({ kind: 'opening', state: 'failed', status: 400, error: { status: 400 } });
    expect(session.current.networkEntries[0]?.responseBodyPreview).toContain('invalid request');
  });

  it('bounds oversized opening responses and marks the Network preview as truncated', async () => {
    const openingProfile: TurnStageProfile = {
      ...profile,
      opening: { mode: 'request', request: { method: 'GET', url: 'http://127.0.0.1:9095/api/opening' } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 })));
    const session = new BrowserSession(openingProfile, environment, new Map(), () => undefined);

    await session.start();

    expect(session.current.snapshot.sessionState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('maximum allowed size');
    expect(session.current.networkEntries[0]?.responseBodyTruncated).toBe(true);
    expect(session.current.networkEntries[0]?.responseBodyPreview?.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('lets the browser reject untrusted HTTPS instead of claiming to disable certificate checks', async () => {
    const tlsProfile: TurnStageProfile = {
      ...profile,
      conversation: { send: { ...profile.conversation.send, tls: { allowInvalidCertificates: true } } },
    };
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetch);
    const session = new BrowserSession(tlsProfile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(fetch).toHaveBeenCalledOnce();
    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('did not provide an HTTP response');
    expect(session.current.networkEntries[0]?.state).toBe('failed');
  });

  it('does not ask permission for opening requests to the Web app own origin', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { location: { origin: 'http://web.example:9095' }, confirm });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Ready' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const sameOriginProfile: TurnStageProfile = {
      ...profile,
      opening: { mode: 'request', request: { method: 'GET', url: 'http://web.example:9095/api/opening' } },
    };

    await new BrowserSession(sameOriginProfile, environment, new Map(), () => undefined).start();

    expect(fetch).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not interrupt external opening or secret-bearing messages with a browser confirmation', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { location: { origin: 'http://web.example:9095' }, confirm });
    const fetch = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/opening')
      ? new Response(JSON.stringify({ message: 'Ready' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const externalProfile: TurnStageProfile = {
      ...profile,
      opening: { mode: 'request', request: { method: 'GET', url: 'https://external.example/opening' } },
      conversation: { send: { ...profile.conversation.send, url: 'http://external.example/stream', headers: { authorization: 'Bearer ${secret.api}' } } },
    };
    const session = new BrowserSession(externalProfile, environment, new Map([['api', 'test-token']]), () => undefined);

    await session.start();
    await session.send('Hello', { kind: 'manual' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(session.current.snapshot.turnState).toBe('completed');
  });

  it('replays recorded raw events through the shared mapping and reducer path', async () => {
    const recorded = new BrowserSession(profile, environment, new Map(), () => undefined);
    const run: LocalRun = {
      id: 'browser-replay', profileId: profile.id, createdAt: Date.now(), metrics: recorded.current.snapshot.metrics, result: { type: 'completed' },
      snapshot: { ...structuredClone(recorded.current.snapshot), messages: [{ id: 'user', role: 'user', status: 'completed', createdAt: 1, completedAt: 1, parts: [{ type: 'text', text: 'Replay' }], citations: [], actions: [], followups: [] }] },
      rawEvents: [
        { sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'sse', raw: 'event: message\ndata: {"text":"Again"}', data: { text: 'Again' }, sse: { event: 'message' } },
        { sequence: 2, receivedAt: 2, elapsedMs: 0, protocol: 'sse', raw: 'event: done\ndata: {}', data: {}, sse: { event: 'done' } },
      ],
    };

    expect(recorded.replayRun(run, 4)).toBe(true);
    await vi.waitFor(() => expect(recorded.current.snapshot.replay?.status).toBe('completed'));
    expect(recorded.current.snapshot.messages.find((message) => message.role === 'assistant')?.parts).toContainEqual({ type: 'text', text: 'Again' });
    expect(recorded.current.snapshot.normalizedEvents.map((event) => event.type)).toEqual(['content.text.delta', 'stream.completed']);
  });

  it('resolves environment secret references from memory and redacts the inspector', async () => {
    const secretProfile: TurnStageProfile = { ...profile, conversation: { send: { ...profile.conversation.send, headers: { authorization: 'Bearer ${secret.api}' } } } };
    const secretEnvironment: TurnStageEnvironment = { ...environment, secretReferences: { api: 'company-token' } };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-only-secret-value');
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const session = new BrowserSession(secretProfile, secretEnvironment, new Map([['company-token', 'test-only-secret-value']]), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.requestPreview).toMatchObject({ headers: { authorization: 'Bearer ••••••••' } });
    expect(session.current.networkEntries[0]?.requestHeaders.authorization).toBe('Bearer ••••••••');
  });

  it('fails closed when the configured browser request timeout elapses', async () => {
    const timeoutProfile: TurnStageProfile = { ...profile, conversation: { send: { ...profile.conversation.send, timeoutMs: 10 } } };
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const session = new BrowserSession(timeoutProfile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.snapshot.errors[0]).toMatchObject({ type: 'RequestTimeoutError' });
  });

  it('follows same-origin redirects using the shared bounded redirect policy', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/stream-v2' } }))
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const session = new BrowserSession(profile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('completed');
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://example.test/stream-v2', expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects cross-origin redirects under the default profile policy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/stream' } })));
    const session = new BrowserSession(profile, environment, new Map(), () => undefined);
    await session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('different origin');
  });
});
