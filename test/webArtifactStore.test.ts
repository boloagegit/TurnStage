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

  it('clears only the selected profile collection', async () => {
    const store = new ArtifactStore();
    await store.put('runs', { id: 'run-a', profileId: 'profile-a', kind: 'conversation', name: 'A', updatedAt: 1, value: {} });
    await store.put('runs', { id: 'run-b', profileId: 'profile-b', kind: 'conversation', name: 'B', updatedAt: 2, value: {} });

    expect(await store.clearProfile('runs', 'profile-a')).toBe(1);
    expect(await store.list('runs')).toMatchObject([{ id: 'run-b' }]);
  });
});
