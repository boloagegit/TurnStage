import { findNodeAtOffset, getLocation, getNodePath, parseTree } from 'jsonc-parser';

/** Where a Profile issue lives. Test-case issues only stop the affected cases, not the chat session. */
export type ProfileIssueScope = 'tests';

export function profileIssueScope(text: string, offset: number): ProfileIssueScope | undefined {
  return getLocation(text, offset).path[0] === 'tests' ? 'tests' : undefined;
}

/** True for an error that makes the Profile unusable for chat requests. */
export function blocksSession(issue: { severity: 'error' | 'warning'; scope?: ProfileIssueScope }): boolean {
  return issue.severity === 'error' && issue.scope !== 'tests';
}

/** Paths travel to the Webview, which accepts at most 32 segments of up to 256 characters; longer keys are cut. */
function boundedPath(path: ReadonlyArray<string | number>): Array<string | number> {
  return path.slice(0, 32).map((part) => typeof part === 'string' && part.length > 256 ? part.slice(0, 256) : part);
}

/** The JSON path of the Profile value an issue points at, so the UI can say where it is and open that setting. */
export function profileIssuePath(root: ReturnType<typeof parseTree>, offset: number): Array<string | number> {
  const node = root ? findNodeAtOffset(root, offset, true) : undefined;
  // A property key resolves to its property node; report the value's path either way.
  return node ? getNodePath(node.type === 'property' ? node.children?.[1] ?? node : node) : [];
}

/**
 * Annotates validation issues with their scope, so hosts and the banner can tell test-case issues apart, and
 * with the path of the value they point at. A path an issue already names is kept.
 */
export function withIssueScope<T extends { offset: number; path?: Array<string | number> }>(text: string, issues: readonly T[]): Array<T & { scope?: ProfileIssueScope; path: Array<string | number> }> {
  const root = parseTree(text);
  return issues.map((issue) => {
    const scope = profileIssueScope(text, issue.offset);
    const path = boundedPath(issue.path?.length ? issue.path : profileIssuePath(root, issue.offset));
    return { ...issue, path, ...(scope ? { scope } : {}) };
  });
}
