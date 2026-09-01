import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/types';
import { buildEventTurnGroups, flattenEventTree } from '../src/webview/main';

describe('event turn grouping', () => {
  it('groups and flattens 5,000 retained events without unbounded rendering work', () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, turnIndex) => ({
      id: `user-${turnIndex}`,
      role: 'user',
      status: 'completed',
      createdAt: turnIndex,
      parts: [{ type: 'text', text: `Attack case ${turnIndex} with a bounded prompt excerpt.` }],
      citations: [], actions: [], followups: [], metadata: { clientRequestId: `turn-${turnIndex}` },
    }));
    const events = Array.from({ length: 5_000 }, (_, index) => {
      const turnIndex = Math.floor(index / 50);
      return { sequence: index + 1, rawSequence: index + 1, turnId: `turn-${turnIndex}`, turnIndex, turnSequence: (index % 50) + 1, elapsedMs: index % 50, type: index % 50 === 49 ? 'stream.completed' : 'content.text.delta' };
    });

    const startedAt = performance.now();
    const groups = buildEventTurnGroups(events, messages, 'normalized', new Set());
    const collapsedRows = flattenEventTree(groups, new Set(groups.map((group) => group.key)));
    const expandedRows = flattenEventTree(groups, new Set());
    const elapsed = performance.now() - startedAt;

    expect(groups).toHaveLength(100);
    expect(groups[0]).toMatchObject({ key: 'turn-0', durationMs: 49, terminal: true });
    expect(groups[0]?.excerpt).toContain('Attack case 0');
    expect(collapsedRows).toHaveLength(100);
    expect(expandedRows).toHaveLength(5_100);
    expect(elapsed).toBeLessThan(250);
  });
});
