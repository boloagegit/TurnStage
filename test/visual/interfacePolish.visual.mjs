/* global localStorage, sessionStorage, innerWidth */
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
    const file = path === '/' ? resolve(root, 'web-dist/index.html') : path === '/turnstage-catalog.json' || path === '/theme-boot.js' || path.startsWith('/assets/')
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
  await web.setViewportSize({ width: 1100, height: 844 });
  await web.waitForFunction(() => document.querySelector('.test-surface')?.dataset.layout === 'narrow');
  const sidebarBreakpoint = await web.locator('.test-workspace').evaluate((element) => ({ windowWidth: innerWidth, workspaceWidth: element.getBoundingClientRect().width }));
  assert.ok(sidebarBreakpoint.windowWidth > 1024 && sidebarBreakpoint.workspaceWidth <= 1024, 'Web tabs use the workspace width after subtracting the library sidebar');
  assert.equal(await web.getByRole('tab', { name: 'Chat', exact: true }).isVisible(), true);
  await capture(web, 'web-sidebar-narrow');
  await web.reload();
  await web.waitForFunction(() => document.querySelector('.test-surface')?.dataset.layout === 'narrow');
  await web.getByRole('tab', { name: 'Chat', exact: true }).waitFor();
  await capture(web, 'web-sidebar-narrow-reload');
  await web.setViewportSize({ width: 390, height: 844 });
  // ResizeObserver commits the measured layout asynchronously; do not inspect
  // tab bounds from the previous width before the new layout has rendered.
  await web.waitForFunction(() => innerWidth === 390 && document.querySelector('.test-surface')?.dataset.layout === 'narrow' && document.querySelector('.test-workspace')?.getBoundingClientRect().width <= 390);
  const configureBounds = await web.getByRole('tab', { name: 'Configure', exact: true }).boundingBox();
  assert.ok(configureBounds && configureBounds.x + configureBounds.width <= 390, 'Mobile: Configure tab is fully visible');
  await capture(web, 'web-mobile');
  // System UI font metrics differ across hosts. A wider installed font must
  // not stretch the grid header or hide the final tab behind a scroll clip.
  await web.evaluate(() => document.documentElement.style.setProperty('--vscode-font-family', 'Verdana, system-ui, sans-serif'));
  const mobileTabs = await web.locator('.right-pane-tabs').evaluate((element) => {
    const pane = element.closest('.debug-pane').getBoundingClientRect();
    const list = element.getBoundingClientRect();
    return [...element.querySelectorAll('[role="tab"]')].map((tab) => {
      const bounds = tab.getBoundingClientRect();
      return { label: tab.getAttribute('aria-label') ?? tab.textContent, left: bounds.left, right: bounds.right, paneLeft: pane.left, paneRight: pane.right, listLeft: list.left, listRight: list.right };
    });
  });
  await web.screenshot({ path: resolve(output, 'web-mobile-wide-font.png'), fullPage: false });
  assert.deepEqual(mobileTabs.filter((tab) => tab.left < Math.max(tab.paneLeft, tab.listLeft) || tab.right > Math.min(tab.paneRight, tab.listRight)), [], 'Mobile: every tab fits the workspace with wider system font metrics');
  await capture(web, 'web-mobile-wide-font');
  await web.evaluate(() => document.documentElement.style.removeProperty('--vscode-font-family'));
  await web.getByRole('button', { name: 'Search profiles' }).click();
  await capture(web, 'web-mobile-library');
  await web.close();

  const vsix = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  vsix.on('pageerror', (error) => errors.push(`vsix: ${error.message}`));
  await vsix.goto(`${url}/test/visual/profileWorkspaceHarness.html?rightPane=debug&locale=en-US&persistState=1`);
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
  await vsix.getByRole('tab', { name: 'General tests', exact: true }).click();
  await vsix.getByRole('tablist', { name: 'Test sections' }).getByRole('tab', { name: 'Cases', exact: true }).click();
  await vsix.getByRole('checkbox', { name: /^Select case /u }).first().check();
  const actionRadius = await vsix.locator('.unified-test-workspace__run-actions').evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius));
  assert.ok(actionRadius <= 3, 'native action bars must use workbench-sized corners');
  await capture(vsix, 'vsix-selected-case-actions');
  await vsix.setViewportSize({ width: 760, height: 720 });
  const chatTab = vsix.getByRole('tab', { name: 'Chat', exact: true });
  await chatTab.click();
  assert.equal(await chatTab.getAttribute('aria-selected'), 'true');
  const narrowLayout = await vsix.evaluate(() => {
    const chat = document.querySelector('.preview-pane').getBoundingClientRect();
    const panel = document.querySelector('.right-pane-panel').getBoundingClientRect();
    return { sameTop: Math.abs(chat.top - panel.top) < 1, chatHeight: chat.height, panelVisibility: getComputedStyle(document.querySelector('.right-pane-panel')).visibility };
  });
  assert.equal(narrowLayout.sameTop, true, 'VS Code chat and workspace must share one grid area');
  assert.ok(narrowLayout.chatHeight > 600, 'chat must use the full narrow editor height');
  assert.equal(narrowLayout.panelVisibility, 'hidden');
  const messagesBefore = await vsix.locator('[data-message-id]').count();
  await vsix.getByRole('tab', { name: 'General tests', exact: true }).click();
  assert.equal(await vsix.locator('.preview-pane').evaluate((element) => getComputedStyle(element).visibility), 'hidden');
  await chatTab.click();
  assert.equal(await vsix.locator('[data-message-id]').count(), messagesBefore, 'narrow tab switching must retain chat');
  await vsix.getByRole('tab', { name: 'General tests', exact: true }).click();
  await vsix.waitForFunction(() => JSON.parse(sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').narrowView === 'pane');
  await vsix.reload();
  await vsix.getByRole('tab', { name: 'General tests', exact: true, selected: true }).waitFor();
  assert.equal(await vsix.locator('.preview-pane').evaluate((element) => getComputedStyle(element).visibility), 'hidden', 'reload must restore the workspace side');
  await vsix.getByRole('tab', { name: 'Chat', exact: true }).click();
  await vsix.getByRole('textbox', { name: 'Message', exact: true }).fill('Unfinished native draft');
  await vsix.waitForFunction(() => JSON.parse(sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').narrowView === 'chat');
  await vsix.reload();
  await vsix.getByRole('tab', { name: 'Chat', exact: true, selected: true }).waitFor();
  assert.equal(await vsix.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Unfinished native draft');
  await capture(vsix, 'vsix-narrow');
  for (const width of [425, 350]) {
    await vsix.setViewportSize({ width, height: 720 });
    const compactTabs = await vsix.evaluate(() => {
      const pane = document.querySelector('.debug-pane').getBoundingClientRect();
      const icon = document.querySelector('.right-pane-tab__icon').getBoundingClientRect();
      const configure = document.querySelector('#right-pane-configure-tab').getBoundingClientRect();
      return { firstInset: icon.left - pane.left, configureRight: configure.right, paneRight: pane.right };
    });
    assert.equal(compactTabs.firstInset, 16, 'the first compact tab must align with the 16px content inset');
    assert.ok(compactTabs.configureRight <= compactTabs.paneRight, `Configure must remain visible in ${width}px editors`);
    await capture(vsix, `vsix-compact-tabs-${width}`);
    await vsix.getByRole('tab', { name: 'Debug', exact: true }).click();
    const evidenceTabs = await vsix.getByRole('tablist', { name: 'Evidence views' }).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('[role="tab"]')].map((tab) => ({ label: tab.getAttribute('aria-label'), left: tab.getBoundingClientRect().left, right: tab.getBoundingClientRect().right, listLeft: bounds.left, listRight: bounds.right }));
    });
    assert.equal(evidenceTabs.length, 6);
    assert.deepEqual(evidenceTabs.filter((tab) => tab.left < tab.listLeft || tab.right > tab.listRight + 1), [], `all Debug tabs must fit in ${width}px editors`);
    await capture(vsix, `vsix-compact-debug-${width}`);
    await chatTab.click();
  }
  await vsix.close();

  assert.deepEqual(errors, [], 'No page errors');
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ passed: true, screenshots, selectAudit }, null, 2));
  console.log(JSON.stringify({ passed: true, screenshotCount: screenshots.length, auditedSelects: selectAudit.reduce((count, item) => count + item.count, 0), output }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
