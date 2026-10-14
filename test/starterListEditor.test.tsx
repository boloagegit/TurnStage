// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StarterListEditor, starterRows, startersFromRows } from '../src/webview/StarterListEditor';

afterEach(cleanup);

const starters = [
  { id: 'explain', label: 'Explain', prompt: 'Please explain a sample topic.', behavior: 'send' as const },
  { id: 'draft', label: 'Draft', prompt: 'Draft a reply', behavior: 'fill' as const },
];

describe('starter rows', () => {
  it('reads plain strings as sendable prompts, as the runtime does', () => {
    expect(starterRows(['Hello'])).toEqual([{ id: 'starter-1', label: 'Hello', prompt: 'Hello', behavior: 'send', actionId: '' }]);
  });

  it('drops blank rows, fills label or prompt from the other, and keeps IDs unique', () => {
    expect(startersFromRows([
      { id: '', label: 'Ask', prompt: '', behavior: 'send', actionId: '' },
      { id: '', label: '', prompt: '', behavior: 'send', actionId: '' },
      { id: '', label: 'Ask', prompt: 'Again', behavior: 'fill', actionId: '' },
    ])).toEqual({ starters: [
      { id: 'ask', label: 'Ask', prompt: 'Ask', behavior: 'send' },
      { id: 'ask-2', label: 'Ask', prompt: 'Again', behavior: 'fill' },
    ] });
  });

  it('requires an action for action starters', () => {
    expect(startersFromRows([{ id: 'a', label: 'Start over', prompt: 'docs', behavior: 'action', actionId: ' ' }]).error).toBe('Starter 1 runs an action; choose which one.');
    expect(startersFromRows([{ id: 'a', label: 'Start over', prompt: 'docs', behavior: 'action', actionId: 'conversation.new' }]).starters?.[0]).toEqual({ id: 'a', label: 'Start over', prompt: 'docs', behavior: 'action', actionId: 'conversation.new' });
  });
});

function renderEditor(onCommit = vi.fn()) {
  render(<div><StarterListEditor value={starters} onCommit={onCommit} jsonEditor={null} /><button type="button">Outside</button></div>);
  return onCommit;
}

describe('StarterListEditor', () => {
  it('edits a label and commits when focus leaves the list', async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor();
    const label = screen.getAllByRole('textbox', { name: 'Button label' })[0]!;
    await user.clear(label);
    await user.type(label, 'Explain more');
    expect(onCommit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).toHaveBeenCalledWith([{ ...starters[0], label: 'Explain more' }, starters[1]]);
  });

  it('reorders and removes at once', async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor();
    await user.click(screen.getByRole('button', { name: 'Move Draft up' }));
    expect(onCommit).toHaveBeenLastCalledWith([starters[1], starters[0]]);
    await user.click(screen.getByRole('button', { name: 'Remove Explain' }));
    expect(onCommit).toHaveBeenLastCalledWith([starters[1]]);
  });

  it('offers only actions a starter can run and saves the choice at once', async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor();
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'When clicked' })[0]!, 'action');
    expect(onCommit).toHaveBeenLastCalledWith([{ ...starters[0], behavior: 'action', actionId: 'conversation.new' }, starters[1]]);
    const action = screen.getByRole('combobox', { name: 'Action' });
    expect([...(action as HTMLSelectElement).options].map((option) => option.value)).toEqual(['conversation.new', 'conversation.clear']);
    await user.selectOptions(action, 'conversation.clear');
    expect(onCommit).toHaveBeenLastCalledWith([{ ...starters[0], behavior: 'action', actionId: 'conversation.clear' }, starters[1]]);
  });

  it('keeps an action ID written in JSON as an option', () => {
    render(<StarterListEditor value={[{ id: 'x', label: 'X', prompt: 'X', behavior: 'action', actionId: 'custom.thing' }]} onCommit={vi.fn()} jsonEditor={null} />);
    expect((screen.getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).value).toBe('custom.thing');
  });

  it('adds an empty starter with focus on its label and saves nothing until it has text', async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor();
    await user.click(screen.getByRole('button', { name: 'Add starter' }));
    expect(document.activeElement).toBe(screen.getAllByRole('textbox', { name: 'Button label' })[2]);
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores the saved list on Escape', async () => {
    const user = userEvent.setup();
    const onCommit = renderEditor();
    const label = screen.getAllByRole('textbox', { name: 'Button label' })[0] as HTMLInputElement;
    await user.type(label, ' changed{Escape}');
    expect(label.value).toBe('Explain');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
