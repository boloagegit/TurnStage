import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioRunGroupRecord } from '../src/shared/types';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments: string[] = [];
      for (const segment of `${base.path}/${parts.join('/')}`.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
      }
      return new Uri(`/${segments.join('/')}`);
    }
    toString(): string { return `file://${this.path}`; }
  }
  const files = new Map<string, Uint8Array>();
  const directories: string[] = [];
  const fs = {
    readFile: async (uri: Uri) => {
      const value = files.get(uri.path);
      if (!value) throw new Error('missing');
      return value;
    },
    writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.path, bytes); },
    stat: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('missing'); return { size: value.byteLength }; },
    createDirectory: async (uri: Uri) => { directories.push(uri.path); },
    delete: async (uri: Uri) => { files.delete(uri.path); },
  };
  return { Uri, files, directories, workspace: { fs } };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, workspace: mock.workspace }));

import { ScenarioRunGroupRepository } from '../src/extension/testing/scenarioRunGroupRepository';

function record(id: string, updatedAt: number, outcome: ScenarioRunGroupRecord['outcome'] = 'resisted'): ScenarioRunGroupRecord {
  return {
    format: 'turnstage-run-group', version: 1, id, profileId: 'profile', scenarioId: 'case', scenarioName: 'Case', createdAt: updatedAt, updatedAt,
    requestedAttempts: 1, completedAttempts: 1, plannedTurns: 1, plannedRequests: 1, maximumDurationMs: 100, sampleComplete: outcome === 'resisted', outcome, stability: outcome === 'resisted' ? 'stable-pass' : 'inconclusive',
    counts: { resisted: outcome === 'resisted' ? 1 : 0, attackSucceeded: outcome === 'attackSucceeded' ? 1 : 0, indeterminate: outcome === 'indeterminate' ? 1 : 0, infrastructureError: outcome === 'infrastructureError' ? 1 : 0 },
    attempts: [{ attempt: 1, outcome, durationMs: 100, attemptedTurns: 1, completedTurns: outcome === 'resisted' ? 1 : 0, startedAt: updatedAt, completedAt: updatedAt + 100 }],
  };
}

function repository(): ScenarioRunGroupRepository {
  return new ScenarioRunGroupRepository({ storageUri: new mock.Uri('/workspace-storage'), globalStorageUri: new mock.Uri('/global-storage') } as never);
}

describe('ScenarioRunGroupRepository', () => {
  beforeEach(() => { mock.files.clear(); mock.directories.length = 0; });

  it('persists in workspace-local storage and applies retention by newest update', async () => {
    const target = repository();
    await target.save(record('old', 1), 2);
    await target.save(record('middle', 2), 2);
    await target.save(record('new', 3), 2);

    expect((await target.list('profile')).map((item) => item.id)).toEqual(['new', 'middle']);
    expect([...mock.files.keys()]).toEqual(['/workspace-storage/run-groups/profile.json']);
    expect(mock.directories).toEqual(['/workspace-storage/run-groups', '/workspace-storage/run-groups', '/workspace-storage/run-groups']);
  });

  it('serializes concurrent writes and filters malformed records', async () => {
    const target = repository();
    await Promise.all(Array.from({ length: 8 }, (_, index) => target.save(record(`run-${index}`, index), 20)));
    const path = '/workspace-storage/run-groups/profile.json';
    const value = JSON.parse(new TextDecoder().decode(mock.files.get(path)!)) as unknown[];
    value.push({ id: 'malformed', profileId: 'profile', format: 'turnstage-run-group', version: 1 });
    mock.files.set(path, new TextEncoder().encode(JSON.stringify(value)));

    const listed = await target.list('profile');
    expect(listed).toHaveLength(8);
    expect(new Set(listed.map((item) => item.id))).toEqual(new Set(Array.from({ length: 8 }, (_, index) => `run-${index}`)));
  });

  it('does not cross profile boundaries when reading a shared workspace', async () => {
    const target = repository();
    await target.save(record('run', 1), 20);
    expect(await target.list('other-profile')).toEqual([]);
    expect(await target.get('profile', 'run')).toMatchObject({ profileId: 'profile', id: 'run' });
  });
});
