/* global localStorage */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'web-case-scale');
await mkdir(output, { recursive: true });
const requests = [];
const server = createServer(async (request, response) => {
  if (request.url === '/api/agent/opening') {
    requests.push('opening');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Ready for browser test.' }));
    return;
  }
  if (request.url === '/api/agent/chat/stream') {
    requests.push('chat');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end('event: start\ndata: {"conversationId":"qa-conversation","assistantMessageId":"qa-message"}\n\nevent: message\ndata: {"text":"A sample result from the browser mock."}\n\nevent: done\ndata: {}\n\n');
    return;
  }
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(root, 'web-dist', `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${resolve(root, 'web-dist')}${sep}`)) throw new Error('outside Web dist');
    response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
const profile = JSON.parse(await readFile(resolve(root, 'resources/templates/agent-flow.turnstage.jsonc'), 'utf8'));
profile.id = 'product-gap-qa';
profile.name = 'Product gap QA';
profile.opening.request.url = `${url}api/agent/opening`;
profile.conversation.send.url = `${url}api/agent/chat/stream`;
profile.conversation.stop.request.url = `${url}api/agent/chat/stop`;
profile.tests = { scenarios: [] };
const contract = { format: 'turnstage-contract-suite', version: 1, id: 'large-regression', name: 'Large regression', cases: Array.from({ length: 1000 }, (_, index) => {
  const number = String(index + 1).padStart(4, '0');
  return { id: `case-${number}`, name: `Load case ${number}`, steps: [{ id: 'turn', input: 'Find a sample result.', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }] };
}) };
const redTeam = { format: 'turnstage-adversarial-suite', version: 1, id: 'red-qa', name: 'Red QA', cases: [{ id: 'red-1', name: 'Red browser check', turns: [{ id: 'turn', input: 'Say a sample result.' }], forbid: { content: ['forbidden-marker'] } }] };
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', acceptDownloads: true });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((value) => {
    localStorage.setItem('turnstage.web.profiles.v1', JSON.stringify([{ id: value.id, name: value.name, raw: JSON.stringify(value), updatedAt: Date.now() }]));
    localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', activeProfileId: value.id }));
  }, profile);
  await page.goto(url);
  await page.getByRole('tab', { name: 'General tests' }).click();
  await page.getByRole('tab', { name: 'Cases' }).click();
  await importSuite(page, contract, 'large-regression.jsonc');
  await page.getByRole('button', { name: 'Run case Load case 0001' }).waitFor();
  assert.match(await page.locator('.debug-pane').innerText(), /1,000 of 1,000 cases/u);
  await page.screenshot({ path: resolve(output, 'general-1000-cases.png') });
  await page.getByRole('button', { name: 'Run case Load case 0001' }).click();
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Select test result Load case 0001' }).waitFor();
  await page.locator('.unified-test-history__selector select').waitFor();
  assert.match(await page.locator('.automation-result-table').innerText(), /Passed/u);
  await page.screenshot({ path: resolve(output, 'general-result.png') });
  await page.getByRole('tab', { name: 'Red Team' }).click();
  await page.getByRole('tab', { name: 'Cases' }).click();
  await importSuite(page, redTeam, 'red-qa.jsonc');
  await page.getByRole('button', { name: 'Run case Red browser check' }).click();
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByText('Red browser check').first().waitFor();
  await page.locator('.unified-test-history__selector select').waitFor();
  assert.match(await page.locator('.adversarial-result-table').last().innerText(), /Resisted/u);
  await page.screenshot({ path: resolve(output, 'red-result.png') });
  await page.getByRole('button', { name: 'Profile actions: Product gap QA' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export profile and cases' }).click();
  const download = await downloaded;
  const bundleFile = resolve(output, download.suggestedFilename());
  await download.saveAs(bundleFile);
  const bundle = JSON.parse(await readFile(bundleFile, 'utf8'));
  assert.equal(bundle.version, 2);
  assert.equal(bundle.suites.length, 2);
  assert.equal(bundle.suites.find((item) => item.suiteId === 'large-regression').raw.length > 0, true);
  const restored = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  restored.on('pageerror', (error) => pageErrors.push(error.message));
  await restored.addInitScript(() => localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en' })));
  await restored.goto(url);
  await restored.locator('input[type="file"][accept*=".jsonc"]').setInputFiles(bundleFile);
  await restored.getByRole('button', { name: 'Product gap QA, Local' }).waitFor();
  await restored.getByRole('tab', { name: 'General tests' }).click();
  await restored.getByRole('tab', { name: 'Cases' }).click();
  await restored.getByRole('button', { name: 'Run case Load case 0001' }).waitFor();
  assert.match(await restored.locator('.debug-pane').innerText(), /1,000 of 1,000 cases/u);
  await restored.getByRole('tab', { name: 'Red Team' }).click();
  await restored.getByRole('tab', { name: 'Cases' }).click();
  await restored.getByRole('button', { name: 'Run case Red browser check' }).waitFor();
  await restored.screenshot({ path: resolve(output, 'restored-bundle.png') });
  const importInput = restored.locator('input[type="file"][accept*=".jsonc"]');
  await importInput.setInputFiles(bundleFile);
  await importInput.setInputFiles(bundleFile);
  await restored.waitForFunction(() => JSON.parse(localStorage.getItem('turnstage.web.profiles.v1') ?? '[]').length === 3);
  const importedIds = await restored.evaluate(() => JSON.parse(localStorage.getItem('turnstage.web.profiles.v1') ?? '[]').map((item) => item.id));
  assert.equal(new Set(importedIds).size, 3, 'Concurrent bundle imports must each reserve a unique Profile ID');
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page.getByRole('button', { name: 'Delete case Red browser check from browser copy' }).click();
  await page.getByRole('alertdialog', { name: 'Delete case Red browser check from browser copy?' }).getByRole('button', { name: 'Delete case' }).click();
  await page.getByRole('button', { name: 'Run case Red browser check' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Profile actions: Product gap QA' }).click();
  const emptySuiteDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export profile and cases' }).click();
  const emptyBundleFile = resolve(output, 'after-last-case-deleted.json');
  await (await emptySuiteDownload).saveAs(emptyBundleFile);
  const afterDeletion = JSON.parse(await readFile(emptyBundleFile, 'utf8'));
  assert.deepEqual(afterDeletion.suites.map((item) => item.suiteId), ['large-regression']);
  assert.equal(requests.filter((item) => item === 'chat').length, 2);
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: true, generalCases: 1000, redCases: 1, executedCases: 2, exportedSuites: 2, restoredBundle: true, parallelBundleImports: 2, emptySuiteFiltered: true, screenshots: ['general-1000-cases.png', 'general-result.png', 'red-result.png', 'restored-bundle.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, output, generalCases: 1000, redCases: 1, executedCases: 2, exportedSuites: 2, restoredBundle: true, parallelBundleImports: 2, emptySuiteFiltered: true }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

async function importSuite(page, suite, fileName) {
  const menu = page.locator('.adversarial-case-file-menu');
  if (!await menu.getAttribute('open')) await menu.locator(':scope > summary').click();
  const formats = menu.locator('.case-format-submenu').first();
  if (!await formats.getAttribute('open')) await formats.locator('summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSONC copy' }).click();
  await (await chooser).setFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(suite)) });
}
