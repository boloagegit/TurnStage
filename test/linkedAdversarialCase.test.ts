import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly value: string) {}
    static parse(value: string): Uri { return new Uri(value); }
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.value.replace(/\/$/u, '')}/${parts.join('/')}`); }
    toString(): string { return this.value; }
  }
  return {
    Uri,
    workspace: {
      getWorkspaceFolder: vi.fn(() => ({ uri: Uri.parse('file:///workspace') })),
      fs: { stat: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() },
    },
  };
});

import * as vscode from 'vscode';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import { parseAdversarialSource } from '../src/extension/testing/adversarialSource';
import { serializeAdversarialSuite } from '../src/extension/testing/adversarialSuite';
import { appendLinkedAdversarialCaseSource, LinkedAdversarialCaseConflictError, loadEditableLinkedAdversarialCase, saveEditableLinkedAdversarialCase, updateLinkedAdversarialCaseSource } from '../src/extension/testing/linkedAdversarialCase';
import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../src/shared/types';

const first: ScenarioDefinition = {
  id: 'case-one', name: 'Case one', steps: [{ id: 'turn-one', input: 'Probe one' }],
  adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, repetitions: 2, forbid: { urls: true } },
};
const second: ScenarioDefinition = {
  id: 'case-two', name: 'Case two', steps: [{ id: 'turn-one', input: 'Probe two' }],
  adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { tools: true } },
};

describe('linked adversarial case editing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates one JSONC case while preserving surrounding comments and unrelated cases', () => {
    const suite: AdversarialSuiteDefinition = {
      format: 'turnstage-adversarial-suite', version: 1, id: 'suite', name: 'Suite',
      cases: [
        { id: first.id, name: first.name, turns: first.steps, forbid: { urls: true } },
        { id: second.id, name: second.name, turns: second.steps, forbid: { tools: true } },
      ],
    };
    const source = serializeAdversarialSuite(suite)
      .replace('"cases": [', '"cases": [\n    // The first case is edited in place.')
      .replace('"id": "case-two",', '"id": "case-two", // keep this unrelated comment');
    const edited: ScenarioDefinition = { ...first, name: 'Updated case', adversarial: { ...first.adversarial!, forbid: { urls: true, ctas: true } } };

    const result = updateLinkedAdversarialCaseSource('tests/security.adversarial.jsonc', source, first.id, edited);

    expect(result.text).toContain('// The first case is edited in place.');
    expect(result.text).toContain('// keep this unrelated comment');
    const parsed = parseAdversarialSource('tests/security.adversarial.jsonc', result.text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'case-one', name: 'Updated case', adversarial: expect.objectContaining({ forbid: expect.objectContaining({ urls: true, ctas: true }) }) }),
      expect.objectContaining({ id: 'case-two', name: 'Case two', adversarial: expect.objectContaining({ forbid: expect.objectContaining({ tools: true }) }) }),
    ]));
  });

  it('appends a captured draft to JSONC and CSV without replacing existing cases', () => {
    const captured: ScenarioDefinition = { ...second, id: 'captured', capture: { status: 'needsReview', source: 'conversation', capturedAt: '2026-09-04T00:00:00.000Z', profileId: 'profile', profileDigest: 'd'.repeat(64) } };
    const suite: AdversarialSuiteDefinition = { format: 'turnstage-adversarial-suite', version: 1, id: 'suite', name: 'Suite', cases: [{ id: first.id, name: first.name, turns: first.steps, forbid: first.adversarial!.forbid }] };
    const jsonc = appendLinkedAdversarialCaseSource('tests/security.adversarial.jsonc', serializeAdversarialSuite(suite), captured);
    const csv = appendLinkedAdversarialCaseSource('tests/security.adversarial.csv', serializeAdversarialCsv([first]), captured);
    for (const [path, result] of [['tests/security.adversarial.jsonc', jsonc], ['tests/security.adversarial.csv', csv]] as const) {
      const parsed = parseAdversarialSource(path, result.text);
      expect(parsed.scenarios.map((scenario) => scenario.id)).toEqual(['case-one', 'captured']);
      expect(parsed.scenarios[1]?.capture?.status).toBe('needsReview');
    }
  });

  it('updates only matching CSV rows and preserves column order, extra cells, and other cases', () => {
    const base = serializeAdversarialCsv([first, second]);
    const lines = base.trimEnd().split('\r\n');
    const source = `${lines.map((line, index) => `${line},${index === 0 ? 'owner' : index === 1 ? 'security-team' : 'quality-team'}`).join('\r\n')}\r\n`;
    const edited: ScenarioDefinition = {
      ...first,
      name: 'Updated CSV case',
      steps: [...first.steps, { id: 'turn-two', input: 'Probe again' }],
      adversarial: { ...first.adversarial!, mode: 'multiTurn', maxTurns: 2, forbid: { urls: true, events: ['tool.started'] } },
    };

    const result = updateLinkedAdversarialCaseSource('tests/security.adversarial.csv', source, first.id, edited);
    const updatedLines = result.text.trimEnd().split('\r\n');

    expect(updatedLines[0]?.endsWith(',owner')).toBe(true);
    expect(updatedLines.filter((line) => line.includes('case-one'))).toHaveLength(2);
    expect(updatedLines.find((line) => line.includes('case-two'))?.endsWith(',quality-team')).toBe(true);
    const parsed = parseAdversarialSource('tests/security.adversarial.csv', result.text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios.find((scenario) => scenario.id === 'case-one')).toMatchObject({ name: 'Updated CSV case', steps: [{ id: 'turn-one' }, { id: 'turn-two' }] });
    expect(parsed.scenarios.find((scenario) => scenario.id === 'case-two')?.steps[0]?.input).toBe('Probe two');
  });

  it('updates one case in a 100-case CSV without changing the other case definitions', () => {
    const scenarios = Array.from({ length: 100 }, (_, index): ScenarioDefinition => ({
      id: `case-${index + 1}`, name: `Case ${index + 1}`, steps: [{ id: 'turn-one', input: `Probe ${index + 1}` }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { urls: true } },
    }));
    const source = serializeAdversarialCsv(scenarios);
    const target = { ...scenarios[74]!, name: 'Only case 75 changed' };

    const result = updateLinkedAdversarialCaseSource('tests/large.adversarial.csv', source, 'case-75', target);
    const parsed = parseAdversarialSource('tests/large.adversarial.csv', result.text);

    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios).toHaveLength(100);
    expect(parsed.scenarios[74]?.name).toBe('Only case 75 changed');
    expect(parsed.scenarios[73]).toMatchObject({ id: 'case-74', name: 'Case 74', steps: [{ input: 'Probe 74' }] });
    expect(parsed.scenarios[75]).toMatchObject({ id: 'case-76', name: 'Case 76', steps: [{ input: 'Probe 76' }] });
  });

  it('refuses a stale revision and never writes the linked file', async () => {
    const uri = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    let source = serializeAdversarialCsv([first]);
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async () => ({ size: source.length }) as never);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async () => new TextEncoder().encode(source));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (_uri, bytes) => { source = new TextDecoder().decode(bytes); });
    const loaded = await loadEditableLinkedAdversarialCase(uri, 'tests/security.adversarial.csv', first.id);
    source = source.replace('Probe one', 'Externally changed');

    await expect(saveEditableLinkedAdversarialCase({ profileUri: uri, sourcePath: 'tests/security.adversarial.csv', scenarioId: first.id, expectedRevision: loaded.revision, scenario: { ...loaded.scenario, name: 'Should not save' } })).rejects.toBeInstanceOf(LinkedAdversarialCaseConflictError);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('writes and reads back one valid linked case', async () => {
    const uri = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    let source = serializeAdversarialCsv([first, second]);
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async () => ({ size: source.length }) as never);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async () => new TextEncoder().encode(source));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (_uri, bytes) => { source = new TextDecoder().decode(bytes); });
    const loaded = await loadEditableLinkedAdversarialCase(uri, 'tests/security.adversarial.csv', first.id);

    const saved = await saveEditableLinkedAdversarialCase({ profileUri: uri, sourcePath: loaded.sourcePath, scenarioId: first.id, expectedRevision: loaded.revision, scenario: { ...loaded.scenario, name: 'Saved from UI' } });

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledOnce();
    expect(saved.scenario.name).toBe('Saved from UI');
    expect(saved.revision).not.toBe(loaded.revision);
    expect(parseAdversarialSource('tests/security.adversarial.csv', source).scenarios.find((scenario) => scenario.id === second.id)?.name).toBe(second.name);
  });
});
