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
    const cases = Array.from({ length: 100 }, (_, index) => ({
      id: `${kind === 'contract' ? 'Conversation' : 'Prompt injection'} ${String(index + 1).padStart(2, '0')}`,
      profileId: 'sit-chat',
      outcome: kind === 'contract' ? (index % 5 === 0 ? 'failed' : index % 7 === 0 ? 'error' : 'passed') : (index % 5 === 0 ? 'attackSucceeded' : index % 7 === 0 ? 'indeterminate' : 'resisted'),
      durationMs: 240 + index * 330,
      requestedAttempts: 2, completedAttempts: 2,
      stability: kind === 'adversarial' ? (index % 5 === 0 ? 'stable-fail' : index % 7 === 0 ? 'inconclusive' : 'stable-pass') : undefined,
      passedChecks: 4, failedChecks: index % 5 === 0 ? 1 : 0,
      findingCount: index % 5 === 0 ? 2 : 0,
      facts: index === 0 ? [{ label: 'Failed check', value: 'answer-contains-required-field' }] : [],
      timeline: index === 0 ? [{ elapsedMs: 0, label: '送出請求' }, { elapsedMs: 118, label: '收到第一個事件' }, { elapsedMs: 246, label: '產生第一段回應' }, { elapsedMs: 570, label: '執行完成' }] : [],
      evidence: index === 0 ? {
        metrics: { headersLatency: 92, firstChunkLatency: 118, firstEventLatency: 118, ttft: 246, totalDuration: 570, eventCount: 4, byteCount: 1842 },
        steps: [{ id: 'first-turn', name: '詢問信用卡申請方式', input: '我想申請信用卡，需要準備什麼？', durationMs: 570, checks: [
          { id: 'turn-completed', label: '對話正常完成', passed: true, kind: 'assertion', expected: 'completed', actual: 'completed' },
          { id: 'contains-required-documents', label: '回應包含必要文件', passed: false, kind: 'assertion', expected: ['身分證', '財力證明'], actual: ['身分證'] },
        ] }],
        messages: [
          { role: 'user', status: 'completed', parts: [{ type: 'text', text: '我想申請信用卡，需要準備什麼？' }] },
          { role: 'assistant', status: 'completed', timing: { ttft: 246, totalDuration: 570 }, parts: [{ type: 'markdown', text: '請先準備 **身分證**，並確認申請資格。' }] },
        ],
        requests: [{ kind: 'stream', method: 'POST', url: 'https://api.example.test/chat/stream', state: 'completed', status: 200, requestHeaders: { authorization: 'Bearer ••••••••', 'content-type': 'application/json' }, requestBody: { message: '我想申請信用卡，需要準備什麼？' }, responseHeaders: { 'content-type': 'text/event-stream' }, responseBody: 'event: message\\ndata: {"text":"請先準備身分證"}', timing: { headers: 92, firstChunk: 118, total: 570 }, transferredBytes: 1842, eventCount: 4 }],
        rawEvents: [{ sequence: 1, protocol: 'sse', elapsedMs: 118, event: 'message', data: { text: '請先準備身分證' }, raw: 'event: message\\ndata: {"text":"請先準備身分證"}' }, { sequence: 2, protocol: 'sse', elapsedMs: 570, event: 'done', data: {}, raw: 'event: done\\ndata: {}' }],
        normalizedEvents: [{ version: 1, sequence: 1, type: 'content.markdown.delta', text: '請先準備身分證' }, { version: 1, sequence: 2, type: 'stream.completed' }],
        errors: index % 5 === 0 ? [{ type: 'AssertionError', message: '回應缺少財力證明' }] : [],
      } : undefined,
    }));
    const html = renderTestReportHtml({ kind, locale: 'zh-TW', generatedAt: '2026-09-14T12:00:00.000Z', runId: 'run-20260914-01', cases });
    const file = resolve(output, `${kind}.html`);
    await writeFile(file, html);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const remoteRequests = [];
    page.on('request', (request) => { if (!request.url().startsWith('file:')) remoteRequests.push(request.url()); });
    await page.goto(`file://${file}`);
    assert.equal(await page.locator('[data-report-case]').count(), 100);
    await page.getByRole('searchbox', { name: '搜尋案例' }).fill(cases[0].id);
    assert.equal(await page.locator('[data-report-case]:visible').count(), 1);
    await page.getByRole('button', { name: '清除篩選' }).click();
    assert.equal(await page.locator('[data-report-case]:visible').count(), 25);
    await page.getByRole('button', { name: '下一頁' }).click();
    assert.equal(await page.locator('[data-report-case]:visible').first().getByText(/26$/u).count(), 1);
    await page.getByRole('button', { name: '上一頁' }).click();
    const detailToggle = page.locator('[data-report-case]').first().getByRole('button', { name: '完整明細' });
    await detailToggle.focus();
    await detailToggle.press('Enter');
    assert.equal(await page.locator('[data-report-details]:visible').getByText('時間與指標', { exact: true }).count(), 1);
    const failedOutcome = kind === 'contract' ? 'failed' : 'attackSucceeded';
    await page.locator('#report-outcome').selectOption(failedOutcome);
    assert.equal(await page.locator('[data-report-case]:visible').count(), 20);
    await page.getByRole('button', { name: '清除篩選' }).click();
    assert.equal(await page.locator('.segment').count() >= 2, true);
    assert.equal(await page.locator('.bars li').count(), 8);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, `${kind}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.locator('[data-report-case]:visible').first().locator('td:visible').count(), 4);
    await page.screenshot({ path: resolve(output, `${kind}-mobile.png`), fullPage: true });
    await page.screenshot({ path: resolve(output, `${kind}-mobile-viewport.png`), fullPage: false });
    await page.setViewportSize({ width: 320, height: 720 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('[data-report-details]').first().evaluate((element) => getComputedStyle(element).display !== 'none'), true);
    assert.equal(await page.locator('.evidence-section').first().evaluate((element) => getComputedStyle(element).display !== 'none'), true);
    assert.deepEqual(remoteRequests, []);
    await page.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(`Report visuals: ${output}\n`);
