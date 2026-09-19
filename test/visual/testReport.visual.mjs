/* global window */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts', 'test-reports');
await mkdir(output, { recursive: true });
const bundled = await build({ entryPoints: [resolve(root, 'src/shared/testReportHtml.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
const { renderTestReportHtml } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const require = createRequire(import.meta.url);
const browser = await chromium.launch({ headless: true, executablePath: require('node:fs').existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });

try {
  for (const kind of ['contract', 'adversarial']) {
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `${kind === 'contract' ? 'Conversation' : 'Prompt injection'} ${String(index + 1).padStart(2, '0')}`,
      profileId: 'sit-chat',
      outcome: kind === 'contract' ? (index % 5 === 0 ? 'failed' : index % 7 === 0 ? 'error' : 'passed') : (index % 5 === 0 ? 'attackSucceeded' : index % 7 === 0 ? 'indeterminate' : 'resisted'),
      durationMs: 240 + index * 330,
      requestedAttempts: 2, completedAttempts: 2,
      passedChecks: 4, failedChecks: index % 5 === 0 ? 1 : 0,
      findingCount: index % 5 === 0 ? 2 : 0,
      facts: index === 0 ? [{ label: 'Failed check', value: 'answer-contains-required-field' }] : [],
    }));
    const html = renderTestReportHtml({ kind, locale: 'zh-TW', generatedAt: '2026-09-14T12:00:00.000Z', runId: 'run-20260914-01', cases });
    const file = resolve(output, `${kind}.html`);
    await writeFile(file, html);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const remoteRequests = [];
    page.on('request', (request) => { if (!request.url().startsWith('file:')) remoteRequests.push(request.url()); });
    await page.goto(`file://${file}`);
    assert.equal(await page.locator('tbody tr').count(), 12);
    await page.getByRole('searchbox', { name: '搜尋案例' }).fill(cases[0].id);
    assert.equal(await page.locator('tbody tr:visible').count(), 1);
    await page.getByRole('button', { name: '清除篩選' }).click();
    assert.equal(await page.locator('tbody tr:visible').count(), 12);
    const failedOutcome = kind === 'contract' ? 'failed' : 'attackSucceeded';
    await page.locator('#report-outcome').selectOption(failedOutcome);
    assert.equal(await page.locator('tbody tr:visible').count(), 3);
    await page.getByRole('button', { name: '清除篩選' }).click();
    assert.equal(await page.locator('.segment').count() >= 2, true);
    assert.equal(await page.locator('.bars li').count(), 8);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, `${kind}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, `${kind}-mobile.png`), fullPage: true });
    assert.deepEqual(remoteRequests, []);
    await page.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`Report visuals: ${output}\n`);
