import { describe, expect, it } from 'vitest';
import { contractCsvTemplate, parseContractCsv, serializeContractCsv } from '../src/extension/testing/contractCsv';
import type { ScenarioDefinition } from '../src/shared/types';

describe('functional contract CSV', () => {
  it('round-trips multi-turn prompts, assertions, controls, comparison, performance, and faults', () => {
    const scenario: ScenarioDefinition = { id: 'formula-case', name: '=Formula', description: 'CSV, quoted', tags: ['multi-turn'], sourceBinding: { components: ['chat'] }, controls: { locale: 'zh-TW' }, steps: [{ id: 'turn-1', input: '=SUM(1,2)', assertions: [{ path: 'assistant.text', operator: 'exists' }] }, { id: 'turn-2', input: 'line one\nline two' }], assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }], comparison: { baseline: { label: 'A' }, candidate: { label: 'B' } }, performance: { thresholds: { 'metrics.ttft': 1500 } }, faults: { disconnectAfterEvents: 3 } };
    const csv = serializeContractCsv([scenario]);
    expect(csv).toContain("'=SUM(1,2)");
    const parsed = parseContractCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios[0]).toEqual(scenario);
  });

  it('imports 100 cases without collapsing boundaries', () => {
    const scenarios = Array.from({ length: 100 }, (_, index): ScenarioDefinition => ({ id: `case-${index + 1}`, name: `Case ${index + 1}`, steps: [{ id: 'turn-1', input: `Prompt ${index + 1}` }] }));
    const parsed = parseContractCsv(serializeContractCsv(scenarios));
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios).toHaveLength(100);
    expect(parsed.scenarios.at(-1)?.id).toBe('case-100');
  });

  it('keeps the documented 500-case ceiling bounded and rejects case 501', () => {
    const scenarios = Array.from({ length: 500 }, (_, index): ScenarioDefinition => ({ id: `case-${index + 1}`, name: `Case ${index + 1}`, steps: [{ id: 'turn-1', input: `Prompt ${index + 1}` }] }));
    expect(parseContractCsv(serializeContractCsv(scenarios))).toMatchObject({ issues: [], scenarios: { length: 500 }, rowCount: 500 });
    const overflow = [...scenarios, { id: 'case-501', name: 'Case 501', steps: [{ id: 'turn-1', input: 'Overflow' }] }];
    expect(parseContractCsv(serializeContractCsv(overflow)).issues).toContainEqual(expect.objectContaining({ message: 'CSV can contain at most 500 cases.' }));
  });

  it('reports malformed JSON and turn gaps with row and column evidence', () => {
    const lines = contractCsvTemplate().split('\r\n');
    const invalid = lines[1]!.replace(',1,ask,', ',2,ask,').replace('[],', 'not-json,');
    const parsed = parseContractCsv([lines[0], invalid].join('\r\n'));
    expect(parsed.scenarios).toEqual([]);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ row: 2, column: 'turn_index' }), expect.objectContaining({ row: 2 })]));
  });
});
