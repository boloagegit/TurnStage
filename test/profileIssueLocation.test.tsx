// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIssueScope } from '../src/shared/profileIssueScope';
import { issuePathText, issueSection } from '../src/webview/profileIssueLocation';
import { ProfileIssueList } from '../src/webview/ProfileIssueList';

afterEach(cleanup);

describe('where a Profile issue is', () => {
  it('records the path of the value an issue points at, on both hosts', () => {
    const text = '{\n  "opening": { "starters": [{ "id": "a", "behavior": "action" }] },\n  "tests": { "scenarios": [] }\n}';
    const issues = withIssueScope(text, [
      { severity: 'error' as const, message: 'Unknown starter action id', offset: text.indexOf('[{'), length: 1 },
      { severity: 'error' as const, message: 'Bad behavior', offset: text.indexOf('"action"'), length: 8 },
      { severity: 'error' as const, message: 'Scenarios', offset: text.indexOf('[]'), length: 2 },
      { severity: 'error' as const, message: 'Root', offset: 0, length: 1 },
    ]);
    expect(issues.map((issue) => issue.path)).toEqual([['opening', 'starters'], ['opening', 'starters', 0, 'behavior'], ['tests', 'scenarios'], []]);
    expect(issues[2]?.scope).toBe('tests');
  });

  it('keeps a path the validator already named', () => {
    expect(withIssueScope('{"a":1}', [{ offset: 0, path: ['stream', 'mappings', 2] }])[0]?.path).toEqual(['stream', 'mappings', 2]);
  });

  it('maps each path to the settings section that edits it', () => {
    expect(issueSection(['opening', 'starters'])).toBe('opening-flow');
    expect(issueSection(['conversation', 'send', 'variants', 0, 'body'])).toBe('opening-flow');
    expect(issueSection(['conversation', 'stop', 'request', 'url'])).toBe('opening-flow');
    expect(issueSection(['conversation', 'send', 'url'])).toBe('request');
    expect(issueSection(['stream', 'mappings', 1])).toBe('stream-mapping');
    expect(issueSection(['ui', 'messageActions'])).toBe('chat-ui');
    expect(issueSection(['errorPolicy'])).toBe('history-errors');
    expect(issueSection(['metrics', 'enabled'])).toBe('history-errors');
    expect(issueSection(['security', 'allowedDomains'])).toBe('security');
    expect(issueSection([])).toBe('general');
    expect(issueSection(undefined)).toBe('general');
    expect(issuePathText(['opening', 'starters', 2, 'actionId'])).toBe('opening.starters[2].actionId');
  });
});

describe('ProfileIssueList', () => {
  const issues = [
    { severity: 'error' as const, message: 'Unknown starter action id: open-docs.', path: ['opening', 'starters'] },
    { severity: 'error' as const, message: 'A request URL is required.', path: ['conversation', 'send', 'url'] },
    { severity: 'error' as const, message: 'Third', path: ['security'] },
  ];

  it('says what is wrong and where, and opens that section', async () => {
    const onGoTo = vi.fn();
    render(<ProfileIssueList issues={issues} limit={2} onGoTo={onGoTo} />);
    expect(screen.getByText('opening.starters')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go to Request: A request URL is required.' }));
    expect(onGoTo).toHaveBeenCalledWith('request');
    expect(screen.getByText('1 more')).toBeTruthy();
  });
});
