import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const artifactDirectory = resolve(root, 'artifacts', 'visual-regression');
const browserCandidates = [
  process.env.TURNSTAGE_CHROMIUM_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('Path outside visual-test root');
    response.setHeader('Content-Type', contentType(file));
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});

await mkdir(artifactDirectory, { recursive: true });
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const url = `http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html`;
  const waitForProfile = async () => {
    await page.locator('.profile-identity').waitFor();
    assert.equal(await page.getByText('Loading profile…').count(), 0, 'The recreated Webview must not remain on Loading profile…');
    assert.ok((await page.locator('.profile-identity').innerText()).includes('Slow SSE Visual Proof'));
    assert.ok(!(await page.locator('.profile-identity').innerText()).includes('.jsonc'));
  };

  await page.goto(url);
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, 'wide-dark.png'), fullPage: true });

  await page.reload();
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, 'rehydrated-after-reload.png'), fullPage: true });

  await page.setViewportSize({ width: 760, height: 900 });
  await page.reload();
  await waitForProfile();
  assert.equal(await page.locator('.profile-identity__meta').evaluate((element) => getComputedStyle(element).display), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Narrow layout must not overflow horizontally');
  await page.screenshot({ path: resolve(artifactDirectory, 'narrow-dark.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await waitForProfile();
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty('--vscode-editor-background', '#ffffff');
    style.setProperty('--vscode-editor-foreground', '#1f1f1f');
    style.setProperty('--vscode-descriptionForeground', '#616161');
    style.setProperty('--vscode-editorGroup-border', '#d4d4d4');
    style.setProperty('--vscode-editorGroup-emptyBackground', '#f3f3f3');
    document.body.className = 'vscode-light';
  });
  await page.screenshot({ path: resolve(artifactDirectory, 'wide-light.png'), fullPage: true });

  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: resolve(artifactDirectory, 'high-contrast.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });

  await page.setViewportSize({ width: 720, height: 450 });
  await page.reload();
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, '200-percent-equivalent.png'), fullPage: true });

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const activeElement = document.activeElement;
    return { tag: activeElement?.tagName, outline: activeElement ? getComputedStyle(activeElement).outlineStyle : 'none' };
  });
  assert.notEqual(focus.tag, 'BODY', 'Keyboard focus must enter the Webview');
  assert.notEqual(focus.outline, 'none', 'Keyboard focus must remain visibly outlined');

  console.log(JSON.stringify({ wide: true, rehydrated: true, narrow: true, light: true, highContrast: true, zoom200Equivalent: true, keyboardFocus: focus, artifacts: artifactDirectory }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose(undefined)));
}

function contentType(file) {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.ttf': return 'font/ttf';
    default: return 'application/octet-stream';
  }
}
