/** A stable case identity across the editor, browser, and CLI surfaces. */
export interface TestCaseIdentity {
  profileId: string;
  suiteId?: string;
  scenarioId: string;
  kind: 'contract' | 'adversarial';
}

export interface SelectableTestCase extends TestCaseIdentity {
  ready: boolean;
}

export type TestSelection =
  | { kind: 'contract' | 'adversarial' }
  | { cases: readonly TestCaseIdentity[] };

export function testCaseKey(value: TestCaseIdentity): string {
  return JSON.stringify([value.profileId, value.kind, value.suiteId ?? null, value.scenarioId]);
}

/** Resolve the complete selection before any request is sent. Drafts never enter a formal run. */
export function resolveTestSelection<T extends SelectableTestCase>(entries: readonly T[], selection: TestSelection): T[] {
  const ready = entries.filter((entry) => entry.ready);
  let selected: T[];
  if ('kind' in selection) {
    selected = ready.filter((entry) => entry.kind === selection.kind);
  } else {
    if (!selection.cases.length) throw new Error('Select at least one test case to run.');
    const wanted = new Set(selection.cases.map(testCaseKey));
    if (wanted.size !== selection.cases.length) throw new Error('The selection contains the same case more than once.');
    selected = ready.filter((entry) => wanted.has(testCaseKey(entry)));
    if (selected.length < wanted.size) throw new Error('One or more selected cases are missing or still need review. Refresh the cases and try again.');
  }
  if (!selected.length) throw new Error('No ready test cases match this selection.');
  if (new Set(selected.map(testCaseKey)).size !== selected.length) throw new Error('More than one test case has the same profile, type, suite, and case ID. Give each case a unique ID before running.');
  return selected;
}
