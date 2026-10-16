import { describe, expect, it } from 'vitest';
// @ts-expect-error The CI helper is a plain ES module without type declarations.
import { isDocumentationOnly, parseNameStatus } from '../scripts/ci-scope.mjs';

const change = (status: string, path: string) => ({ status, path });

describe('CI scope', () => {
  it('skips the heavy jobs only for added or edited documentation files', () => {
    expect(isDocumentationOnly([change('M', 'docs/web-user-guide.en.md'), change('A', 'CHANGELOG.md'), change('M', 'README.zh-TW.md'), change('A', '.github/ISSUE_TEMPLATE/backend_profile.yml')])).toBe(true);
    expect(isDocumentationOnly([change('M', 'CONTRIBUTING.md'), change('M', '.github/release.yml')])).toBe(true);
  });

  it('runs everything for code, tested files, deletions, and empty changes', () => {
    expect(isDocumentationOnly([])).toBe(false);
    expect(isDocumentationOnly([change('M', 'docs/README.md'), change('M', 'src/webview/main.tsx')])).toBe(false);
    for (const path of ['README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'media/marketplace/stream-debug.png', 'resources/templates/basic-sse-chat.turnstage.jsonc', 'scripts/ci-scope.mjs', 'test/ciScope.test.ts', 'docs-extra/notes.md']) {
      expect(isDocumentationOnly([change('M', path)]), path).toBe(false);
    }
    expect(isDocumentationOnly([change('D', 'docs/README.md')])).toBe(false);
    expect(isDocumentationOnly([change('T', 'docs/README.md')])).toBe(false);
  });

  it('parses NUL-separated name-status output, including spaces in paths', () => {
    expect(parseNameStatus('M\0docs/a b.md\0A\0CHANGELOG.md\0')).toEqual([change('M', 'docs/a b.md'), change('A', 'CHANGELOG.md')]);
    expect(parseNameStatus('')).toEqual([]);
  });
});
