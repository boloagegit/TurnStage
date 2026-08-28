import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';

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

describe('generic POST plus SSE chat mock contract', () => {
  const openingBody = {
    actorId: 'synthetic-user-a',
    taskId: 'DEMO_OPENING_TASK',
    blockId: 'DEMO_BLOCK',
    tags: [{ attrName: 'Test', attrValue: 'Y' }],
    openingMsgArgs: [{ placeholder: 'sampleValue', value: '123456' }],
  };

  it('returns the 7021 fallback signal and optional normalized opening choices', async () => {
    const fallback = await postJson('/v1/chat/opening', openingBody);
    expect(fallback).toMatchObject({ status: 200, data: { code: 7021 } });

    const configured = await postJson('/v1/chat/opening', openingBody, { 'X-TurnStage-Mode': 'opening-options' });
    expect(configured.data).toMatchObject({
      openingMessage: expect.any(String),
      optionsInfo: expect.arrayContaining([expect.objectContaining({ behavior: 'send', prompt: expect.any(String) })]),
    });
  });

  it('distinguishes first-turn and continuation bodies and emits the expected SSE order', async () => {
    const first = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'synthetic-user-a', message: 'First turn', openingMessage: { content: 'Synthetic opening' }, conversationProfile: { customerReference: 'SYNTHETIC_CUSTOMER', userReference: 'SYNTHETIC_USER', sessionProof: 'SYNTHETIC_PROOF_1' } }),
    });
    const firstEvents = parseSse(await first.text());
    expect(firstEvents.map((event) => event.event)).toEqual(['start', 'status', 'message', 'title', 'done']);
    const cid = String(firstEvents[0]?.data.cid);

    const continuation = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: 'synthetic-user-a', message: 'Next turn', cid }),
    });
    const continuationEvents = parseSse(await continuation.text());
    expect(continuationEvents.map((event) => event.event)).toEqual(['start', 'status', 'message', 'title', 'done']);
    expect(continuationEvents[0]?.data.cid).toBe(cid);

    const invalidContinuation = await postJson('/v1/chat/stream', { actorId: 'synthetic-user-a', message: 'Invalid continuation', cid, openingMessage: { content: 'Must not be present' } });
    expect(invalidContinuation).toMatchObject({ status: 400, data: { code: 'CONTINUATION_CONTAINS_FIRST_TURN_FIELDS' } });
  });

  it('emits a terminal domain error and validates the remote stop payload', async () => {
    const failed = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-TurnStage-Mode': 'contract-error' },
      body: JSON.stringify({ actorId: 'synthetic-user-a', message: 'Trigger synthetic failure', openingMessage: { content: 'Synthetic opening' }, conversationProfile: {} }),
    });
    const events = parseSse(await failed.text());
    expect(events.map((event) => event.event)).toEqual(['start', 'status', 'message', 'error']);
    expect(events.at(-1)?.data).toEqual({ code: 'SAMPLE_SERVICE_UNAVAILABLE', message: 'The synthetic knowledge service is temporarily unavailable.' });

    const started = events[0]!.data;
    const stopped = await postJson('/v1/chat/stop', { cid: started.cid, assistantMessageId: started.assistantMessageId, reason: 'user_cancel' });
    expect(stopped).toMatchObject({ status: 200, data: { stopped: true, cid: started.cid, assistantMessageId: started.assistantMessageId, reason: 'user_cancel' } });
  });

  it('emits follow-up, CTA, web-link, unknown custom event, and diagnostic fixtures', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-TurnStage-Mode': 'contract-actions' },
      body: JSON.stringify({ actorId: 'synthetic-user-a', message: 'Interaction fixtures', openingMessage: { content: 'Synthetic opening' }, conversationProfile: { customerReference: 'SYNTHETIC_CUSTOMER', userReference: 'SYNTHETIC_USER', sessionProof: 'SYNTHETIC_PROOF_1' } }),
    });
    const events = parseSse(await response.text());
    expect(events.map((event) => event.event)).toEqual(['start', 'status', 'message', 'followup', 'action', 'action', 'custom_card', 'diagnostic', 'title', 'done']);
    expect(events.find((event) => event.event === 'custom_card')?.data).toMatchObject({ type: 'form', fields: expect.any(Array) });
  });

  async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
});

function parseSse(text: string): Array<{ event: string; data: Record<string, any> }> {
  return text.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = JSON.parse(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')) as Record<string, any>;
    return { event, data };
  });
}

function waitForServer(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveServer, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the mock server.')), 4_000);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) { clearTimeout(timeout); resolveServer(match[1]); }
    });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Mock server exited before it was ready (code ${code}): ${output}`)));
  });
}
