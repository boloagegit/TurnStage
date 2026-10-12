// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/webview/clipboardText', () => ({ copyText: vi.fn(async () => undefined) }));

import { ClipboardButton } from '../src/webview/ClipboardButton';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ClipboardButton', () => {
  it('returns to its copy label after confirming a copy so a repeated copy is announced again', async () => {
    vi.useFakeTimers();
    render(<ClipboardButton text="{}" label="Copy JSON" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' })); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Copied');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
