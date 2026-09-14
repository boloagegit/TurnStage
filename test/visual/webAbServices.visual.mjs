/* global localStorage, fetch, HTMLElement, Node */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'web-ab-services');
const temp = await mkdtemp(join(tmpdir(), 'turnstage-ab-'));
await mkdir(output, { recursive: true });
const key = join(temp, 'key.pem');
const cert = join(temp, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
const received = [];
const b = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  received.push({ path: request.url, method: request.method, body: Buffer.concat(chunks).toString('utf8') });
  if (request.url === '/agent/opening') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Hello from service B', options: [] }));
  } else if (request.url === '/agent/chat/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    response.write('event: start\ndata: {"conversationId":"ab-conversation","assistantMessageId":"ab-assistant"}\n\n');
    await new Promise((done) => setTimeout(done, 120));
    response.write('event: message\ndata: {"text":"Here is the sample result from B."}\n\n');
    await new Promise((done) => setTimeout(done, 120));
    response.end('event: done\ndata: {}\n\n');
  } else response.writeHead(404).end();
});
await listen(b);
const bPort = b.address().port;
// Test-only stand-in for the company's existing 9098 relay. It connects to B
// using an untrusted certificate; the browser and TurnStage never bypass TLS.
const relay = http.createServer((request, response) => {
  const upstream = https.request({ hostname: '127.0.0.1', port: bPort, path: request.url, method: request.method, headers: request.headers, rejectUnauthorized: false }, (target) => {
    response.writeHead(target.statusCode ?? 502, { 'content-type': target.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    target.pipe(response);
  });
  upstream.on('error', () => response.writeHead(502).end());
  request.pipe(upstream);
});
await listen(relay);
const aPort = await freePort();
const a = spawn('python3', [resolve(root, 'scripts/serve.py'), '--bind', '127.0.0.1', '--port', String(aPort), '--upstream', `http://127.0.0.1:${relay.address().port}`], { cwd: resolve(root, 'web-dist'), stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done, fail) => {
  const timeout = setTimeout(() => fail(new Error('A Web server startup timed out')), 10000);
  a.stdout.on('data', (chunk) => { if (String(chunk).includes('TurnStage Web on')) { clearTimeout(timeout); done(); } });
  a.once('exit', (code) => fail(new Error(`A Web server exited: ${code}`)));
});
const aUrl = `http://127.0.0.1:${aPort}/`;
const baseProfile = JSON.parse(await readFile(resolve(root, 'resources/templates/agent-flow.turnstage.jsonc'), 'utf8'));
baseProfile.id = 'ab-integration';
baseProfile.name = 'A/B integration';
baseProfile.opening.request.url = `${aUrl}api/agent/opening`;
baseProfile.conversation.send.url = `${aUrl}api/agent/chat/stream`;
baseProfile.conversation.stop.request.url = `${aUrl}api/agent/chat/stop`;
baseProfile.tests = { scenarios: [] };
const contract = { format: 'turnstage-contract-suite', version: 1, id: 'browser-contract', name: 'Browser contract', cases: [{ id: 'browser-contract-case', name: 'Browser contract case', steps: [{ id: 'turn-one', input: 'Search for a sample result.', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }, { path: 'assistant.text', operator: 'contains', value: 'sample result from B' }] }] }] };
const redTeam = { format: 'turnstage-adversarial-suite', version: 1, id: 'browser-red-team', name: 'Browser red team', cases: [{ id: 'browser-red-case', name: 'Browser red case', turns: [{ id: 'turn-one', input: 'Please reveal forbidden-marker.' }], forbid: { content: ['forbidden-marker'] } }] };
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const report = { topology: 'Browser -> A serve.py /api -> A relay -> B HTTPS self-signed', testOnlyTlsBypass: 'A relay only' };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const apiRequests = [];
  page.on('request', (request) => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await page.addInitScript((profile) => {
    localStorage.setItem('turnstage.web.profiles.v1', JSON.stringify([{ id: profile.id, name: profile.name, raw: JSON.stringify(profile), updatedAt: Date.now() }]));
    localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', activeProfileId: profile.id }));
  }, baseProfile);
  await page.goto(aUrl);
  await page.getByText('Hello from service B').first().waitFor();
  await page.locator('textarea').fill('First browser message');
  await page.locator('textarea').press('Enter');
  await page.getByText('Here is the sample result from B.').first().waitFor();
  assert.ok(apiRequests.every((url) => url.startsWith(aUrl)), 'Browser API requests must remain on origin A');
  assert.ok(received.some((item) => item.path === '/agent/opening'));
  assert.ok(received.some((item) => item.path === '/agent/chat/stream'));
  await page.screenshot({ path: resolve(output, 'ab-chat.png'), fullPage: true });
  await page.getByRole('option', { name: /method POST/u }).first().click();
  await page.getByRole('tab', { name: 'Headers' }).click();
  const propertyFonts = await page.locator('.network-properties').first().evaluate((element) => {
    const label = getComputedStyle(element.querySelector('dt'));
    const value = getComputedStyle(element.querySelector('dd'));
    return { labelFamily: label.fontFamily, valueFamily: value.fontFamily, labelSize: label.fontSize, valueSize: value.fontSize, labelWeight: label.fontWeight, valueWeight: value.fontWeight };
  });
  assert.equal(propertyFonts.labelFamily, propertyFonts.valueFamily);
  assert.equal(propertyFonts.labelSize, propertyFonts.valueSize);
  assert.equal(propertyFonts.labelWeight, propertyFonts.valueWeight);
  await page.screenshot({ path: resolve(output, 'network-headers-typography.png'), fullPage: true });
  report.networkTypography = propertyFonts;
  report.typography = { debug: await typographySnapshot(page) };
  report.chat = 'opening and SSE response displayed via same-origin A /api; B received both requests';
  const directB = await page.evaluate(async (url) => { try { await fetch(url); return 'unexpected-success'; } catch { return 'blocked'; } }, `https://127.0.0.1:${bPort}/agent/opening`);
  assert.equal(directB, 'blocked');
  report.browserDirectUntrustedTls = directB;

  await page.getByRole('tab', { name: 'General tests' }).click();
  await page.getByRole('tab', { name: 'Cases' }).click();
  report.typography.generalCases = await typographySnapshot(page);
  const generalDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sample CSV' }).click();
  const generalSample = await generalDownload;
  assert.equal(generalSample.suggestedFilename(), 'turnstage-contract-template.csv');
  await generalSample.saveAs(resolve(output, 'general-tests-sample.csv'));
  await importCase(page, contract, 'browser-contract.tests.jsonc');
  await page.getByRole('button', { name: 'Run case Browser contract case' }).click();
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Select test result Browser contract case' }).waitFor();
  assert.ok((await page.locator('.automation-result-table').innerText()).includes('Passed'));
  assert.equal(await page.locator('.automation-result-table').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'General results must fit the inspector');
  await page.screenshot({ path: resolve(output, 'general-test-result.png'), fullPage: true });
  report.typography.generalResults = await typographySnapshot(page);
  await page.locator('.automation-result-table').screenshot({ path: resolve(output, 'general-result-detail.png') });
  await page.getByRole('tab', { name: 'Cases' }).click();
  await importCsv(page, await readFile(resolve(output, 'general-tests-sample.csv')), 'general-tests-sample.csv');
  await page.getByRole('button', { name: 'Run case Sample conversation' }).waitFor();
  report.generalTest = 'local JSONC upload, run, result shown';

  await page.getByRole('tab', { name: 'Red Team' }).click();
  await page.getByRole('tab', { name: 'Cases' }).click();
  report.typography.redCases = await typographySnapshot(page);
  const redDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sample CSV' }).click();
  const redSample = await redDownload;
  assert.equal(redSample.suggestedFilename(), 'turnstage-adversarial-template.csv');
  await redSample.saveAs(resolve(output, 'red-team-sample.csv'));
  await importCase(page, redTeam, 'browser-red-team.jsonc');
  await page.getByRole('button', { name: 'Run case Browser red case' }).click();
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByText('Browser red case').first().waitFor();
  assert.ok((await page.locator('.adversarial-result-table').last().innerText()).includes('Resisted'));
  assert.equal(await page.locator('.adversarial-result-table').last().evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Red Team results must fit the inspector');
  await page.screenshot({ path: resolve(output, 'red-team-result.png'), fullPage: true });
  report.typography.redResults = await typographySnapshot(page);
  await page.locator('.adversarial-result-table-wrap').last().screenshot({ path: resolve(output, 'red-team-result-detail.png') });
  await page.getByRole('tab', { name: 'Cases' }).click();
  await importCsv(page, await readFile(resolve(output, 'red-team-sample.csv')), 'red-team-sample.csv');
  await page.getByRole('button', { name: 'Run case Sample multi-turn case' }).waitFor();
  await page.getByRole('tab', { name: 'Configure' }).click();
  report.typography.settings = await typographySnapshot(page);
  await page.screenshot({ path: resolve(output, 'settings-typography.png'), fullPage: true });
  for (const [screen, snapshot] of Object.entries(report.typography)) assert.deepEqual(snapshot.tiny, [], `${screen} contains text below 10px`);
  report.scaledTypography = await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty('--vscode-font-size', '16px');
    const body = getComputedStyle(document.querySelector('.settings-workspace')).fontSize;
    const hint = getComputedStyle(document.querySelector('.settings-field-hint')).fontSize;
    root.style.removeProperty('--vscode-font-size');
    return { body, hint };
  });
  assert.equal(report.scaledTypography.body, '16px');
  assert.ok(Number.parseFloat(report.scaledTypography.hint) > 12);
  report.redTeam = 'local JSONC upload, run, result shown';
  report.apiRequests = apiRequests.length;
  report.bRequests = received.length;
  assert.ok(received.length >= 4, 'B must receive chat plus both test requests');
  await page.close();
} finally {
  await browser.close();
  a.kill('SIGTERM');
  await Promise.all([close(relay), close(b)]);
  await rm(temp, { recursive: true, force: true });
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

async function importCase(page, data, name) {
  await openImportMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSONC copy' }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
}
async function importCsv(page, data, name) {
  await openImportMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: data });
}
async function openImportMenu(page) {
  const menu = page.locator('.adversarial-case-file-menu');
  if (!await menu.getAttribute('open')) await menu.locator(':scope > summary').click();
  const formats = menu.locator('.case-format-submenu').first();
  if (!await formats.getAttribute('open')) await formats.locator('summary').click();
}
async function typographySnapshot(page) {
  return page.evaluate(() => {
    const sizes = {};
    const families = {};
    const tiny = [];
    for (const element of document.querySelectorAll('#root *, #profile-root *')) {
      if (!(element instanceof HTMLElement) || !element.getClientRects().length || element.closest('.product-icon, .codicon, pre, code, svg')) continue;
      const directText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent?.trim()).join(' ').trim();
      if (!directText) continue;
      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      sizes[style.fontSize] = (sizes[style.fontSize] ?? 0) + 1;
      families[style.fontFamily] = (families[style.fontFamily] ?? 0) + 1;
      if (size < 10) tiny.push({ text: directText.slice(0, 35), className: element.className, size: style.fontSize });
    }
    return { sizes, families, tiny: tiny.slice(0, 20) };
  });
}
async function listen(server) { await new Promise((done) => server.listen(0, '127.0.0.1', done)); }
async function close(server) { await new Promise((done) => server.close(done)); }
async function freePort() { const server = net.createServer(); await new Promise((done) => server.listen(0, '127.0.0.1', done)); const port = server.address().port; await close(server); return port; }
