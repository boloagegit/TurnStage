import { describe, expect, it } from 'vitest';
import { normalizeNetworkInspectorState, normalizeScrollPosition, normalizeWebviewState, shouldApplyProfileInspectorDefault } from '../src/webview/main';

describe('Webview UI checkpoint', () => {
  it('restores a bounded v2 checkpoint without accepting arbitrary scroll keys', () => {
    const restored = normalizeWebviewState({
      version: 2,
      section: 'security',
      configurationSection: 'security',
      rightPaneMode: 'configure',
      inspectorTab: 'Runs',
      splitPercent: 92,
      splitCustomized: true,
      selectedRawSequence: 9,
      expandedAdversarialCaseId: 'case-1',
      acceptedForms: ['message-1:contact', 'message-1:contact'],
      collapsedEventTurns: { raw: ['turn-1', 'turn-1'], normalized: ['turn-2'] },
      scrollPositions: { chat: 423.6, 'configure.security': 812, arbitrary: 999, 'events.raw': Number.POSITIVE_INFINITY },
      networkInspector: { query: 'timeout', selectedId: 'stream-2', detailTab: 'Timing' }
    });

    expect(restored).toMatchObject({
      version: 2,
      section: 'security',
      configurationSection: 'security',
      rightPaneMode: 'configure',
      inspectorTab: 'Runs',
      splitPercent: 90,
      splitCustomized: true,
      selectedRawSequence: 9,
      expandedAdversarialCaseId: 'case-1',
      acceptedForms: ['message-1:contact'],
      collapsedEventTurns: { raw: ['turn-1'], normalized: ['turn-2'] },
      scrollPositions: { chat: 424, 'configure.security': 812 },
      networkInspector: { query: 'timeout', selectedId: 'stream-2', detailTab: 'Timing' }
    });
    expect(restored?.scrollPositions).not.toHaveProperty('arbitrary');
    expect(restored?.scrollPositions).not.toHaveProperty('events.raw');
  });

  it('migrates the legacy Request tab and only applies profile defaults without a saved inspector tab', () => {
    const legacy = normalizeWebviewState({ inspectorTab: 'Request' });
    expect(legacy?.inspectorTab).toBe('Network');
    expect(shouldApplyProfileInspectorDefault(legacy)).toBe(false);
    expect(shouldApplyProfileInspectorDefault(normalizeWebviewState({ rightPaneMode: 'debug' }))).toBe(true);
  });

  it('fails closed for malformed, oversized, and non-finite transient state', () => {
    expect(normalizeWebviewState(null)).toBeUndefined();
    const restored = normalizeWebviewState({
      rightPaneMode: 'unknown',
      inspectorTab: 'Unknown',
      selectedRawSequence: -1,
      expandedAdversarialCaseId: 'x'.repeat(513),
      acceptedForms: ['ok', 42, 'x'.repeat(513)],
      collapsedEventTurns: { raw: ['ok', 42, 'x'.repeat(513)], normalized: 'bad' },
      scrollPositions: { chat: -20, adversarial: 99_999_999 },
      networkInspector: { query: 'q'.repeat(600), selectedId: 'x'.repeat(513), detailTab: 'Unknown' }
    });
    expect(restored).toEqual({
      version: 2,
      scrollPositions: { chat: 0, adversarial: 10_000_000 },
      networkInspector: { query: 'q'.repeat(512), detailTab: 'Headers' },
      collapsedEventTurns: { raw: ['ok'], normalized: [] },
      acceptedForms: ['ok']
    });
    expect(normalizeScrollPosition(Number.NaN)).toBe(0);
    expect(normalizeNetworkInspectorState(undefined)).toEqual({ query: '', detailTab: 'Headers' });
  });
});
