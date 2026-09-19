// @vitest-environment jsdom

import React from 'react';
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileReferencePanel, type ReferencePage } from '../web/src/ProfileReferencePanel';
import { JsoncCodeViewer } from '../web/src/JsoncCodeViewer';

afterEach(cleanup);

const raw = '{\n  // Keep this comment\n  "id": "example",\n}\n';

function mount(page: ReferencePage = 'source', locale = 'zh-TW') {
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const onCopy = vi.fn(async () => undefined);
  render(<ProfileReferencePanel page={page} onClose={onClose} profileName="Example" raw={raw} locale={locale} onDownload={onDownload} onCopy={onCopy} />);
  return { onClose, onDownload, onCopy };
}

describe('Web profile reference', () => {
  it('shows the exact JSONC source without removing comments and keeps copy and download separate', () => {
    const actions = mount();
    const dialog = screen.getByRole('dialog', { name: 'Example' });
    expect([...dialog.querySelectorAll('.jsonc-line code')].map((line) => line.textContent).join('\n')).toBe(raw);
    expect(within(dialog).getByText(/唯讀/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '複製' }));
    expect(actions.onCopy).toHaveBeenCalledWith(raw);
    fireEvent.click(within(dialog).getByRole('button', { name: '下載 JSONC' }));
    expect(actions.onDownload).toHaveBeenCalledWith(raw);
    expect(within(dialog).queryByRole('tab')).toBeNull();
  });

  it('opens browser-local JSONC directly in the structured editor', async () => {
    const onSave = vi.fn((value: string) => value.includes('broken')
      ? { ok: false as const, error: 'Invalid JSONC', offset: value.indexOf('broken') }
      : { ok: true as const, id: 'example', raw: value });
    const onDownload = vi.fn();
    const onCopy = vi.fn(async () => undefined);
    render(<ProfileReferencePanel page="source" onClose={() => undefined} profileName="Example" raw={raw} locale="zh-TW" readOnly={false} onSave={onSave} onDownload={onDownload} onCopy={onCopy} />);
    expect(screen.queryByRole('button', { name: '編輯 JSONC' })).toBeNull();
    const editor = await screen.findByRole('textbox', { name: 'JSONC' });
    expect(screen.getByRole('navigation', { name: '設定區段' })).toBeTruthy();
    expect(document.querySelector('.profile-reference-editor .jsonc-lines')).toBeNull();
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(screen.getByRole('button', { name: '格式化' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '儲存' }).hasAttribute('disabled')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'JSONC' })).toBeTruthy();
  });

  it('offers a duplicate for read-only sources and opens the copy in the editor', async () => {
    const onDuplicate = vi.fn(() => ({ id: 'copy', raw }));
    const onClose = vi.fn();
    render(<ProfileReferencePanel page="source" onClose={onClose} profileName="Example" raw={raw} locale="zh-TW" onDuplicate={onDuplicate} onDownload={() => undefined} onCopy={async () => undefined} />);
    expect(screen.queryByRole('button', { name: '編輯 JSONC' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '複製後編輯' }));
    expect(onDuplicate).toHaveBeenCalledOnce();
    await screen.findByRole('textbox', { name: 'JSONC' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows focused examples and paths in the guide', () => {
    const actions = mount('guide');
    const dialog = screen.getByRole('dialog', { name: '設定檔指南' });
    fireEvent.click(within(dialog).getByRole('button', { name: '設定逾時' }));
    expect(within(dialog).getByText('conversation.send')).toBeTruthy();
    expect(within(dialog).getByText(/idleTimeoutMs/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '複製' }));
    expect(actions.onCopy).toHaveBeenCalledWith(expect.stringContaining('idleTimeoutMs'));
  });

  it.each([['en', 'Profile guide'], ['zh-TW', '設定檔指南'], ['ja', 'プロファイルガイド'], ['ko', '프로필 가이드']])('labels the guide in %s', (locale, title) => {
    mount('guide', locale);
    expect(screen.getByRole('dialog', { name: title })).toBeTruthy();
  });

  it('closes with Escape and returns keyboard focus', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const actions = mount();
    expect(screen.getByRole('button', { name: '關閉' })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(actions.onClose).toHaveBeenCalledOnce();
    cleanup();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('has no detected accessibility violations in either page', async () => {
    const view = render(<ProfileReferencePanel page="source" onClose={() => undefined} profileName="Example" raw={raw} locale="en" onDownload={() => undefined} onCopy={async () => undefined} />);
    expect((await axe.run(document.body, { rules: { 'region': { enabled: false } } })).violations).toEqual([]);
    view.rerender(<ProfileReferencePanel page="guide" onClose={() => undefined} profileName="Example" raw={raw} locale="en" onDownload={() => undefined} onCopy={async () => undefined} />);
    expect((await axe.run(document.body, { rules: { 'region': { enabled: false } } })).violations).toEqual([]);
  });

  it('finds text, navigates matches, and wraps long lines by default', () => {
    const lines = '{\n  "controls": { "name": "Demo" },\n  "opening": "Demo"\n}';
    render(<JsoncCodeViewer raw={lines} labels={{ search: 'Search JSONC', previous: 'Previous', next: 'Next', noMatches: 'No matches', matchCount: '{current} of {total}', wrap: 'Wrap lines', sections: 'Sections', overview: 'Top', lines: '{count} lines' }} />);
    expect((screen.getByRole('checkbox', { name: 'Wrap lines' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search JSONC' }), { target: { value: 'Demo' } });
    expect(screen.getByRole('status').textContent).toBe('1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('status').textContent).toBe('2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('status').textContent).toBe('1 of 2');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search JSONC' }), { target: { value: 'not-here' } });
    expect(screen.getByRole('status').textContent).toBe('No matches');
  });
});
