import { describe, expect, it } from 'vitest';
import { isSafeRegexPattern } from '../src/shared/regexSafety';

describe('regex safety policy', () => {
  it('accepts bounded ordinary validation patterns', () => {
    for (const pattern of ['', '^hello(?: world)?$', '[A-Z0-9_-]{1,32}', 'error|failed']) expect(isSafeRegexPattern(pattern)).toBe(true);
  });

  it('rejects backreferences, lookarounds, nested repetition, ambiguous repeated alternation, and repeated wildcards', () => {
    for (const pattern of ['(a+)+$', '(a|aa)+$', '(.*)*', '(?=secret).*', '(a)\\1', '.*middle.*end']) expect(isSafeRegexPattern(pattern)).toBe(false);
    expect(isSafeRegexPattern('x'.repeat(257))).toBe(false);
    expect(isSafeRegexPattern('[')).toBe(false);
  });
});
