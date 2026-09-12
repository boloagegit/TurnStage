import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { HostPayload } from '../src/shared/protocol';
import type { TurnStageProfile } from '../src/shared/types';
import { createSnapshot } from '../src/extension/runtime/reducer';
import { WebInsightsController } from '../web/src/webInsightsController';

describe('WebInsightsController', () => {
  it('reports observed browser stream and mapping gaps without guessing proxy state', () => {
    const profile: TurnStageProfile = { version: 1, id: 'insights', name: 'Insights', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] } };
    const snapshot = createSnapshot(true);
    snapshot.metrics.unmatchedEventCount = 2;
    const posted: HostPayload[] = [];
    const controller = new WebInsightsController(() => profile, () => ({ snapshot, networkEntries: [{ id: 'n', kind: 'stream', attempt: 1, state: 'completed', method: 'POST', url: 'https://example.test', requestHeaders: {}, startedAt: 1, completedAt: 2, timing: {}, transferredBytes: 0, eventCount: 0, status: 200 }] }), (payload) => posted.push(payload));

    controller.analyzeConnection();

    expect(posted[0]).toMatchObject({ type: 'connection.result', result: { protocol: 'sse', confidence: 'medium', status: 200, unmatchedEventCount: 2, safe: false, networkPath: { route: 'unknown', confidence: 'low' } } });
  });
});
