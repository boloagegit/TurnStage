// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdversarialCaseCatalog, ContractCaseCatalog } from '../src/shared/protocol';
import type { TurnStageProfile } from '../src/shared/types';
import { AdversarialWorkspace, AutomationWorkspace } from '../src/webview/SettingsWorkspace';

afterEach(() => cleanup());

const profile: TurnStageProfile = { version: 1, id: 'profile', name: 'Profile', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [], contractSuites: ['tests/general.tests.jsonc'], adversarialSuites: ['tests/red.csv'] } };
const contractCatalog: ContractCaseCatalog = { total: 60, truncated: false, issues: [], entries: Array.from({ length: 60 }, (_, index) => ({ sourcePath: 'tests/general.tests.jsonc', suiteId: 'general', suiteName: 'General', scenarioId: `case-${index + 1}`, scenarioName: `General case ${index + 1}`, tags: [], turns: 1, assertions: 1, comparison: false, performance: false, faults: false, revision: 'a'.repeat(64) })) };
const redCatalog: AdversarialCaseCatalog = { total: 60, truncated: false, issues: [], entries: Array.from({ length: 60 }, (_, index) => ({ sourcePath: 'tests/red.csv', suiteId: 'red', suiteName: 'Red', scenarioId: `case-${index + 1}`, scenarioName: `Red case ${index + 1}`, tags: [], mode: 'singleTurn', turns: 1, maxTurns: 1, repetitions: 1, timeoutMs: 60_000, prohibit: { content: 0, events: 0, urls: true, ctas: false, tools: false }, revision: 'b'.repeat(64) })) };

describe('opening a case from the unified list', () => {
  it('opens a linked general case even when it is outside the current 25-row page', async () => {
    const post = vi.fn();
    render(<AutomationWorkspace profile={profile} post={post} activeSection="scenarios" expandedCaseId="contract-linked:tests/general.tests.jsonc:general:case-51" onExpandedCaseIdChange={() => undefined} linkedCaseCatalog={contractCatalog} trusted />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'contract.case.request', sourcePath: 'tests/general.tests.jsonc', scenarioId: 'case-51' }));
  });

  it('opens a linked red-team case outside the current page', async () => {
    const post = vi.fn();
    render(<AdversarialWorkspace profile={profile} post={post} activeSection="cases" expandedCaseId="linked:tests/red.csv:case-51" onExpandedCaseIdChange={() => undefined} linkedCaseCatalog={redCatalog} trusted />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'adversarial.case.request', sourcePath: 'tests/red.csv', scenarioId: 'case-51' }));
  });

  it('closes a newly created red-team case after saving its draft', async () => {
    const onClose = vi.fn();
    const redProfile = { ...profile, tests: { ...profile.tests, scenarios: [{ id: 'adversarial-1', name: 'New red-team case', steps: [{ id: 'turn-1', input: 'Hello' }], adversarial: { mode: 'singleTurn' as const, maxTurns: 1, timeoutMs: 60_000, stopOnAttackSucceeded: true, forbid: { content: ['forbidden-marker'] } } }] } };
    render(<AdversarialWorkspace profile={redProfile} post={vi.fn()} activeSection="cases" expandedCaseId="adversarial-1" onExpandedCaseIdChange={onClose} trusted />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(onClose).toHaveBeenCalledWith(undefined);
  });
});

describe('case selection guidance', () => {
  it('shows why two incomplete general cases are excluded from select all', () => {
    const onToggleCase = vi.fn();
    const fourCases: TurnStageProfile = { ...profile, tests: { scenarios: [
      { id: 'ready-1', name: 'Ready 1', steps: [{ id: 'step-1', input: 'Hello' }] },
      { id: 'empty-2', name: 'Case 2', steps: [{ id: 'step-1', input: '' }] },
      { id: 'ready-3', name: 'Ready 3', steps: [{ id: 'step-1', input: 'Goodbye' }] },
      { id: 'empty-4', name: 'Case 4', steps: [{ id: 'step-1', input: '  ' }] },
    ] } };
    render(<AutomationWorkspace profile={fourCases} post={vi.fn()} activeSection="scenarios" vscodeFeatures={false} selectedCaseKeys={new Set()} onToggleCase={onToggleCase} />);
    const cases = screen.getByRole('list');
    expect(within(cases).getByRole('button', { name: 'Case 2. Add the message for step 1.' })).toBeTruthy();
    expect(within(cases).getByRole('button', { name: 'Case 4. Add the message for step 1.' })).toBeTruthy();
    expect((within(cases).getByRole('checkbox', { name: /Select case Case 2/ }) as HTMLInputElement).disabled).toBe(true);
    const selectAll = screen.getByRole('button', { name: 'Select all selectable cases (2/4)' });
    fireEvent.click(selectAll);
    expect(onToggleCase.mock.calls.map(([item]) => item.scenarioId)).toEqual(['ready-1', 'ready-3']);
  });

  it('uses the same row guidance for review-required red-team cases and Web-only exclusions', () => {
    const onToggleCase = vi.fn();
    const mixedProfile: TurnStageProfile = { ...profile, tests: { scenarios: [
      { id: 'web-only', name: 'VS Code check', steps: [{ id: 'step-1', input: 'Hello' }], performance: { regression: { 'scenario.durationMs': { maxIncreaseMs: 100 } } } },
      { id: 'red-ready', name: 'Ready red', steps: [{ id: 'turn-1', input: 'Probe' }], adversarial: { forbid: { urls: true } } },
      { id: 'red-review', name: 'Draft red', steps: [{ id: 'turn-1', input: 'Probe' }], capture: { source: 'chat', status: 'needsReview', capturedAt: 1, sourceId: '1' }, adversarial: { forbid: { urls: true } } },
    ] } };
    const { rerender } = render(<AutomationWorkspace profile={mixedProfile} post={vi.fn()} activeSection="scenarios" vscodeFeatures={false} selectedCaseKeys={new Set()} onToggleCase={onToggleCase} />);
    expect(screen.getByRole('button', { name: 'VS Code check. This case needs the VS Code extension.' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Select case VS Code check/ }) as HTMLInputElement).disabled).toBe(true);
    rerender(<AdversarialWorkspace profile={mixedProfile} post={vi.fn()} activeSection="cases" vscodeFeatures={false} selectedCaseKeys={new Set()} onToggleCase={onToggleCase} />);
    expect(screen.getByRole('button', { name: 'Draft red. Review this case before selecting it.' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Select case Draft red/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select all selectable cases (1/2)' }));
    expect(onToggleCase.mock.calls.map(([item]) => item.scenarioId)).toEqual(['red-ready']);
  });
});
