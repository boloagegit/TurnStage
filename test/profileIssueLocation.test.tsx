// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIssueScope } from '../src/shared/profileIssueScope';
import { issuePathText, issueSection, issueTarget } from '../src/webview/profileIssueLocation';
import { isHostMessage, PROTOCOL_VERSION } from '../src/shared/protocol';
import { ProfileValidator } from '../src/extension/config/profileValidator';
import type { TurnStageProfile } from '../src/shared/types';
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

  it('keeps a path the validator already named, even for a value missing from the text', () => {
    expect(withIssueScope('{"a":1}', [{ offset: 0, path: ['stream', 'mappings', 2] }])[0]?.path).toEqual(['stream', 'mappings', 2]);
    const profile = { version: 1, id: 'p', name: 'P', conversation: { send: { method: 'POST', url: 'https://x.test' } }, stream: { transport: 'sse', mappings: [{ id: 'd', match: { event: 'done' }, emit: { type: 'stream.completed' } }] } } as TurnStageProfile;
    const missing = new ProfileValidator().validate(profile, undefined).find((issue) => issue.message === 'At least one request variant is required.');
    expect(missing?.path).toEqual(['conversation', 'send', 'variants']);
    expect(issueSection(missing?.path)).toBe('opening-flow');
  });

  it('cuts overlong keys so the Webview still accepts the diagnostics', () => {
    const key = 'k'.repeat(300);
    const text = `{"tests":{"reporting":{"${key}":1}}}`;
    const [issue] = withIssueScope(text, [{ severity: 'error' as const, message: 'Unknown key', offset: text.indexOf(':1') + 1, length: 1 }]);
    expect((issue!.path[2] as string).length).toBe(256);
    const envelope = { protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'editor-1', requestId: 'request-1' };
    expect(isHostMessage({ ...envelope, type: 'profile.validation', diagnostics: [issue] }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'profile.validation', diagnostics: [{ ...issue, path: ['x'.repeat(257)] }] }, 'editor-1')).toBe(false);
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
    expect(issueSection(['tests', 'reporting'])).toBe('scenario-tests');
    expect(issueSection(['tests', 'scenarios', 0])).toBeUndefined();
    expect(issueSection(undefined)).toBe('general');
    expect(issuePathText(['opening', 'starters', 2, 'actionId'])).toBe('opening.starters[2].actionId');
  });

  it('sends test-case issues to the pane that edits the case', () => {
    const profile = { tests: { scenarios: [{ id: 'a' }, { id: 'b', adversarial: {} }] } } as unknown as TurnStageProfile;
    expect(issueTarget(['tests', 'scenarios', 0, 'steps'], profile)).toEqual({ kind: 'cases', pane: 'tests', section: 'scenarios' });
    expect(issueTarget(['tests', 'scenarios', 1, 'steps'], profile)).toEqual({ kind: 'cases', pane: 'adversarial', section: 'cases' });
    expect(issueTarget(['tests', 'campaigns', 0], profile)).toEqual({ kind: 'cases', pane: 'adversarial', section: 'campaigns' });
    expect(issueTarget(['tests', 'contractSuites', 0], profile)).toEqual({ kind: 'cases', pane: 'tests', section: 'scenarios' });
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
    expect(onGoTo).toHaveBeenCalledWith({ kind: 'settings', section: 'request' });
    expect(screen.getByText('1 more')).toBeTruthy();
  });

  it('names a test pane without a button unless the caller can open it', async () => {
    const caseIssue = [{ severity: 'error' as const, message: 'Step input is required.', path: ['tests', 'scenarios', 0, 'steps', 0, 'input'] }];
    const { unmount } = render(<ProfileIssueList issues={caseIssue} onGoTo={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('General tests')).toBeTruthy();
    unmount();
    const onGoTo = vi.fn();
    render(<ProfileIssueList issues={caseIssue} onGoTo={onGoTo} canGoTo={() => true} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go to General tests: Step input is required.' }));
    expect(onGoTo).toHaveBeenCalledWith({ kind: 'cases', pane: 'tests', section: 'scenarios' });
  });
});
