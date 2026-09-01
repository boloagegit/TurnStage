import { describe, expect, it } from 'vitest';
import type { TurnStageProfile } from '../src/shared/types';
import { clampSplit, DEFAULT_SPLIT_PERCENT, initialSplitPercent, splitTrackSizes } from '../src/webview/main';
import { DEFAULT_MESSAGE_ACTIONS, resolveComposer, resolveMessageActions, resolveMessageActionVisibility, resolveStreaming, resolveUiLayout } from '../src/webview/uiConfig';

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
  it('gives the primary chat workspace more room than the supporting inspector', () => {
    expect(DEFAULT_SPLIT_PERCENT).toBe(64);
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT_PERCENT);
    expect(clampSplit(-100)).toBe(10);
    expect(clampSplit(1_000)).toBe(90);
  });
  it('keeps the split ratio as the layout source of truth without percentage feedback', () => {
    expect(splitTrackSizes(64)).toEqual({ preview: '64fr', inspector: '36fr' });
    expect(splitTrackSizes(64, 360)).toEqual({ preview: '1fr', inspector: '360px' });
    expect(splitTrackSizes(64, 360, true)).toEqual({ preview: '64fr', inspector: '36fr' });
  });
  it('discards legacy auto-shrunk state while preserving an explicit user resize', () => {
    expect(initialSplitPercent(28, false)).toBe(DEFAULT_SPLIT_PERCENT);
    expect(initialSplitPercent(72, true)).toBe(72);
    expect(initialSplitPercent(undefined, true)).toBe(DEFAULT_SPLIT_PERCENT);
  });
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

  it('resolves bounded Assistant streaming effects and parameters', () => {
    expect(resolveStreaming()).toEqual({ reveal: 'adaptive', indicator: 'caret', pace: 'balanced', maxVisualLagMs: 600, effect: 'caret', speedMs: 900, intensityPercent: 70 });
    expect(resolveStreaming({ streaming: { reveal: 'event', indicator: 'dots', pace: 'fast', maxVisualLagMs: 800, speedMs: 1_200, intensityPercent: 80 } })).toEqual({ reveal: 'event', indicator: 'dots', pace: 'fast', maxVisualLagMs: 800, effect: 'dots', speedMs: 1_200, intensityPercent: 80 });
    expect(resolveStreaming({ streaming: { reveal: 'unknown' as 'adaptive', indicator: 'typewriter' as 'caret', pace: 'rushed' as 'fast', maxVisualLagMs: 10, speedMs: 100, intensityPercent: 250 } })).toEqual({ reveal: 'adaptive', indicator: 'caret', pace: 'balanced', maxVisualLagMs: 100, effect: 'caret', speedMs: 400, intensityPercent: 100 });
    expect(resolveStreaming({ streaming: { effect: 'shimmer' } })).toMatchObject({ indicator: 'shimmer', effect: 'shimmer' });
  });

  it('uses the declared message action order and applies role capabilities', () => {
    expect(resolveMessageActions(profile(), 'assistant', true)).toEqual(DEFAULT_MESSAGE_ACTIONS);
    expect(resolveMessageActions(profile(['message.inspectRaw', 'message.copy', 'message.retry']), 'user', true)).toEqual(['message.inspectRaw', 'message.copy']);
    expect(resolveMessageActions(profile(['message.retry', 'message.editAndResend', 'message.copy']), 'assistant', false)).toEqual(['message.retry', 'message.editAndResend', 'message.copy']);
  });

  it('keeps message actions visible by default and supports interaction-only profiles', () => {
    expect(resolveMessageActionVisibility()).toBe('always');
    expect(resolveMessageActionVisibility({ messageActionVisibility: 'always' })).toBe('always');
    expect(resolveMessageActionVisibility({ messageActionVisibility: 'interaction' })).toBe('interaction');
    expect(resolveMessageActionVisibility({ messageActionVisibility: 'hidden' as 'always' })).toBe('always');
  });

  it('allows an empty toolbar and ignores unsupported action IDs defensively', () => {
    expect(resolveMessageActions(profile([]), 'assistant', true)).toEqual([]);
    expect(resolveMessageActions(profile(['unknown.action', 'message.copy']), 'assistant', true)).toEqual(['message.copy']);
    expect(resolveMessageActions(profile(['message.copy', 'message.copy']), 'assistant', true)).toEqual(['message.copy']);
  });
});
