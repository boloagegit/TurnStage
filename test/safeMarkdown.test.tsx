// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MARKDOWN_LINES, SafeMarkdown, parseSafeMarkdown, sanitizeMarkdownHref } from '../src/webview/SafeMarkdown';

describe('SafeMarkdown', () => {
  afterEach(() => cleanup());

  it('renders the supported block and inline Markdown subset', () => {
    render(<SafeMarkdown text={'# Heading\n\nA **strong** and *emphasized* `value` with [docs](https://example.com "Docs").\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```ts\nconst answer = 42;\n```'} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('strong').tagName).toBe('STRONG');
    expect(screen.getByText('emphasized').tagName).toBe('EM');
    expect(screen.getByText('value').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.getAllByRole('list')[0]?.tagName).toBe('UL');
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(screen.getByRole('blockquote').textContent).toContain('quoted');
    expect(screen.getByText('const answer = 42;').closest('code')?.className).toBe('language-ts');
  });

  it('renders unsafe links as label text without an anchor', () => {
    render(<SafeMarkdown text={'[javascript](javascript:alert(1)) [data](data:text/html,hi) [command](command:rm) [safe](mailto:test@example.com) [relative](./guide#intro)'} />);

    expect(screen.queryByRole('link', { name: 'javascript' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'data' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'command' })).toBeNull();
    expect(screen.getByRole('link', { name: 'safe' }).getAttribute('href')).toBe('mailto:test@example.com');
    expect(screen.getByRole('link', { name: 'relative' }).getAttribute('href')).toBe('./guide#intro');
    expect(screen.queryByRole('link', { name: /alert/ })).toBeNull();
  });

  it('escapes plain text and does not create HTML elements from model output', () => {
    const { container } = render(<SafeMarkdown text={'<script>alert(1)</script> & plain text'} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script> & plain text');
  });

  it('copies code through the optional callback and announces completion', async () => {
    const onCopyCode = vi.fn().mockResolvedValue(undefined);
    render(<SafeMarkdown text={'```json\n{"ok":true}\n```'} onCopyCode={onCopyCode} />);

    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    fireEvent.click(copyButton);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(onCopyCode).toHaveBeenCalledWith('{"ok":true}', 'json');
  });

  it('bounds line processing and keeps parser output finite for pathological input', () => {
    const input = Array.from({ length: MAX_MARKDOWN_LINES + 500 }, (_, index) => `line ${index}`).join('\n');
    const blocks = parseSafeMarkdown(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect((blocks[0] as { text: string }).text.split('\n')).toHaveLength(MAX_MARKDOWN_LINES);
  });
});

describe('sanitizeMarkdownHref', () => {
  it.each(['http://example.com', 'https://example.com', 'mailto:test@example.com', '#section', '/docs/guide', '../guide', '?q=one'])('allows %s', (href) => {
    expect(sanitizeMarkdownHref(href)).toBe(href);
  });

  it.each(['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'command:rm -rf /'])('blocks %s', (href) => {
    expect(sanitizeMarkdownHref(href)).toBeUndefined();
  });
});
