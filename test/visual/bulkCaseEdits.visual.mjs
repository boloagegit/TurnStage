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
  const sent = (type) => page.evaluate((name) => globalThis.__turnstageMessages.filter((message) => message.type === name), type);
  const reset = () => page.evaluate(() => { globalThis.__turnstageMessages.length = 0; });
  await page.goto(`http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html?rightPane=tests&capturedDraft=true`);
  await page.getByRole('tablist', { name: 'Test sections' }).getByRole('tab', { name: 'Cases' }).click();
  await page.getByRole('searchbox', { name: 'Search cases' }).waitFor();

  // Reviewed capture drafts are marked ready together, after a confirmation.
  await reset();
  await page.getByRole('button', { name: 'Mark 1 draft ready' }).locator('xpath=..').screenshot({ path: resolve(artifacts, 'bulk-mark-ready.png') });
  await page.getByRole('button', { name: 'Mark 1 draft ready' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark ready' }).click();
  const [ready] = await sent('profile.patch');
  assert.deepEqual(ready.path, ['tests', 'scenarios']);
  const probe = ready.value.find((item) => item.id === 'captured-release-probe');
  assert.equal(probe.capture.status, 'ready');
  assert.deepEqual(probe.tags, ['captured']);
  await page.getByText('Marked 1 draft ready.').waitFor();

  // Tag a Profile case and a linked case in one action.
  await page.getByRole('checkbox', { name: /Select case Slow stream contract/ }).check();
  await page.getByRole('checkbox', { name: /Select case Linked multi-turn contract/ }).check();
  const selection = page.getByRole('region', { name: 'Selected cases' });
  await page.locator('.unified-test-workspace__run-actions').screenshot({ path: resolve(artifacts, 'bulk-selection-actions.png') });
  await reset();
  await selection.getByRole('button', { name: 'Add tag…' }).click();
  await selection.getByRole('textbox', { name: 'Tag to add' }).fill('release gate');
  await page.locator('.unified-test-workspace__run-actions').screenshot({ path: resolve(artifacts, 'bulk-selection-tag.png') });
  await selection.getByRole('button', { name: 'Add tag', exact: true }).click();
  await page.getByText('Tagged 2 cases with “release gate”.').waitFor();
  const [tagged] = await sent('profile.patch');
  assert.ok(tagged.value.find((item) => item.id === 'slow-stream-contract').tags.includes('release gate'));
  const [savedLinked] = await sent('contract.case.save');
  assert.equal(savedLinked.expectedRevision, 'c'.repeat(64), 'Linked cases are saved against the revision that was loaded');
  assert.ok(savedLinked.scenario.tags.includes('release gate'));
  assert.equal(await selection.getByRole('button', { name: 'Add tag…' }).evaluate((element) => element === document.activeElement), true, 'Focus returns to Add tag after applying');

  // Delete both, after a destructive confirmation; the selection is cleared.
  await reset();
  await selection.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog', { name: 'Delete 2 cases?' }).getByRole('button', { name: 'Delete cases' }).click();
  await page.getByText('Deleted 2 cases.').waitFor();
  const [removed] = await sent('profile.patch');
  assert.equal(removed.value.some((item) => item.id === 'slow-stream-contract'), false);
  const [deletedLinked] = await sent('contract.case.delete');
  assert.equal(deletedLinked.scenarioId, 'linked-multi-turn-contract');
  assert.equal(await page.getByRole('region', { name: 'Selected cases' }).count(), 0, 'Deleted cases leave the selection');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: ['bulk-mark-ready.png', 'bulk-selection-actions.png', 'bulk-selection-tag.png'], artifacts }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
