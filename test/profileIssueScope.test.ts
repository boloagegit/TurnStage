import { describe, expect, it } from 'vitest';
import { blocksSession, profileIssueScope, withIssueScope } from '../src/shared/profileIssueScope';

const text = JSON.stringify({ id: 'p', conversation: { send: { url: '' } }, tests: { scenarios: [{ id: 'draft', steps: [{ id: 'turn', input: '' }] }] } }, null, 2);

describe('Profile issue scope', () => {
  it('treats errors inside test cases as non-blocking for chat', () => {
    const testOffset = text.indexOf('"input"') + '"input": '.length;
    const chatOffset = text.indexOf('"url"') + '"url": '.length;
    expect(profileIssueScope(text, testOffset)).toBe('tests');
    expect(profileIssueScope(text, chatOffset)).toBeUndefined();
    const issues = withIssueScope(text, [
      { severity: 'error' as const, message: 'Input is required.', offset: testOffset, length: 2 },
      { severity: 'error' as const, message: 'URL is required.', offset: chatOffset, length: 2 },
      { severity: 'warning' as const, message: 'Unused.', offset: 0, length: 1 },
    ]);
    expect(issues.map((issue) => issue.scope)).toEqual(['tests', undefined, undefined]);
    expect(issues.map(blocksSession)).toEqual([false, true, false]);
  });
});
