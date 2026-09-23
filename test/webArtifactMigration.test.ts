import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../web/src/artifactStore';

describe('ArtifactStore migration', () => {
  it('indexes existing version 1 artifacts by profile and kind without losing them', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('turnstage-web', 1);
      request.onupgradeneeded = () => {
        const runs = request.result.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('profileId', 'profileId', { unique: false });
        runs.createIndex('updatedAt', 'updatedAt', { unique: false });
        runs.put({ id: 'legacy-test-batch', profileId: 'legacy-profile', kind: 'test-batch', name: 'Legacy run', updatedAt: 1, value: { id: 'legacy-run' } });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });

    const store = new ArtifactStore();
    expect(await store.listByKind('runs', 'legacy-profile', 'test-batch')).toMatchObject([{ id: 'legacy-test-batch', value: { id: 'legacy-run' } }]);
    expect(await store.listByKind('runs', 'legacy-profile', 'conversation')).toEqual([]);
  });
});
