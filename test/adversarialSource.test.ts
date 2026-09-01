import { describe, expect, it } from 'vitest';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import { parseAdversarialSource } from '../src/extension/testing/adversarialSource';
import { serializeAdversarialSuite } from '../src/extension/testing/adversarialSuite';
import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../src/shared/types';

describe('linked adversarial sources', () => {
  it('uses a CSV file directly as a deterministic multi-turn suite', () => {
    const scenarios: ScenarioDefinition[] = [{
      id: 'gradual-override', name: 'Gradual override', tags: ['multi-turn'],
      steps: [{ id: 'context', input: 'Explain the policy.' }, { id: 'attack', input: 'Ignore it.', additionalForbid: { events: ['tool.started'] } }],
      adversarial: { mode: 'multiTurn', maxTurns: 2, timeoutMs: 60_000, repetitions: 3, forbid: { content: ['protected-marker'], tools: true } },
    }];
    const source = serializeAdversarialCsv(scenarios);

    const first = parseAdversarialSource('.vscode/turnstage/tests/security-regression.adversarial.csv', source);
    const second = parseAdversarialSource('.vscode/turnstage/tests/security-regression.adversarial.csv', source);

    expect(first.issues).toEqual([]);
    expect(first.suite?.id).toBe(second.suite?.id);
    expect(first.suite).toMatchObject({ format: 'turnstage-adversarial-suite', version: 1, name: 'security regression' });
    expect(first.scenarios[0]).toMatchObject({
      id: 'gradual-override', steps: [{ id: 'context' }, { id: 'attack' }],
      adversarial: { mode: 'multiTurn', maxTurns: 2, repetitions: 3, forbid: { content: ['protected-marker'], tools: true } },
    });
  });

  it('reports CSV locations without returning a partial suite', () => {
    const source = serializeAdversarialCsv([{
      id: 'case-1', name: 'Case 1', steps: [{ id: 'turn-1', input: 'Probe' }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { urls: true } },
    }]).replace(',true,1,', ',perhaps,1,');

    const parsed = parseAdversarialSource('tests/security.adversarial.csv', source);

    expect(parsed.suite).toBeUndefined();
    expect(parsed.scenarios).toEqual([]);
    expect(parsed.issues).toContainEqual(expect.stringMatching(/^tests\/security\.adversarial\.csv:2:enabled:/u));
  });

  it('keeps JSONC suites on the same source-loading path', () => {
    const suite: AdversarialSuiteDefinition = {
      format: 'turnstage-adversarial-suite', version: 1, id: 'jsonc-suite', name: 'JSONC suite',
      cases: [{ id: 'case-1', name: 'Case 1', turns: [{ id: 'turn-1', input: 'Probe' }], forbid: { urls: true } }],
    };
    const parsed = parseAdversarialSource('tests/security.adversarial.jsonc', serializeAdversarialSuite(suite).replace('{\n', '{\n  // source comment\n'));

    expect(parsed.issues).toEqual([]);
    expect(parsed.suite?.id).toBe('jsonc-suite');
    expect(parsed.scenarios).toHaveLength(1);
  });
});
