// @vitest-environment jsdom

import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConversationDirectory, SessionSnapshot, TurnStageProfile } from '../src/shared/types';
import { MobileChatPreview } from '../src/webview/MobileChatPreview';
import { ConversationDrawer, groupConversations, historyCheckSummary } from '../src/webview/ConversationDrawer';
import { AppSkeleton, isNarrowWorkspaceWidth, KeepAlivePane, NARROW_WORKSPACE_WIDTH } from '../src/webview/main';
import { setLocale } from '../src/webview/i18n';

beforeAll(() => {
  class TestResizeObserver implements ResizeObserver {
    observe(): void { /* jsdom has no layout */ }
    unobserve(): void { /* jsdom has no layout */ }
    disconnect(): void { /* jsdom has no layout */ }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  if (!('scrollIntoView' in Element.prototype)) Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => undefined, configurable: true });
});

afterEach(() => { cleanup(); setLocale('en', 'ltr'); });

const profile: TurnStageProfile = {
  version: 1, id: 'drawer', name: 'Drawer', opening: { mode: 'disabled' },
  conversation: { send: { method: 'POST', url: 'https://example.test' } },
  stream: { transport: 'sse', mappings: [] },
};

const now = Date.now();
function directory(overrides: Partial<ConversationDirectory> = {}): ConversationDirectory {
  return {
    enabled: true,
    currentKey: 'local:current',
    items: [
      { key: 'local:current', source: 'local', title: 'Refund follow-up', preview: 'Refunds arrive in 3–5 days', updatedAt: now, messageCount: 6 },
      { key: 'local:old', source: 'local', title: 'Old topic', updatedAt: now - 3 * 86_400_000, messageCount: 2 },
      { key: 'remote:c9', source: 'remote', conversationId: 'c9', title: '', updatedAt: now - 60_000 },
    ],
    remote: { configured: true, status: 'ready' },
    history: { configured: true },
    ...overrides,
  };
}

function chat(id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, status: 'completed', createdAt: 1, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [], ...extra };
}

function snapshot(messages: ChatMessage[]): SessionSnapshot {
  return { sessionId: 's1', sessionState: 'ready', turnState: 'completed', messages, rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [], droppedEventCount: 0, trusted: true, controls: {} };
}

describe('conversation drawer', () => {
  it('groups conversations by day and filters by title, preview, or id', () => {
    const groups = groupConversations(directory().items, '', new Date(now));
    expect(groups.map((group) => [group.group, group.items.map((item) => item.key)])).toEqual([['today', expect.arrayContaining(['local:current'])], ['earlier', ['local:old']]]);
    expect(groupConversations(directory().items, 'c9', new Date(now)).flatMap((group) => group.items.map((item) => item.key))).toEqual(['remote:c9']);
  });

  it('opens another conversation, marks the current one, and confirms deletion inline', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(<ConversationDrawer id="drawer" directory={directory()} messages={[]} view="conversations" onViewChange={vi.fn()} onClose={vi.fn()} post={post} busy={false} />);
    expect(screen.getByRole('button', { name: /Refund follow-up/u }).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Delete Refund follow-up' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Untitled conversation/u }));
    expect(post).toHaveBeenCalledWith({ type: 'conversation.open', key: 'remote:c9' });
    expect(screen.queryByRole('button', { name: 'Delete Untitled conversation' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete Old topic' }));
    const confirm = screen.getByRole('group', { name: 'Delete Old topic?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(post).toHaveBeenCalledWith({ type: 'conversation.delete', key: 'local:old' });
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(post).toHaveBeenCalledWith({ type: 'conversation.new' });
  });

  it('requests the server list once when it has not been loaded and closes on Escape', () => {
    const post = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<ConversationDrawer id="drawer" directory={directory({ remote: { configured: true, status: 'idle' } })} messages={[]} view="conversations" onViewChange={vi.fn()} onClose={onClose} post={post} busy={false} />);
    rerender(<ConversationDrawer id="drawer" directory={directory({ remote: { configured: true, status: 'idle' } })} messages={[]} view="conversations" onViewChange={vi.fn()} onClose={onClose} post={post} busy={false} />);
    expect(post.mock.calls.filter(([message]) => message.type === 'conversation.list.refresh')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Conversations' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows streamed vs saved differences and links back to the message', async () => {
    const onReveal = vi.fn();
    const post = vi.fn();
    const user = userEvent.setup();
    const state = directory({ check: { status: 'done', checkedAt: now, results: [
      { messageId: 'u1', role: 'user', status: 'match' },
      { messageId: 'a1', role: 'assistant', status: 'mismatch', streamedText: 'Refunds arrive in 3–5 days.', persistedText: 'Refunds arrive in 7 days.' },
    ] } });
    expect(historyCheckSummary(state)).toEqual({ status: 'mismatch', differences: 1 });
    render(<ConversationDrawer id="drawer" directory={state} messages={[chat('u1', 'user', 'How long?'), chat('a1', 'assistant', 'Refunds arrive in 3–5 days.')]} view="check" onViewChange={vi.fn()} onClose={vi.fn()} post={post} busy={false} onRevealMessage={onReveal} />);
    expect(screen.getByText('1 of 2 messages differ')).toBeTruthy();
    const diff = document.querySelector('.history-check-row__diff')!;
    expect(diff.querySelector('del')?.textContent).toBe('3–5');
    expect(diff.querySelector('ins')?.textContent).toBe('7');
    await user.click(screen.getAllByRole('button', { name: 'Show in conversation' })[0]!);
    expect(onReveal).toHaveBeenCalledWith('a1');
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(post).toHaveBeenCalledWith({ type: 'conversation.history.verify' });
  });

  it('translates the drawer into Traditional Chinese', () => {
    setLocale('zh-TW');
    render(<ConversationDrawer id="drawer" directory={directory()} messages={[]} view="conversations" onViewChange={vi.fn()} onClose={vi.fn()} post={vi.fn()} busy={false} />);
    expect(screen.getByRole('tab', { name: '對話' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /新對話/u })).toBeTruthy();
    expect(screen.getByText('今天')).toBeTruthy();
  });
});

describe('chat preview conversation tools', () => {
  const props = { profile, active: false, continuationBlocked: false, draft: '', setDraft: vi.fn(), send: vi.fn() };

  it('toggles the drawer outside the device preview and restores focus when closed', async () => {
    const user = userEvent.setup();
    const { container } = render(<MobileChatPreview {...props} post={vi.fn()} snapshot={snapshot([chat('u1', 'user', 'Hi')])} conversations={directory()} />);
    const toggle = screen.getByRole('button', { name: 'Conversations' });
    await user.click(toggle);
    const drawer = screen.getByRole('region', { name: 'Conversations' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.mobile-chat-preview__device')?.contains(drawer)).toBe(false);
    await user.click(within(drawer).getByRole('button', { name: 'Close conversations' }));
    expect(screen.queryByRole('region', { name: 'Conversations' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy();
  });

  it('marks where server history ends and summarizes the latest check', async () => {
    const user = userEvent.setup();
    const messages = [
      chat('history-1', 'user', 'Earlier', { metadata: { historySource: 'server' } }),
      chat('history-2', 'assistant', 'Earlier answer', { metadata: { historySource: 'server' } }),
      chat('user-1', 'user', 'New question'),
    ];
    render(<MobileChatPreview {...props} post={vi.fn()} snapshot={snapshot(messages)} conversations={directory({ check: { status: 'done', results: [{ messageId: 'user-1', role: 'user', status: 'match' }] } })} />);
    const divider = screen.getByRole('separator', { name: '' });
    expect(divider.textContent).toBe('Earlier messages loaded from the server · new messages below');
    expect(divider.nextElementSibling?.getAttribute('data-message-id')).toBe('user-1');
    await user.click(screen.getByRole('button', { name: 'Matches server copy' }));
    expect(screen.getByRole('tab', { name: 'History check' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches drawer views with arrow keys and Home/End, then restores focus on Escape', async () => {
    const user = userEvent.setup();
    render(<MobileChatPreview {...props} post={vi.fn()} snapshot={snapshot([])} conversations={directory()} />);
    const toggle = screen.getByRole('button', { name: 'Conversations' });
    await user.click(toggle);
    const conversations = screen.getByRole('tab', { name: 'Conversations' });
    const check = screen.getByRole('tab', { name: 'History check' });
    expect(document.activeElement).toBe(conversations);
    await user.keyboard('{ArrowRight}');
    expect(check.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(check);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(conversations);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(check);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(conversations);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(check);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Conversations' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps focus inside the drawer while opening and deleting conversations', async () => {
    const user = userEvent.setup();
    const post = vi.fn();
    const { rerender } = render(<MobileChatPreview {...props} post={post} snapshot={snapshot([])} conversations={directory()} />);
    const toggle = screen.getByRole('button', { name: 'Conversations' });
    await user.click(toggle);
    const tab = screen.getByRole('tab', { name: 'Conversations' });
    await user.click(screen.getByRole('button', { name: /Untitled conversation/u }));
    expect(document.activeElement).toBe(tab);
    rerender(<MobileChatPreview {...props} post={post} snapshot={snapshot([])} conversations={directory({ opening: 'remote:c9' })} />);
    expect(document.activeElement).toBe(tab);
    rerender(<MobileChatPreview {...props} post={post} snapshot={snapshot([])} conversations={directory()} />);
    await user.click(screen.getByRole('button', { name: 'Delete Old topic' }));
    expect(document.activeElement).toBe(within(screen.getByRole('group', { name: 'Delete Old topic?' })).getByRole('button', { name: 'Delete' }));
    await user.keyboard('{Enter}');
    expect(post).toHaveBeenCalledWith({ type: 'conversation.delete', key: 'local:old' });
    expect(document.activeElement).toBe(tab);
    rerender(<MobileChatPreview {...props} post={post} snapshot={snapshot([])} conversations={directory({ items: directory().items.filter((item) => item.key !== 'local:old') })} />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Conversations' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('omits conversation tools when the host has no archive', () => {
    render(<MobileChatPreview {...props} post={vi.fn()} snapshot={snapshot([])} />);
    expect(screen.queryByRole('button', { name: 'Conversations' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart session' })).toBeTruthy();
  });

  it('shows message placeholders instead of loading text before the first snapshot', () => {
    const { container } = render(<MobileChatPreview {...props} post={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading conversation…' })).toBeTruthy();
    expect(container.querySelectorAll('.mobile-chat-preview__loading .ts-skeleton')).toHaveLength(2);
  });
});

describe('visual continuity', () => {
  function Panes(): React.JSX.Element {
    const [mode, setMode] = useState<'a' | 'b'>('a');
    const [renders, setRenders] = useState(0);
    return <>
      <button type="button" onClick={() => setMode(mode === 'a' ? 'b' : 'a')}>switch</button>
      <button type="button" onClick={() => setRenders((value) => value + 1)}>update {renders}</button>
      <KeepAlivePane active={mode === 'a'} render={() => <label>First <input defaultValue="" /> <span data-testid="a-renders">{renders}</span></label>} />
      <KeepAlivePane active={mode === 'b'} render={() => <p>Second pane</p>} />
    </>;
  }

  it('keeps a visited pane mounted while hidden and does not re-render it with new props', async () => {
    const user = userEvent.setup();
    render(<Panes />);
    expect(screen.queryByText('Second pane')).toBeNull();
    await user.type(screen.getByRole('textbox'), 'draft kept');
    await user.click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByText('Second pane')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /update/u }));
    expect(screen.getByTestId('a-renders').textContent).toBe('0');
    await user.click(screen.getByRole('button', { name: 'switch' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('draft kept');
    expect(screen.getByTestId('a-renders').textContent).toBe('1');
  });

  it('draws the workspace shell before the Profile arrives', () => {
    act(() => { render(<AppSkeleton splitPercent={70} />); });
    const skeleton = document.querySelector('.app-skeleton') as HTMLElement;
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.style.getPropertyValue('--app-skeleton-split')).toBe('70fr');
    expect(skeleton.querySelectorAll('.app-skeleton__tabs .ts-skeleton')).toHaveLength(4);
  });

  it('switches to tabs by the workspace width, not the window, and ignores a hidden (zero-width) workspace', () => {
    expect(NARROW_WORKSPACE_WIDTH).toBe(1024);
    // A 1100px Web window minus the library sidebar leaves a ~796px workspace: tabs, not a cramped split.
    expect(isNarrowWorkspaceWidth(796)).toBe(true);
    expect(isNarrowWorkspaceWidth(1100)).toBe(false);
    expect(isNarrowWorkspaceWidth(0)).toBe(false);
  });
});
