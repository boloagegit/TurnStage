import { getLocation } from 'jsonc-parser';

/** Where a Profile issue lives. Test-case issues only stop the affected cases, not the chat session. */
export type ProfileIssueScope = 'tests';

export function profileIssueScope(text: string, offset: number): ProfileIssueScope | undefined {
  return getLocation(text, offset).path[0] === 'tests' ? 'tests' : undefined;
}

/** True for an error that makes the Profile unusable for chat requests. */
export function blocksSession(issue: { severity: 'error' | 'warning'; scope?: ProfileIssueScope }): boolean {
  return issue.severity === 'error' && issue.scope !== 'tests';
}

/** Annotates validation issues with their scope so hosts and the banner can tell test-case issues apart. */
export function withIssueScope<T extends { offset: number }>(text: string, issues: readonly T[]): Array<T & { scope?: ProfileIssueScope }> {
  return issues.map((issue) => { const scope = profileIssueScope(text, issue.offset); return scope ? { ...issue, scope } : issue; });
}
