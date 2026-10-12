// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GettingStarted, gettingStartedProgress, type GettingStartedStep } from '../src/webview/GettingStarted';

afterEach(cleanup);

const steps = (done: Record<GettingStartedStep['id'], boolean>, run = vi.fn()): GettingStartedStep[] => [
  { id: 'send', title: 'Send a message', detail: 'd', done: done.send, action: { label: 'Write a message', run } },
  { id: 'save', title: 'Save the reply as a test', detail: 'd', done: done.save, action: { label: 'Save this conversation', run } },
  { id: 'run', title: 'Run it and read the result', detail: 'd', done: done.run, action: { label: 'Open General tests', run } },
];

describe('getting started guide', () => {
  it('offers only the next unfinished step and marks finished ones', () => {
    const run = vi.fn();
    render(<GettingStarted steps={steps(gettingStartedProgress({ sentMessage: true, capturedCase: false, recordedRun: false }), run)} onDismiss={() => undefined} />);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write a message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open General tests' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save this conversation' }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByText('Save the reply as a test').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText(', done')).toBeTruthy();
  });

  it('can be hidden', () => {
    const onDismiss = vi.fn();
    render(<GettingStarted steps={steps({ send: false, save: false, run: false })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the getting started steps' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
