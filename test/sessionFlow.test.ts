import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
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
    const profile = basicProfile();
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
      { appendLine: vi.fn() } as never,
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
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'progress', text: 'Preparing a sample response…', status: 'completed' }),
        expect.objectContaining({ type: 'text', text: 'Here is the sample result.' }),
      ]),
    });
    expect(controller.requestPreview).toMatchObject({ method: 'POST', url: `${baseUrl}/basic/chat/stream`, variantId: 'first-turn' });
    expect(savedRuns).toHaveLength(1);
    expect(savedRuns[0]).toMatchObject({ profileId: 'functional-session', result: { type: 'completed' } });
    expect(savedRuns[0]?.rawEvents).toHaveLength(6);
    expect(savedRuns[0]?.normalizedEvents).toHaveLength(6);
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
