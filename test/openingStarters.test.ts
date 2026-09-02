import { describe, expect, it } from 'vitest';
import { MAX_OPENING_STARTERS, normalizeOpeningStarters } from '../src/extension/opening/starterNormalizer';

describe('opening starter normalization', () => {
  it('turns common string choices into visible send prompts', () => {
    expect(normalizeOpeningStarters(['  Show a sample overview  '])).toEqual([
      { id: 'starter-1', label: 'Show a sample overview', prompt: 'Show a sample overview', behavior: 'send' },
    ]);
  });

  it('preserves valid choices and derives missing display labels from prompt-like fields', () => {
    expect(normalizeOpeningStarters([
      { id: 'valid', label: 'Valid label', prompt: 'Valid prompt', behavior: 'fill' },
      { id: 'prompt-only', prompt: 'Prompt only' },
      { title: 'Titled choice', value: 'submitted value' },
    ])).toEqual([
      { id: 'valid', label: 'Valid label', prompt: 'Valid prompt', behavior: 'fill' },
      { id: 'prompt-only', label: 'Prompt only', prompt: 'Prompt only', behavior: 'send' },
      { id: 'submitted value', label: 'Titled choice', prompt: 'submitted value', behavior: 'send' },
    ]);
  });

  it('filters blank choices, makes ids unique, and never promotes malformed data to an action', () => {
    expect(normalizeOpeningStarters([
      '',
      null,
      { id: 'same', label: 'First', prompt: 'First', behavior: 'action' },
      { id: 'same', label: 'Second', prompt: 'Second', behavior: 'action', actionId: 'safe-action' },
      { id: 'unused' },
    ])).toEqual([
      { id: 'same', label: 'First', prompt: 'First', behavior: 'send' },
      { id: 'same-2', label: 'Second', prompt: 'Second', behavior: 'action', actionId: 'safe-action' },
    ]);
  });

  it('bounds adversarially large option lists', () => {
    const result = normalizeOpeningStarters(Array.from({ length: MAX_OPENING_STARTERS + 25 }, (_, index) => `Choice ${index + 1}`));
    expect(result).toHaveLength(MAX_OPENING_STARTERS);
    expect(result.at(-1)?.label).toBe(`Choice ${MAX_OPENING_STARTERS}`);
  });
});
