// @vitest-environment jsdom

import { parseTree } from 'jsonc-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageProfile } from '../src/shared/types';
import { deleteProfileDraft, loadProfileDraft, saveProfileDraft, sourceFingerprint } from '../web/src/profileDrafts';
import { schemaDiagnostics, webCompatibilityDiagnostics } from '../web/src/profileSourceDiagnostics';

const base: TurnStageProfile = {
  version: 1,
  id: 'diagnostic-test',
  name: 'Diagnostic test',
  environment: 'local',
  conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat', variants: [{ id: 'headers-only', headers: { 'X-Test': 'yes' } }] } },
  stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
};

describe('profile source validation', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage);
  });

  it('accepts runtime-supported control, opening, stop, history, and headers-only variant fields', () => {
    const profile = {
      ...base,
      controls: [{ id: 'user', type: 'select', label: 'User', default: { custid: 'C001' }, resetOnNewConversation: false, options: [{ label: 'A', value: { custid: 'C001' } }] }],
      opening: { mode: 'static', trigger: 'sessionStart', message: 'Hello', fallbacks: [], failurePolicy: { allowRetry: true, useFallbackOnNetworkError: true } },
      conversation: { ...base.conversation, stop: { strategy: 'abortOnly', onMissingContext: 'localAbortWithWarning', preservePartialContent: true, appendSystemNotice: true } },
      history: { localRuns: { enabled: true, maxRuns: 10 } },
      errorPolicy: { preservePartialContent: true, showErrorPart: true, keepConversationId: true, allowContinuation: true, releaseAllLocks: true },
    } as TurnStageProfile;
    expect(schemaDiagnostics(profile, parseTree(JSON.stringify(profile)))).toEqual([]);
  });

  it('reports unsupported settings and Web-only capability differences at their source offsets', () => {
    const profile = { ...base, controls: [{ id: 'bad', type: 'text', label: 'Bad', unexpected: true }], tests: { scenarios: [{ id: 's', name: 'S', steps: [], faults: { disconnectAfterEvents: 1 }, performance: { regression: { 'scenario.durationMs': { maxIncreaseMs: 100 } } } }] } } as unknown as TurnStageProfile;
    const raw = JSON.stringify(profile, null, 2);
    const tree = parseTree(raw);
    expect(schemaDiagnostics(profile, tree).some((item) => item.code === 'schema.additionalProperties' && item.offset > 0)).toBe(true);
    const compatibility = webCompatibilityDiagnostics(profile, tree, []);
    expect(compatibility.map((item) => item.code)).toEqual(expect.arrayContaining(['web.unsupported.faults', 'web.unsupported.performance']));
  });

  it('persists, restores, and removes browser-local drafts without changing the base source', () => {
    saveProfileDraft(base.id, '{"base":true}', '{"draft":true}');
    expect(loadProfileDraft(base.id)).toMatchObject({ profileId: base.id, baseFingerprint: sourceFingerprint('{"base":true}'), draft: '{"draft":true}' });
    deleteProfileDraft(base.id);
    expect(loadProfileDraft(base.id)).toBeUndefined();
  });
});
