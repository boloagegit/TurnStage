/* global localStorage, indexedDB */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const dist = resolve(root, 'web-dist');
const output = resolve(root, 'artifacts', 'web-jsonc-visual');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${dist}${sep}`)) throw new Error('outside web-dist');
    response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/?profile=basic-sse-chat`;
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const mock = spawn(process.execPath, ['examples/mock-server/server.mjs'], { cwd: root, env: { ...process.env, TURNSTAGE_MOCK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const mockPort = await new Promise((resolvePort, reject) => {
  const timeout = globalThis.setTimeout(() => reject(new Error('Mock server did not start.')), 10_000);
  mock.stdout.on('data', (chunk) => { const match = String(chunk).match(/127\.0\.0\.1:(\d+)/u); if (match) { globalThis.clearTimeout(timeout); resolvePort(Number(match[1])); } });
  mock.once('error', reject);
  mock.once('exit', (code) => reject(new Error(`Mock server exited before startup (${code}).`)));
});
const errors = [];
const screenshots = [];
async function screenshot(page, name) {
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  screenshots.push(name);
}
async function visualAction(page, name) {
  await page.locator('.mobile-chat-preview__viewport-toolbar').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 250)));
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|visual baseline/i.test(message.text())) errors.push(message.text().slice(0, 250)); });
  await page.addInitScript(() => localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', theme: 'dark' })));
  await page.goto(url);
  await page.getByRole('button', { name: 'Profile actions: Basic SSE Chat' }).click();
  await page.getByRole('menuitem', { name: 'View JSONC' }).click();
  assert.equal(await page.getByRole('button', { name: 'Edit JSONC' }).count(), 0, 'Server default is read-only');
  await page.getByRole('button', { name: 'Duplicate to edit' }).click();
  const editor = page.getByRole('textbox', { name: 'JSONC' });
  await editor.waitFor();
  const editorLayout = async () => page.locator('.profile-reference-editor').evaluate((container) => {
    const outer = container.getBoundingClientRect();
    const input = container.querySelector('textarea').getBoundingClientRect();
    return { outerHeight: outer.height, inputHeight: input.height, topGap: input.top - outer.top, bottomGap: outer.bottom - input.bottom };
  });
  let layout = await editorLayout();
  assert.ok(layout.outerHeight > 400 && layout.inputHeight >= layout.outerHeight - 60 && layout.topGap >= 40 && layout.bottomGap <= 2, `Highlighted JSONC editor fills the dialog below its toolbar: ${JSON.stringify(layout)}`);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /opening/u }).waitFor();
  assert.ok(await page.locator('.profile-reference-editor .jsonc-key').count() > 3, 'Editable source retains syntax highlighting');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /opening/u }).click();
  const sectionJump = await editor.evaluate((element) => ({ inputScroll: element.scrollTop, highlightedScroll: element.parentElement.scrollTop, caret: element.selectionStart, targetTop: element.parentElement.querySelector('[data-line="20"]').offsetTop, inputScrollHeight: element.scrollHeight, highlightedScrollHeight: element.parentElement.scrollHeight }));
  assert.ok(sectionJump.inputScroll > 0 && Math.abs(sectionJump.inputScroll - sectionJump.highlightedScroll) <= 2 && sectionJump.caret > 0, `Section jump keeps editor and highlighting aligned: ${JSON.stringify(sectionJump)}`);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Top' }).click();
  await screenshot(page, 'jsonc-editing');
  await page.setViewportSize({ width: 520, height: 700 });
  layout = await editorLayout();
  assert.ok(layout.outerHeight > 300 && layout.inputHeight >= layout.outerHeight - 110 && layout.bottomGap <= 2, `Narrow JSONC editor fills the dialog below its wrapped toolbar: ${JSON.stringify(layout)}`);
  await screenshot(page, 'jsonc-editing-narrow');
  await page.setViewportSize({ width: 1400, height: 900 });
  const initial = await editor.inputValue();
  assert.match(initial, /basic-sse-chat-copy/u);
  await editor.focus();
  await editor.press('End');
  await editor.type('x');
  assert.notEqual(await editor.inputValue(), initial, 'Typing edits the highlighted JSONC source directly');
  await editor.fill(initial);
  await editor.fill('{ broken');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').waitFor();
  layout = await editorLayout();
  assert.ok(layout.inputHeight > 300 && layout.inputHeight < layout.outerHeight - 60, `Validation notice leaves room to edit: ${JSON.stringify(layout)}`);
  await screenshot(page, 'jsonc-validation');
  assert.equal(await editor.inputValue(), '{ broken', 'Invalid draft remains editable');
  const valid = initial.replace('"Basic SSE Chat Copy"', '"JSONC Edited"').replace('"Hello, I am a test assistant. What would you like to test?"', '"Visual regression changed opening"') + '\n// Preserved browser-local comment\n';
  await editor.fill(valid);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status', { name: '' }).filter({ hasText: 'Saved' }).first().waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('turnstage.web.profiles.v1')).find((item) => item.id === 'basic-sse-chat-copy'));
  assert.equal(saved.raw, valid, 'JSONC text and comments persist unchanged');
  await screenshot(page, 'jsonc-saved');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Profile actions: JSONC Edited' }).waitFor();
  await page.getByRole('button', { name: 'Profile actions: JSONC Edited' }).click();
  await page.getByRole('menuitem', { name: 'Edit JSONC' }).click();
  assert.match(await page.getByRole('textbox', { name: 'JSONC' }).inputValue(), /Preserved browser-local comment/u, 'Browser-local source opens directly for editing after reload');
  await page.getByRole('button', { name: 'Close' }).click();

  await visualAction(page, 'Compare visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'No visual baseline for this viewport' }).waitFor();
  await visualAction(page, 'Save visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual baseline saved.' }).waitFor();
  await screenshot(page, 'visual-baseline-saved');
  await visualAction(page, 'Compare visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual comparison passed (0%).' }).waitFor();
  await screenshot(page, 'visual-comparison-passed');
  page.once('dialog', (dialog) => dialog.dismiss());
  await visualAction(page, 'Save visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual baseline unchanged.' }).waitFor();
  await page.reload();
  await visualAction(page, 'Compare visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual comparison passed (0%).' }).waitFor();
  const baselineCount = await page.evaluate(async () => new Promise((resolveCount, reject) => { const open = indexedDB.open('turnstage-web'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const request = db.transaction('visualBaselines').objectStore('visualBaselines').count(); request.onsuccess = () => { resolveCount(request.result); db.close(); }; request.onerror = () => reject(request.error); }; }));
  assert.equal(baselineCount, 1, 'Visual baseline persists in IndexedDB');

  await page.getByRole('button', { name: 'Profile actions: JSONC Edited' }).click();
  await page.getByRole('menuitem', { name: 'Edit JSONC' }).click();
  await page.getByRole('textbox', { name: 'JSONC' }).fill(valid.replace('Visual regression changed opening', 'A different visual opening'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await visualAction(page, 'Compare visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: /Visual comparison failed/u }).waitFor();
  await screenshot(page, 'visual-comparison-failed');
  await page.getByRole('button', { name: 'Profile actions: JSONC Edited' }).click();
  await page.getByRole('menuitem', { name: 'Edit JSONC' }).click();
  const thresholdSource = await page.getByRole('textbox', { name: 'JSONC' }).inputValue();
  const withThreshold = thresholdSource.replace('"tests": {', '"tests": { "visual": { "baselineDirectory": ".turnstage/baselines", "maxDifferencePercent": 1, "channelTolerance": 16 },');
  assert.notEqual(withThreshold, thresholdSource, 'Fixture contains visual test settings');
  await page.getByRole('textbox', { name: 'JSONC' }).fill(withThreshold);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await visualAction(page, 'Compare visual baseline');
  await page.locator('.mobile-chat-preview__status').filter({ hasText: /Visual comparison passed \(0\.\d+%\)/u }).waitFor();
  await screenshot(page, 'visual-comparison-threshold');

  await page.locator('.mobile-chat-preview__viewport-settings > summary').click();
  await screenshot(page, 'viewport-settings');
  const panel = await page.locator('.mobile-chat-preview__viewport-settings-panel').boundingBox();
  assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 1400, 'Viewport settings fit within the page');
  const alignment = await page.locator('.mobile-chat-preview__dimensions').evaluate((element) => {
    const center = (selector) => { const box = element.querySelector(selector).getBoundingClientRect(); return box.y + box.height / 2; };
    return [Math.abs(center('label input') - center(':scope > span')), Math.abs(center('label input') - center('.mobile-chat-preview__rotate'))];
  });
  assert.ok(alignment.every((difference) => difference <= 1.5), `Dimension separator and swap button align with inputs: ${alignment}`);
  await page.getByRole('combobox', { name: 'Viewport preset' }).selectOption('mobile-m');
  await page.getByRole('combobox', { name: 'Viewport zoom' }).waitFor();
  await screenshot(page, 'viewport-settings-fixed');
  assert.deepEqual(errors, [], 'No browser page or visual CSP errors');
  const capturePage = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });
  capturePage.on('pageerror', (error) => errors.push(error.message.slice(0, 250)));
  await capturePage.addInitScript(({ port }) => {
    localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'zh-TW', theme: 'dark' }));
    localStorage.setItem('turnstage.web.environments.v1', JSON.stringify([{ id: 'local', name: 'Mock', raw: JSON.stringify({ version: 1, id: 'local', name: 'Mock', variables: { baseUrl: `http://127.0.0.1:${port}` } }), updatedAt: Date.now() }]));
  }, { port: mockPort });
  await capturePage.goto(url);
  await capturePage.locator('.mobile-chat-preview__composer textarea').fill('Please search for sample information.');
  await capturePage.getByRole('button', { name: '傳送訊息' }).click();
  await capturePage.locator('.mobile-chat-preview__session-state--ready').waitFor();
  await capturePage.locator('.mobile-chat-preview__viewport-toolbar').getByRole('button', { name: '更多動作' }).click();
  await capturePage.getByRole('menuitem', { name: '另存為測試…' }).click();
  await capturePage.locator('.operation-status').filter({ hasText: '已儲存測試案例：Please search for sample information.' }).waitFor();
  await screenshot(capturePage, 'captured-case-localized');
  assert.deepEqual(errors, [], 'No browser errors during mock conversation capture');
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: true, screenshots, baselineCount }, null, 2));
  console.log(JSON.stringify({ passed: true, screenshots, output }, null, 2));
} finally {
  await browser.close();
  mock.kill('SIGTERM');
  await new Promise((done) => server.close(done));
}
