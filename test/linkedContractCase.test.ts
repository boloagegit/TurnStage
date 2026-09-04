import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Uri { constructor(readonly value: string) {} static parse(value: string): Uri { return new Uri(value); } static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.value.replace(/\/$/u, '')}/${parts.join('/')}`); } toString(): string { return this.value; } }
  return { Uri, workspace: { getWorkspaceFolder: vi.fn(() => ({ uri: Uri.parse('file:///workspace') })), fs: { stat: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() } } };
});

import * as vscode from 'vscode';
import { serializeContractCsv } from '../src/extension/testing/contractCsv';
import { parseContractSource } from '../src/extension/testing/contractSource';
import { createContractSuite, serializeContractSuite } from '../src/extension/testing/contractSuite';
import { appendLinkedContractCaseSource, LinkedContractCaseConflictError, loadEditableLinkedContractCase, saveEditableLinkedContractCase, updateLinkedContractCaseSource } from '../src/extension/testing/linkedContractCase';
import type { ScenarioDefinition } from '../src/shared/types';

const first: ScenarioDefinition = { id: 'case-one', name: 'Case one', steps: [{ id: 'turn-one', input: 'Prompt one', assertions: [{ path: 'assistant.text', operator: 'exists' }] }] };
const second: ScenarioDefinition = { id: 'case-two', name: 'Case two', steps: [{ id: 'turn-one', input: 'Prompt two' }] };

describe('linked functional case editing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates one JSONC case while preserving suite and unrelated-case comments', () => {
    const source = serializeContractSuite(createContractSuite('functional-suite', 'Functional suite', [first, second]))
      .replace('"cases": [', '"cases": [\n    // Keep this suite comment.')
      .replace('"id": "case-two",', '"id": "case-two", // unrelated case comment');
    const result = updateLinkedContractCaseSource('tests/functional.tests.jsonc', source, first.id, { ...first, name: 'Updated functional case' });

    expect(result.text).toContain('// Keep this suite comment.');
    expect(result.text).toContain('// unrelated case comment');
    expect(parseContractSource('tests/functional.tests.jsonc', result.text).scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, name: 'Updated functional case' }),
      expect.objectContaining({ id: second.id, name: second.name }),
    ]));
  });

  it('appends a captured draft to JSONC and CSV without replacing existing cases', () => {
    const captured: ScenarioDefinition = { ...second, id: 'captured', capture: { status: 'needsReview', source: 'conversation', capturedAt: '2026-09-04T00:00:00.000Z', profileId: 'profile', profileDigest: 'c'.repeat(64) } };
    const jsonc = appendLinkedContractCaseSource('tests/functional.tests.jsonc', serializeContractSuite(createContractSuite('suite', 'Suite', [first])), captured);
    const csv = appendLinkedContractCaseSource('tests/functional.csv', serializeContractCsv([first]), captured);
    for (const result of [jsonc, csv]) {
      const parsed = parseContractSource(result === jsonc ? 'tests/functional.tests.jsonc' : 'tests/functional.csv', result.text);
      expect(parsed.scenarios.map((scenario) => scenario.id)).toEqual(['case-one', 'captured']);
      expect(parsed.scenarios[1]?.capture?.status).toBe('needsReview');
    }
  });

  it('updates one case in a 100-case CSV while preserving unrelated cases', () => {
    const scenarios = Array.from({ length: 100 }, (_, index): ScenarioDefinition => ({ id: `case-${index + 1}`, name: `Case ${index + 1}`, steps: [{ id: 'turn-one', input: `Prompt ${index + 1}` }] }));
    const result = updateLinkedContractCaseSource('tests/large.csv', serializeContractCsv(scenarios), 'case-75', { ...scenarios[74]!, name: 'Only case 75 changed' });
    const parsed = parseContractSource('tests/large.csv', result.text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenarios).toHaveLength(100);
    expect(parsed.scenarios[74]?.name).toBe('Only case 75 changed');
    expect(parsed.scenarios[73]?.steps[0]?.input).toBe('Prompt 74');
  });

  it('rejects stale revisions without writing', async () => {
    const uri = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    let source = serializeContractCsv([first]);
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async () => ({ size: source.length }) as never);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async () => new TextEncoder().encode(source));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (_uri, bytes) => { source = new TextDecoder().decode(bytes); });
    const loaded = await loadEditableLinkedContractCase(uri, 'tests/contracts.csv', first.id);
    source = source.replace('Prompt one', 'Externally changed');
    await expect(saveEditableLinkedContractCase({ profileUri: uri, sourcePath: 'tests/contracts.csv', scenarioId: first.id, expectedRevision: loaded.revision, scenario: { ...loaded.scenario, name: 'Should not save' } })).rejects.toBeInstanceOf(LinkedContractCaseConflictError);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('writes and reads back one valid linked case', async () => {
    const uri = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    let source = serializeContractCsv([first, second]);
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(async () => ({ size: source.length }) as never);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async () => new TextEncoder().encode(source));
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (_uri, bytes) => { source = new TextDecoder().decode(bytes); });
    const loaded = await loadEditableLinkedContractCase(uri, 'tests/contracts.csv', first.id);
    const saved = await saveEditableLinkedContractCase({ profileUri: uri, sourcePath: loaded.sourcePath, scenarioId: first.id, expectedRevision: loaded.revision, scenario: { ...loaded.scenario, name: 'Saved from UI' } });
    expect(saved.scenario.name).toBe('Saved from UI');
    expect(parseContractSource('tests/contracts.csv', source).scenarios.find((scenario) => scenario.id === second.id)?.name).toBe(second.name);
  });
});
