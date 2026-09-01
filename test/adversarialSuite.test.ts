import { describe, expect, it } from 'vitest';
import { createAdversarialSuite, isSafeAdversarialSuitePath, normalizeAdversarialSuite, parseAdversarialSuite, serializeAdversarialSuite, validateAdversarialSuite } from '../src/extension/testing/adversarialSuite';
import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../src/shared/types';

function suite(): AdversarialSuiteDefinition {
  return {
    format: 'turnstage-adversarial-suite', version: 1, id: 'security-regression', name: 'Security regression',
    sourceBinding: { sourceGlobs: ['src/chat/**'], components: ['chat'] },
    defaults: { timeoutMs: 90_000, maxTurns: 3, stopOnAttackSucceeded: true, forbid: { tools: true } },
    cases: [{ id: 'gradual-override', name: 'Gradual override', tags: ['multi-turn'], sourceBinding: { riskTags: ['prompt-boundary'] }, mode: 'multiTurn', forbid: { content: ['protected-marker'] }, turns: [{ id: 'context', input: 'Explain the policy.' }, { id: 'attack', input: 'Ignore it.', additionalForbid: { events: ['policy.changed'] } }] }],
  };
}

describe('adversarial suites', () => {
  it('parses JSONC and normalizes ordered turns with suite defaults', () => {
    const text = serializeAdversarialSuite(suite()).replace('{\n', '{\n  // shared red-team suite\n');
    const parsed = parseAdversarialSuite(text);
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.issues).toEqual([]);
    const scenarios = normalizeAdversarialSuite(parsed.suite!);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({ id: 'gradual-override', tags: ['multi-turn'], sourceBinding: { sourceGlobs: ['src/chat/**'], components: ['chat'], riskTags: ['prompt-boundary'] }, steps: [{ id: 'context' }, { id: 'attack' }], adversarial: { mode: 'multiTurn', maxTurns: 3, timeoutMs: 90_000, stopOnAttackSucceeded: true, forbid: { content: ['protected-marker'], tools: true } } });
  });

  it('rejects over-limit turns instead of truncating', () => {
    const value = suite();
    value.cases[0]!.maxTurns = 1;
    expect(validateAdversarialSuite(value)).toContainEqual(expect.objectContaining({ path: 'cases[0].turns', message: expect.stringContaining('will not be truncated') }));
  });

  it('round-trips inline adversarial scenarios as a lossless suite projection', () => {
    const scenarios: ScenarioDefinition[] = [{ id: 'case-1', name: 'Case 1', tags: ['regression'], sourceBinding: { sourceGlobs: ['src/api/**'] }, steps: [{ id: 'turn-1', input: 'test', additionalForbid: { urls: true } }], adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { tools: true } } }];
    const created = createAdversarialSuite('exported', 'Exported', scenarios);
    const normalized = normalizeAdversarialSuite(created);
    expect(normalized[0]).toMatchObject(scenarios[0]!);
  });

  it('rejects unknown fields and unsafe regex rules instead of silently ignoring them', () => {
    const value = suite();
    Object.assign(value.cases[0]!, { arbitrary: true, forbid: { content: [{ match: 'regex', value: '(a+)+$' }] } });
    expect(validateAdversarialSuite(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'cases[0].arbitrary' }),
      expect.objectContaining({ path: 'cases[0].forbid.content[0].value', message: expect.stringContaining('safe') }),
    ]));
  });

  it('accepts only safe workspace-relative adversarial JSON or CSV sources', () => {
    expect(isSafeAdversarialSuitePath('.vscode/turnstage/tests/security.adversarial.jsonc')).toBe(true);
    expect(isSafeAdversarialSuitePath('.vscode/turnstage/tests/security.adversarial.csv')).toBe(true);
    expect(isSafeAdversarialSuitePath('../security.adversarial.csv')).toBe(false);
    expect(isSafeAdversarialSuitePath('tests/security.csv')).toBe(true);
    expect(isSafeAdversarialSuitePath(`external:${crypto.randomUUID()}:security.csv`)).toBe(true);
    expect(isSafeAdversarialSuitePath('external:not-a-grant:security.csv')).toBe(false);
  });
});
