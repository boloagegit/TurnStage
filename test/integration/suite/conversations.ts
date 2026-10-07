import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ConversationRepository } from '../../../src/extension/history/conversationRepository';
import { LocalRunRepository } from '../../../src/extension/history/localRunRepository';
import { SessionController } from '../../../src/extension/runtime/sessionController';
import { SecretService } from '../../../src/extension/security/security';
import type { ConversationDirectory, TurnStageProfile } from '../../../src/shared/types';

/** Real Extension Host trust, filesystem, HTTP, and SSE boundaries for the drawer. */
export async function assertConversationHistoryBoundary(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'turnstage-conversation-integration-'));
  const requests: string[] = [];
  const histories = new Map<string, Array<{ role: string; content: string }>>();
  let sequence = 0;
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/conversations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [...histories.keys()].map((id) => ({ id, title: id })) }));
    } else if (request.url?.startsWith('/conversations/')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ messages: histories.get(request.url.split('/')[2]!) ?? [] }));
    } else {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as { message: string; conversationId?: string };
      const id = input.conversationId ?? `conversation-${++sequence}`;
      histories.set(id, [...(histories.get(id) ?? []), { role: 'user', content: input.message }, { role: 'assistant', content: request.headers['x-rewrite'] === 'true' ? 'Saved answer.' : 'Streamed answer.' }]);
      response.setHeader('content-type', 'text/event-stream');
      response.end(`event: start\ndata: ${JSON.stringify({ conversationId: id })}\n\nevent: message\ndata: {"text":"Streamed answer."}\n\nevent: done\ndata: {}\n\n`);
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const profile: TurnStageProfile = {
    version: 1, id: 'conversations-integration', name: 'Conversations integration',
    conversation: { send: { method: 'POST', url: `${baseUrl}/stream`, headers: { 'Content-Type': 'application/json' }, variants: [{ id: 'send', body: { message: { $value: 'input.text' }, conversationId: { $value: 'conversation.id' } } }] } },
    conversations: {
      list: { request: { method: 'GET', url: `${baseUrl}/conversations` } },
      history: { request: { method: 'GET', url: `${baseUrl}/conversations/\${conversation.id}/messages` } },
    },
    stream: { transport: 'sse', mappings: [
      { id: 'start', match: { event: 'start' }, emit: { type: 'conversation.started', conversationId: { path: '$.conversationId' } } },
      { id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
      { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } },
    ] },
    history: { localRuns: { enabled: false } },
  };
  const context = {
    globalStorageUri: vscode.Uri.file(directory),
    globalState: { get: (_key: string, fallback: unknown) => fallback },
    workspaceState: { get: (_key: string, fallback: unknown) => fallback },
  } as unknown as vscode.ExtensionContext;
  const archive = new ConversationRepository(context, { workspace: 'integration', profileId: profile.id, environmentId: 'local' });
  const output = vscode.window.createOutputChannel('TurnStage conversation integration');
  let loads = 0;
  let saves = 0;
  const states: ConversationDirectory[] = [];
  const controllers: SessionController[] = [];
  const makeController = (persist = true) => {
    const controller = new SessionController(profile, vscode.Uri.file(join(directory, 'profile.turnstage.jsonc')), { version: 1, id: 'local', name: 'Local', variables: {} }, context, new SecretService(context), new LocalRunRepository(context), () => undefined, output, {
      authorizeRequest: async () => true,
      conversations: {
        ...(persist ? { storage: { load: async () => { loads += 1; return archive.load(); }, save: async (items) => { saves += 1; await archive.save(items); } } } : {}),
        changed: (state) => states.push(state),
      },
    });
    controllers.push(controller);
    return controller;
  };
  try {
    const controller = makeController();
    await controller.loadRuns();
    if (!vscode.workspace.isTrusted) {
      controller.snapshot.conversationId = 'restricted';
      await controller.refreshConversationList();
      await controller.verifyConversationHistory();
      assert.equal(await controller.openConversation('remote:restricted'), false);
      await controller.send('Blocked request', { kind: 'manual' });
      await controller.newConversation();
      assert.equal(await controller.deleteConversation('local:missing'), false);
      assert.deepEqual(requests, [], 'Restricted Mode must issue no list, history, or stream requests');
      assert.equal(loads, 0, 'Restricted Mode must not load saved conversations');
      assert.equal(saves, 0, 'Restricted Mode must not write saved conversations');
      assert.deepEqual(await readdir(directory), [], 'Restricted Mode must create no conversation archive files');
      console.log('Extension Host Restricted Mode conversations: 0 HTTP requests, 0 archive reads/writes, 0 files.');
      return;
    }
    await controller.send('First question', { kind: 'manual' });
    await waitForCheck(controller);
    assert.deepEqual(controller.getConversationDirectory()?.check?.results.map((result) => result.status), ['match', 'match']);
    const firstKey = controller.getConversationDirectory()!.currentKey;
    const firstId = controller.snapshot.conversationId;
    assert.equal((await archive.load()).length, 1, 'A completed turn must save the actual archive file');
    await controller.newConversation();
    profile.conversation.send.headers!['x-rewrite'] = 'true';
    await controller.send('Second question', { kind: 'manual' });
    await waitForCheck(controller);
    assert.equal(controller.getConversationDirectory()?.check?.results.find((result) => result.role === 'assistant')?.status, 'mismatch');
    const secondKey = controller.getConversationDirectory()!.currentKey;
    const beforeOpen = requests.length;
    assert.equal(await controller.openConversation(firstKey), true);
    assert.equal(controller.snapshot.conversationId, firstId);
    assert.equal(requests.length, beforeOpen, 'Opening an archived conversation must not send a request');
    assert.equal(await controller.deleteConversation(secondKey), true);
    assert.equal((await archive.load()).length, 1, 'Deleting a non-current conversation must update the actual archive');
    const fresh = makeController(false);
    await fresh.loadRuns();
    await fresh.refreshConversationList();
    assert.equal(fresh.getConversationDirectory()?.remote.status, 'ready');
    assert.equal(await fresh.openConversation(`remote:${firstId}`), true);
    assert.deepEqual(fresh.snapshot.messages.map((message) => message.metadata?.historySource), ['server', 'server']);
    assert.ok(states.some((state) => state.remote.status === 'loading'), 'Directory messages must include server-list progress');
    assert.ok(states.some((state) => state.opening), 'Directory messages must include history-loading progress');
    assert.ok(states.some((state) => state.check?.status === 'checking'), 'Directory messages must include verification progress');
    console.log('Extension Host trusted conversations: SSE match/mismatch, archive switch/delete, server list/history passed.');
  } finally {
    await Promise.all(controllers.map((controller) => controller.disposeAndWait()));
    output.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForCheck(controller: SessionController): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (controller.getConversationDirectory()?.check?.status !== 'done' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert.equal(controller.getConversationDirectory()?.check?.status, 'done');
}
