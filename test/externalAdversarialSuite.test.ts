import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Uri {
    constructor(readonly value: string) {}
    static parse(value: string): Uri { return new Uri(value); }
    get path(): string { try { return new URL(this.value).pathname; } catch { return this.value; } }
    toString(): string { return this.value; }
  }
  return {
    Uri,
    workspace: {
      getWorkspaceFolder: vi.fn(() => undefined),
      fs: { stat: vi.fn(), readFile: vi.fn() },
    },
  };
});

import * as vscode from 'vscode';
import { ExternalAdversarialSuiteRepository, isExternalAdversarialSuiteReference } from '../src/extension/testing/externalAdversarialSuite';
import { loadAdversarialSuite } from '../src/extension/testing/adversarialSuiteRepository';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';

describe('external adversarial suite grants', () => {
  let state: Map<string, unknown>;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    state = new Map();
    context = {
      workspaceState: {
        get: (key: string) => state.get(key),
        update: async (key: string, value: unknown) => { state.set(key, value); },
      },
    } as never;
  });

  it('stores the real URI locally and resolves only for the Profile that granted it', async () => {
    const repository = new ExternalAdversarialSuiteRepository(context);
    const profile = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    const otherProfile = vscode.Uri.parse('file:///other/profile.turnstage.jsonc');
    const suite = vscode.Uri.parse('file:///Users/example/shared/security.csv');

    const reference = await repository.grant(profile, suite);

    expect(isExternalAdversarialSuiteReference(reference)).toBe(true);
    expect(reference).toContain('security.csv');
    expect(JSON.stringify([...state.values()])).toContain('file:///Users/example/shared/security.csv');
    expect(repository.resolve(profile, reference)?.toString()).toBe(suite.toString());
    expect(repository.resolve(otherProfile, reference)).toBeUndefined();
    expect(repository.resolve(profile, `external:${crypto.randomUUID()}:other.csv`)).toBeUndefined();
  });

  it('reuses an existing grant instead of growing local state', async () => {
    const repository = new ExternalAdversarialSuiteRepository(context);
    const profile = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    const suite = vscode.Uri.parse('file:///outside/security.csv');
    const first = await repository.grant(profile, suite);
    const second = await repository.grant(profile, suite);

    expect(second).toBe(first);
    expect((state.values().next().value as unknown[])).toHaveLength(1);
  });

  it('loads a granted external CSV without requiring a shared workspace folder', async () => {
    const repository = new ExternalAdversarialSuiteRepository(context);
    const profile = vscode.Uri.parse('file:///workspace/profile.turnstage.jsonc');
    const suite = vscode.Uri.parse('file:///outside/security.csv');
    const reference = await repository.grant(profile, suite);
    const csv = serializeAdversarialCsv([{ id: 'case-1', name: 'Case 1', steps: [{ id: 'turn-1', input: 'Probe' }], adversarial: { forbid: { urls: true } } }]);
    vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ size: csv.length } as never);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode(csv));

    const loaded = await loadAdversarialSuite(profile, reference, (value) => repository.resolve(profile, value));

    expect(loaded.uri.toString()).toBe(suite.toString());
    expect(loaded.scenarios).toHaveLength(1);
    expect(loaded.scenarios[0]?.steps[0]?.input).toBe('Probe');
  });
});
