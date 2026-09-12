import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalRun, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { BrowserSession } from '../web/src/browserSession';

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
    const states: Array<ReturnType<typeof structuredClone>> = [];
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
    expect(states.length).toBeGreaterThan(3);
  });

  it('turns browser fetch failures into an explicit CORS-oriented error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const session = new BrowserSession(profile, environment, new Map(), () => undefined);
    session.start();

    await session.send('Hello', { kind: 'manual' });

    expect(session.current.snapshot.turnState).toBe('failed');
    expect(session.current.snapshot.errors[0]?.message).toContain('CORS');
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
