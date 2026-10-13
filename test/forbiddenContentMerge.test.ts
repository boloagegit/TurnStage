import { describe, expect, it } from 'vitest';
import { mergeContentPhrases } from '../src/webview/SettingsWorkspace';

describe('forbidden content phrases', () => {
  const regex = { id: undefined, pattern: 'secret-\\d+' } as unknown as Exclude<NonNullable<Parameters<typeof mergeContentPhrases>[0]>[number], string>;

  it('keeps regex rules at their positions when a phrase is edited', () => {
    expect(mergeContentPhrases(['first', regex, 'second'], ['first edited', 'second'])).toEqual(['first edited', regex, 'second']);
  });

  it('appends new phrases and drops removed ones from the end of the string slots', () => {
    expect(mergeContentPhrases([regex, 'only'], ['only', 'added'])).toEqual([regex, 'only', 'added']);
    expect(mergeContentPhrases(['a', regex, 'b'], ['a'])).toEqual(['a', regex]);
    expect(mergeContentPhrases(undefined, ['x'])).toEqual(['x']);
  });
});
