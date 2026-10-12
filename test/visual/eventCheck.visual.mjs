import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const artifacts = resolve(root, 'artifacts', 'visual-regression');
const browserCandidates = [process.env.TURNSTAGE_CHROMIUM_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('Path outside visual-test root');
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream';
    response.setHeader('Content-Type', type);
    response.end(await readFile(file));
  } catch { response.statusCode = 404; response.end('Not found'); }
});

await mkdir(artifacts, { recursive: true });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html`);
  await page.getByRole('tablist', { name: 'Right panel' }).getByRole('tab', { name: 'Debug' }).click();
  await page.getByRole('tab', { name: /^Normalized/ }).click();
  await page.locator('.event-row').first().click();
  await page.getByRole('button', { name: 'Add as check' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add check from event' });
  await dialog.waitFor();
  const targets = await dialog.getByRole('combobox', { name: 'Add to case' }).locator('option').allInnerTexts();
  assert.ok(targets.includes('Slow stream contract'), 'Profile cases are offered');
  assert.ok(targets.some((label) => label.startsWith('Linked multi-turn contract')), 'Linked suite cases are offered');
  await page.screenshot({ path: resolve(artifacts, 'event-check-dialog.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(artifacts, 'event-check-dialog-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // A Profile case is updated with a Profile patch.
  await page.evaluate(() => { globalThis.__turnstageMessages.length = 0; });
  await dialog.getByRole('button', { name: 'Add check' }).click();
  const patch = await page.evaluate(() => globalThis.__turnstageMessages.find((message) => message.type === 'profile.patch'));
  assert.deepEqual(patch.path, ['tests', 'scenarios']);
  assert.equal(patch.value.find((item) => item.id === 'slow-stream-contract').assertions.at(-1).path, 'events.normalized[*].type');
  await page.getByText(/^Check added to Slow stream contract\./).waitFor();

  // A linked case is loaded, extended, and saved against the revision that was loaded.
  await page.getByRole('button', { name: 'Add as check' }).click();
  const linked = await dialog.getByRole('combobox', { name: 'Add to case' }).locator('option', { hasText: 'Linked multi-turn contract' }).getAttribute('value');
  await dialog.getByRole('combobox', { name: 'Add to case' }).selectOption(linked);
  await page.evaluate(() => { globalThis.__turnstageMessages.length = 0; });
  await dialog.getByRole('button', { name: 'Add check' }).click();
  await page.getByText(/^Check added to Linked multi-turn contract\./).waitFor();
  const save = await page.evaluate(() => globalThis.__turnstageMessages.find((message) => message.type === 'contract.case.save'));
  assert.equal(save.expectedRevision, 'c'.repeat(64));
  assert.deepEqual(save.scenario.assertions.map((item) => item.path), ['assistant.text', 'events.normalized[*].type']);
  assert.equal(await page.getByRole('dialog').count(), 0, 'Adding a check does not open the case editor');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: ['event-check-dialog.png', 'event-check-dialog-narrow.png'], artifacts }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
