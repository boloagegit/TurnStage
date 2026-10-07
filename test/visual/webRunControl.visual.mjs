/* global localStorage, indexedDB */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'test-run-control');
await mkdir(output, { recursive: true });
const probe = { hold: true, requests: [], pending: new Set() };
const server = createServer(async (request, response) => {
  if (request.url === '/api/stream') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body).message;
    probe.requests.push(message);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.flushHeaders();
    const finish = () => {
      probe.pending.delete(finish);
      if (!response.destroyed) response.end('event: message\ndata: {"text":"Mock result."}\n\nevent: done\ndata: {}\n\n');
    };
    response.once('close', () => probe.pending.delete(finish));
    if (probe.hold) probe.pending.add(finish);
    else finish();
    return;
  }
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(root, 'web-dist', `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${resolve(root, 'web-dist')}${sep}`)) throw new Error('outside dist');
    response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;
const profile = {
  version: 1, id: 'run-control-qa', name: 'Run control QA',
  conversation: { send: { method: 'POST', url: `${url}api/stream`, timeoutMs: 120000, idleTimeoutMs: 120000, variants: [{ id: 'send', body: { message: { $value: 'input.text' } } }] } },
  stream: { transport: 'sse', dataFormat: 'json', unexpectedEndPolicy: 'fail', mappings: [
    { id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
    { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } },
  ] }, tests: { scenarios: [] },
};
const executablePath = process.env.TURNSTAGE_CHROMIUM_EXECUTABLE === 'bundled' ? undefined : [process.env.TURNSTAGE_CHROMIUM_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].filter(Boolean).find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const results = [];
const pageErrors = [];
try {
  for (const [kind, tab] of [['contract', 'General tests'], ['adversarial', 'Red Team']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript((value) => {
      localStorage.setItem('turnstage.web.profiles.v1', JSON.stringify([{ id: value.id, name: value.name, raw: JSON.stringify(value), updatedAt: Date.now() }]));
      localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', theme: 'dark', activeProfileId: value.id }));
    }, profile);
    await page.goto(url);
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.getByRole('tab', { name: 'Cases', exact: true }).click();
    const count = 5000;
    const columns = kind === 'contract' ? ['case_id', 'case_name', 'enabled', 'turn_index', 'turn_id', 'user_message', 'step_assertions_json'] : ['case_id', 'case_name', 'description', 'tags', 'enabled', 'turn_index', 'turn_id', 'turn_name', 'user_message', 'forbidden_content_json', 'forbid_urls', 'forbid_ctas', 'forbid_tools', 'forbidden_events_json', 'additional_forbidden_content_json', 'additional_forbid_urls', 'additional_forbid_ctas', 'additional_forbid_tools', 'additional_forbidden_events_json', 'max_turns', 'timeout_ms', 'stop_on_attack_succeeded'];
    const rows = Array.from({ length: count }, (_, index) => {
      const id = `${kind}-${String(index + 1).padStart(4, '0')}`;
      const values = { case_id: id, case_name: `Case ${id}`, enabled: 'true', turn_index: '1', turn_id: 'turn', user_message: id, step_assertions_json: JSON.stringify([{ path: 'turn.state', operator: 'equals', value: 'completed' }]), forbidden_content_json: JSON.stringify(['forbidden-marker']), max_turns: '1', timeout_ms: '120000' };
      return csvRow(columns.map((column) => values[column] ?? ''));
    });
    const menu = page.locator('.adversarial-case-file-menu').filter({ visible: true });
    await menu.locator(':scope > summary').click();
    await menu.locator('.case-format-submenu').first().locator('summary').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
    await (await chooser).setFiles({ name: `large-${kind}.csv`, mimeType: 'text/csv', buffer: Buffer.from(`${csvRow(columns)}\r\n${rows.join('\r\n')}\r\n`) });
    await page.getByRole('button', { name: `Run case Case ${kind}-0001`, exact: true }).waitFor();
    await page.getByRole('button', { name: /Select all selectable cases/u }).click();
    await page.getByRole('button', { name: 'Run selected 5,000', exact: true }).waitFor();
    probe.hold = true;
    probe.requests.length = 0;
    const started = Date.now();
    await page.getByRole('button', { name: 'Run selected 5,000', exact: true }).click();
    await waitUntil(() => probe.requests.length === 4);
    const pause = page.getByRole('button', { name: 'Pause test run', exact: true });
    await pause.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Pausing test run…', { exact: true }).waitFor();
    for (const finish of [...probe.pending]) finish();
    await page.getByText('Test run paused', { exact: true }).waitFor();
    assert.equal(probe.requests.length, 4, 'Pause must stop subsequent dispatch');
    assert.match(await page.locator('.test-operation-status').innerText(), /4 \/ 5,000 cases/u);
    await page.screenshot({ path: resolve(output, `${kind}-paused.png`) });
    const resume = page.getByRole('button', { name: 'Resume test run', exact: true });
    assert.equal(await resume.evaluate((element) => element === document.activeElement), true, 'Pause/resume retains keyboard focus');
    await page.setViewportSize({ width: 800, height: 900 });
    await page.screenshot({ path: resolve(output, `${kind}-paused-narrow.png`) });
    const controls = page.locator('.test-operation-status__controls');
    const boxes = await controls.getByRole('button').evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { width: box.width, height: box.height, right: box.right }; }));
    assert.ok(boxes.every((box) => box.width >= 24 && box.height >= 24 && box.right <= 800));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByText('Language and appearance', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Appearance theme', exact: true }).selectOption('light');
    await page.getByText('Language and appearance', { exact: true }).click();
    await page.screenshot({ path: resolve(output, `${kind}-paused-light.png`) });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.screenshot({ path: resolve(output, `${kind}-paused-high-contrast.png`) });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.getByText('Language and appearance', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Appearance theme', exact: true }).selectOption('dark');
    await page.getByText('Language and appearance', { exact: true }).click();
    await page.setViewportSize({ width: 720, height: 450 });
    await page.screenshot({ path: resolve(output, `${kind}-paused-200-percent-layout.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    probe.hold = false;
    await resume.press('Enter');
    // Shared CI runners can take over fifteen minutes for 5,000 red-team cases.
    // Keep the complete workload, but fail independently if progress stops.
    const { promise: stalled, reject: rejectStall } = Promise.withResolvers();
    let lastRequestCount = probe.requests.length;
    let lastProgressAt = Date.now();
    const progressLog = setInterval(() => {
      if (probe.requests.length !== lastRequestCount) {
        lastRequestCount = probe.requests.length;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt >= 90000) {
        rejectStall(new Error(`${kind} run made no request progress for 90 seconds (${lastRequestCount}/${count})`));
      }
      console.log(JSON.stringify({ kind, requests: probe.requests.length, pending: probe.pending.size }));
    }, 15000);
    try {
      await Promise.race([
        page.getByText('Test run completed', { exact: true }).waitFor({ timeout: 1200000 }),
        stalled,
      ]);
    } catch (error) {
      const diagnostic = { kind, requests: probe.requests.length, pending: probe.pending.size, status: await page.locator('.test-operation-status').innerText(), pageErrors, body: (await page.locator('body').innerText()).slice(-8000) };
      await writeFile(resolve(output, `${kind}-completion-failed.json`), JSON.stringify(diagnostic, null, 2));
      await page.screenshot({ path: resolve(output, `${kind}-completion-failed.png`) });
      console.error(JSON.stringify(diagnostic));
      throw error;
    } finally {
      clearInterval(progressLog);
    }
    const elapsedMs = Date.now() - started;
    assert.equal(probe.requests.length, count);
    assert.equal(new Set(probe.requests).size, count, 'Resume must not resend completed cases');
    let runs = await histories(page);
    const completed = runs.find((run) => run.status === 'completed');
    assert.equal(completed.cases.length, count);
    const unexpected = completed.cases.filter((item) => item.completedAttempts !== 1 || item.outcome !== (kind === 'contract' ? 'passed' : 'resisted'));
    if (unexpected.length) {
      await page.screenshot({ path: resolve(output, `${kind}-unexpected.png`) });
      await writeFile(resolve(output, `${kind}-unexpected.json`), JSON.stringify({ cases: unexpected.slice(0, 5), evidence: await artifact(page, 'evidence', unexpected[0].evidenceId) }, null, 2));
    }
    assert.equal(unexpected.length, 0, `Unexpected outcomes: ${JSON.stringify(unexpected.slice(0, 2))}`);
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
    await page.screenshot({ path: resolve(output, `${kind}-5000-completed.png`) });
    const exports = page.locator('.adversarial-export-actions');
    await exports.locator(':scope > summary').click();
    const downloaded = page.waitForEvent('download', { timeout: 120000 });
    await exports.getByRole('button', { name: 'HTML report', exact: true }).click();
    const file = resolve(output, `${kind}-5000.html`);
    await (await downloaded).saveAs(file);
    const html = await readFile(file, 'utf8');
    assert.equal((html.match(/<tr data-report-case/gu) ?? []).length, count, 'HTML report must include all cases');
    assert.ok(html.includes(`${kind}-5000`));
    await page.getByRole('tab', { name: 'Cases', exact: true }).click();
    probe.hold = true;
    probe.requests.length = 0;
    await page.getByRole('button', { name: 'Run selected 5,000', exact: true }).click();
    await waitUntil(() => probe.requests.length === 4);
    await page.getByRole('button', { name: 'Pause test run', exact: true }).click();
    for (const finish of [...probe.pending]) finish();
    await page.getByText('Test run paused', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop test run', exact: true }).press('Enter');
    await page.getByText('Test run cancelled', { exact: true }).waitFor();
    runs = await histories(page);
    const cancelled = runs.filter((run) => run.status === 'cancelled').sort((a, b) => b.startedAt - a.startedAt)[0];
    assert.equal(cancelled.cases.length, count);
    assert.equal(cancelled.cases.filter((item) => item.completedAttempts === 1).length, 4);
    assert.equal(cancelled.cases.filter((item) => item.outcome === undefined).length, 4996);
    assert.equal(probe.requests.length, 4);
    await page.screenshot({ path: resolve(output, `${kind}-cancelled.png`) });
    probe.requests.length = 0;
    await page.getByRole('button', { name: 'Run selected 5,000', exact: true }).click();
    await waitUntil(() => probe.requests.length === 4);
    await page.getByRole('button', { name: 'Stop test run', exact: true }).click();
    await page.getByText('Test run cancelled', { exact: true }).waitFor();
    await waitUntil(() => probe.pending.size === 0);
    const activeCancelled = (await histories(page)).sort((a, b) => b.startedAt - a.startedAt)[0];
    assert.equal(activeCancelled.status, 'cancelled');
    assert.ok(activeCancelled.cases.every((item) => !['passed', 'resisted'].includes(item.outcome)));
    assert.equal(probe.requests.length, 4, 'Active cancellation must abort sockets and not send another case');
    results.push({ kind, importedCsvCases: count, completedCases: count, uniqueRequests: count, pausedAfter: 4, cancelledCompleted: 4, cancelledUnfinished: 4996, htmlCases: count, elapsedMs });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: true, results, pageErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, output, results }, null, 2));
} finally {
  for (const finish of [...probe.pending]) finish();
  await browser.close();
  await new Promise((done) => server.close(done));
}

function csvRow(values) { return values.map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(','); }
async function waitUntil(condition) {
  const deadline = Date.now() + 30000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'Mock requests did not arrive'); await new Promise((done) => setTimeout(done, 25)); }
}
async function histories(page) {
  return page.evaluate(() => new Promise((done, reject) => {
    const open = indexedDB.open('turnstage-web');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('runs').objectStore('runs').getAll();
      request.onerror = () => { db.close(); reject(request.error); };
      request.onsuccess = () => { db.close(); done(request.result.filter((item) => item.kind === 'test-batch').map((item) => item.value)); };
    };
  }));
}
async function artifact(page, store, id) {
  return page.evaluate(({ store, id }) => new Promise((done, reject) => {
    const open = indexedDB.open('turnstage-web');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction(store).objectStore(store).get(id);
      request.onerror = () => { db.close(); reject(request.error); };
      request.onsuccess = () => { db.close(); done(request.result); };
    };
  }), { store, id });
}
