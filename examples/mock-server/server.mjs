import http from 'node:http';

const requestedPort = Number(process.env.TURNSTAGE_MOCK_PORT ?? 8787);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('TURNSTAGE_MOCK_PORT must be an integer from 0 to 65535.');
const contractSlowDelayMs = Number(process.env.TURNSTAGE_MOCK_CONTRACT_SLOW_DELAY_MS ?? 450);
if (!Number.isInteger(contractSlowDelayMs) || contractSlowDelayMs < 1 || contractSlowDelayMs > 30000) throw new Error('TURNSTAGE_MOCK_CONTRACT_SLOW_DELAY_MS must be an integer from 1 to 30000.');
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
const readBody = async (request) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return undefined; }
};
const sse = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const contractSessions = new Map();
const intermittentAttempts = new Map();
const openingProbe = { requests: 0 };
const concurrencyProbe = {
  active: 0,
  maxActive: 0,
  activeByMessage: new Map(),
  maxActiveByMessage: new Map(),
  intervals: [],
};
const requiredString = (body, key) => typeof body[key] === 'string' && Boolean(body[key].trim());
const invalidFields = (response, fields) => json(response, 400, { code: 'INVALID_REQUEST', fields });

function resetConcurrencyProbe() {
  concurrencyProbe.active = 0;
  concurrencyProbe.maxActive = 0;
  concurrencyProbe.activeByMessage.clear();
  concurrencyProbe.maxActiveByMessage.clear();
  concurrencyProbe.intervals.length = 0;
}

function beginConcurrencyProbe(response, body) {
  const message = typeof body.message === 'string' ? body.message.slice(0, 200) : '<missing-message>';
  const interval = { message, startedAt: Date.now(), endedAt: undefined };
  concurrencyProbe.active += 1;
  concurrencyProbe.maxActive = Math.max(concurrencyProbe.maxActive, concurrencyProbe.active);
  const messageActive = (concurrencyProbe.activeByMessage.get(message) ?? 0) + 1;
  concurrencyProbe.activeByMessage.set(message, messageActive);
  concurrencyProbe.maxActiveByMessage.set(message, Math.max(concurrencyProbe.maxActiveByMessage.get(message) ?? 0, messageActive));
  concurrencyProbe.intervals.push(interval);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    interval.endedAt = Date.now();
    concurrencyProbe.active = Math.max(0, concurrencyProbe.active - 1);
    concurrencyProbe.activeByMessage.set(message, Math.max(0, (concurrencyProbe.activeByMessage.get(message) ?? 1) - 1));
  };
  response.once('finish', finish);
  response.once('close', finish);
}

function concurrencyProbeSnapshot() {
  return {
    active: concurrencyProbe.active,
    maxActive: concurrencyProbe.maxActive,
    maxActiveByMessage: Object.fromEntries(concurrencyProbe.maxActiveByMessage),
    intervals: concurrencyProbe.intervals.map((interval) => ({ ...interval })),
  };
}

async function handleContractOpening(response, body, mode) {
  const missing = ['actorId', 'taskId', 'blockId'].filter((key) => !requiredString(body, key));
  if (!Array.isArray(body.tags)) missing.push('tags');
  if (!Array.isArray(body.openingMsgArgs)) missing.push('openingMsgArgs');
  if (missing.length) return invalidFields(response, missing);
  if (mode === 'opening-options') {
    return json(response, 200, {
      openingMessage: 'Hello, I am a synthetic test assistant. How can I help?',
      optionsInfo: [
        'Show a sample overview',
        { option: 'Which inputs are required?' },
      ],
      quota: { used: 48, limit: 100, resetAt: '2026-12-31T16:00:00.000Z' },
    });
  }
  return json(response, 200, { code: 7021, message: 'No configured opening message' });
}

async function handleContractStream(request, response, body, mode) {
  const missing = ['actorId', 'message'].filter((key) => !requiredString(body, key));
  const continuation = requiredString(body, 'cid');
  if (!continuation) {
    if (!requiredString(body.openingMessage ?? {}, 'content')) missing.push('openingMessage.content');
    if (!body.conversationProfile || typeof body.conversationProfile !== 'object') missing.push('conversationProfile');
  }
  if (missing.length) return invalidFields(response, missing);
  if (body.message !== body.message.trim()) return json(response, 400, { code: 'MESSAGE_NOT_TRIMMED' });
  if (continuation && ('openingMessage' in body || 'conversationProfile' in body)) return json(response, 400, { code: 'CONTINUATION_CONTAINS_FIRST_TURN_FIELDS' });

  const cid = continuation ? body.cid : `cid-${Date.now()}`;
  const assistantMessageId = `assistant-${Date.now()}`;
  contractSessions.set(cid, { assistantMessageId, stopped: false });
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': 'mock-contract-stream' });
  response.flushHeaders();
  const wait = mode === 'contract-slow' ? contractSlowDelayMs : 35;
  const write = async (event, data) => {
    await delay(wait);
    if (response.destroyed || contractSessions.get(cid)?.stopped) return false;
    response.write(sse(event, data));
    return true;
  };
  if (!await write('start', { cid, assistantMessageId })) return;
  if (!await write('status', { text: 'Analyzing the test request…' })) return;
  if (!await write('message', { text: 'This is a deterministic streamed response from the local mock server.' })) return;
  if (mode === 'contract-error') {
    await write('error', { code: 'SAMPLE_SERVICE_UNAVAILABLE', message: 'The synthetic knowledge service is temporarily unavailable.' });
    response.end();
    return;
  }
  if (mode === 'contract-actions') {
    if (!await write('followup', { id: 'followup-example', label: 'Show another example', prompt: 'Show another example', behavior: 'send' })) return;
    if (!await write('action', { id: 'cta-details', label: 'Explain details', actionId: 'request.send', payload: { messageText: 'Explain the sample details', ctaKey: 'sample_details' } })) return;
    if (!await write('action', { id: 'cta-web', label: 'Open sample documentation', actionId: 'uri.open', payload: { uri: 'https://example.com/sample-guide', ctaKey: 'sample_guide' } })) return;
    if (!await write('custom_card', { type: 'form', id: 'sample-form', title: 'Synthetic form', fields: [{ id: 'name', type: 'text', label: 'Name', required: true }], submit: { action: 'conversation.send', messageTemplate: 'Submit sample form', interactionKind: 'formSubmit' } })) return;
    if (!await write('diagnostic', { intent: 'sample-intent', selectedTools: ['sample_search'], guardrails: ['sample-check'], e2e_ms: 180 })) return;
  }
  if (!await write('title', { title: 'Sample consultation' })) return;
  await write('done', { ok: true });
  response.end();
}

function handleContractStop(response, body) {
  const missing = ['cid', 'assistantMessageId', 'reason'].filter((key) => !requiredString(body, key));
  if (missing.length) return invalidFields(response, missing);
  if (body.reason !== 'user_cancel') return json(response, 400, { code: 'INVALID_STOP_REASON' });
  const session = contractSessions.get(body.cid);
  if (session && session.assistantMessageId !== body.assistantMessageId) return json(response, 409, { code: 'ASSISTANT_MESSAGE_MISMATCH' });
  if (session) session.stopped = true;
  return json(response, 200, { stopped: true, cid: body.cid, assistantMessageId: body.assistantMessageId, reason: body.reason });
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST') return json(response, 405, { code: 'METHOD_NOT_ALLOWED' });
  if (request.url === '/__turnstage_test/concurrency/reset') { resetConcurrencyProbe(); return json(response, 200, concurrencyProbeSnapshot()); }
  if (request.url === '/__turnstage_test/concurrency/metrics') return json(response, 200, concurrencyProbeSnapshot());
  if (request.url === '/__turnstage_test/opening/reset') { openingProbe.requests = 0; return json(response, 200, openingProbe); }
  if (request.url === '/__turnstage_test/opening/metrics') return json(response, 200, openingProbe);
  const body = await readBody(request); if (!body) return json(response, 400, { code: 'INVALID_JSON' });
  const mode = request.headers['x-turnstage-mode'] ?? body.mode ?? 'normal';
  if (request.url === '/basic/chat/stream') beginConcurrencyProbe(response, body);
  if (request.url === '/v1/chat/opening') return handleContractOpening(response, body, mode);
  if (request.url === '/v1/chat/stream') return handleContractStream(request, response, body, mode);
  if (request.url === '/v1/chat/stop') return handleContractStop(response, body);
  if (request.url === '/agent/opening') {
    openingProbe.requests += 1;
    if (mode === 'opening-timeout') { await delay(450); return json(response, 504, { code: 'OPENING_TIMEOUT_FIXTURE' }); }
    if (mode === 'fallback') return json(response, 404, { code: 'OPENING_NOT_FOUND' });
    if (mode === 'network-error') { request.socket.destroy(); return; }
    return json(response, 200, { message: 'Hello, I am a test assistant. What would you like to explore?', options: [{ id: 'starter-search', label: 'Search sample information', prompt: 'Please search for sample information.', behavior: 'send' }, { id: 'starter-prepare', label: 'Prepare a test request', prompt: 'Please help me prepare a test request.', behavior: 'fill' }] });
  }
  if (request.url === '/basic/chat/stop' || request.url === '/agent/chat/stop') return json(response, 200, { stopped: true, conversationId: body.conversationId ?? null, clientRequestId: body.clientRequestId ?? null });
  if (request.url === '/transport/ndjson') {
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    response.write('{"kind":"first","value":1}\n{"kind":');
    await delay(25);
    response.end('"second","value":2}');
    return;
  }
  if (request.url === '/transport/text-stream') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    response.write('first ');
    await delay(25);
    response.end('second');
    return;
  }
  if (request.url === '/transport/wrong-content-type') return json(response, 200, { value: 'not an event stream' });
  if (!request.url?.endsWith('/stream')) return json(response, 404, { code: 'NOT_FOUND' });
  if (mode === 'delayed-headers') await delay(450);
  if (mode === 'http-401') return json(response, 401, { code: 'AUTH_REQUIRED' });
  if (mode === 'http-403') return json(response, 403, { code: 'AUTH_FORBIDDEN' });
  if (mode === 'http-500') return json(response, 500, { code: 'SAMPLE_FAILURE' });
  if (mode === 'intermittent') {
    const key = String(body.caseId ?? body.message ?? 'default').slice(0, 100);
    const attempt = (intermittentAttempts.get(key) ?? 0) + 1;
    intermittentAttempts.set(key, attempt);
    if (attempt % 2 === 1) return json(response, 503, { code: 'SYNTHETIC_INTERMITTENT_FAILURE', attempt });
  }
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': 'mock-basic-stream' });
  response.flushHeaders();
  if (mode === 'delayed-first-chunk' || mode === 'proxy-buffer') await delay(450);
  const write = async (event, data, wait = mode === 'slow' ? 600 : 55) => { await delay(wait); if (response.destroyed) return; const payload = sse(event, data); if (mode === 'chunk-split') { const point = Math.max(1, Math.floor(payload.length / 2)); response.write(payload.slice(0, point)); await delay(20); response.write(payload.slice(point)); } else response.write(payload); };
  if (mode === 'idle-timeout') { await delay(2_000); response.end(); return; }
  if (mode === 'proxy-buffer') {
    response.end([
      sse('start', { conversationId: body.conversationId ?? `conversation-${Date.now()}`, assistantMessageId: `assistant-${Date.now()}` }),
      sse('status', { text: 'Buffered by a synthetic proxy.' }),
      sse('message', { text: 'Buffered response.' }),
      sse('done', { ok: true }),
    ].join(''));
    return;
  }
  await write('start', { conversationId: body.conversationId ?? `conversation-${Date.now()}`, assistantMessageId: `assistant-${Date.now()}` });
  await write('status', { text: request.url.startsWith('/agent/') ? 'Searching sample sources…' : 'Preparing a sample response…' });
  if (mode === 'delayed-first-event') await delay(450);
  if (request.url.startsWith('/agent/') || mode === 'adversarial-tool') {
    await write('tool_call', { toolCallId: 'tool-1', name: 'sample_search', arguments: { query: body.message ?? 'sample' } });
    await write('tool_result', { toolCallId: 'tool-1', result: { matches: 1, source: 'Example source' } });
  }
  if (mode === 'adversarial-event') await write('adversarial_signal', { observed: true });
  if (mode === 'mapping-drift') await write('renamed_message_delta', { fragment: 'The configured mapping no longer matches this event.' });
  if (mode === 'adversarial-cta') await write('action', { id: 'adversarial-action', label: 'Continue', actionId: 'request.send', payload: { message: 'Continue' } });
  if (mode === 'slow-second-turn' && body.conversationId) await delay(450);
  const prefix = mode === 'adversarial-content' ? 'sample-protected-marker ' : mode === 'adversarial-url' ? 'https://example.test/prohibited ' : 'Here is the ';
  await write('message', { text: prefix });
  if (mode === 'malformed-json') response.write('event: message\ndata: {not-json}\n\n');
  if (mode === 'unknown-event') await write('custom_event', { value: 'kept in the raw inspector' });
  await write('message', { text: 'sample result.' });
  if (request.url.startsWith('/agent/')) {
    await write('citation', { id: 'citation-1', title: 'Example source', kind: 'url', uri: 'https://example.com', description: 'A safe example citation.' });
    await write('citation_reference', { citationId: 'citation-1' });
    await write('action', { id: 'open-details', label: 'Open details', actionId: 'message.copy', appearance: 'secondary' });
    await write('form', { type: 'form', id: 'contact-form', title: 'Contact Information', fields: [{ id: 'name', type: 'text', label: 'Name', required: true, maxLength: 50 }, { id: 'phone', type: 'tel', label: 'Phone', required: true, pattern: '^[0-9+\\- ]+$' }], submit: { action: 'conversation.send', messageTemplate: 'Submit contact information', interactionKind: 'formSubmit' } });
    await write('followup', { id: 'followup-another', label: 'Show another example', prompt: 'Please show another example.', behavior: 'send' });
    await write('diagnostic', { intent: 'sample-search', selectedTools: ['sample_search'], safetyChecks: ['example-only'], requestId: 'example-value' });
    await write('usage', { inputTokens: 24, outputTokens: 18, source: 'backend' });
  }
  await write('title', { title: 'Sample conversation' });
  if (mode === 'partial-error') { await write('error', { code: 'SAMPLE_STREAM_ERROR', message: 'A sample partial failure occurred.' }); response.end(); return; }
  if (mode === 'disconnect') { response.destroy(); return; }
  if (mode === 'missing-terminal') { response.end(); return; }
  await write('done', { ok: true }); response.end();
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`TurnStage mock server listening on http://127.0.0.1:${port}`);
});
const shutdown = () => {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', (error) => { console.error(`TurnStage mock server failed: ${error.message}`); process.exit(1); });
