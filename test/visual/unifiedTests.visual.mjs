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
  await page.goto(`http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html?rightPane=tests`);
  await page.getByRole('tab', { name: 'General tests', exact: true }).waitFor();
  assert.equal(await page.getByRole('tablist', { name: 'Right panel' }).getByRole('tab').count(), 4);
  assert.equal(await page.getByRole('tab', { name: 'Red Team', exact: true }).count(), 1, 'Red Team has its own top-level tab');
  await page.getByRole('tablist', { name: 'Test sections' }).getByRole('tab', { name: 'Cases' }).click();
  await page.getByRole('tab', { name: 'Cases' }).press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Results' }).press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'Cases' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('searchbox', { name: 'Search cases' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'General tests' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByText('Linked case 1', { exact: true }).count(), 0, 'General list excludes red-team cases');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-general-cases.png') });
  await page.getByRole('tab', { name: 'General tests' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'true');
  await page.waitForFunction(() => document.querySelectorAll('.adversarial-case-list .test-case-select input[type="checkbox"]').length === 25);
  assert.equal(await page.getByText('Slow stream contract', { exact: true }).count(), 0, 'Red-team list excludes general cases');
  await page.getByRole('searchbox', { name: 'Search cases' }).fill('Linked case 1');
  await page.getByRole('button', { name: /Select matching cases \(11\/11\)/ }).click();
  assert.match(await page.getByRole('button', { name: /Run selected/ }).innerText(), /Run selected 11/);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('searchbox', { name: 'Search cases' }).fill('');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-red-team-cases.png') });
  assert.equal(await page.getByRole('button', { name: 'Manage red-team tests' }).count(), 0, 'No extra management screen');
  await page.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('tab', { name: 'General tests' }).click();
  assert.equal(await page.getByRole('tab', { name: 'Cases' }).getAttribute('aria-selected'), 'true', 'General cases remember their section independently');
  await page.getByRole('tab', { name: 'Red Team' }).click();
  assert.equal(await page.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected'), 'true', 'Red Team remembers its own result section');
  await page.getByRole('tab', { name: 'Cases' }).click();
  await page.getByRole('tab', { name: 'General tests' }).click();
  const select = page.getByRole('checkbox', { name: /Select case/ }).first();
  await select.check();
  await page.getByRole('button', { name: /Run selected 1/ }).click();
  assert.equal(await page.getByRole('group', { name: 'Review selected run' }).count(), 0, 'Selected cases start without a second confirmation');
  assert.equal(await page.evaluate(() => globalThis.__turnstageMessages.some((message) => message.type === 'test.runSelection' && message.cases.length === 1)), true);
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-selected.png') });

  const key = JSON.stringify(['slow-sse-proof', 'contract', null, 'slow-stream-contract']);
  const caseBase = { profileId: 'slow-sse-proof', scenarioId: 'slow-stream-contract', kind: 'contract', key, name: 'Slow stream contract', definitionDigest: 'a'.repeat(64), requestedAttempts: 1, completedAttempts: 1, durationMs: 20 };
  const base = { format: 'turnstage-test-run-history', version: 1, id: 'base', profileId: 'slow-sse-proof', startedAt: 1_790_000_000_000, finishedAt: 1_790_000_000_020, status: 'completed', runner: 'vscode', evaluatorVersion: 1, profileDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64), cases: [{ ...caseBase, outcome: 'passed' }] };
  const current = { ...base, id: 'current', startedAt: base.startedAt + 1000, finishedAt: base.finishedAt + 1000, cases: [{ ...caseBase, outcome: 'failed' }] };
  await page.evaluate(({ base, current }) => globalThis.__turnstageHarness.dispatch({ type: 'test.history', profileId: 'slow-sse-proof', runs: [current, base], baselineRunId: 'base' }), { base, current });
  await page.evaluate(() => globalThis.__turnstageHarness.dispatch({ type: 'test.operation', operation: { action: 'runSelection', state: 'completed' } }));
  await page.getByRole('button', { name: 'View test results' }).waitFor();
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-completed.png') });
  await page.getByRole('button', { name: 'View test results' }).click();
  assert.equal(await page.getByRole('tab', { name: 'Results' }).getAttribute('aria-selected'), 'true', 'Completed runs link directly to results');
  assert.equal(await page.getByRole('text', { name: 'New failure' }).count(), 0); // plain text lives in a list row, not a role-specific control
  assert.match(await page.getByRole('region', { name: 'Run history' }).innerText(), /New failure/);
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-history.png') });
  await page.setViewportSize({ width: 760, height: 720 });
  assert.equal(await page.locator('.debug-pane').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Narrow test pane must not overflow horizontally');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-history-narrow.png') });
  await page.evaluate(() => {
    const style = document.documentElement.style;
    for (const [token, value] of Object.entries({
      '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#1f1f1f', '--vscode-editorGroup-border': '#d4d4d4',
      '--vscode-editorWidget-background': '#f3f3f3', '--vscode-editorWidget-border': '#c8c8c8', '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-descriptionForeground': '#616161', '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#1f1f1f',
      '--vscode-input-border': '#cecece', '--vscode-input-placeholderForeground': '#767676', '--vscode-list-inactiveSelectionBackground': '#e4e6f1',
      '--vscode-button-secondaryBackground': '#e5e5e5', '--vscode-button-secondaryForeground': '#1f1f1f', '--vscode-errorForeground': '#b42318',
    })) style.setProperty(token, value);
    document.body.className = 'vscode-light';
  });
  assert.equal(await page.locator('.debug-pane').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Light theme must not overflow the narrow test pane');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-history-light.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-history-high-contrast.png') });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-font-size', '26px'));
  assert.equal(await page.locator('.debug-pane').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, '200% test typography must not overflow the pane horizontally');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifacts, 'unified-run-history-200-percent.png') });
  for (const [locale, previous, next] of [['zh-TW', '上一頁', '下一頁'], ['ja-JP', '前のページ', '次のページ'], ['ko-KR', '이전 페이지', '다음 페이지']]) {
    const localizedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await localizedPage.goto(`http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html?rightPane=adversarial&locale=${locale}`);
    await localizedPage.getByRole('button', { name: previous }).waitFor();
    await localizedPage.getByRole('button', { name: next }).waitFor();
    assert.equal(await localizedPage.locator('.debug-pane').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, `${locale}: localized case list must fit the pane`);
    await localizedPage.locator('.debug-pane').screenshot({ path: resolve(artifacts, `unified-red-team-${locale}.png`) });
    await localizedPage.close();
  }
  await page.getByRole('button', { name: 'Clear history' }).click();
  assert.equal(await page.getByRole('alertdialog', { name: 'Clear run history?' }).count(), 1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.__turnstageMessages.some((message) => message.type === 'test.history.clear')), false, 'Cancelling does not clear history');
  await page.getByRole('button', { name: 'Clear history' }).click();
  await page.getByRole('alertdialog', { name: 'Clear run history?' }).getByRole('button', { name: 'Clear history' }).click();
  assert.equal(await page.evaluate(() => globalThis.__turnstageMessages.some((message) => message.type === 'test.history.clear' && message.kind === 'contract')), true);
  await page.evaluate(() => globalThis.__turnstageHarness.dispatch({ type: 'test.history', profileId: 'slow-sse-proof', runs: [] }));
  await page.getByText('No recorded runs yet.').waitFor();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(JSON.stringify({ passed: true, screenshots: ['unified-general-cases.png', 'unified-red-team-cases.png', 'unified-run-selected.png', 'unified-run-completed.png', 'unified-run-history.png', 'unified-run-history-narrow.png', 'unified-run-history-light.png', 'unified-run-history-high-contrast.png', 'unified-run-history-200-percent.png', 'unified-red-team-zh-TW.png', 'unified-red-team-ja-JP.png', 'unified-red-team-ko-KR.png'], artifacts }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
