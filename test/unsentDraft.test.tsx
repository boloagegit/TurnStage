// @vitest-environment jsdom

import React, { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, SessionSnapshot } from '../src/shared/types';
import { useRestoreUnsentDraft } from '../src/webview/unsentDraft';

afterEach(cleanup);

function user(id: string, text: string): ChatMessage {
  return { id, role: 'user', status: 'completed', createdAt: 1, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] };
}

function snapshot(turnState: SessionSnapshot['turnState'], messages: ChatMessage[] = []): SessionSnapshot {
  return {
    sessionId: 'session', sessionState: 'ready', turnState, messages, rawEvents: [], normalizedEvents: [],
    metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 },
    errors: [], droppedEventCount: 0, trusted: true, controls: {},
  };
}

let sendText: (text: string) => void = () => undefined;
function Composer({ current }: { current: SessionSnapshot }): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const track = useRestoreUnsentDraft(current, setDraft);
  sendText = (text) => { track(text); setDraft(''); };
  return <output>{draft}</output>;
}

describe('useRestoreUnsentDraft', () => {
  it('puts the text back when the turn settles without the user message', () => {
    const { rerender } = render(<Composer current={snapshot('idle', [user('user-1', 'earlier')])} />);
    act(() => sendText('Do not lose me'));
    expect(screen.getByRole('status').textContent).toBe('');
    rerender(<Composer current={snapshot('idle', [user('user-1', 'earlier')])} />);
    expect(screen.getByRole('status').textContent).toBe('Do not lose me');
  });

  it('keeps the composer empty once the host accepts the message', () => {
    const { rerender } = render(<Composer current={snapshot('idle')} />);
    act(() => sendText('Accepted'));
    rerender(<Composer current={snapshot('waitingStart', [user('user-2', 'Accepted')])} />);
    rerender(<Composer current={snapshot('completed', [user('user-2', 'Accepted')])} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('withdraws a restored draft if the message was accepted after all', () => {
    const { rerender } = render(<Composer current={snapshot('idle')} />);
    act(() => sendText('Raced'));
    rerender(<Composer current={snapshot('idle')} />);
    expect(screen.getByRole('status').textContent).toBe('Raced');
    rerender(<Composer current={snapshot('streaming', [user('user-3', 'Raced')])} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
