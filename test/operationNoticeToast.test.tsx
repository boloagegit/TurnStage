// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorNotice, OperationNoticeToast } from '../src/webview/OperationNoticeToast';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('OperationNoticeToast', () => {
  it('dismisses a status notice after a moment', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<OperationNoticeToast notice="Profile is valid." onDismiss={onDismiss} post={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Profile is valid.');
    act(() => { vi.advanceTimersByTime(3200); });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('announces errors assertively and keeps them until they are dismissed', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<OperationNoticeToast notice={errorNotice('Could not export the suite.')} onDismiss={onDismiss} post={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('waits while keyboard focus is on an artifact action', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const post = vi.fn();
    render(<OperationNoticeToast notice={{ message: 'Run exported.', artifactId: 'artifact-1' }} onDismiss={onDismiss} post={post} />);
    const open = screen.getByRole('button', { name: 'Open' });
    act(() => { open.focus(); });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(post).toHaveBeenCalledWith({ type: 'artifact.action', artifactId: 'artifact-1', action: 'open' });
    act(() => { open.blur(); });
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
