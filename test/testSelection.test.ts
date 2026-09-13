import { describe, expect, it } from 'vitest';
import { resolveTestSelection, type SelectableTestCase } from '../src/shared/testSelection';

const base = { profileId: 'profile', scenarioId: 'same', ready: true } as const;
const entries: SelectableTestCase[] = [
  { ...base, kind: 'contract' },
  { ...base, kind: 'adversarial' },
  { ...base, suiteId: 'other-suite', kind: 'contract' },
  { profileId: 'profile', scenarioId: 'draft', kind: 'contract', ready: false },
];

describe('formal test selection', () => {
  it('keeps kinds and full suite identities separate', () => {
    expect(resolveTestSelection(entries, { kind: 'adversarial' })).toEqual([entries[1]]);
    expect(resolveTestSelection(entries, { cases: [{ profileId: 'profile', scenarioId: 'same', suiteId: 'other-suite', kind: 'contract' }] })).toEqual([entries[2]]);
  });

  it('never treats a draft, missing case, or empty scope as a successful run', () => {
    expect(resolveTestSelection(entries, { kind: 'contract' })).toHaveLength(2);
    expect(() => resolveTestSelection(entries, { cases: [{ profileId: 'profile', scenarioId: 'draft', kind: 'contract' }] })).toThrow(/missing or still need review/u);
    expect(() => resolveTestSelection(entries, { cases: [] })).toThrow(/Select at least one/u);
  });

  it('rejects duplicate case identities before execution', () => {
    expect(() => resolveTestSelection([...entries, entries[0]!], { kind: 'contract' })).toThrow(/same profile/u);
  });
});
