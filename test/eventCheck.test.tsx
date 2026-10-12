// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddCheckDialog } from '../src/webview/AddCheckDialog';
import { checkTargets, eventCheckOptions, hasAssertion, MAX_CHECK_TEXT } from '../src/webview/eventCheck';
import type { TurnStageProfile } from '../src/shared/types';

afterEach(cleanup);

describe('checks built from an inspected event', () => {
  it('offers the event type, reply text, and tool name that the event carries', () => {
    expect(eventCheckOptions({ type: 'stream.completed' }).map((item) => item.assertion)).toEqual([{ path: 'events.normalized[*].type', operator: 'contains', value: 'stream.completed' }]);
    expect(eventCheckOptions({ type: 'content.text.delta', text: '  Here is\n the sample result. ' })[1]?.assertion).toEqual({ path: 'assistant.text', operator: 'contains', value: 'Here is the sample result.' });
    expect(eventCheckOptions({ type: 'tool.started', name: 'search' })[1]?.assertion).toEqual({ path: 'events.normalized[*].name', operator: 'contains', value: 'search' });
    // Text on a non-content event, or a name on a non-tool event, is not offered as a check.
    expect(eventCheckOptions({ type: 'progress.updated', text: 'Thinking', name: 'x' })).toHaveLength(1);
    expect(eventCheckOptions({})).toEqual([]);
    const long = eventCheckOptions({ type: 'content.text.delta', text: 'word '.repeat(60) })[1]!.value;
    expect(long.length).toBeLessThanOrEqual(MAX_CHECK_TEXT);
    expect(long.endsWith('word')).toBe(true);
  });

  it('targets General cases in the Profile and in linked suites, never Red Team cases', () => {
    const profile = { tests: { scenarios: [{ id: 'inline', name: 'Inline case', steps: [] }, { id: 'red', adversarial: { forbid: {} }, steps: [] }] } } as unknown as TurnStageProfile;
    const targets = checkTargets(profile, { entries: [{ sourcePath: 'tests/a.tests.jsonc', scenarioId: 'linked', scenarioName: 'Linked case', suiteName: 'Suite A' }], total: 1, truncated: false, issues: [] } as never);
    expect(targets.map((item) => [item.kind, item.name])).toEqual([['inline', 'Inline case'], ['linked', 'Linked case']]);
    expect(targets[0]).toMatchObject({ index: 0 });
  });

  it('recognizes a check the case already has', () => {
    const assertion = { path: 'assistant.text', operator: 'contains' as const, value: 'x' };
    expect(hasAssertion([assertion], { ...assertion })).toBe(true);
    expect(hasAssertion([assertion], { ...assertion, value: 'y' })).toBe(false);
    expect(hasAssertion(undefined, assertion)).toBe(false);
  });

  it('adds the chosen check to the chosen case', () => {
    const onAdd = vi.fn();
    const options = eventCheckOptions({ type: 'content.text.delta', text: 'sample result' });
    const targets = checkTargets({ tests: { scenarios: [{ id: 'a', name: 'Case A', steps: [] }, { id: 'b', name: 'Case B', steps: [] }] } } as unknown as TurnStageProfile, undefined);
    render(<AddCheckDialog options={options} targets={targets} readOnly={false} onAdd={onAdd} onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: 'Add check from event' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'The final reply contains “sample result”' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Add to case' }), { target: { value: targets[1]!.key } });
    fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
    expect(onAdd).toHaveBeenCalledWith(options[1], targets[1]);
  });

  it('explains what to do when there is nowhere to add the check', () => {
    render(<AddCheckDialog options={eventCheckOptions({ type: 'stream.completed' })} targets={[]} readOnly onAdd={() => undefined} onClose={() => undefined} />);
    expect((screen.getByRole('button', { name: 'Add check' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Save this conversation as a test first/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy check as JSON' })).toBeTruthy();
  });
});
