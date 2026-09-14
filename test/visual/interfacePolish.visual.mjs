/* global localStorage, innerWidth */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'interface-polish');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path === '/' ? resolve(root, 'web-dist/index.html') : path === '/turnstage-catalog.json' || path.startsWith('/assets/')
      ? resolve(root, 'web-dist', `.${path}`) : resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('outside workspace');
    response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const screenshots = [];
const errors = [];
const selectAudit = [];
const settings = ['general', 'opening-flow', 'request', 'stream-mapping', 'chat-ui', 'scenario-tests', 'history-errors', 'security'];

async function capture(page, name) {
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: false });
  const overflow = await page.evaluate(() => { const shell = document.getElementById('web-shell'); return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, shell: shell ? shell.scrollWidth - shell.clientWidth : 0 }; });
  assert.ok(overflow.document <= 1, `${name}: document overflows by ${overflow.document}px`);
  assert.ok((overflow.shell ?? 0) <= 1, `${name}: web shell overflows by ${overflow.shell}px`);
  const selects = await page.locator('select:visible').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { label: element.getAttribute('aria-label') ?? element.closest('label')?.textContent?.trim().slice(0, 50) ?? element.id, appearance: style.appearance, backgroundImage: style.backgroundImage, paddingRight: Number.parseFloat(style.paddingRight), width: bounds.width, inViewport: bounds.left >= 0 && bounds.right <= innerWidth + 1 };
  }));
  const failures = selects.filter((item) => item.appearance !== 'none' || !item.backgroundImage.includes('linear-gradient') || item.paddingRight < 28 || !item.inViewport);
  assert.deepEqual(failures, [], `${name}: dropdown arrow styling or viewport position is inconsistent`);
  selectAudit.push({ page: name, count: selects.length });
  screenshots.push(name);
}

async function visitPanels(page, prefix) {
  await page.getByRole('tab', { name: 'Debug', exact: true }).click();
  for (const tabName of ['Network', 'Raw Events', 'Normalized Events', 'Metrics', 'Errors', 'Runs']) {
    await page.getByRole('tablist', { name: 'Evidence views' }).getByRole('tab', { name: new RegExp(`^${tabName}(?: \\(|$)`, 'u') }).click();
    await capture(page, `${prefix}-debug-${tabName.toLowerCase().replaceAll(' ', '-')}`);
  }
  await page.getByRole('tab', { name: 'General tests', exact: true }).click();
  for (const tabName of ['Cases', 'Results']) {
    await page.getByRole('tablist', { name: 'Test sections' }).getByRole('tab', { name: tabName, exact: true }).click();
    await capture(page, `${prefix}-general-${tabName.toLowerCase()}`);
  }
  await page.getByRole('tab', { name: 'Red Team', exact: true }).click();
  for (const tabName of ['Cases', 'Results']) {
    await page.getByRole('tablist', { name: 'Test sections' }).getByRole('tab', { name: tabName, exact: true }).click();
    await capture(page, `${prefix}-red-team-${tabName.toLowerCase()}`);
  }
  await page.getByRole('tab', { name: 'Configure', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Profile configuration sections' });
  for (const section of settings) {
    await picker.selectOption(section);
    await capture(page, `${prefix}-settings-${section}`);
  }
}

try {
  const web = await browser.newPage({ viewport: { width: 1600, height: 960 }, locale: 'en-US' });
  web.on('pageerror', (error) => errors.push(`web: ${error.message}`));
  await web.addInitScript(() => localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', theme: 'dark' })));
  await web.goto(url);
  await web.getByRole('button', { name: /^Basic SSE Chat, /u }).waitFor();
  assert.equal(await web.locator('html').getAttribute('lang'), 'en');
  await capture(web, 'web-shell');
  const defaultFolder = web.getByRole('button', { name: /^Default\s+\d+$/u });
  assert.equal(await defaultFolder.getAttribute('aria-expanded'), 'true');
  await defaultFolder.click();
  assert.equal(await defaultFolder.getAttribute('aria-expanded'), 'false');
  await capture(web, 'web-folder-collapsed');
  await defaultFolder.click();
  await visitPanels(web, 'web');
  await web.getByRole('button', { name: 'Profile guide' }).click();
  await web.getByRole('dialog', { name: 'Profile guide' }).waitFor();
  await capture(web, 'web-profile-guide');
  await web.getByRole('dialog', { name: 'Profile guide' }).getByRole('button', { name: 'Close' }).click();
  await web.getByRole('button', { name: 'Profile actions: Basic SSE Chat' }).click();
  await capture(web, 'web-profile-menu');
  await web.getByRole('menuitem', { name: 'View JSONC' }).click();
  await web.getByRole('dialog').waitFor();
  await capture(web, 'web-jsonc');
  await web.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await web.setViewportSize({ width: 390, height: 844 });
  const configureBounds = await web.getByRole('tab', { name: 'Configure', exact: true }).boundingBox();
  assert.ok(configureBounds && configureBounds.x + configureBounds.width <= 390, 'Mobile: Configure tab is fully visible');
  await capture(web, 'web-mobile');
  await web.getByRole('button', { name: 'Search profiles' }).click();
  await capture(web, 'web-mobile-library');
  await web.close();

  const vsix = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  vsix.on('pageerror', (error) => errors.push(`vsix: ${error.message}`));
  await vsix.goto(`${url}/test/visual/profileWorkspaceHarness.html?rightPane=debug&locale=en-US`);
  await vsix.getByRole('tab', { name: 'Debug', exact: true }).waitFor();
  await capture(vsix, 'vsix-shell');
  await vsix.getByRole('button', { name: 'More actions', exact: true }).first().click();
  await capture(vsix, 'vsix-toolbar-menu');
  await vsix.getByRole('menuitem', { name: 'Save visual baseline' }).click();
  await vsix.locator('.mobile-chat-preview__status.is-visible').filter({ hasText: 'Visual baseline saved.' }).waitFor();
  await capture(vsix, 'vsix-visual-baseline');
  await vsix.getByRole('button', { name: 'More actions', exact: true }).first().click();
  await vsix.getByRole('menuitem', { name: 'Compare visual baseline' }).click();
  await vsix.locator('.mobile-chat-preview__status.is-visible').filter({ hasText: 'Visual comparison passed (0%).' }).waitFor();
  await capture(vsix, 'vsix-visual-comparison');
  await vsix.evaluate(() => globalThis.__turnstageHarness.dispatch({ type: 'visual.error', operation: 'compare', message: 'Visual comparison could not be completed.' }));
  await vsix.locator('.mobile-chat-preview__status.is-visible').filter({ hasText: 'Visual comparison could not be completed.' }).waitFor();
  await capture(vsix, 'vsix-visual-error');
  await visitPanels(vsix, 'vsix');
  await vsix.setViewportSize({ width: 760, height: 720 });
  await capture(vsix, 'vsix-narrow');
  await vsix.close();

  assert.deepEqual(errors, [], 'No page errors');
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: true, screenshots, selectAudit }, null, 2));
  console.log(JSON.stringify({ passed: true, screenshotCount: screenshots.length, auditedSelects: selectAudit.reduce((count, item) => count + item.count, 0), output }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
