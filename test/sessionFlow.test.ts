import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import type { LocalRun, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    getWorkspaceFolder: () => undefined,
  },
}));

let server: ChildProcessWithoutNullStreams;
let baseUrl: string;

beforeAll(async () => {
  server = spawn(process.execPath, [resolve(import.meta.dirname, '../examples/mock-server/server.mjs')], {
    env: { ...process.env, TURNSTAGE_MOCK_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  baseUrl = await waitForServer(server);
}, 5_000);

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => server.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(() => { server.kill('SIGKILL'); resolveTimeout(); }, 1_000)),
  ]);
});

describe('SessionController end-to-end functional flow', () => {
  it('builds a request, streams SSE, maps events, reduces chat state, and records the run', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const savedRuns: LocalRun[] = [];
    const output = { appendLine: vi.fn() };
    const profile = basicProfile();
    profile.conversation.send.headers = {
      ...profile.conversation.send.headers,
      Cookie: 'session=local-cookie',
      'X-API-Key': 'local-api-key',
      'X-Custom-Trace': 'prefix-${secret.apiToken}',
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: { baseUrl } };
    const controller = new SessionController(
      profile,
      {} as never,
      environment,
      {} as never,
      { get: vi.fn(async () => 'test-token') } as never,
      {
        list: vi.fn(async () => []),
        save: vi.fn(async (run: LocalRun) => { savedRuns.push(run); }),
      } as never,
      vi.fn(),
      output as never,
    );

    await controller.send('Verify the complete flow', { kind: 'manual' });

    expect(controller.snapshot.turnState).toBe('completed');
    expect(controller.snapshot.conversationId).toMatch(/^conversation-/);
    expect(controller.snapshot.title).toBe('Sample conversation');
    expect(controller.snapshot.rawEvents).toHaveLength(6);
    expect(controller.snapshot.normalizedEvents.map((event) => event.type)).toEqual([
      'conversation.started',
      'progress.updated',
      'content.text.delta',
      'content.text.delta',
      'conversation.title.updated',
      'stream.completed',
    ]);
    expect(controller.snapshot.messages[0]).toMatchObject({ role: 'user', status: 'completed', parts: [{ type: 'text', text: 'Verify the complete flow' }] });
    expect(controller.snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'completed',
      timing: { ttft: expect.any(Number), totalDuration: expect.any(Number) },
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'progress', text: 'Preparing a sample response…', status: 'completed' }),
        expect.objectContaining({ type: 'text', text: 'Here is the sample result.' }),
      ]),
    });
    expect(controller.requestPreview).toMatchObject({ method: 'POST', url: `${baseUrl}/basic/chat/stream`, variantId: 'first-turn' });
    expect(savedRuns).toHaveLength(1);
    expect(savedRuns[0]).toMatchObject({ profileId: 'functional-session', result: { type: 'completed' } });
    expect(savedRuns[0]?.metrics.reconnectCount).toBe(0);
    expect(savedRuns[0]?.rawEvents).toHaveLength(6);
    expect(savedRuns[0]?.normalizedEvents).toHaveLength(6);
    const assistantTiming = controller.snapshot.messages[1]?.timing;
    expect(assistantTiming?.ttft).toBeGreaterThanOrEqual(0);
    expect(assistantTiming?.totalDuration).toBeGreaterThanOrEqual(assistantTiming?.ttft ?? 0);
    expect(savedRuns[0]?.snapshot?.messages[1]?.timing).toEqual(assistantTiming);
    const outputText = output.appendLine.mock.calls.flat().join('\n');
    expect(outputText).toContain('] start profile="functional-session" environment="local" method=POST');
    expect(outputText).toContain('] headers attempt=1 status=200');
    expect(outputText).toContain('] firstChunk=1');
    expect(outputText).toContain('] ended profile="functional-session" environment="local" state=completed');
    expect(outputText).toContain('profile="functional-session" environment="local"');
    expect(outputText).toMatch(/requestHeaders=6 headerBytes=\d+ bodyBytes=\d+/);
    expect(outputText).toContain('requestId="mock-basic-stream"');
    expect(outputText).toContain('lastEvent="done"');
    expect(outputText).toContain('terminalEvent=true');
    expect(outputText).toContain('parseErrors=0 mappingErrors=0 unmatched=0');
    expect(outputText).not.toContain('test-token');
    expect(outputText).not.toContain('Verify the complete flow');
    const networkEntries = controller.getNetworkEntries();
    expect(networkEntries).toHaveLength(1);
    expect(networkEntries[0]).toMatchObject({
      kind: 'stream', attempt: 1, method: 'POST', status: 200, state: 'completed',
      protocol: 'sse', transferredBytes: expect.any(Number), eventCount: 6,
      timing: { headers: expect.any(Number), firstChunk: expect.any(Number), total: expect.any(Number) },
      requestHeaders: { Authorization: 'Bearer ••••••••' },
    });
    expect(networkEntries[0]?.responseHeaders).toMatchObject({ 'content-type': expect.stringContaining('text/event-stream') });
    expect(networkEntries[0]?.requestHeaders).toMatchObject({ Cookie: '••••••••', 'X-API-Key': '••••••••', 'X-Custom-Trace': 'prefix-••••••••' });
    expect(networkEntries[0]?.responseBodyPreview).toContain('sample result');
    expect(JSON.stringify(networkEntries)).not.toContain('Bearer test-token');
    expect(JSON.stringify(networkEntries)).not.toContain('local-cookie');
    expect(JSON.stringify(networkEntries)).not.toContain('local-api-key');
    expect(outputText).not.toContain('local-cookie');
    expect(outputText).not.toContain('local-api-key');
  });

  it('serializes reconnect attempts into a failed run when the retry budget is exhausted', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const savedRuns: LocalRun[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '0' } });
    }) as typeof fetch;
    try {
      const profile = basicProfile();
      profile.conversation.send.reconnect = { maxAttempts: 2, baseDelayMs: 0, retryOnStatuses: [429] };
      const controller = new SessionController(
        profile,
        {} as never,
        { version: 1, id: 'retry', name: 'Retry', variables: { baseUrl: 'https://retry.example' } },
        {} as never,
        { get: vi.fn(async () => 'test-token') } as never,
        {
          list: vi.fn(async () => []),
          save: vi.fn(async (run: LocalRun) => { savedRuns.push(run); }),
        } as never,
        vi.fn(),
        { appendLine: vi.fn() } as never,
      );

      await controller.send('Retry exhaustion', { kind: 'manual' });

      expect(calls).toBe(3);
      expect(controller.snapshot.turnState).toBe('failed');
      expect(controller.snapshot.metrics.reconnectCount).toBe(2);
      expect(savedRuns[0]?.metrics.reconnectCount).toBe(2);
      expect(controller.getNetworkEntries().map((entry) => ({ attempt: entry.attempt, state: entry.state, status: entry.status }))).toEqual([
        { attempt: 1, state: 'failed', status: 429 },
        { attempt: 2, state: 'failed', status: 429 },
        { attempt: 3, state: 'failed', status: 429 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps an idle timeout visible in the Network timing and error details', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = basicProfile();
    profile.controls!.find((control) => control.id === 'mode')!.default = 'idle-timeout';
    profile.conversation.send.timeoutMs = 2_000;
    profile.conversation.send.idleTimeoutMs = 100;
    const output = { appendLine: vi.fn() };
    const controller = new SessionController(
      profile,
      {} as never,
      { version: 1, id: 'idle-timeout', name: 'Idle timeout', variables: { baseUrl } },
      {} as never,
      { get: vi.fn(async () => 'test-token') } as never,
      { list: vi.fn(async () => []), save: vi.fn(async () => undefined) } as never,
      vi.fn(),
      output as never,
    );

    await controller.send('Trigger idle timeout', { kind: 'manual' });

    expect(controller.snapshot.turnState).toBe('failed');
    expect(controller.getNetworkEntries()).toHaveLength(1);
    expect(controller.getNetworkEntries()[0]).toMatchObject({
      kind: 'stream',
      attempt: 1,
      status: 200,
      state: 'failed',
      timing: { headers: expect.any(Number), total: expect.any(Number), idleTimeout: 100, timeout: 2_000 },
      error: { type: 'IdleTimeoutError' },
    });
    const outputText = output.appendLine.mock.calls.flat().join('\n');
    expect(outputText).toContain('IdleTimeoutError');
    expect(outputText).toContain('phase=after-headers');
    expect(outputText).toContain('terminalEvent=false');
    expect(outputText).toContain('lastEvent=none');
    expect(outputText).not.toContain('test-token');
    expect(outputText).not.toContain('Trigger idle timeout');
  });

  it('runs the synthetic enterprise first-turn, continuation, and domain-error contract', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = parse(readFileSync(resolve(import.meta.dirname, '../resources/templates/enterprise-chat.turnstage.jsonc'), 'utf8')) as TurnStageProfile;
    const savedRuns: LocalRun[] = [];
    const state = new Map<string, unknown>();
    const context = {
      globalState: { get: (key: string, fallback?: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } },
      workspaceState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) },
      secrets: { get: vi.fn(async () => undefined), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    };
    const controller = new SessionController(
      profile,
      {} as never,
      { version: 1, id: 'local', name: 'Local', variables: { baseUrl } },
      context as never,
      { get: vi.fn(async () => undefined) } as never,
      { list: vi.fn(async () => []), save: vi.fn(async (run: LocalRun) => { savedRuns.push(run); }) } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );

    await controller.startSession();
    expect(controller.snapshot).toMatchObject({ sessionState: 'ready', opening: { message: 'Hello, I am a synthetic test assistant. How can I help?' } });
    expect(controller.getNetworkEntries()[0]).toMatchObject({ kind: 'opening', status: 200, state: 'completed' });

    await controller.send('  第一輪問題  ', { kind: 'manual' });
    const cid = controller.snapshot.conversationId;
    const firstAssistantTiming = structuredClone(controller.snapshot.messages.at(-1)?.timing);
    expect(cid).toMatch(/^cid-/);
    expect(controller.requestPreview).toMatchObject({ variantId: 'first-turn' });
    expect(controller.snapshot.rawEvents.map((event) => event.sse?.event)).toEqual(['start', 'status', 'message', 'title', 'done']);
    expect(JSON.stringify(controller.requestPreview?.body)).toContain('SYNTHETIC_PROOF_');

    await controller.send('下一句', { kind: 'manual' });
    expect(controller.requestPreview).toMatchObject({ variantId: 'continuation', body: expect.objectContaining({ cid }) });
    expect(controller.snapshot.rawEvents).toHaveLength(5);
    expect(controller.snapshot.normalizedEvents).toHaveLength(5);
    expect(savedRuns).toHaveLength(2);
    expect(savedRuns.every((run) => run.rawEvents?.length === 5)).toBe(true);
    expect(controller.snapshot.messages.at(-3)?.timing).toEqual(firstAssistantTiming);
    expect(controller.snapshot.messages.at(-1)?.timing).toMatchObject({ ttft: expect.any(Number), totalDuration: expect.any(Number) });
    expect(controller.snapshot.messages.at(-1)?.timing).not.toBe(controller.snapshot.messages.at(-3)?.timing);

    await controller.setControl('mode', 'contract-actions');
    await controller.newConversation();
    await controller.send('互動元件', { kind: 'manual' });
    const customCard = controller.snapshot.rawEvents.find((event) => event.sse?.event === 'custom_card');
    expect(customCard).toMatchObject({ data: expect.objectContaining({ type: 'form' }) });
    expect(customCard?.mappingRuleId).toBeUndefined();
    expect(controller.snapshot.normalizedEvents.some((event) => event.type === 'form.upsert')).toBe(false);
    expect(controller.snapshot.metrics.unmatchedEventCount).toBe(1);
    expect(controller.snapshot.turnState).toBe('completed');
    expect(controller.snapshot.normalizedEvents.filter((event) => event.type === 'action.upsert')).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: expect.objectContaining({ actionId: 'request.send', payload: { text: expect.any(String), interactionKey: 'sample_details' } }) }),
      expect.objectContaining({ action: expect.objectContaining({ actionId: 'uri.open', payload: { uri: 'https://example.com/sample-guide', interactionKey: 'sample_guide' } }) }),
    ]));

    await controller.setControl('mode', 'contract-error');
    await controller.newConversation();
    await controller.send('Trigger synthetic failure', { kind: 'manual' });
    expect(controller.snapshot.turnState).toBe('failed');
    expect(controller.snapshot.rawEvents.map((event) => event.sse?.event)).toEqual(['start', 'status', 'message', 'error']);
    expect(controller.snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'failed' });
    expect(JSON.stringify(controller.snapshot.messages.at(-1))).not.toContain('streaming');
    expect(controller.snapshot.errors.at(-1)?.message).toBe('The synthetic knowledge service is temporarily unavailable.');
  });

  it('uses the live assistant id for stop and appends the configured system notice', async () => {
    const { SessionController } = await import('../src/extension/runtime/sessionController');
    const profile = parse(readFileSync(resolve(import.meta.dirname, '../resources/templates/enterprise-chat.turnstage.jsonc'), 'utf8')) as TurnStageProfile;
    profile.controls!.find((control) => control.id === 'mode')!.default = 'contract-slow';
    const controller = new SessionController(
      profile,
      {} as never,
      { version: 1, id: 'local', name: 'Local', variables: { baseUrl } },
      { globalState: { get: (key: string, fallback?: unknown) => { void key; return fallback; }, update: vi.fn(async () => undefined) }, workspaceState: { get: () => undefined, update: vi.fn(async () => undefined) }, secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() } } as never,
      { get: vi.fn(async () => undefined) } as never,
      { list: vi.fn(async () => []), save: vi.fn(async () => undefined) } as never,
      vi.fn(),
      { appendLine: vi.fn() } as never,
    );
    await controller.startSession();
    const sending = controller.send('請開始慢速回覆', { kind: 'manual' });
    await waitUntil(() => controller.snapshot.turnState === 'streaming', 2_000);
    const assistantId = controller.snapshot.messages.at(-1)?.id;
    await controller.abort();
    await sending;

    expect(assistantId).toMatch(/^assistant-/);
    expect(controller.snapshot.turnState).toBe('aborted');
    expect(controller.snapshot.messages.at(-2)).toMatchObject({ id: assistantId, role: 'assistant', status: 'aborted' });
    expect(controller.snapshot.messages.at(-2)?.timing?.totalDuration).toEqual(expect.any(Number));
    expect(controller.snapshot.messages.at(-1)).toMatchObject({ role: 'system', status: 'completed', parts: [{ type: 'text', text: 'Conversation stopped.' }] });
    expect(controller.snapshot.errors.some((error) => error.type === 'RemoteStopWarning')).toBe(false);
    expect(controller.getNetworkEntries().some((entry) => entry.kind === 'stop' && entry.status === 200 && entry.state === 'completed')).toBe(true);
    expect(controller.getLatestConnectionExchange()).toMatchObject({ kind: 'stream' });

    controller.clearConversation();
    expect(controller.getNetworkEntries()).toEqual([]);
    expect(controller.getLatestConnectionExchange()).toBeUndefined();
    expect(controller.requestPreview).toBeUndefined();
    expect(controller.snapshot.metrics).toMatchObject({ eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 });
  });
});

function basicProfile(): TurnStageProfile {
  return {
    version: 1,
    id: 'functional-session',
    name: 'Functional session',
    controls: [
      { id: 'mode', type: 'select', label: 'Mode', default: 'normal' },
      { id: 'actor', type: 'text', label: 'Actor', default: 'actor-a' },
    ],
    conversation: {
      send: {
        method: 'POST',
        url: '${env.baseUrl}/basic/chat/stream',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer ${secret.apiToken}' },
        variants: [{
          id: 'first-turn',
          when: { path: 'conversation.id', operator: 'notExists' },
          body: { mode: { $value: 'controls.mode' }, actorId: { $value: 'controls.actor' }, message: { $value: 'input.text' } },
        }],
      },
    },
    stream: {
      transport: 'sse',
      mappings: [
        { id: 'start', match: { event: 'start' }, emit: { type: 'conversation.started', conversationId: { path: '$.conversationId' }, assistantMessageId: { path: '$.assistantMessageId' } } },
        { id: 'status', match: { event: 'status' }, emit: { type: 'progress.updated', text: { path: '$.text' } } },
        { id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
        { id: 'title', match: { event: 'title' }, emit: { type: 'conversation.title.updated', title: { path: '$.title' } } },
        { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } },
      ],
    },
    history: { localRuns: { enabled: true, maxRuns: 3, recordRawEvents: true, recordNormalizedEvents: true, recordChatSnapshot: true } },
  };
}

function waitForServer(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveServer, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the mock server.')), 4_000);
    let output = '';
    const finish = (value: string) => { clearTimeout(timeout); resolveServer(value); };
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(match[1]);
    });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Mock server exited before it was ready (code ${code}): ${output}`)));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for session state.');
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}
