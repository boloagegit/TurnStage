// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTestReportHtml } from '../src/shared/testReportHtml';

describe('offline HTML test report', () => {
  it('shows accessible charts, complete details, and local-only report controls', () => {
    const html = renderTestReportHtml({
      kind: 'contract', locale: 'zh-TW', generatedAt: '2026-09-14T12:00:00.000Z',
      cases: [
        { id: '快測', outcome: 'passed', durationMs: 120, passedChecks: 3, failedChecks: 0 },
        { id: '<img src=x onerror=alert(1)>', outcome: 'failed', durationMs: 2300, passedChecks: 1, failedChecks: 1,
          facts: Array.from({ length: 24 }, (_, index) => ({ label: `Failed check ${index}`, value: index ? `detail ${index}` : '<script>alert(1)</script>' })),
          timeline: Array.from({ length: 18 }, (_, index) => ({ elapsedMs: 30 + index, label: `event ${index} & detail` })) },
      ],
    });
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe('一般測試報告');
    expect(document.querySelector('.distribution')?.getAttribute('role')).toBe('img');
    expect(document.querySelectorAll('.segment')).toHaveLength(2);
    expect(document.querySelectorAll('.bars li')).toHaveLength(2);
    expect(document.querySelectorAll('[data-report-case]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-report-case]')[1]?.querySelector('th')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelectorAll('.case-detail-summary div')).toHaveLength(24);
    expect(document.querySelectorAll('.case-detail-panel ol li')).toHaveLength(18);
    expect(document.querySelector('input[type="search"]')).toBeTruthy();
    expect(document.querySelector('select#report-outcome')).toBeTruthy();
    expect(document.querySelector('#report-failures')).toBeTruthy();
    expect(document.querySelector('#report-page-size')).toBeTruthy();
    expect(document.querySelector('.performance-summary')?.textContent).toContain('成功率');
    expect(document.querySelector('script')?.getAttribute('nonce')).toBe('turnstage-report');
    expect(document.querySelector('link')).toBeNull();
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'nonce-turnstage-report'");
    expect(document.querySelector('style')?.textContent).toContain('@media(max-width:520px)');
    expect(document.querySelector('style')?.textContent).toContain('@media print');
    expect(document.querySelectorAll('body style')).toHaveLength(0);
    expect(html).toContain('.detail-row[hidden]{display:table-row!important}');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('onerror=alert(1)>');
  });

  it('keeps red-team outcome labels distinct and handles an empty report', () => {
    const html = renderTestReportHtml({ kind: 'adversarial', locale: 'ja', generatedAt: '2026-09-14T12:00:00.000Z', cases: [
      { id: 'probe-1', outcome: 'resisted', durationMs: 900, findingCount: 0 },
      { id: 'probe-2', outcome: 'attackSucceeded', durationMs: 1700, findingCount: 2, stability: 'unstable' },
    ] });
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe('レッドチームテストレポート');
    expect(document.querySelector('.distribution')?.getAttribute('aria-label')).toContain('攻撃成功 1');
    expect(document.querySelector('thead')?.textContent).toContain('検出');
    expect(document.querySelectorAll('[data-report-case]')).toHaveLength(2);
    expect(document.querySelector('.performance-summary')?.textContent).toContain('不安定');

    const empty = new DOMParser().parseFromString(renderTestReportHtml({ kind: 'contract', generatedAt: 'invalid', cases: [] }), 'text/html');
    expect(empty.querySelector('tbody')).toBeNull();
    expect(empty.querySelector('.empty')?.textContent).toBe('No measured duration available');
  });

  it('renders timing, step assertions, conversation, requests, and both event forms', () => {
    const html = renderTestReportHtml({ kind: 'contract', locale: 'zh-TW', generatedAt: '2026-09-19T00:00:00.000Z', cases: [{
      id: '詳細案例', outcome: 'failed', durationMs: 640,
      evidence: {
        metrics: { ttft: 120, totalDuration: 640 },
        steps: [{ id: 'step-1', name: '第一步', input: '使用者輸入', durationMs: 640, checks: [{ id: 'check-1', label: '狀態檢查', passed: false, kind: 'assertion', expected: 'completed', actual: 'failed' }] }],
        messages: [{ role: 'assistant', status: 'completed', parts: [{ type: 'markdown', text: '**結果**' }] }],
        requests: [{ kind: 'stream', method: 'POST', url: 'https://example.test/chat', state: 'completed', status: 200, requestHeaders: { authorization: '••••••••' }, requestBody: { message: '使用者輸入' }, responseBody: 'data: done', timing: { total: 640 }, transferredBytes: 9, eventCount: 1 }],
        rawEvents: [{ sequence: 1, raw: 'data: done' }],
        normalizedEvents: [{ sequence: 1, type: 'stream.completed' }],
        errors: [{ type: 'AssertionError', message: '狀態不同' }],
      },
    }] });
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('.evidence-grid')?.textContent).toContain('時間與指標');
    expect(document.querySelector('.evidence-grid')?.textContent).toContain('使用者輸入');
    expect(document.querySelector('.evidence-grid')?.textContent).toContain('completed');
    expect(document.querySelector('.evidence-grid')?.textContent).toContain('failed');
    expect(document.querySelectorAll('.evidence-section')).toHaveLength(7);
  });
});
