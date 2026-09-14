/* global window, fetch, Image */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const artifacts = resolve(root, 'artifacts', 'rich-content');
let webUrl = process.env.TURNSTAGE_WEB_BASE_URL;
let mockUrl = process.env.TURNSTAGE_MOCK_BASE_URL;
const executablePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const servers = [];
let mockChild;
const certDirectory = await mkdtemp(join(tmpdir(), 'turnstage-rich-tls-'));
await mkdir(artifacts, { recursive: true });
if (!mockUrl) {
  // The bundled Agent Flow environment intentionally points at port 8787.
  mockChild = spawn(process.execPath, [resolve(root, 'examples/mock-server/server.mjs')], { cwd: root, env: { ...process.env, TURNSTAGE_MOCK_PORT: '8787' }, stdio: ['ignore', 'pipe', 'pipe'] });
  mockUrl = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Mock server startup timed out')), 10000);
    mockChild.stdout.on('data', (chunk) => {
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(String(chunk));
      if (match) { clearTimeout(timer); done(match[1]); }
    });
    mockChild.once('error', fail);
    mockChild.once('exit', (code) => fail(new Error(`Mock server exited early (${code})`)));
  });
}
if (!webUrl) {
  const staticWeb = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const file = resolve(root, 'web-dist', `.${pathname === '/' ? '/index.html' : pathname}`);
      const webRoot = resolve(root, 'web-dist');
      if (!file.startsWith(`${webRoot}${sep}`)) throw new Error('Outside Web distribution');
      response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await listen(staticWeb); servers.push(staticWeb);
  webUrl = `http://127.0.0.1:${staticWeb.address().port}/`;
}
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const report = { web: {}, vsixWebview: {}, network: {} };

try {
  for (const [mode, label, heading] of [['rich-html', 'HTML response', 'HTML response'], ['rich-markdown', 'Markdown response', 'Markdown response'], ['rich-mixed', 'Mixed HTML + Markdown', 'Mixed response'], ['rich-complex', 'Complex HTML + Markdown', 'Complex response']]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requests = [];
    page.on('request', (request) => { if (request.url().startsWith(mockUrl)) requests.push(request.url()); });
    await page.goto(webUrl);
    await page.getByText('Agent Flow', { exact: true }).first().click();
    await page.locator('details.mobile-chat-preview__controls summary').click();
    await page.locator('#mobile-chat-preview-control-mode').selectOption({ label });
    await page.locator('details.mobile-chat-preview__controls summary').click();
    await page.locator('textarea').fill(`Show ${mode} content`);
    await page.locator('textarea').press('Enter');
    await page.getByRole('heading', { name: heading }).waitFor();
    await page.getByRole('img', { name: 'Mock image loaded' }).evaluate(async (image) => {
      if (!image.complete) await new Promise((done) => { image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true }); });
    });
    const image = await page.getByRole('img', { name: 'Mock image loaded' }).evaluate((element) => ({ width: element.naturalWidth, height: element.naturalHeight, referrerPolicy: element.referrerPolicy }));
    assert.deepEqual(image, { width: 240, height: 80, referrerPolicy: 'no-referrer' });
    assert.equal(await page.getByRole('table').count(), 1);
    if (mode === 'rich-html') assert.equal(await page.locator('.safe-markdown--rich br').count(), 1);
    if (mode === 'rich-mixed') {
      assert.equal(await page.getByText('Markdown bold').evaluate((element) => element.tagName), 'STRONG');
      assert.equal(await page.getByText('HTML bold').evaluate((element) => element.tagName), 'STRONG');
    }
    if (mode === 'rich-complex') {
      await page.getByRole('heading', { name: 'Complex response' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(artifacts, 'web-rich-complex-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 760, height: 720 });
      await page.evaluate(() => document.documentElement.style.setProperty('--vscode-font-size', '26px'));
      assert.equal(await page.locator('.safe-markdown--rich').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Complex Web response must fit narrow viewport and 200% text');
      assert.equal(await page.locator('.safe-markdown--rich table').evaluate((element) => element.scrollWidth > element.clientWidth), true, 'Complex Web table must scroll internally');
      assert.equal(await page.getByRole('img', { name: 'Mock image loaded' }).evaluate((element) => element.getBoundingClientRect().width <= element.parentElement.getBoundingClientRect().width + 1), true, 'Complex Web image must fit');
      await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'web-rich-complex-detail.png') });
    }
    assert.ok(requests.some((url) => url.includes('/agent/chat/stream')), 'Browser must call the mock stream');
    assert.ok(requests.some((url) => url.includes('/rich-content/image.svg')), 'Browser must request the remote image');
    await page.screenshot({ path: resolve(artifacts, `web-${mode}.png`), fullPage: true });
    report.web[mode] = { passed: true, image, streamRequested: true, screenshot: `web-${mode}.png` };
    await page.close();
  }

  const harness = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('Outside repository');
      response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await listen(harness); servers.push(harness);
  const harnessPort = harness.address().port;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${harnessPort}/test/visual/profileWorkspaceHarness.html`);
  await page.waitForFunction(() => Boolean(window.__turnstageHarness?.snapshot));
  await page.getByText('Here is the sample result.').waitFor();
  await page.evaluate((imageUrl) => {
    const snapshot = JSON.parse(JSON.stringify(window.__turnstageHarness.snapshot));
    const assistant = snapshot.messages.find((message) => message.role === 'assistant');
    assistant.parts = [{ type: 'markdown', text: `### VSIX Webview mixed response\n\n**Markdown** and <strong>HTML</strong>.<br>Next line\n\n<img src="${imageUrl}" alt="Mock image loaded">\n\n| Kind | Result |\n| --- | --- |\n| Mixed | Visible |` }];
    window.__turnstageHarness.dispatch({ type: 'session.snapshot', snapshot, runs: [], requestPreview: { method: 'POST', url: imageUrl }, networkEntries: [] });
  }, `${mockUrl}/rich-content/image.svg`);
  await page.getByRole('heading', { name: 'VSIX Webview mixed response' }).waitFor();
  const harnessImage = await page.getByRole('img', { name: 'Mock image loaded' }).evaluate(async (image) => {
    if (!image.complete) await new Promise((done) => { image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true }); });
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  assert.deepEqual(harnessImage, { width: 240, height: 80 });
  assert.equal(await page.getByRole('table').count(), 1);
  await page.screenshot({ path: resolve(artifacts, 'vsix-webview-mixed.png'), fullPage: true });
  report.vsixWebview = { passed: true, image: harnessImage, screenshot: 'vsix-webview-mixed.png', note: 'Shared VSIX Webview bundle in browser harness; Extension Host tested separately' };
  for (const [markdown, html, strongCount, literalHtml, literalMarkdown] of [[true, true, 2, false, false], [true, false, 1, true, false], [false, true, 1, false, true], [false, false, 0, true, true]]) {
    await page.evaluate(({ markdown, html }) => {
      const profile = JSON.parse(JSON.stringify(window.__turnstageHarness.profile));
      profile.ui.responseContent = { markdown, html };
      window.__turnstageHarness.dispatch({ type: 'profile.snapshot', profile, version: 1, environments: ['local'] });
    }, { markdown, html });
    await page.waitForFunction(({ expected }) => document.querySelectorAll('.mobile-chat-preview__text strong').length === expected, { expected: strongCount });
    const content = await page.locator('.mobile-chat-preview__text').last().innerText();
    assert.equal(content.includes('<strong>HTML</strong>'), literalHtml);
    assert.equal(content.includes('**Markdown**'), literalMarkdown);
  }
  await page.evaluate(() => window.__turnstageHarness.dispatch({ type: 'profile.snapshot', profile: JSON.parse(JSON.stringify(window.__turnstageHarness.profile)), version: 1, environments: ['local'] }));
  await page.waitForFunction(() => document.querySelectorAll('.mobile-chat-preview__text strong').length === 2);
  report.vsixWebview.profileFormats = 'default, Markdown only, HTML only and literal text checked';
  await page.setViewportSize({ width: 760, height: 720 });
  assert.equal(await page.locator('.safe-markdown--rich').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Rich content must not overflow a narrow editor');
  await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'vsix-webview-mixed-narrow.png') });
  await page.evaluate(() => {
    document.body.className = 'vscode-light';
    for (const [name, value] of Object.entries({ '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#1f1f1f', '--vscode-editorWidget-border': '#c8c8c8', '--vscode-focusBorder': '#005fb8' })) document.documentElement.style.setProperty(name, value);
  });
  await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'vsix-webview-mixed-light.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'vsix-webview-mixed-high-contrast.png') });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-font-size', '26px'));
  assert.equal(await page.locator('.safe-markdown--rich').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Rich content must not overflow at 200% text size');
  await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'vsix-webview-mixed-200-percent.png') });
  report.vsixWebview.responsiveAndThemes = 'narrow, light, high contrast and 200% checked';
  await page.evaluate((imageUrl) => {
    const snapshot = JSON.parse(JSON.stringify(window.__turnstageHarness.snapshot));
    const columns = Array.from({ length: 20 }, (_, index) => `<th>Column ${index}</th>`).join('');
    snapshot.messages.find((message) => message.role === 'assistant').parts = [{ type: 'markdown', text: `<h3>Complex response</h3><table><thead><tr>${columns}</tr></thead><tbody><tr><td colspan="20"><blockquote>Nested HTML</blockquote></td></tr></tbody></table><img src="${imageUrl}" width="3000" alt="Large mock image"><div>${'LONGVALUE'.repeat(80)}</div>` }];
    window.__turnstageHarness.dispatch({ type: 'session.snapshot', snapshot, runs: [], networkEntries: [] });
  }, `${mockUrl}/rich-content/image.svg`);
  await page.getByRole('heading', { name: 'Complex response' }).waitFor();
  assert.equal(await page.locator('.safe-markdown--rich').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Complex response must not overflow at 200% text size');
  assert.equal(await page.locator('.safe-markdown--rich table').evaluate((element) => element.scrollWidth > element.clientWidth), true, 'Wide tables should scroll within the response instead of wrapping headers one letter per line');
  assert.equal(await page.getByRole('img', { name: 'Large mock image' }).evaluate((element) => element.getBoundingClientRect().width <= element.parentElement.getBoundingClientRect().width + 1), true, 'Oversized image must fit the response width');
  await page.locator('.safe-markdown--rich').screenshot({ path: resolve(artifacts, 'vsix-webview-complex.png') });
  report.vsixWebview.complexContent = '20-column nested table, oversized image and long unbroken text checked at narrow width and 200%';
  await page.evaluate(() => {
    const snapshot = JSON.parse(JSON.stringify(window.__turnstageHarness.snapshot));
    snapshot.messages.find((message) => message.role === 'assistant').parts = [{ type: 'markdown', text: '<h3>Security check</h3><script>window.turnstagePwned=1</script><img src="javascript:alert(1)" onerror="window.turnstagePwned=2" alt="unsafe"><a href="javascript:alert(1)" onclick="window.turnstagePwned=3">unsafe link</a><iframe src="https://example.com"></iframe>' }];
    window.__turnstageHarness.dispatch({ type: 'session.snapshot', snapshot, runs: [], networkEntries: [] });
  });
  await page.getByRole('heading', { name: 'Security check' }).waitFor();
  assert.equal(await page.locator('.safe-markdown--rich script, .safe-markdown--rich iframe, .safe-markdown--rich [onclick], .safe-markdown--rich [onerror], .safe-markdown--rich a[href^="javascript"], .safe-markdown--rich img[src^="javascript"]').count(), 0);
  assert.equal(await page.evaluate(() => window.turnstagePwned), undefined);
  report.vsixWebview.unsafeHtmlBlocked = true;
  await page.close();

  const noCors = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); });
  await listen(noCors); servers.push(noCors);
  const noCorsUrl = `http://127.0.0.1:${noCors.address().port}/no-cors.svg`;
  const networkPage = await browser.newPage();
  await networkPage.goto(webUrl);
  const noCorsFetch = await networkPage.evaluate(async (url) => { try { await fetch(url); return 'unexpected-success'; } catch { return 'blocked'; } }, noCorsUrl);
  const noCorsImage = await networkPage.evaluate(async (url) => {
    const image = new Image(); image.src = url;
    await new Promise((done) => { image.onload = done; image.onerror = done; });
    return image.naturalWidth;
  }, noCorsUrl);
  assert.equal(noCorsFetch, 'blocked', 'Cross-origin fetch without CORS must fail');
  assert.equal(noCorsImage, 1, 'Cross-origin image display should not require CORS');
  report.network.cors = { apiFetchWithoutCors: noCorsFetch, imageWithoutCors: 'loaded' };

  const keyPath = join(certDirectory, 'key.pem');
  const certPath = join(certDirectory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const invalidTls = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => { response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); });
  await listen(invalidTls); servers.push(invalidTls);
  const invalidTlsUrl = `https://localhost:${invalidTls.address().port}/invalid-cert.svg`;
  const tlsFetch = await networkPage.evaluate(async (url) => { try { await fetch(url); return 'unexpected-success'; } catch { return 'blocked'; } }, invalidTlsUrl);
  const tlsImage = await networkPage.evaluate(async (url) => {
    const image = new Image(); image.src = url;
    await new Promise((done) => { image.onload = done; image.onerror = done; });
    return image.naturalWidth;
  }, invalidTlsUrl);
  assert.equal(tlsFetch, 'blocked', 'Browser must reject self-signed TLS for API calls');
  assert.equal(tlsImage, 0, 'Browser must reject self-signed TLS for images');
  report.network.tls = { apiFetchInvalidCertificate: tlsFetch, imageInvalidCertificate: 'blocked' };
  await networkPage.close();

  await writeFile(resolve(artifacts, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  if (mockChild && mockChild.exitCode === null) {
    mockChild.kill('SIGTERM');
    await new Promise((done) => mockChild.once('exit', done));
  }
  await rm(certDirectory, { recursive: true, force: true });
}

function listen(server) { return new Promise((done) => server.listen(0, '127.0.0.1', done)); }
