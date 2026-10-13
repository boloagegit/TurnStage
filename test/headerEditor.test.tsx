// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderEditor, headersFromRows, literalCredential } from '../src/webview/HeaderEditor';

afterEach(cleanup);

describe('header rows', () => {
  it('ignores blank rows and rejects nameless values and repeated names', () => {
    expect(headersFromRows([{ name: 'Accept', value: 'text/event-stream' }, { name: ' ', value: '' }])).toEqual({ headers: { Accept: 'text/event-stream' } });
    expect(headersFromRows([{ name: '', value: 'orphan' }]).error).toBe('Every header needs a name.');
    expect(headersFromRows([{ name: 'Accept', value: 'a' }, { name: 'accept', value: 'b' }]).error).toBe('Header accept appears more than once.');
  });

  it('flags credentials typed as plain text, not secret references', () => {
    expect(literalCredential({ name: 'Authorization', value: 'Bearer abc' })).toBe(true);
    expect(literalCredential({ name: 'X-Api-Key', value: 'abc' })).toBe(true);
    expect(literalCredential({ name: 'Authorization', value: 'Bearer ${secret.token}' })).toBe(false);
    expect(literalCredential({ name: 'Accept', value: 'text/event-stream' })).toBe(false);
    expect(literalCredential({ name: 'Authorization', value: 'Bearer old-token ${secret.apiKey}' })).toBe(true);
    expect(literalCredential({ name: 'Authorization', value: 'Basic ${secret.basic}' })).toBe(false);
    expect(literalCredential({ name: 'Authorization', value: 'Bearer ${env.token}' })).toBe(true);
  });
});

function renderEditor(value: Record<string, string> | undefined, onCommit = vi.fn()) {
  const view = render(<div><HeaderEditor id="headers" label="Headers" value={value} onCommit={onCommit} jsonEditor={<textarea aria-label="Headers JSON" />} /><button type="button">Outside</button></div>);
  return { ...view, onCommit };
}

describe('HeaderEditor', () => {
  it('commits edited rows when focus leaves the rows, not between name and value', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor({ Accept: 'text/event-stream' });
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Header 2 name' }));
    await user.keyboard('X-Trace');
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('on');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).toHaveBeenCalledWith({ Accept: 'text/event-stream', 'X-Trace': 'on' });
  });

  it('removes a row and commits immediately', async () => {
    const { onCommit } = renderEditor({ Accept: 'a', 'X-Trace': 'on' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove X-Trace' }));
    expect(onCommit).toHaveBeenCalledWith({ Accept: 'a' });
  });

  it('restores the saved rows on Escape', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor({ Accept: 'a' });
    const value = screen.getByRole('textbox', { name: 'Header 1 value' }) as HTMLInputElement;
    await user.clear(value);
    await user.type(value, 'changed{Escape}');
    expect(value.value).toBe('a');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a duplicate-name error instead of committing', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor({ Accept: 'a' });
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    await user.keyboard('accept');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.getByRole('alert').textContent).toBe('Header accept appears more than once.');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('warns on a literal credential', () => {
    renderEditor({ Authorization: 'Bearer abc' });
    expect(screen.getByRole('note').textContent).toContain('${secret.apiKey}');
  });

  it('keeps a row being typed when the saved value changes underneath', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<HeaderEditor id="headers" label="Headers" value={{ Accept: 'a' }} onCommit={onCommit} jsonEditor={null} />);
    const value = screen.getByRole('textbox', { name: 'Header 1 value' }) as HTMLInputElement;
    await user.clear(value);
    await user.type(value, 'typing');
    rerender(<HeaderEditor id="headers" label="Headers" value={{ Accept: 'from-host' }} onCommit={onCommit} jsonEditor={null} />);
    expect(value.value).toBe('typing');
  });

  it('follows saved changes while nobody is editing the rows', () => {
    const { rerender } = render(<HeaderEditor id="headers" label="Headers" value={{ Accept: 'a' }} onCommit={vi.fn()} jsonEditor={null} />);
    rerender(<HeaderEditor id="headers" label="Headers" value={{ Accept: 'b', 'X-Trace': 'on' }} onCommit={vi.fn()} jsonEditor={null} />);
    expect((screen.getByRole('textbox', { name: 'Header 2 name' }) as HTMLInputElement).value).toBe('X-Trace');
  });
});
