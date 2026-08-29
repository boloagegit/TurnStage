import { describe, expect, it } from 'vitest';
import { mapChangedFilesToTests, mapSuiteImpact, matchesSourceGlob, normalizeSourcePath, validateSourceBinding } from '../src/extension/testing/impactMapping';

describe('source impact mapping', () => {
  it('normalizes safe workspace paths and rejects traversal or outside roots', () => {
    expect(normalizeSourcePath('./src\\runtime\\client.ts')).toBe('src/runtime/client.ts');
    expect(normalizeSourcePath('/workspace/src/runtime/client.ts', '/workspace')).toBe('src/runtime/client.ts');
    expect(normalizeSourcePath('/workspace-other/src/client.ts', '/workspace')).toBeUndefined();
    expect(normalizeSourcePath('../src/client.ts')).toBeUndefined();
    expect(normalizeSourcePath('file:///workspace/src/client.ts', '/workspace')).toBeUndefined();
    expect(normalizeSourcePath('src/\u0000client.ts')).toBeUndefined();
  });

  it('matches bounded globs without crossing a single-star segment', () => {
    expect(matchesSourceGlob('src/runtime/client.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesSourceGlob('src/client.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesSourceGlob('src/runtime/client.ts', 'src/*.ts')).toBe(false);
    expect(matchesSourceGlob('packages/a/index.tsx', '*.{ts,tsx}')).toBe(true);
    expect(matchesSourceGlob('src/A.ts', 'src/[a-z].ts')).toBe(false);
    expect(matchesSourceGlob('src/a.ts', 'src/[a-z].ts')).toBe(true);
    expect(matchesSourceGlob('SRC/a.ts', 'src/*.ts', false)).toBe(true);
    expect(matchesSourceGlob('src/client.ts', '../src/**')).toBe(false);
  });

  it('selects cases with explicit glob, component, endpoint, and risk reasons', () => {
    const result = mapChangedFilesToTests([
      { path: 'src/chat/client.ts', components: ['chat'], endpoints: ['/chat'], riskTags: ['prompt-boundary'] },
      'docs/readme.md',
    ], [
      { id: 'chat-contract', name: 'Chat', sourceBinding: { sourceGlobs: ['src/**/*.ts'], components: ['chat'], endpoints: ['/chat'], riskTags: ['prompt-boundary'] } },
      { id: 'unrelated', sourceGlobs: ['src/other/**'] },
      { id: 'unbound' },
    ]);

    expect(result.changedFiles).toEqual(['docs/readme.md', 'src/chat/client.ts']);
    expect(result.selected.map((item) => item.id)).toEqual(['chat-contract']);
    expect(result.selected[0]?.reasons.map((reason) => reason.kind)).toEqual(['component', 'endpoint', 'riskTag', 'sourceGlob']);
    expect(result.selected[0]?.reasons.every((reason) => reason.message.includes('src/chat/client.ts'))).toBe(true);
    expect(result.omitted.map((item) => item.id)).toEqual(['unbound', 'unrelated']);
    expect(result.omitted[0]?.reasons[0]?.kind).toBe('noMatch');
  });

  it('inherits suite bindings and supports explicit manual inclusion of unbound cases', () => {
    const result = mapSuiteImpact([{ path: 'packages/api/server.ts', riskTags: ['backend'] }], {
      id: 'suite',
      sourceBinding: { sourceGlobs: ['packages/api/**'], riskTags: ['backend'] },
      cases: [
        { id: 'inherits' },
        { id: 'manual', tags: ['high-risk'] },
      ],
    }, { includeUnbound: true, caseIds: ['manual'] });

    expect(result.selected.map((item) => item.id)).toEqual(['inherits', 'manual']);
    expect(result.selected.find((item) => item.id === 'inherits')?.reasons[0]?.kind).toBe('riskTag');
    expect(result.selected.find((item) => item.id === 'manual')?.reasons.some((reason) => reason.kind === 'manual')).toBe(true);
  });

  it('reports malformed source binding values instead of silently accepting them', () => {
    const issues = validateSourceBinding({ sourceGlobs: ['../escape/**'], extra: true, components: [''] });
    expect(issues.map((issue) => issue.scope)).toEqual(expect.arrayContaining(['sourceBinding.extra', 'sourceBinding.sourceGlobs', 'sourceBinding.components']));
  });
});
