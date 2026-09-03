import { describe, expect, it } from 'vitest';
import { createContractSuite, isSafeContractSuitePath, normalizeContractSuite, parseContractSuite, serializeContractSuite, validateContractSuite } from '../src/extension/testing/contractSuite';
import type { ContractSuiteDefinition, ScenarioDefinition } from '../src/shared/types';

function suite(): ContractSuiteDefinition {
  return {
    format: 'turnstage-contract-suite', version: 1, id: 'conversation-regression', name: 'Conversation regression',
    sourceBinding: { sourceGlobs: ['src/chat/**'], components: ['chat'] },
    cases: [{ id: 'multi-turn', name: 'Multi-turn', tags: ['regression'], sourceBinding: { riskTags: ['continuation'] }, steps: [{ id: 'first', input: 'Start', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }, { id: 'continue', input: 'Continue' }], assertions: [{ path: 'assistant.text', operator: 'exists' }], performance: { thresholds: { 'metrics.ttft': 2000 } } }],
  };
}

describe('functional contract suites', () => {
  it('parses JSONC and merges suite source bindings without adding adversarial behavior', () => {
    const parsed = parseContractSuite(serializeContractSuite(suite()).replace('{\n', '{\n  // shared functional suite\n'));
    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.issues).toEqual([]);
    expect(normalizeContractSuite(parsed.suite!)[0]).toMatchObject({ id: 'multi-turn', sourceBinding: { sourceGlobs: ['src/chat/**'], components: ['chat'], riskTags: ['continuation'] }, steps: [{ id: 'first' }, { id: 'continue' }], performance: { thresholds: { 'metrics.ttft': 2000 } } });
  });

  it('round-trips all functional fields and excludes adversarial scenarios', () => {
    const functional: ScenarioDefinition = { id: 'case-1', name: 'Case 1', controls: { mode: 'safe' }, steps: [{ id: 'turn-1', input: 'test', assertions: [{ path: 'assistant.text', operator: 'contains', value: 'ok' }] }], comparison: { baseline: {}, candidate: {} }, faults: { delayPerChunkMs: 10 } };
    const adversarial: ScenarioDefinition = { id: 'attack', name: 'Attack', steps: [{ id: 'turn-1', input: 'attack' }], adversarial: { forbid: { urls: true } } };
    expect(normalizeContractSuite(createContractSuite('exported', 'Exported', [functional, adversarial]))).toEqual([functional]);
  });

  it('rejects executable-looking unknown fields, duplicate ids, and excessive steps', () => {
    const value = suite();
    Object.assign(value.cases[0]!, { script: 'process.exit()' });
    value.cases.push({ ...structuredClone(value.cases[0]!), id: 'multi-turn', steps: Array.from({ length: 101 }, (_, index) => ({ id: `step-${index}`, input: 'x' })) });
    expect(validateContractSuite(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'cases[0].script' }),
      expect.objectContaining({ path: 'cases[1].id', message: expect.stringContaining('Duplicate') }),
      expect.objectContaining({ path: 'cases[1].steps', message: expect.stringContaining('at most 100') }),
    ]));
  });

  it('accepts only safe workspace-relative test JSON or CSV sources and opaque grants', () => {
    expect(isSafeContractSuitePath('.vscode/turnstage/tests/regression.tests.jsonc')).toBe(true);
    expect(isSafeContractSuitePath('qa/regression.csv')).toBe(true);
    expect(isSafeContractSuitePath('../regression.csv')).toBe(false);
    expect(isSafeContractSuitePath('qa/regression.jsonc')).toBe(false);
    expect(isSafeContractSuitePath(`external:${crypto.randomUUID()}:regression.csv`)).toBe(true);
  });
});
