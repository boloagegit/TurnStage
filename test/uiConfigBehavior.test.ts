import { describe, expect, it } from 'vitest';
import type { TurnStageProfile } from '../src/shared/types';
import { DEFAULT_MESSAGE_ACTIONS, resolveComposer, resolveMessageActions, resolveUiLayout } from '../src/webview/uiConfig';

function profile(messageActions?: string[]): TurnStageProfile {
  return {
    version: 1,
    id: 'ui-config-test',
    name: 'UI config test',
    conversation: { send: { method: 'POST', url: 'https://example.test' } },
    stream: { transport: 'sse', mappings: [] },
    ui: messageActions === undefined ? undefined : { messageActions },
  };
}

describe('profile-driven UI behavior', () => {
  it('resolves every layout preset into an observable workspace behavior', () => {
    expect(resolveUiLayout({ layout: { preset: 'chat-only' } })).toMatchObject({ showInspector: false, compact: false });
    expect(resolveUiLayout({ layout: { preset: 'split-inspector', inspectorPosition: 'bottom' } })).toMatchObject({ showInspector: true, inspectorPosition: 'bottom' });
    expect(resolveUiLayout({ layout: { preset: 'chat-with-metrics' } })).toMatchObject({ showInspector: true, initialInspectorTab: 'Metrics' });
    expect(resolveUiLayout({ layout: { preset: 'compact' } })).toMatchObject({ showInspector: true, compact: true, inspectorWidth: 320 });
  });

  it('clamps configured inspector width to the supported range', () => {
    expect(resolveUiLayout({ layout: { inspectorWidth: 100 } }).inspectorWidth).toBe(240);
    expect(resolveUiLayout({ layout: { inspectorWidth: 360 } }).inspectorWidth).toBe(360);
    expect(resolveUiLayout({ layout: { inspectorWidth: 2000 } }).inspectorWidth).toBe(960);
  });

  it('resolves composer defaults and explicit single-line behavior', () => {
    expect(resolveComposer()).toEqual({ placeholder: '', multiline: true, enterBehavior: 'send', shiftEnterBehavior: 'newline', showStopWhileStreaming: true });
    expect(resolveComposer({ composer: { placeholder: 'Ask', multiline: false, enterBehavior: 'newline', shiftEnterBehavior: 'send', showStopWhileStreaming: false } })).toEqual({ placeholder: 'Ask', multiline: false, enterBehavior: 'newline', shiftEnterBehavior: 'send', showStopWhileStreaming: false });
  });

  it('uses the declared message action order and applies role capabilities', () => {
    expect(resolveMessageActions(profile(), 'assistant', true)).toEqual(DEFAULT_MESSAGE_ACTIONS);
    expect(resolveMessageActions(profile(['message.inspectRaw', 'message.copy', 'message.retry']), 'user', true)).toEqual(['message.inspectRaw', 'message.copy']);
    expect(resolveMessageActions(profile(['message.retry', 'message.editAndResend', 'message.copy']), 'assistant', false)).toEqual(['message.retry', 'message.editAndResend', 'message.copy']);
  });

  it('allows an empty toolbar and ignores unsupported action IDs defensively', () => {
    expect(resolveMessageActions(profile([]), 'assistant', true)).toEqual([]);
    expect(resolveMessageActions(profile(['unknown.action', 'message.copy']), 'assistant', true)).toEqual(['message.copy']);
    expect(resolveMessageActions(profile(['message.copy', 'message.copy']), 'assistant', true)).toEqual(['message.copy']);
  });
});
