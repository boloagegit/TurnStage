import { describe, expect, it } from 'vitest';
import { DEFAULT_INSPECTOR_TAB, normalizeNetworkInspectorState, normalizeScrollPosition, normalizeWebviewState, shouldApplyProfileInspectorDefault } from '../src/webview/main';

describe('Webview UI checkpoint', () => {
  it('migrates a bounded checkpoint with independent Tests and Red Team scroll positions', () => {
    const restored = normalizeWebviewState({
      version: 4,
      section: 'security',
      configurationSection: 'security',
      rightPaneMode: 'configure',
      testsSection: 'campaigns',
      redTeamSection: 'campaigns',
      selectedCampaignId: 'campaign-1',
      inspectorTab: 'Runs',
      splitPercent: 92,
      splitCustomized: true,
      selectedRawSequence: 9,
      expandedAdversarialCaseId: 'case-1',
      adversarialCaseCollection: { query: 'privacy', mode: 'multiTurn', source: 'linked:tests/security.csv', tag: 'security', sort: 'name', page: 3, pageSize: 50 },
      adversarialResultCollection: { query: 'leak', outcome: 'attackSucceeded', stability: 'unstable', page: 2, pageSize: 50 },
      acceptedForms: ['message-1:contact', 'message-1:contact'],
      collapsedEventTurns: { raw: ['turn-1', 'turn-1'], normalized: ['turn-2'] },
      scrollPositions: { chat: 423.6, 'tests.scenarios': 240, 'adversarial.results': 120, 'adversarial.cases': 640, adversarial: 999, 'configure.security': 812, arbitrary: 999, 'events.raw': Number.POSITIVE_INFINITY },
      networkInspector: { query: 'timeout', selectedId: 'stream-2', detailTab: 'Timing' }
    });

    expect(restored).toMatchObject({
      version: 6,
      section: 'security',
      configurationSection: 'security',
      rightPaneMode: 'configure',
      testsSection: 'campaigns',
      redTeamSection: 'campaigns',
      selectedCampaignId: 'campaign-1',
      inspectorTab: 'Runs',
      splitPercent: 90,
      splitCustomized: true,
      selectedRawSequence: 9,
      expandedAdversarialCaseId: 'case-1',
      adversarialCaseCollection: { query: 'privacy', mode: 'multiTurn', source: 'linked:tests/security.csv', tag: 'security', sort: 'name', page: 3, pageSize: 50 },
      adversarialResultCollection: { query: 'leak', outcome: 'attackSucceeded', stability: 'unstable', page: 2, pageSize: 50 },
      acceptedForms: ['message-1:contact'],
      collapsedEventTurns: { raw: ['turn-1'], normalized: ['turn-2'] },
      scrollPositions: { chat: 424, 'tests.scenarios': 240, 'adversarial.results': 120, 'adversarial.cases': 640, 'configure.security': 812 },
      networkInspector: { query: 'timeout', selectedId: 'stream-2', detailTab: 'Timing' }
    });
    expect(restored?.scrollPositions).not.toHaveProperty('arbitrary');
    expect(restored?.scrollPositions).not.toHaveProperty('events.raw');
    expect(restored?.scrollPositions).not.toHaveProperty('adversarial');
  });

  it('migrates the legacy Request tab and only applies profile defaults without a saved inspector tab', () => {
    expect(DEFAULT_INSPECTOR_TAB).toBe('Network');
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
      scrollPositions: { chat: -20, adversarial: 99_999_999, 'adversarial.timeline': 99_999_999 },
      networkInspector: { query: 'q'.repeat(600), selectedId: 'x'.repeat(513), detailTab: 'Unknown' }
    });
    expect(restored).toEqual({
      version: 6,
      scrollPositions: { chat: 0, 'adversarial.timeline': 10_000_000 },
      adversarialCaseCollection: { query: '', mode: 'all', source: 'all', tag: 'all', sort: 'sourceOrder', page: 0, pageSize: 25 },
      adversarialResultCollection: { query: '', outcome: 'all', stability: 'all', attentionOnly: false, page: 0, pageSize: 25 },
      networkInspector: { query: 'q'.repeat(512), detailTab: 'Headers' },
      collapsedEventTurns: { raw: ['ok'], normalized: [] },
      acceptedForms: ['ok']
    });
    expect(normalizeScrollPosition(Number.NaN)).toBe(0);
    expect(normalizeNetworkInspectorState(undefined)).toEqual({ query: '', detailTab: 'Headers' });
  });
});
