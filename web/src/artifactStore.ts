import { clearTestRunHistoryKind, type TestRunHistoryRecord } from '../../src/shared/testRunHistory';

export type ArtifactStoreName = 'suites' | 'runs' | 'evidence' | 'campaigns' | 'visualBaselines';

export interface StoredArtifact<T = unknown> {
  id: string;
  profileId: string;
  kind: string;
  name: string;
  updatedAt: number;
  value: T;
}

const DATABASE_NAME = 'turnstage-web';
const DATABASE_VERSION = 1;
const STORES: ArtifactStoreName[] = ['suites', 'runs', 'evidence', 'campaigns', 'visualBaselines'];

export class ArtifactStore {
  private database?: Promise<IDBDatabase>;

  async put<T>(store: ArtifactStoreName, artifact: StoredArtifact<T>): Promise<void> {
    const database = await this.open();
    await transaction(database, store, 'readwrite', (objectStore) => objectStore.put(structuredClone(artifact)));
  }

  async get<T>(store: ArtifactStoreName, id: string): Promise<StoredArtifact<T> | undefined> {
    const database = await this.open();
    return transaction(database, store, 'readonly', (objectStore) => objectStore.get(id)) as Promise<StoredArtifact<T> | undefined>;
  }

  async list<T>(store: ArtifactStoreName, profileId?: string): Promise<Array<StoredArtifact<T>>> {
    const database = await this.open();
    const values = await transaction(database, store, 'readonly', (objectStore) => profileId ? objectStore.index('profileId').getAll(profileId) : objectStore.getAll()) as Array<StoredArtifact<T>>;
    return values.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async keys(store: ArtifactStoreName, profileId: string): Promise<IDBValidKey[]> {
    const database = await this.open();
    return transaction(database, store, 'readonly', (objectStore) => objectStore.index('profileId').getAllKeys(profileId)) as Promise<IDBValidKey[]>;
  }

  async delete(store: ArtifactStoreName, id: string): Promise<void> {
    const database = await this.open();
    await transaction(database, store, 'readwrite', (objectStore) => objectStore.delete(id));
  }

  async clearProfile(store: ArtifactStoreName, profileId: string): Promise<number> {
    const records = await this.list(store, profileId);
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      for (const record of records) objectStore.delete(record.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
    });
    return records.length;
  }

  async clearTestHistory(profileId: string, kind: 'contract' | 'adversarial'): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('runs', 'readwrite');
      const objectStore = tx.objectStore('runs');
      const request = objectStore.index('profileId').getAll(profileId);
      request.onsuccess = () => {
        const artifacts = request.result as StoredArtifact[];
        const batches = artifacts.filter((item): item is StoredArtifact<TestRunHistoryRecord> => item.kind === 'test-batch');
        const baseline = artifacts.find((item) => item.id === `test-baseline:${profileId}`);
        const baselineRunId = (baseline?.value as { runId?: string } | undefined)?.runId;
        const cleared = clearTestRunHistoryKind(batches.map((item) => item.value), kind, baselineRunId);
        const retained = new Map(cleared.runs.map((run) => [run.id, run]));
        for (const item of batches) {
          const run = retained.get(item.value.id);
          if (!run) objectStore.delete(item.id);
          else if (run.cases.length !== item.value.cases.length) objectStore.put({ ...item, value: run });
        }
        if (baseline && !cleared.baselineRunId) objectStore.delete(baseline.id);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read test history.'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not clear test history.'));
      tx.onabort = () => reject(tx.error ?? new Error('Test history clear was aborted.'));
    });
  }

  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of STORES) {
          if (database.objectStoreNames.contains(store)) continue;
          const objectStore = database.createObjectStore(store, { keyPath: 'id' });
          objectStore.createIndex('profileId', 'profileId', { unique: false });
          objectStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('TurnStage Web could not open IndexedDB.'));
      request.onblocked = () => reject(new Error('TurnStage Web storage upgrade is blocked by another open tab.'));
    });
  }
}

function transaction(database: IDBDatabase, store: ArtifactStoreName, mode: IDBTransactionMode, request: (objectStore: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const operation = request(tx.objectStore(store));
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}
