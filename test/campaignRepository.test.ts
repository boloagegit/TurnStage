import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignRunRecordV1 } from '../src/shared/types';

const mock = vi.hoisted(() => {
  class Uri {
    constructor(readonly path: string) {}
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.path}/${parts.join('/')}`.replace(/\/+/g, '/')); }
    toString(): string { return `file://${this.path}`; }
  }
  const files = new Map<string, Uint8Array>();
  const fs = {
    readFile: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('missing'); return value; },
    writeFile: async (uri: Uri, bytes: Uint8Array) => { files.set(uri.path, bytes); },
    stat: async (uri: Uri) => { const value = files.get(uri.path); if (!value) throw new Error('missing'); return { size: value.byteLength }; },
    createDirectory: async () => undefined,
  };
  return { Uri, files, workspace: { fs, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
});

vi.mock('vscode', () => ({ Uri: mock.Uri, workspace: mock.workspace }));

import { CampaignRepository } from '../src/extension/testing/campaignRepository';

function repository(output?: { appendLine: (line: string) => void }): CampaignRepository { return new CampaignRepository({ storageUri: new mock.Uri('/workspace'), globalStorageUri: new mock.Uri('/global') } as never, output); }
function run(id: string, updatedAt: number, status: CampaignRunRecordV1['status'] = 'completed'): CampaignRunRecordV1 {
  return {
    format: 'turnstage-campaign-run', version: 1, id, campaignId: 'release', campaignName: 'Release', profileId: 'demo', createdAt: 1, updatedAt, status,
    sourceDigest: 'a'.repeat(64),
    plan: { selectedCases: 1, plannedAttempts: 1, plannedTurns: 1, plannedRequests: 1, maximumDurationMs: 1000, maxConcurrency: 1 },
    cases: [{ key: 'demo/inline/case', profileId: 'demo', scenarioId: 'case', scenarioName: 'Case', tags: ['security'], requestedAttempts: 1, completedAttempts: status === 'completed' ? 1 : 0, plannedTurns: 1, outcome: status === 'completed' ? 'resisted' : undefined, sampleComplete: status === 'completed', evidenceId: 'must-not-persist' }],
    coverage: { requiredTags: ['security'], coveredTags: ['security'], missingTags: [], caseCountByTag: { security: 1 }, percent: 100 },
  };
}

describe('CampaignRepository', () => {
  beforeEach(() => mock.files.clear());

  it('keeps metadata in workspace storage, strips evidence ids, and retains newest runs', async () => {
    const target = repository();
    await target.saveRun(run('old', 1), 2);
    await target.saveRun(run('middle', 2), 2);
    await target.saveRun(run('new', 3), 2);
    const listed = await target.listRuns('demo', 'release');
    expect(listed.map((item) => item.id)).toEqual(['new', 'middle']);
    expect(listed[0]!.cases[0]).not.toHaveProperty('evidenceId');
    expect([...mock.files.keys()]).toEqual(['/workspace/campaigns/demo.json']);
  });

  it('accepts only a complete campaign as baseline', async () => {
    const target = repository();
    await target.saveRun(run('complete', 2));
    await target.saveRun(run('partial', 3, 'cancelled'));
    await expect(target.acceptBaseline('demo', 'release', 'partial')).rejects.toThrow('completed, non-empty campaign sample');
    await expect(target.acceptBaseline('demo', 'release', 'complete', 10)).resolves.toMatchObject({ runId: 'complete', acceptedAt: 10 });
    expect((await target.getAcceptedBaseline('demo', 'release'))?.run.id).toBe('complete');
    await target.saveRun(run('newer', 20), 1);
    expect((await target.listRuns('demo', 'release')).map((item) => item.id)).toEqual(['newer', 'complete']);
    expect((await target.getAcceptedBaseline('demo', 'release'))?.run.id).toBe('complete');
  });

  it('does not accept an empty completed run as a baseline', async () => {
    const target = repository();
    const empty = run('empty', 2);
    empty.plan.selectedCases = 0;
    empty.cases = [];
    empty.coverage.percent = 0;
    await target.saveRun(empty);
    await expect(target.acceptBaseline('demo', 'release', 'empty')).rejects.toThrow('completed, non-empty campaign sample');
  });

  it('drops malformed and cross-profile records fail closed', async () => {
    const target = repository();
    await target.saveRun(run('valid', 1));
    const path = '/workspace/campaigns/demo.json';
    const stored = JSON.parse(new TextDecoder().decode(mock.files.get(path)!));
    stored.runs.push({ ...run('cross', 2), profileId: 'other' }, { id: 'bad' });
    mock.files.set(path, new TextEncoder().encode(JSON.stringify(stored)));
    expect((await target.listRuns('demo')).map((item) => item.id)).toEqual(['valid']);
  });

  it('emits one sanitized warning for repeated corrupt storage reads', async () => {
    const output = { appendLine: vi.fn() };
    mock.files.set('/workspace/campaigns/demo.json', new TextEncoder().encode('{"secret":"must-not-appear"'));
    const target = repository(output);
    await target.listRuns('demo');
    await target.listRuns('demo');
    expect(output.appendLine).toHaveBeenCalledTimes(1);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('reason=read-failed'));
    expect(output.appendLine.mock.calls.flat().join('\n')).not.toContain('must-not-appear');
  });
});
