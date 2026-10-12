import { describe, expect, it } from 'vitest';
import { describeAssertion } from '../src/webview/assertionSummary';
import { suggestedCaptureAssertions } from '../src/extension/testing/scenarioCapture';
import type { SessionSnapshot } from '../src/shared/types';

describe('check summaries', () => {
  it('describes every suggested capture check in plain words', () => {
    const snapshot = {
      messages: [{ id: 'a', role: 'assistant', status: 'completed', createdAt: 1, parts: [{ type: 'text', text: 'Hi' }], citations: [], actions: [], followups: [] }],
      normalizedEvents: [{ version: 1, type: 'tool.started', name: 'search', sequence: 1, receivedAt: 1 }, { version: 1, type: 'stream.completed', sequence: 2, receivedAt: 2 }],
      metrics: { eventCount: 2, byteCount: 1, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 },
    } as unknown as SessionSnapshot;
    const summaries = suggestedCaptureAssertions(snapshot).map(describeAssertion);
    expect(summaries).toEqual([
      'The turn completes.',
      'These events occur in this order: tool.started → stream.completed',
      'The tool search is called',
      'The reply is not empty.',
      'No stream data fails to parse.',
      'No stream event fails its mapping.',
    ]);
  });

  it('leaves unfamiliar checks to their fields', () => {
    expect(describeAssertion({ path: 'metrics.ttft', operator: 'lessThan', value: 2000 })).toBeUndefined();
  });
});
