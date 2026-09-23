import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../web/src/artifactStore';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('turnstage-web');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe('ArtifactStore', () => {
  it('keeps large Web artifacts isolated by profile', async () => {
    const store = new ArtifactStore();
    await store.put('evidence', { id: 'evidence-a', profileId: 'profile-a', kind: 'scenario', name: 'A', updatedAt: 2, value: { passed: true } });
    await store.put('evidence', { id: 'evidence-b', profileId: 'profile-b', kind: 'scenario', name: 'B', updatedAt: 1, value: { passed: false } });

    expect(await store.get('evidence', 'evidence-a')).toMatchObject({ profileId: 'profile-a', value: { passed: true } });
    expect(await store.list('evidence', 'profile-a')).toHaveLength(1);
    expect(await store.list('evidence')).toHaveLength(2);
  });

  it('reads only the requested profile and artifact kind', async () => {
    const store = new ArtifactStore();
    const profileId = `indexed-${crypto.randomUUID()}`;
    await store.put('runs', { id: `${profileId}:batch`, profileId, kind: 'test-batch', name: 'Batch', updatedAt: 2, value: { id: 'batch' } });
    await store.put('runs', { id: `${profileId}:detail`, profileId, kind: 'test', name: 'Detail', updatedAt: 3, value: { id: 'detail' } });
    await store.put('runs', { id: `${profileId}:other`, profileId: `${profileId}-other`, kind: 'test-batch', name: 'Other', updatedAt: 4, value: { id: 'other' } });
    expect((await store.listByKind('runs', profileId, 'test-batch')).map((item) => item.id)).toEqual([`${profileId}:batch`]);
  });

  it('clears only the selected profile collection', async () => {
    const store = new ArtifactStore();
    await store.put('runs', { id: 'run-a', profileId: 'profile-a', kind: 'conversation', name: 'A', updatedAt: 1, value: {} });
    await store.put('runs', { id: 'run-b', profileId: 'profile-b', kind: 'conversation', name: 'B', updatedAt: 2, value: {} });

    expect(await store.clearProfile('runs', 'profile-a')).toBe(1);
    expect(await store.list('runs', 'profile-a')).toEqual([]);
    expect(await store.list('runs', 'profile-b')).toMatchObject([{ id: 'run-b' }]);
  });

  it('clears one test type atomically while preserving other history, evidence, and profiles', async () => {
    const store = new ArtifactStore();
    const general = { id: 'general', cases: [{ kind: 'contract' }] };
    const red = { id: 'red', cases: [{ kind: 'adversarial' }] };
    const mixed = { id: 'mixed', cases: [{ kind: 'contract' }, { kind: 'adversarial' }] };
    for (const run of [general, red, mixed]) await store.put('runs', { id: `test-batch:clear-a:${run.id}`, profileId: 'clear-a', kind: 'test-batch', name: run.id, updatedAt: 1, value: run });
    await store.put('runs', { id: 'test-batch:clear-b:general', profileId: 'clear-b', kind: 'test-batch', name: 'Other profile', updatedAt: 1, value: general });
    await store.put('runs', { id: 'test-baseline:clear-a', profileId: 'clear-a', kind: 'test-baseline', name: 'Baseline', updatedAt: 1, value: { runId: 'general' } });
    await store.put('runs', { id: 'test-batch:clear-a:running', profileId: 'clear-a', kind: 'test-batch', name: 'Running', updatedAt: 2, value: { id: 'running', checkpointState: 'running', cases: [{ kind: 'contract' }] } });
    await store.put('runs', { id: 'test-checkpoint:clear-a:running:0', profileId: 'clear-a', kind: 'test-checkpoint', name: 'Checkpoint', updatedAt: 2, value: { runId: 'running' } });
    await store.put('evidence', { id: 'clear-evidence', profileId: 'clear-a', kind: 'contract', name: 'Evidence', updatedAt: 1, value: {} });

    await store.clearTestHistory('clear-a', 'contract');

    expect(await store.get('runs', 'test-batch:clear-a:general')).toBeUndefined();
    expect((await store.get<typeof mixed>('runs', 'test-batch:clear-a:mixed'))?.value.cases).toEqual([{ kind: 'adversarial' }]);
    expect(await store.get('runs', 'test-batch:clear-a:red')).toBeTruthy();
    expect(await store.get('runs', 'test-batch:clear-b:general')).toBeTruthy();
    expect(await store.get('runs', 'test-batch:clear-a:running')).toBeTruthy();
    expect(await store.get('runs', 'test-checkpoint:clear-a:running:0')).toBeTruthy();
    expect(await store.get('runs', 'test-baseline:clear-a')).toBeUndefined();
    expect(await store.get('evidence', 'clear-evidence')).toBeTruthy();
  });
});
