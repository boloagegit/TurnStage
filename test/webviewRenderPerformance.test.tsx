// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, NetworkExchange, SessionDelta, SessionSnapshot, TurnStageProfile } from '../src/shared/types';
import { applySessionDelta } from '../src/shared/sessionDelta';
import { MobileChatPreview } from '../src/webview/MobileChatPreview';
import { NetworkInspector, VirtualEvents } from '../src/webview/main';
import { RichMarkdown, splitStreamingMarkdown } from '../src/webview/RichMarkdown';
import { tokenizeJson } from '../src/webview/JsonViewer';
import { AutomationWorkspace, SettingsWorkspace } from '../src/webview/SettingsWorkspace';
import { useConfirmAction } from '../src/webview/ConfirmAction';
import { formatDuration, formatNumber, setLocale } from '../src/webview/i18n';
import { LiveCaseStatusBadge, LiveCaseStatusContext, useLiveCaseStatuses } from '../src/webview/liveCaseStatus';
import { isHostMessage, PROTOCOL_VERSION, type TestOperationSnapshot } from '../src/shared/protocol';

beforeAll(() => {
  class TestResizeObserver implements ResizeObserver {
    observe(): void { /* jsdom has no layout */ }
    unobserve(): void { /* jsdom has no layout */ }
    disconnect(): void { /* jsdom has no layout */ }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => { cleanup(); setLocale('en', 'ltr'); });

const profile: TurnStageProfile = {
  version: 1,
  id: 'render-performance',
  name: 'Render performance',
  opening: { mode: 'disabled' },
  conversation: { send: { method: 'POST', url: 'https://example.test' } },
  stream: { transport: 'sse', mappings: [] },
};

function message(id: string, text: string, status: ChatMessage['status'] = 'completed', type: 'text' | 'markdown' = 'markdown'): ChatMessage {
  return { id, role: 'assistant', status, createdAt: 1, parts: [{ type, text }], citations: [], actions: [], followups: [] };
}

function snapshot(messages: ChatMessage[], overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session-1', sessionState: 'ready', turnState: 'streaming', messages,
    rawEvents: [{ sequence: 1, receivedAt: 1, elapsedMs: 0, protocol: 'sse', raw: 'one', data: {} }],
    normalizedEvents: [],
    metrics: { eventCount: 1, byteCount: 3, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 },
    errors: [], droppedEventCount: 0, trusted: true, controls: {}, ...overrides,
  };
}

describe('session delta identity', () => {
  it('keeps unchanged event and message arrays so memoized views can skip work', () => {
    const current = snapshot([message('a', 'first'), message('b', 'second')]);
    const { messages, rawEvents, normalizedEvents, ...core } = current;
    void messages; void rawEvents; void normalizedEvents;
    const metricsOnly: SessionDelta = { baseSessionId: 'session-1', core: { ...core, metrics: { ...core.metrics, byteCount: 9 } }, rawEvents: { retainFromSequence: 1, append: [] }, normalizedEvents: { append: [] }, messages: { removeIds: [], upsert: [] } };
    const next = applySessionDelta(current, metricsOnly)!;
    expect(next.rawEvents).toBe(current.rawEvents);
    expect(next.normalizedEvents).toBe(current.normalizedEvents);
    expect(next.messages).toBe(current.messages);
    expect(next.metrics.byteCount).toBe(9);

    const tail: SessionDelta = { ...metricsOnly, messages: { removeIds: [], upsert: [message('b', 'second, longer', 'streaming')] } };
    const streamed = applySessionDelta(current, tail)!;
    expect(streamed.messages[0]).toBe(current.messages[0]);
    expect(streamed.messages[1]?.parts[0]?.text).toBe('second, longer');
  });
});

describe('streaming Markdown', () => {
  const sample = '# Title\n\nSome *em* and **strong** with `code` and a [link](https://example.test).\n\n- a\n- b\n\n  - nested\n\n1. one\n2. two\n\n* loose\n\n* list\n\n> quote\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n    indented code\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nline1\nline2\n\n- [ ] task\n\nEnd paragraph.';
  const normalize = (html: string) => html.replace(/response-[A-Za-z0-9_-]+/gu, 'scope').replace(/>\s+</gu, '><');

  it('splits only at top-level blank lines outside fences', () => {
    const chunks = splitStreamingMarkdown(sample, true);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.join('')).toBe(sample);
    expect(chunks.some((chunk) => chunk.includes('const a = 1;\n\nconst b = 2;'))).toBe(true);
    // A list item after a blank line continues the previous block (loose list).
    expect(chunks.find((chunk) => chunk.includes('* loose'))).toContain('* list');
  });

  it('keeps sources whose meaning spans blocks as one fragment', () => {
    expect(splitStreamingMarkdown('<div>\n\ntext\n\n</div>', true)).toHaveLength(1);
    expect(splitStreamingMarkdown('See [x][1].\n\n[1]: https://example.test', false)).toHaveLength(1);
    expect(splitStreamingMarkdown('Note[^1]\n\n[^1]: text', false)).toHaveLength(1);
  });

  it('renders the same document whether parsed whole or in streaming fragments', () => {
    expect(normalize(renderToStaticMarkup(<RichMarkdown text={sample} streaming />))).toBe(normalize(renderToStaticMarkup(<RichMarkdown text={sample} />)));
  });

  it('keeps completed messages mounted while a later message streams', () => {
    const completed = message('done', 'Finished.\n\n```js\nconst kept = true;\n```');
    const props = { profile, active: true, continuationBlocked: false, draft: '', setDraft: vi.fn(), send: vi.fn(), post: vi.fn() };
    const { container, rerender } = render(<MobileChatPreview {...props} snapshot={snapshot([completed, message('live', 'Partial', 'streaming')])} />);
    const codeBlock = container.querySelector('[data-message-id="done"] .safe-markdown__code-block');
    expect(codeBlock).toBeTruthy();
    rerender(<MobileChatPreview {...props} snapshot={snapshot([completed, message('live', 'Partial answer that keeps growing', 'streaming')])} />);
    expect(container.querySelector('[data-message-id="done"] .safe-markdown__code-block')).toBe(codeBlock);
    expect(container.querySelector('[data-message-id="live"]')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[data-message-id="done"]')?.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('inspector interaction stability', () => {
  it('detects JSON object keys without scanning the remaining text', () => {
    const tokens = tokenizeJson('{\n  "key" : "value",\n  "list": ["a"]\n}');
    expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text)).toEqual(['"key"', '"list"']);
    expect(tokens.filter((token) => token.kind === 'string').map((token) => token.text)).toEqual(['"value"', '"a"']);
  });

  it('formats with cached Intl formatters per locale', () => {
    expect(formatNumber(1234)).toBe('1,234');
    setLocale('ja');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatDuration(1500)).toBe(new Intl.NumberFormat('ja', { maximumFractionDigits: 0, style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(1500));
  });

  it('does not override a user-selected Network row when entries stream in', async () => {
    const entry = (id: string, url: string, bytes: number): NetworkExchange => ({ id, kind: 'stream', attempt: 1, method: 'POST', url, state: 'streaming', startedAt: 1, requestHeaders: {}, timing: {}, transferredBytes: bytes, eventCount: 0 });
    const { rerender } = render(<NetworkInspector entries={[entry('first', 'https://example.test/first', 1), entry('second', 'https://example.test/second', 1)]} selectedEntryId="first" />);
    await userEvent.setup().click(screen.getByRole('option', { name: /second/u }));
    expect(screen.getByRole('option', { name: /second/u }).getAttribute('aria-selected')).toBe('true');
    rerender(<NetworkInspector entries={[entry('first', 'https://example.test/first', 2), entry('second', 'https://example.test/second', 5)]} selectedEntryId="first" />);
    expect(screen.getByRole('option', { name: /second/u }).getAttribute('aria-selected')).toBe('true');
  });

  it('does not pull focus back to a selected event on every streamed update', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ sequence: index + 1, rawSequence: index + 1, type: 'message', elapsedMs: index }));
    const outside = document.createElement('input');
    document.body.append(outside);
    const { rerender } = render(<VirtualEvents items={items} label="Raw Events" selectedSequence={5} />);
    outside.focus();
    rerender(<VirtualEvents items={[...items.slice(1), { sequence: 21, rawSequence: 21, type: 'message', elapsedMs: 21 }]} label="Raw Events" selectedSequence={5} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('editing safeguards', () => {
  it('reverts a field with Escape without committing the typed value', async () => {
    const post = vi.fn();
    render(<SettingsWorkspace embedded section="general" onSectionChange={vi.fn()} profile={profile} post={post} vscodeFeatures={false} />);
    const user = userEvent.setup();
    const field = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, 'Discarded name');
    await user.keyboard('{Escape}');
    expect(field.value).toBe('Render performance');
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'profile.patch', path: ['name'] }));
  });

  it('closes only the confirmation when Escape is pressed inside a nested dialog', () => {
    const outer = vi.fn();
    function Harness(): React.JSX.Element {
      const [confirm, dialog] = useConfirmAction();
      return <div onKeyDown={(event) => { if (event.key === 'Escape') outer(); }}>
        <button type="button" onClick={() => confirm({ title: 'Delete step?', actionLabel: 'Delete', onConfirm: vi.fn() })}>Delete</button>
        {dialog}
      </div>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('live test-run status', () => {
  function Harness({ operation }: { operation?: TestOperationSnapshot }): React.JSX.Element {
    const statuses = useLiveCaseStatuses(operation);
    return <LiveCaseStatusContext.Provider value={statuses}>
      <LiveCaseStatusBadge scenarioId="a" />
      <LiveCaseStatusBadge suiteId="suite" scenarioId="b" />
      <LiveCaseStatusBadge scenarioId="c" />
    </LiveCaseStatusContext.Provider>;
  }
  const progress = (patch: Partial<NonNullable<TestOperationSnapshot['progress']>>): TestOperationSnapshot => ({ action: 'runSelection', state: 'running', progress: { totalCases: 3, completedCases: 0, totalAttempts: 3, completedAttempts: 0, maxConcurrency: 2, passedCases: 0, failedCases: 0, ...patch } });

  it('accumulates bounded per-message outcomes and marks running cases', () => {
    const { container, rerender } = render(<Harness operation={progress({ activeCases: [{ scenarioId: 'a' }, { suiteId: 'suite', scenarioId: 'b' }] })} />);
    expect([...container.querySelectorAll('.live-case-status')].map((node) => node.textContent)).toEqual(['Running', 'Running']);
    rerender(<Harness operation={progress({ completedCases: 1, passedCases: 1, activeCases: [{ suiteId: 'suite', scenarioId: 'b' }], completedOutcomes: [{ scenarioId: 'a', outcome: 'passed' }] })} />);
    rerender(<Harness operation={progress({ completedCases: 2, passedCases: 1, failedCases: 1, activeCases: [{ scenarioId: 'c' }], completedOutcomes: [{ suiteId: 'suite', scenarioId: 'b', outcome: 'failed' }] })} />);
    expect([...container.querySelectorAll('.live-case-status')].map((node) => node.className.split('--')[1])).toEqual(['passed', 'failed', 'running']);
    rerender(<Harness operation={{ action: 'runSelection', state: 'running', progress: { totalCases: 3, completedCases: 0, totalAttempts: 3, completedAttempts: 0, maxConcurrency: 2 } }} />);
    expect(container.querySelectorAll('.live-case-status')).toHaveLength(0);
  });

  it('validates the optional live-progress fields at the host boundary', () => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'editor-1', requestId: 'r-1', type: 'test.operation' };
    const valid = progress({ activeCases: [{ scenarioId: 'a' }], completedOutcomes: [{ scenarioId: 'b', outcome: 'failed' }], failedCases: 1, completedCases: 1 });
    expect(isHostMessage({ ...envelope, operation: valid }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, operation: progress({ completedOutcomes: [{ scenarioId: 'b', outcome: 'unknown' as 'failed' }] }) }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, operation: progress({ activeCases: Array.from({ length: 9 }, (_, index) => ({ scenarioId: `c${index}` })) }) }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, operation: progress({ passedCases: 4 }) }, 'editor-1')).toBe(false);
  });

  it('shows a pass/fail/running/queued breakdown while keeping the native progress value', () => {
    const operation = progress({ totalCases: 10, completedCases: 4, passedCases: 3, failedCases: 1, activeCases: [{ scenarioId: 'a' }, { scenarioId: 'b' }] });
    const { container } = render(<AutomationWorkspace profile={profile} post={vi.fn()} activeSection="scenarios" testOperation={operation} />);
    expect(container.querySelector('.test-run-tally')?.textContent).toBe('3 passed · 1 failed · 2 running · 4 queued');
    expect((screen.getByRole('progressbar', { name: 'Test run progress' }) as HTMLProgressElement).value).toBe(4);
    expect(container.querySelectorAll('.test-run-meter > span')).toHaveLength(4);
  });
});
