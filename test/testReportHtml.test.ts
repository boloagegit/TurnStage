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
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(document.querySelector('tbody tr:last-child th')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelectorAll('details dl div')).toHaveLength(24);
    expect(document.querySelectorAll('details ol li')).toHaveLength(18);
    expect(document.querySelector('input[type="search"]')).toBeTruthy();
    expect(document.querySelector('select#report-outcome')).toBeTruthy();
    expect(document.querySelector('script')?.getAttribute('nonce')).toBe('turnstage-report');
    expect(document.querySelector('link')).toBeNull();
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'nonce-turnstage-report'");
    expect(document.querySelector('style')?.textContent).toContain('@media(max-width:520px)');
    expect(document.querySelector('style')?.textContent).toContain('@media print');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('onerror=alert(1)>');
  });

  it('keeps red-team outcome labels distinct and handles an empty report', () => {
    const html = renderTestReportHtml({ kind: 'adversarial', locale: 'ja', generatedAt: '2026-09-14T12:00:00.000Z', cases: [
      { id: 'probe-1', outcome: 'resisted', durationMs: 900, findingCount: 0 },
      { id: 'probe-2', outcome: 'attackSucceeded', durationMs: 1700, findingCount: 2 },
    ] });
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe('レッドチームテストレポート');
    expect(document.querySelector('.distribution')?.getAttribute('aria-label')).toContain('攻撃成功 1');
    expect(document.querySelector('thead')?.textContent).toContain('検出');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);

    const empty = new DOMParser().parseFromString(renderTestReportHtml({ kind: 'contract', generatedAt: 'invalid', cases: [] }), 'text/html');
    expect(empty.querySelector('tbody')).toBeNull();
    expect(empty.querySelector('.empty')?.textContent).toBe('No measured duration available');
  });
});
