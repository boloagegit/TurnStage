// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichMarkdown } from '../src/webview/RichMarkdown';

describe('RichMarkdown', () => {
  afterEach(cleanup);

  it('renders HTML, Markdown, and mixed static content with tables, line breaks and images', () => {
    const { container } = render(<RichMarkdown text={'### Mixed\n\n**Markdown** plus <strong>HTML</strong>.<br>Next line\n\n<img src="https://example.com/image.png" alt="Example image">\n\n| A | B |\n| - | - |\n| one | two |'} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Mixed' })).toBeTruthy();
    expect(screen.getByText('Markdown').tagName).toBe('STRONG');
    expect(screen.getByText('HTML').tagName).toBe('STRONG');
    expect(container.querySelector('br')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Example image' }).getAttribute('src')).toBe('https://example.com/image.png');
    expect(screen.getByRole('img', { name: 'Example image' }).getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.getByRole('table')?.textContent).toContain('one');
  });

  it('does not execute scripts, handlers, embedded frames or CSS', () => {
    const { container } = render(<RichMarkdown text={'<script>window.pwned=1</script><style>body{display:none}</style><iframe src="https://example.com"></iframe><img src="javascript:alert(1)" onerror="window.pwned=2" alt="bad"><a href="javascript:alert(1)" onclick="window.pwned=3">unsafe</a><form><input name="secret"></form>'} />);
    expect(container.querySelector('script,style,iframe,form,input')).toBeNull();
    expect(container.querySelector('[onerror],[onclick]')).toBeNull();
    expect(container.querySelector('img[src^="javascript"]')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as Window & { pwned?: number }).pwned).toBeUndefined();
  });

  it('routes safe links and preserves copy-code behavior', async () => {
    const open = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    render(<RichMarkdown text={'[Docs](https://example.com)\n\n```json\n{"ok":true}\n```'} onOpenLink={open} onCopyCode={copy} />);
    fireEvent.click(screen.getByRole('link', { name: 'Docs' }));
    expect(open).toHaveBeenCalledWith('https://example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(copy).toHaveBeenCalledWith('{"ok":true}', 'json');
  });

  it('defaults both formats on and lets each format be disabled independently', () => {
    const source = '**Markdown** <strong>HTML</strong>';
    const defaultView = render(<RichMarkdown text={source} />);
    expect(defaultView.container.querySelectorAll('strong')).toHaveLength(2);
    defaultView.unmount();

    const markdownOnly = render(<RichMarkdown text={source} html={false} />);
    expect(markdownOnly.container.querySelectorAll('strong')).toHaveLength(1);
    expect(markdownOnly.container.textContent).toContain('<strong>HTML</strong>');
    markdownOnly.unmount();

    const htmlOnly = render(<RichMarkdown text={source} markdown={false} />);
    expect(htmlOnly.container.querySelectorAll('strong')).toHaveLength(1);
    expect(htmlOnly.container.textContent).toContain('**Markdown**');
    htmlOnly.unmount();

    const literal = render(<RichMarkdown text={source} markdown={false} html={false} />);
    expect(literal.container.querySelector('strong')).toBeNull();
    expect(literal.container.textContent).toBe(source);
  });

  it('renders complex static HTML while removing active content', () => {
    const columns = Array.from({ length: 16 }, (_, index) => `<th>Column ${index}</th>`).join('');
    const { container } = render(<RichMarkdown text={`<section><h2>Complex response</h2><table><thead><tr>${columns}</tr></thead><tbody><tr><td colspan="16"><blockquote><em>Nested emphasis</em></blockquote></td></tr></tbody></table><img src="https://example.com/large.png" width="3000" alt="Large image"><div>${'LONGVALUE'.repeat(1000)}</div><script>window.pwned=1</script></section>`} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Complex response' })).toBeTruthy();
    expect(screen.getByRole('table').querySelectorAll('th')).toHaveLength(16);
    expect(screen.getByText('Nested emphasis').tagName).toBe('EM');
    expect(screen.getByRole('img', { name: 'Large image' }).getAttribute('width')).toBe('3000');
    expect(container.querySelector('script')).toBeNull();
  });

  it('applies only profile-approved class styles and keeps incoming CSS inert', () => {
    const { container } = render(<RichMarkdown
      text={'<div class="notice unknown" style="position:fixed;background-image:url(https://bad.test/x)">Safe notice</div>'}
      classStyles={{ notice: { color: '#123456', padding: '12px', fontWeight: '700' } }}
    />);
    const notice = container.querySelector('.notice') as HTMLElement;
    expect(notice.classList.contains('unknown')).toBe(false);
    expect(getComputedStyle(notice).color).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(notice).padding).toBe('12px');
    expect(getComputedStyle(notice).fontWeight).toBe('700');
    expect(notice.style.position).toBe('');
    expect(notice.style.backgroundImage).toBe('');
  });

  it('scopes safe descendant, child, adjacent, and pseudo-class rules to one response', () => {
    const rules = {
      '.card > .title': { color: '#123456', fontWeight: '700' },
      '.card .detail': { padding: '8px' },
      '.item + .item': { marginBlock: '6px' },
      '.card:hover': { backgroundColor: '#eeeeee' },
    };
    const first = render(<RichMarkdown text={'<section class="card"><h3 class="title">Title</h3><p class="detail">Detail</p><p class="item">One</p><p class="item">Two</p></section>'} styleRules={rules} />);
    const title = first.container.querySelector('.title') as HTMLElement;
    const detail = first.container.querySelector('.detail') as HTMLElement;
    const items = first.container.querySelectorAll<HTMLElement>('.item');
    expect(title.className).toBe('title');
    expect(detail.className).toBe('detail');
    expect(items).toHaveLength(2);
    const styleSheet = first.container.querySelector('style')?.textContent ?? '';
    expect(styleSheet).toMatch(/^\[data-response-style-scope="response-[A-Za-z0-9_-]+"\]/u);
    expect(styleSheet).toContain('.card > .title{color:#123456;font-weight:700}');
    expect(styleSheet).toContain('.card .detail{padding:8px}');
    expect(styleSheet).toContain('.item + .item{margin-block:6px}');
    expect(styleSheet).toContain('.card:hover{background-color:#eeeeee}');
    first.unmount();

    const second = render(<RichMarkdown text={'<section class="card"><h3 class="title">Unstyled</h3></section>'} />);
    expect(second.container.querySelector('.card, .title')).toBeNull();
  });

  it('supports bounded structured-card layout properties and tag descendants', () => {
    const { container } = render(<RichMarkdown
      text={'<section class="card"><header class="header"><div class="body"><p>Intro</p><ul><li class="item">One</li></ul></div><div class="cover"><img src="/image.png" alt="Cover"></div></header></section>'}
      classStyles={{
        header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        cover: { flex: 'none', overflow: 'hidden', width: '80px', height: '80px', marginLeft: '12px' },
      }}
      styleRules={{
        '.body:has(p) ul': { paddingBottom: '20px' },
        '.body ul > li': { listStyle: 'disc', lineHeight: '2' },
        '.item:first-child': { marginTop: '0' },
        '.cover img': { maxWidth: '100%', maxHeight: '100%' },
      }}
    />);
    const sheet = container.querySelector('style')?.textContent ?? '';
    expect(sheet).toContain('.header{display:flex;justify-content:space-between;align-items:center}');
    expect(sheet).toContain('.body:has(p) ul{padding-bottom:20px}');
    expect(sheet).toContain('.body ul > li{list-style:disc;line-height:2}');
    expect(sheet).toContain('.cover img{max-width:100%;max-height:100%}');
    expect(container.querySelector('.body ul > li')).not.toBeNull();
    expect(container.querySelector('.body li')?.className).toBe('item');
  });
});
