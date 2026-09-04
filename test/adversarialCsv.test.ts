import { describe, expect, it } from 'vitest';
import { adversarialCsvTemplate, parseAdversarialCsv, serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import type { ScenarioDefinition } from '../src/shared/types';

describe('adversarial CSV', () => {
  it('round-trips multi-turn cases with ordered turns and JSON rule cells', () => {
    const scenarios: ScenarioDefinition[] = [{
      id: 'formula-case', name: '=Formula case', description: 'CSV, quoted', tags: ['multi-turn', 'regression'],
      capture: { status: 'needsReview', source: 'evidence', capturedAt: '2026-09-04T00:00:00.000Z', profileId: 'profile', profileDigest: 'b'.repeat(64), evidenceId: 'evidence-1' },
      steps: [{ id: 'turn-1', name: 'First', input: '=SUM(1,2)' }, { id: 'turn-2', input: 'line one\nline two', additionalForbid: { events: ['tool.started'] } }],
      adversarial: { mode: 'multiTurn', maxTurns: 2, timeoutMs: 90_000, stopOnAttackSucceeded: true, forbid: { content: ['secret,with,comma'], urls: true, tools: true } },
    }];
    const csv = serializeAdversarialCsv(scenarios);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain("'=SUM(1,2)");
    expect(csv).toContain("'=Formula case");
    const parsed = parseAdversarialCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios[0]).toMatchObject({
      id: 'formula-case', name: '=Formula case', description: 'CSV, quoted', tags: ['multi-turn', 'regression'],
      capture: { status: 'needsReview', source: 'evidence', capturedAt: '2026-09-04T00:00:00.000Z', profileId: 'profile', profileDigest: 'b'.repeat(64), evidenceId: 'evidence-1' },
      steps: [{ id: 'turn-1', input: '=SUM(1,2)' }, { id: 'turn-2', input: 'line one\nline two', additionalForbid: { events: ['tool.started'] } }],
      adversarial: { mode: 'multiTurn', maxTurns: 2, timeoutMs: 90_000, stopOnAttackSucceeded: true, forbid: { content: ['secret,with,comma'], urls: true, tools: true } },
    });
  });

  it('reports inconsistent case-level fields and turn gaps with row numbers', () => {
    const csv = adversarialCsvTemplate();
    const lines = csv.split('\r\n');
    const second = lines[2]!.replace(',2,request-protected-value,', ',3,request-protected-value,').replace(',60000,true', ',70000,true');
    const parsed = parseAdversarialCsv([lines[0], lines[1], second].join('\r\n'));
    expect(parsed.scenarios).toEqual([]);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3, column: 'timeout_ms' }),
      expect.objectContaining({ row: 3, column: 'turn_index' }),
    ]));
  });

  it('imports a practical 100-case batch without collapsing case boundaries', () => {
    const scenarios: ScenarioDefinition[] = Array.from({ length: 100 }, (_, index) => ({
      id: `case-${index + 1}`,
      name: `Case ${index + 1}`,
      steps: [{ id: 'turn-1', input: `Fixed probe ${index + 1}` }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { urls: true } },
    }));

    const parsed = parseAdversarialCsv(serializeAdversarialCsv(scenarios));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rowCount).toBe(100);
    expect(parsed.scenarios).toHaveLength(100);
    expect(parsed.scenarios.at(-1)?.id).toBe('case-100');
  });

  it('rejects ambiguous booleans and omits explicitly disabled cases', () => {
    const lines = adversarialCsvTemplate().split('\r\n');
    const invalid = lines[1]!.replace(',true,1,', ',perhaps,1,');
    expect(parseAdversarialCsv([lines[0], invalid].join('\r\n')).issues).toContainEqual(expect.objectContaining({ column: 'enabled' }));

    const disabled = lines.slice(1, 3).map((line) => line.replace(',true,1,', ',false,1,').replace(',true,2,', ',false,2,'));
    const parsed = parseAdversarialCsv([lines[0], ...disabled].join('\r\n'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios).toEqual([]);
  });
});
