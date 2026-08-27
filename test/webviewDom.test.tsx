// @vitest-environment jsdom

import React, { useState } from 'react';
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionSnapshot, TurnStageProfile } from '../src/shared/types';
import { MobileChatPreview } from '../src/webview/MobileChatPreview';
import { ACCESSIBLE_EVENT_WINDOW_SIZE, JsonBlock, VirtualEvents } from '../src/webview/main';
import { setLocale } from '../src/webview/i18n';
import { SettingsWorkspace, type SettingsSectionId } from '../src/webview/SettingsWorkspace';

beforeAll(() => {
  class TestResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>();
    observe(target: Element): void { this.observed.add(target); }
    unobserve(target: Element): void { this.observed.delete(target); }
    disconnect(): void { this.observed.clear(); }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => { cleanup(); document.body.classList.remove('vscode-using-screen-reader'); setLocale('en', 'ltr'); });

describe('Webview DOM behavior', () => {
  it('selects a message with the keyboard and keeps every message action focusable', async () => {
    const user = userEvent.setup();
    const onSelectMessage = vi.fn();
    render(<MobileChatPreview {...mobileProps({ onSelectMessage })} />);

    const message = screen.getByLabelText('Assistant message, Completed');
    message.focus();
    await user.keyboard('{Enter}');
    expect(onSelectMessage).toHaveBeenCalledWith('assistant-1');

    const actions = screen.getByRole('group', { name: 'Message actions' });
    const buttons = Array.from(actions.querySelectorAll('button'));
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('treats persisted secret controls as write-only password inputs', async () => {
    const user = userEvent.setup();
    const post = vi.fn();
    render(<MobileChatPreview {...mobileProps({ post })} />);

    await user.click(screen.getByText('Session controls'));
    const secret = screen.getByLabelText('API token') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    await user.type(secret, 'temporary-secret');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(post).toHaveBeenCalledWith({ type: 'control.set', controlId: 'api-token', value: 'temporary-secret' });
    expect(secret.value).toBe('');
  });

  it('announces clipboard failures through a local live region', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });
    try {
      render(<JsonBlock value={{ text: 'copy me' }} />);
      await user.click(screen.getByRole('button', { name: 'Copy JSON' }));
      expect(await screen.findByText('Copy failed. Try again.')).toBeTruthy();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  it('only follows streamed content when near the bottom and offers a jump when behind', async () => {
    const { rerender } = render(<MobileChatPreview {...mobileProps()} />);
    const messages = screen.getByRole('log') as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(messages, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTo: { configurable: true, value: vi.fn(({ top }: { top: number }) => { messages.scrollTop = top; }) }
    });
    messages.scrollTop = 100;
    fireEvent.scroll(messages);

    scrollHeight = 720;
    rerender(<MobileChatPreview {...mobileProps({ snapshot: { ...snapshot, messages: [...snapshot.messages, assistantMessage('assistant-2', '新訊息 🧪') ] } })} />);
    expect(messages.scrollTop).toBe(100);
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(messages.scrollTop).toBe(520);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    fireEvent.scroll(messages);
    scrollHeight = 840;
    rerender(<MobileChatPreview {...mobileProps({ snapshot: { ...snapshot, messages: [...snapshot.messages, assistantMessage('assistant-2', '新訊息 🧪'), assistantMessage('assistant-3', '更多內容') ] } })} />);
    expect(messages.scrollTop).toBe(640);
  });

  it('preserves the reading position when older messages are prepended', () => {
    const { rerender } = render(<MobileChatPreview {...mobileProps()} />);
    const messages = screen.getByRole('log') as HTMLDivElement;
    let scrollHeight = 600;
    Object.defineProperties(messages, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight }
    });
    messages.scrollTop = 140;
    fireEvent.scroll(messages);
    scrollHeight = 900;
    rerender(<MobileChatPreview {...mobileProps({ snapshot: { ...snapshot, messages: [assistantMessage('older', '較舊內容'), ...snapshot.messages] } })} />);
    expect(messages.scrollTop).toBe(440);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('keeps RTL direction and long CJK or emoji content in the rendered conversation', () => {
    const longText = '這是一段很長的繁體中文內容，包含 emoji 🧪🚀🙂，用來確認對話不會假設拉丁字元寬度。'.repeat(8);
    setLocale('ar', 'rtl');
    render(<MobileChatPreview {...mobileProps({
      profile: { ...profile, name: '🧪 超長的對話助理名稱 — مُساعد طويل' },
      snapshot: { ...snapshot, messages: [assistantMessage('long-cjk', longText)] }
    })} />);

    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText(longText)).toBeTruthy();
    expect(screen.getByRole('log').classList.contains('mobile-chat-preview__messages')).toBe(true);
    expect(screen.getByLabelText('Assistant message, Completed').textContent).toContain('🧪🚀🙂');
  });

  it('bounds a huge event list for screen readers and announces the rendered window', () => {
    document.body.classList.add('vscode-using-screen-reader');
    const items = Array.from({ length: 1000 }, (_, index) => ({ sequence: index + 1, rawSequence: index + 1, type: 'message', elapsedMs: index }));
    render(<VirtualEvents items={items} label="Raw Events" />);

    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(ACCESSIBLE_EVENT_WINDOW_SIZE);
    expect(screen.getByRole('status').textContent).toContain('Showing events');
    expect(screen.getByRole('status').textContent).toContain('1–200');
    expect(screen.getByRole('status').textContent).toContain('1,000');
  });

  it('switches all Profile Configuration sections and persists selection in the parent state', async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);

    await user.click(screen.getByRole('button', { name: 'Security' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Security' }).getAttribute('aria-current')).toBe('page');
  });

  it('disables network and privileged chat actions in Restricted Mode while leaving local inspection available', async () => {
    const restrictedSnapshot = { ...snapshot, trusted: false };
    render(<MobileChatPreview {...mobileProps({ snapshot: restrictedSnapshot, draft: 'hello', onSelectMessage: vi.fn() })} />);

    expect((screen.getByLabelText('Message') as HTMLInputElement | HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit & resend' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Inspect message' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fails closed before the first trusted session snapshot arrives', () => {
    render(<MobileChatPreview {...mobileProps({ snapshot: undefined, draft: 'hello' })} />);

    expect((screen.getByLabelText('Message') as HTMLInputElement | HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no detectable axe violations in the representative chat and settings surfaces', async () => {
    const chat = render(<MobileChatPreview {...mobileProps()} />);
    const chatResult = await axe.run(chat.container, { rules: { 'color-contrast': { enabled: false } } });
    expect(chatResult.violations).toEqual([]);
    cleanup();

    const settings = render(<SettingsHarness />);
    const settingsResult = await axe.run(settings.container, { rules: { 'color-contrast': { enabled: false } } });
    expect(settingsResult.violations).toEqual([]);
  });
});

function SettingsHarness(): React.JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>('general');
  return <SettingsWorkspace section={section} onSectionChange={setSection} profile={profile} post={vi.fn()} />;
}

function mobileProps(overrides: Partial<React.ComponentProps<typeof MobileChatPreview>> = {}): React.ComponentProps<typeof MobileChatPreview> {
  return {
    profile,
    snapshot,
    active: false,
    continuationBlocked: false,
    draft: '',
    setDraft: vi.fn(),
    send: vi.fn(),
    post: vi.fn(),
    selectedMessageId: undefined,
    ...overrides,
  };
}

const profile: TurnStageProfile = {
  version: 1,
  id: 'dom-test',
  name: 'DOM Test',
  controls: [{ id: 'api-token', type: 'text', label: 'API token', default: 'must-not-render', persist: 'secret' }],
  opening: { mode: 'disabled' },
  conversation: { send: { method: 'POST', url: 'https://example.test' } },
  stream: { transport: 'sse', mappings: [] },
  ui: { messageActions: ['message.copy', 'message.retry', 'message.editAndResend', 'message.inspectRaw'] },
};

const snapshot: SessionSnapshot = {
  sessionId: 'session-1',
  sessionState: 'ready',
  turnState: 'completed',
  messages: [{ id: 'assistant-1', role: 'assistant', status: 'completed', createdAt: 1, completedAt: 2, parts: [{ type: 'text', text: 'A completed response.' }], citations: [], actions: [], followups: [] }],
  rawEvents: [],
  normalizedEvents: [],
  metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 },
  errors: [],
  droppedEventCount: 0,
  trusted: true,
  controls: {},
};

function assistantMessage(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', status: 'completed', createdAt: 3, completedAt: 4, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] };
}
