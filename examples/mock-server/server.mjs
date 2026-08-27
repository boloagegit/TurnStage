import http from 'node:http';

const requestedPort = Number(process.env.TURNSTAGE_MOCK_PORT ?? 8787);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('TURNSTAGE_MOCK_PORT must be an integer from 0 to 65535.');
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

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST') return json(response, 405, { code: 'METHOD_NOT_ALLOWED' });
  const body = await readBody(request); if (!body) return json(response, 400, { code: 'INVALID_JSON' });
  const mode = request.headers['x-turnstage-mode'] ?? body.mode ?? 'normal';
  if (request.url === '/agent/opening') {
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
  if (mode === 'http-401') return json(response, 401, { code: 'AUTH_REQUIRED' });
  if (mode === 'http-500') return json(response, 500, { code: 'SAMPLE_FAILURE' });
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.flushHeaders();
  const write = async (event, data, wait = mode === 'slow' ? 600 : 55) => { await delay(wait); if (response.destroyed) return; const payload = sse(event, data); if (mode === 'chunk-split') { const point = Math.max(1, Math.floor(payload.length / 2)); response.write(payload.slice(0, point)); await delay(20); response.write(payload.slice(point)); } else response.write(payload); };
  if (mode === 'idle-timeout') { await delay(120000); response.end(); return; }
  await write('start', { conversationId: body.conversationId ?? `conversation-${Date.now()}`, assistantMessageId: `assistant-${Date.now()}` });
  await write('status', { text: request.url.startsWith('/agent/') ? 'Searching sample sources…' : 'Preparing a sample response…' });
  if (request.url.startsWith('/agent/')) {
    await write('tool_call', { toolCallId: 'tool-1', name: 'sample_search', arguments: { query: body.message ?? 'sample' } });
    await write('tool_result', { toolCallId: 'tool-1', result: { matches: 1, source: 'Example source' } });
  }
  await write('message', { text: 'Here is the ' });
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
