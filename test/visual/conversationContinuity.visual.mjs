/* global localStorage, sessionStorage, window, requestAnimationFrame, performance, Event */
// Conversation drawer, server history check, and visual continuity in TurnStage Web.
// Run after `npm run web:build`: node test/visual/conversationContinuity.visual.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'conversation-continuity');
await mkdir(output, { recursive: true });

const mock = spawn(process.execPath, [resolve(root, 'examples/mock-server/server.mjs')], { env: { ...process.env, TURNSTAGE_MOCK_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const mockUrl = await new Promise((done, fail) => {
  let text = '';
  const timer = setTimeout(() => fail(new Error('mock server did not start')), 5000);
  mock.stdout.on('data', (chunk) => { text += chunk; const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(text); if (match) { clearTimeout(timer); done(match[1]); } });
});
const streamRequests = [];
const server = createServer(async (request, response) => {
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
  version: 1, id: 'conversation-qa', name: 'Conversation QA',
  controls: [{ id: 'mode', type: 'select', label: 'Mock Scenario', default: 'normal', options: [{ label: 'Normal', value: 'normal' }, { label: 'Server rewrites saved answer', value: 'history-rewrite' }] }],
  opening: { mode: 'static', message: 'Hello, ask about a refund.', starters: [] },
  conversation: { send: { method: 'POST', url: `${mockUrl}/basic/chat/stream`, headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, variants: [
    { id: 'first', when: { path: 'conversation.id', operator: 'notExists' }, body: { mode: { $value: 'controls.mode' }, message: { $value: 'input.text' } } },
    { id: 'next', when: { path: 'conversation.id', operator: 'exists' }, body: { mode: { $value: 'controls.mode' }, message: { $value: 'input.text' }, conversationId: { $value: 'conversation.id' } } },
  ] } },
  conversations: {
    list: { request: { method: 'GET', url: `${mockUrl}/conversations` }, response: { itemsPath: '$.data', updatedAtPath: 'updated_at' } },
    history: { request: { method: 'GET', url: `${mockUrl}/conversations/\${conversation.id}/messages` } },
  },
  stream: { transport: 'sse', dataFormat: 'json', unexpectedEndPolicy: 'fail', mappings: [
    { id: 'start', match: { event: 'start' }, emit: { type: 'conversation.started', conversationId: { path: '$.conversationId' }, assistantMessageId: { path: '$.assistantMessageId' } } },
    { id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
    { id: 'title', match: { event: 'title' }, emit: { type: 'conversation.title.updated', title: { path: '$.title' } } },
    { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } },
  ] },
  tests: { scenarios: [{ id: 'refund', name: 'Refund question', steps: [{ id: 'one', input: 'Where is my refund?' }] }] },
};

const executablePath = process.env.TURNSTAGE_CHROMIUM_EXECUTABLE === 'bundled' ? undefined : [process.env.TURNSTAGE_CHROMIUM_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(existsSync);
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const report = { screenshots: [] };
const pageErrors = [];
const dialogs = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  // Records layout state on every animation frame from the first paint on.
  await context.addInitScript(() => {
    const frames = [];
    window.__frames = frames;
    window.__sample = true;
    const tick = () => {
      if (window.__sample) {
        const rootElement = document.getElementById('root');
        const body = document.body;
        const visibleViews = [...document.querySelectorAll('.right-pane-view')].filter((element) => getComputedStyle(element).display !== 'none');
        frames.push({
          t: performance.now(),
          rootChildren: rootElement ? rootElement.children.length : -1,
          background: body ? getComputedStyle(body).backgroundColor : 'none',
          panes: document.querySelector('.right-pane-panel') ? visibleViews.length : -1,
          skeleton: Boolean(document.querySelector('.app-skeleton, .boot-main')),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await context.addInitScript((value) => {
    if (sessionStorage.getItem('qa-seeded')) return;
    sessionStorage.setItem('qa-seeded', '1');
    localStorage.setItem('turnstage.web.profiles.v1', JSON.stringify([{ id: value.id, name: value.name, raw: JSON.stringify(value), updatedAt: Date.now() }]));
    localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, locale: 'en', theme: 'dark', activeProfileId: value.id }));
  }, profile);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  page.on('request', (request) => { if (request.url().endsWith('/basic/chat/stream')) streamRequests.push(request.url()); });
  const drawerOnTop = () => page.evaluate(() => {
    const drawer = document.querySelector('.conversation-drawer');
    if (!drawer) return false;
    const box = drawer.getBoundingClientRect();
    return [[0.5, 0.2], [0.5, 0.5], [0.5, 0.85]].every(([x, y]) => drawer.contains(document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)));
  });
  // Every left text/card edge in the drawer sits on one 12px inset line.
  const drawerEdges = (selectors) => page.evaluate((list) => {
    const drawer = document.querySelector('.conversation-drawer').getBoundingClientRect();
    const textLeft = (element) => { const range = document.createRange(); range.selectNodeContents(element); const rect = [...range.getClientRects()][0] ?? element.getBoundingClientRect(); return rect.left; };
    return Object.fromEntries(list.map(([name, selector, mode]) => { const element = document.querySelector(selector); return [name, element ? Math.round((mode === 'text' ? textLeft(element) : element.getBoundingClientRect().left) - drawer.left) : null]; }));
  }, selectors);
  const drawerRightEdges = () => page.evaluate(() => {
    const drawer = document.querySelector('.conversation-drawer').getBoundingClientRect();
    return Object.fromEntries([['close', '.conversation-drawer__header .icon-button'], ['new', '.conversation-drawer__new'], ['row', '.conversation-row__time'], ['refresh', '.conversation-drawer__footer .icon-button']].map(([name, selector]) => { const element = document.querySelector(selector); return [name, element ? Math.round(drawer.right - element.getBoundingClientRect().right) : null]; }));
  });
  const assertAligned = (edges, label) => { const values = Object.values(edges).filter((value) => value !== null); assert.ok(values.length > 2, `${label}: nothing measured`); assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${label}: misaligned ${JSON.stringify(edges)}`); report[`${label}Edges`] = edges; };
  const shot = async (name) => { await page.waitForTimeout(250); if (await page.locator('.conversation-drawer').count()) assert.equal(await drawerOnTop(), true, `${name}: the drawer is covered by the chat`); await page.screenshot({ path: resolve(output, `${name}.png`) }); report.screenshots.push(`${name}.png`); };

  // First load: no frame without a painted shell, and never a white frame in the dark theme.
  await page.goto(url);
  await page.getByRole('button', { name: 'Conversations' }).waitFor();
  const loadFrames = await page.evaluate(() => window.__frames.splice(0));
  assert.ok(loadFrames.length > 0, 'no frames sampled');
  assert.equal(loadFrames.filter((frame) => frame.rootChildren === 0).length, 0, 'a frame showed an empty app root');
  assert.equal(loadFrames.filter((frame) => frame.background === 'rgb(255, 255, 255)').length, 0, 'a frame flashed white');
  report.firstLoad = { frames: loadFrames.length, skeletonFrames: loadFrames.filter((frame) => frame.skeleton).length };

  // Turn 1 matches the server copy.
  const composer = page.getByRole('textbox', { name: /message/iu }).first();
  await composer.fill('Where is my refund?');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Matches server copy' }).waitFor();
  await shot('01-check-matches');

  // Turn 2 in rewrite mode reports a difference with a diff.
  assert.equal(await page.getByText(/configuration issue/u).count(), 0, 'the QA Profile has configuration issues');
  const modeSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Server rewrites saved answer' }) }).first();
  await page.getByText('Session controls').click();
  await modeSelect.selectOption({ label: 'Server rewrites saved answer' });
  await composer.fill('And the second step?');
  await composer.press('Enter');
  const differs = page.getByRole('button', { name: '1 differs from server' });
  await differs.waitFor();
  await page.setViewportSize({ width: 420, height: 900 });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const differenceCount = await page.locator('.mobile-chat-preview__history-check-count').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const button = element.closest('button').getBoundingClientRect();
    const style = getComputedStyle(element);
    return { text: element.textContent, width: bounds.width, height: bounds.height, clipPath: style.clipPath, insideButton: bounds.left >= button.left && bounds.right <= button.right };
  });
  assert.equal(differenceCount.text, '1');
  assert.ok(differenceCount.width > 1 && differenceCount.height > 1, 'compact toolbar must paint the difference count at readable dimensions');
  assert.equal(differenceCount.clipPath, 'none', 'compact difference count must not inherit hidden-label clipping');
  assert.equal(differenceCount.insideButton, true);
  await shot('02-compact-difference-count');
  await page.setViewportSize({ width: 1440, height: 900 });
  await differs.click();
  await page.getByRole('tab', { name: /History check/u, selected: true }).waitFor();
  assert.equal(await page.locator('.history-check-row__diff del').first().textContent(), 'sample');
  assert.equal(await page.locator('.history-check-row__diff ins').first().textContent(), 'rewritten');
  await page.waitForTimeout(250);
  assertAligned(await drawerEdges([['views', '.conversation-drawer__views', 'box'], ['summary', '.history-check__summary', 'box'], ['hint', '.history-check__hint', 'text'], ['results', '.history-check__results', 'box']]), 'checkView');
  await shot('02-check-diff');

  // The drawer lists the conversation; New conversation keeps it without a confirmation.
  await page.getByRole('tab', { name: 'Conversations' }).click();
  await page.getByRole('button', { name: 'New conversation' }).first().click();
  assert.deepEqual(dialogs, [], 'new conversation asked for confirmation');
  await modeSelect.selectOption({ label: 'Normal' });
  await composer.fill('A different topic');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Matches server copy' }).waitFor();
  const drawer = page.getByRole('region', { name: 'Conversations' });
  if (!await drawer.isVisible()) await page.getByRole('button', { name: 'Conversations' }).click();
  // Both conversations are titled by the server ("Sample conversation"); the earlier one is not current.
  const earlier = drawer.locator('.conversation-row:not(.conversation-row--current) .conversation-row__open').first();
  await earlier.waitFor();
  assert.equal(await drawer.locator('.conversation-row').count(), 2, 'server list duplicated an archived conversation');
  await page.waitForTimeout(250);
  assertAligned(await drawerEdges([['views', '.conversation-drawer__views', 'box'], ['search', '.conversation-drawer__search', 'box'], ['group', '.conversation-drawer__group h3', 'text'], ['title', '.conversation-row__title', 'text'], ['footer', '.conversation-drawer__footer > span', 'text']]), 'listView');
  assertAligned(await drawerRightEdges(), 'listViewRight');
  await shot('03-drawer');
  const requestsBeforeSwitch = streamRequests.length;
  await earlier.click();
  await page.locator('[data-message-id]').filter({ hasText: 'And the second step?' }).waitFor();
  assert.equal(streamRequests.length, requestsBeforeSwitch, 'switching conversations sent a chat request');

  // Tab switches keep the view mounted: the search text survives and no frame is empty.
  await page.getByRole('button', { name: 'Close conversations' }).click();
  await page.getByRole('tab', { name: 'General tests', exact: true }).click();
  await page.getByRole('tab', { name: 'Cases', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search cases', exact: true });
  await search.fill('refund');
  await page.evaluate(() => { window.__frames.splice(0); });
  for (const tab of ['Debug', 'Configure', 'General tests', 'Red Team', 'General tests', 'Debug', 'General tests']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.waitForTimeout(60);
  }
  const switchFrames = await page.evaluate(() => window.__frames.splice(0));
  assert.equal(await search.inputValue(), 'refund', 'the case search was reset by a tab switch');
  assert.equal(switchFrames.filter((frame) => frame.panes === 0).length, 0, 'a frame showed an empty right pane');
  assert.equal(switchFrames.filter((frame) => frame.panes > 1).length, 0, 'two right-pane views were visible at once');
  report.tabSwitch = { frames: switchFrames.length };
  await shot('04-tests-after-switches');

  // General tests and Red Team retain separate mounted content and keyboard targets.
  await page.getByRole('tab', { name: 'Red Team', exact: true }).click();
  const redCases = page.getByRole('tab', { name: 'Cases', exact: true });
  await redCases.focus();
  await redCases.press('ArrowRight');
  await page.getByRole('tab', { name: 'Results', exact: true, selected: true }).waitFor();
  // Selection commits before the next animation frame moves keyboard focus.
  await page.waitForFunction(() => document.activeElement?.id === 'unified-test-adversarial-results-tab');
  assert.equal(await page.getByRole('tab', { name: 'Results', exact: true }).evaluate((element) => element === document.activeElement), true, 'Red Team keyboard navigation focused the hidden General tests pane');
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.right-pane-panel [id]')].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(duplicateIds, [], 'retained test panes must not duplicate accessibility IDs');
  await page.getByRole('tab', { name: 'General tests', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Cases', exact: true }).getAttribute('aria-selected'), 'true', 'Red Team changed the General tests section');
  assert.equal(await search.inputValue(), 'refund');

  // A nonzero Configure scroll position survives visits to all three other panes.
  await page.getByRole('tab', { name: 'Configure', exact: true }).click();
  const settings = page.locator('#settings-content');
  const scrollTop = await settings.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); return element.scrollTop; });
  assert.ok(scrollTop > 0, 'the scroll regression needs overflowing settings content');
  for (const tab of ['Debug', 'General tests', 'Red Team', 'Configure']) await page.getByRole('tab', { name: tab, exact: true }).click();
  assert.equal(await settings.evaluate((element) => element.scrollTop), scrollTop, 'Configure lost its scroll position');
  report.configureScrollTop = scrollTop;
  await page.getByRole('tab', { name: 'General tests', exact: true }).click();

  // Reload: the archive (IndexedDB) and the open tab (sessionStorage) come back.
  await page.reload();
  await page.getByRole('button', { name: 'Conversations' }).waitFor();
  const reloadFrames = await page.evaluate(() => window.__frames.splice(0));
  assert.equal(reloadFrames.filter((frame) => frame.rootChildren === 0).length, 0, 'reload showed an empty app root');
  assert.equal(reloadFrames.filter((frame) => frame.background === 'rgb(255, 255, 255)').length, 0, 'reload flashed white');
  assert.equal(await page.getByRole('tab', { name: 'General tests', exact: true }).getAttribute('aria-selected'), 'true', 'reload lost the open tab');
  await page.getByRole('button', { name: 'Conversations' }).click();
  assert.equal(await page.getByRole('region', { name: 'Conversations' }).locator('.conversation-row').count(), 2, 'the archive did not survive a reload');
  await shot('05-after-reload');

  // Reduced motion removes the view fade.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.right-pane-view').first().evaluate((element) => getComputedStyle(element).animationName), 'none');

  // Narrow and light layouts keep the drawer inside the viewport.
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 820, height: 900 });
  // Narrow workspaces switch between Chat and the workspace with tabs instead of stacking them, in Web as in VS Code.
  const chatTab = page.getByRole('tab', { name: 'Chat', exact: true });
  await chatTab.click();
  assert.equal(await chatTab.getAttribute('aria-selected'), 'true');
  const narrowLayout = await page.evaluate(() => {
    const chat = document.querySelector('.preview-pane').getBoundingClientRect();
    const panel = document.querySelector('.right-pane-panel').getBoundingClientRect();
    return { sameTop: Math.abs(chat.top - panel.top) < 1, chatHeight: chat.height, panelVisibility: getComputedStyle(document.querySelector('.right-pane-panel')).visibility, host: document.documentElement.dataset.host };
  });
  assert.equal(narrowLayout.host, 'web');
  assert.equal(narrowLayout.sameTop, true, 'chat and workspace are stacked instead of sharing one area');
  assert.ok(narrowLayout.chatHeight > 600, 'chat does not use the full narrow height');
  assert.equal(narrowLayout.panelVisibility, 'hidden');
  report.webNarrowLayout = narrowLayout;
  const messagesBefore = await page.locator('[data-message-id]').count();
  await page.getByRole('tab', { name: 'General tests', exact: true }).click();
  assert.equal(await page.locator('.preview-pane').evaluate((element) => getComputedStyle(element).visibility), 'hidden');
  await chatTab.click();
  assert.equal(await page.locator('[data-message-id]').count(), messagesBefore, 'chat remounted when switching narrow tabs');
  if (!await page.getByRole('region', { name: 'Conversations' }).isVisible()) await page.locator('.mobile-chat-preview__conversations').click();
  const box = await page.getByRole('region', { name: 'Conversations' }).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 820, 'drawer overflows a narrow viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'page overflows horizontally');
  await shot('06-narrow');
  assert.deepEqual(pageErrors, []);
  report.streamRequests = streamRequests.length;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
  mock.kill('SIGTERM');
}
