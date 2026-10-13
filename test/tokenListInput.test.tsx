// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenListInput } from '../src/webview/TokenListInput';

afterEach(cleanup);

function renderInput(props: Partial<React.ComponentProps<typeof TokenListInput>> = {}) {
  const onCommit = vi.fn();
  const view = render(<div><TokenListInput aria-label="Domains" value={['a.example']} onCommit={onCommit} {...props} /><button type="button">Outside</button></div>);
  return { ...view, onCommit, input: screen.getByRole('textbox', { name: 'Domains' }) as HTMLInputElement };
}

describe('TokenListInput', () => {
  it('adds a value on Enter and on a typed comma', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput();
    await user.type(input, 'b.example{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith(['a.example', 'b.example']);
    await user.type(input, 'c.example,');
    expect(onCommit).toHaveBeenLastCalledWith(['a.example', 'b.example', 'c.example']);
    expect(input.value).toBe('');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('adds what is left in the box when focus leaves, ignoring duplicates', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput();
    await user.type(input, 'a.example');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, ' b.example ');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).toHaveBeenCalledWith(['a.example', 'b.example']);
  });

  it('adds every pasted value at once', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput({ value: [] });
    await user.click(input);
    await user.paste('x, y\nz');
    expect(onCommit).toHaveBeenCalledWith(['x', 'y', 'z']);
  });

  it('keeps commas inside a value when splitting on commas is off', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput({ value: [], splitOnComma: false });
    await user.type(input, 'Sure, here is the key{Enter}');
    expect(onCommit).toHaveBeenCalledWith(['Sure, here is the key']);
  });

  it('removes a chip with its button and keeps focus in the box', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput({ value: ['a.example', 'b.example'] });
    await user.click(screen.getByRole('button', { name: 'Remove a.example' }));
    expect(onCommit).toHaveBeenCalledWith(['b.example']);
    expect(document.activeElement).toBe(input);
  });

  it('takes the last chip back for editing on Backspace and saves the edit on Enter', async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput();
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(input.value).toBe('a.example');
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}org{Enter}');
    expect(onCommit).toHaveBeenCalledWith(['a.org']);
  });

  it('restores the saved list on Escape without saving and keeps the key from closing a dialog', async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    const onCommit = vi.fn();
    render(<div onKeyDown={onKeyDown}><TokenListInput aria-label="Domains" value={['a.example']} onCommit={onCommit} /></div>);
    const input = screen.getByRole('textbox', { name: 'Domains' }) as HTMLInputElement;
    await user.click(input);
    await user.keyboard('{Backspace}x{Escape}');
    expect(input.value).toBe('');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['a.example']);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onKeyDown.mock.calls.some(([event]) => (event as KeyboardEvent).key === 'Escape')).toBe(false);
  });

  it('rejects a value the field does not accept and enforces its limit', async () => {
    const user = userEvent.setup();
    const validate = (text: string) => /^\d+$/u.test(text) ? { token: String(Number(text)) } : { error: `${text} is not a number.` };
    const { onCommit, input } = renderInput({ value: ['1'], validate, maxItems: 2 });
    await user.type(input, 'abc{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('abc is not a number.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onCommit).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, '02{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith(['1', '2']);
    await user.type(input, '3{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Up to 2 values.');
  });

  it('keeps describing the input with the field hint', () => {
    render(<div><p id="hint">Hint</p><TokenListInput aria-label="Domains" aria-describedby="hint" value={[]} onCommit={vi.fn()} /></div>);
    expect(screen.getByRole('textbox', { name: 'Domains' }).getAttribute('aria-describedby')?.split(' ')[0]).toBe('hint');
  });
});
