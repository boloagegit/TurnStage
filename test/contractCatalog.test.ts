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
      fs: { stat: vi.fn(), readFile: vi.fn() },
    },
  };
});

import * as vscode from 'vscode';
import { loadLinkedContractCaseCatalog, MAX_LINKED_CONTRACT_CATALOG_ENTRIES } from '../src/extension/testing/contractCatalog';
import { createContractSuite, serializeContractSuite } from '../src/extension/testing/contractSuite';
import type { ScenarioDefinition, TurnStageProfile } from '../src/shared/types';

describe('linked functional case catalog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bounds the Webview catalog and excludes prompt and assertion values', async () => {
    const scenarios = Array.from({ length: 120 }, (_, index): ScenarioDefinition => ({
      id: `case-${index + 1}`, name: `Case ${index + 1}`, tags: ['release'],
      steps: [{ id: 'turn-1', input: `PRIVATE PROMPT ${index + 1}`, assertions: [{ path: 'assistant.text', operator: 'contains', value: `PRIVATE ASSERTION ${index + 1}` }] }],
    }));
    const source = serializeContractSuite(createContractSuite('catalog-suite', 'Catalog suite', scenarios));
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ size: source.length } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode(source));
    const profile: TurnStageProfile = {
      version: 1, id: 'profile', name: 'Profile', conversation: { send: { method: 'POST', url: 'https://example.test' } },
      stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [], contractSuites: ['tests/catalog.tests.jsonc'] },
    };

    const catalog = await loadLinkedContractCaseCatalog(vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc'), profile);

    expect(catalog.entries).toHaveLength(MAX_LINKED_CONTRACT_CATALOG_ENTRIES);
    expect(catalog).toMatchObject({ total: 120, truncated: true, issues: [] });
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE PROMPT');
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE ASSERTION');
  });
});
