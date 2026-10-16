// Decides whether a change needs the full CI run or only documentation housekeeping.
//
// CI always reports every required check. When a change touches only the files listed
// below, the heavy jobs finish immediately instead of rebuilding, testing, and packaging
// code that did not change. Anything else, and every deletion or rename, runs everything.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Files no test reads for content and that the build does not depend on. README.md and
// THIRD_PARTY_NOTICES.md are deliberately absent: tests parse them.
const DOCUMENTATION_ONLY = [
  /^docs\//u,
  /^CHANGELOG\.md$/u,
  /^README\.zh-TW\.md$/u,
  /^(?:CONTRIBUTING|SECURITY|SUPPORT|PRIVACY|CODE_OF_CONDUCT|AGENTS|PRODUCT)\.md$/u,
  /^\.github\/ISSUE_TEMPLATE\//u,
  /^\.github\/(?:release\.yml|PULL_REQUEST_TEMPLATE\.md)$/u,
];

/** True when every change adds or edits a documentation-only file. An empty change is not documentation-only. */
export function isDocumentationOnly(entries) {
  return entries.length > 0 && entries.every(({ status, path }) => (status === 'A' || status === 'M') && DOCUMENTATION_ONLY.some((pattern) => pattern.test(path)));
}

/** Parses `git diff --name-status --no-renames -z` output into { status, path } entries. */
export function parseNameStatus(output) {
  const parts = output.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index + 1 < parts.length; index += 2) entries.push({ status: parts[index].charAt(0), path: parts[index + 1] });
  return entries;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function changedEntries(base) {
  const from = base && !/^0+$/u.test(base) ? base : git('merge-base', 'origin/main', 'HEAD').trim();
  return parseNameStatus(git('diff', '--name-status', '--no-renames', '-z', `${from}...HEAD`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let full = true;
  let reason = 'the changed files could not be determined';
  if (process.env.CI_SCOPE_ALWAYS_FULL === 'true') {
    // The default branch is the last line of defence after a merge, so it always runs everything.
    reason = 'a push to the default branch always runs the full suite';
  } else {
    try {
      const entries = changedEntries(process.env.CI_SCOPE_BASE);
      full = !isDocumentationOnly(entries);
      reason = entries.length === 0 ? 'no changed files were found' : full ? `${entries.length} changed file(s) include code or tested files` : `${entries.length} changed file(s) are documentation only`;
    } catch (error) {
      reason = `${reason}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  console.log(`full=${full} (${reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
}
