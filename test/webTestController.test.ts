import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import type { HostPayload } from '../src/shared/protocol';
import type { TestRunHistoryRecord } from '../src/shared/testRunHistory';
import { createTestRunHistoryRecord } from '../src/shared/testRunHistory';
import { WebTestController } from '../web/src/webTestController';
import { ArtifactStore } from '../web/src/artifactStore';
import { serializeContractCsv } from '../src/extension/testing/contractCsv';
import { parseContractCsv } from '../src/extension/testing/contractCsv';
import { parseContractSuite } from '../src/extension/testing/contractSuite';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import { parseAdversarialSuite } from '../src/extension/testing/adversarialSuite';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('WebTestController', () => {
  it('keeps latest results and exports isolated when profiles reuse a case ID', async () => {
    const scenario = { id: 'shared-id', name: 'Same case ID', steps: [{ id: 'turn', input: 'Hello' }] };
    const base: TurnStageProfile = { version: 1, id: `isolation-a-${crypto.randomUUID()}`, name: 'A', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { scenarios: [scenario] } };
    const second = { ...base, id: `isolation-b-${crypto.randomUUID()}`, name: 'B' };
    let active = base;
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 })));
    const messages: HostPayload[] = [];
    const controller = new WebTestController(() => active, () => environment, new Map(), (payload) => { messages.push(payload); });
    await controller.run('runContracts');
    active = second;
    controller.onProfileChanged();
    expect(messages.filter((message): message is Extract<HostPayload, { type: 'test.results' }> => message.type === 'test.results').at(-1)?.automationResults).toEqual([]);
    await controller.run('runContracts');
    const secondResults = messages.filter((message): message is Extract<HostPayload, { type: 'test.results' }> => message.type === 'test.results').at(-1)?.automationResults;
    expect(secondResults).toHaveLength(1);
    expect(secondResults?.[0]?.profileId).toBe(second.id);
    active = base;
    controller.onProfileChanged();
    const firstResults = messages.filter((message): message is Extract<HostPayload, { type: 'test.results' }> => message.type === 'test.results').at(-1)?.automationResults;
    expect(firstResults).toHaveLength(1);
    expect(firstResults?.[0]?.profileId).toBe(base.id);
    let report: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (blob instanceof Blob) report = blob; return 'blob:profile-isolation'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
    await controller.exportReport('json', undefined, 'contract');
    const content = await report!.text();
    expect(content).toContain(base.id);
    expect(content).not.toContain(second.id);
  });

  it('recovers completed checkpoints after a browser restart and reruns only unfinished cases', async () => {
    const scenarios = ['done', 'remaining'].map((id) => ({ id, name: id, steps: [{ id: 'turn', input: id }] }));
    const profile: TurnStageProfile = { version: 1, id: `recovery-${crypto.randomUUID()}`, name: 'Recovery', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { scenarios } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const runId = crypto.randomUUID();
    const planned = scenarios.map((scenario) => ({ profileId: profile.id, kind: 'contract' as const, scenarioId: scenario.id, name: scenario.name, scenario }));
    const pending = { ...createTestRunHistoryRecord({ id: runId, profileId: profile.id, startedAt: 1, finishedAt: 1, status: 'cancelled', runner: 'web', profile, environment, cases: planned, completed: [] }), checkpointState: 'running' };
    const store = new ArtifactStore();
    await store.put('runs', { id: `test-batch:${profile.id}:${runId}`, profileId: profile.id, kind: 'test-batch', name: 'Interrupted run', updatedAt: 1, value: pending });
    await store.put('runs', { id: `test-checkpoint:${profile.id}:${runId}:0`, profileId: profile.id, kind: 'test-checkpoint', name: 'done', updatedAt: 2, value: { runId, completed: { profileId: profile.id, kind: 'contract', scenarioId: 'done', outcome: 'passed', completedAttempts: 1, durationMs: 10 } } });
    const messages: HostPayload[] = [];
    const controller = new WebTestController(() => profile, () => environment, new Map(), (payload) => { messages.push(payload); });
    await controller.postHistory();
    const recovered = messages.filter((message): message is Extract<HostPayload, { type: 'test.history' }> => message.type === 'test.history').at(-1)?.runs[0];
    expect(recovered).toMatchObject({ status: 'cancelled', cases: [{ scenarioId: 'done', outcome: 'passed' }, { scenarioId: 'remaining', completedAttempts: 0 }] });
    expect(await store.get('runs', `test-checkpoint:${profile.id}:${runId}:0`)).toBeUndefined();
    const fetch = vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await controller.rerunHistory(runId, 'contract', 'unfinished');
    expect(fetch).toHaveBeenCalledTimes(1);
    const rerun = messages.filter((message): message is Extract<HostPayload, { type: 'test.history' }> => message.type === 'test.history').at(-1)?.runs[0];
    expect(rerun?.sourceRunId).toBe(runId);
    expect(rerun?.cases.map((item) => item.scenarioId)).toEqual(['remaining']);
  });

  it('does not recover a live run owned by another browser tab', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    const profile: TurnStageProfile = { version: 1, id: `two-tabs-${crypto.randomUUID()}`, name: 'Two tabs', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { scenarios: [{ id: 'one', name: 'One', steps: [{ id: 'turn', input: 'Hello' }] }] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    let releaseRequest: (() => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestStarted?.();
      await new Promise<void>((resolve) => { releaseRequest = resolve; });
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    }));
    const first = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    const secondMessages: HostPayload[] = [];
    const second = new WebTestController(() => profile, () => environment, new Map(), (payload) => { secondMessages.push(payload); });
    const running = first.run('runContracts');
    await started;
    const pending = (await new ArtifactStore().listByKind<TestRunHistoryRecord>('runs', profile.id, 'test-batch'))[0]!;
    await second.postHistory();
    expect((await new ArtifactStore().get('runs', pending.id))?.value).toMatchObject({ checkpointState: 'running' });
    expect(secondMessages.filter((message): message is Extract<HostPayload, { type: 'test.history' }> => message.type === 'test.history').at(-1)?.runs).toEqual([]);
    await second.clearHistory('contract');
    expect((await new ArtifactStore().get('runs', pending.id))?.value).toMatchObject({ checkpointState: 'running' });
    releaseRequest?.();
    await running;
    await second.postHistory();
    expect(secondMessages.filter((message): message is Extract<HostPayload, { type: 'test.history' }> => message.type === 'test.history').at(-1)?.runs[0]).toMatchObject({ status: 'completed' });
    second.onProfileChanged();
  });

  it('does not send a test request when its cross-tab recovery lease cannot be saved', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); }, removeItem: () => undefined });
    const profile: TurnStageProfile = { version: 1, id: `lease-failure-${crypto.randomUUID()}`, name: 'Lease failure', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [{ id: 'one', name: 'One', steps: [{ id: 'turn', input: 'Hello' }] }] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    await expect(controller.run('runContracts')).rejects.toThrow(/Browser storage is unavailable/u);
    expect(fetch).not.toHaveBeenCalled();
    expect(await new ArtifactStore().listByKind('runs', profile.id, 'test-batch')).toEqual([]);
  });

  it('updates an imported suite with the same ID without duplicating its cases', async () => {
    const profile: TurnStageProfile = { version: 1, id: `import-update-${crypto.randomUUID()}`, name: 'Import update', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn(), () => 'zh-TW');
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    const first = serializeContractCsv([{ id: 'case-one', name: 'One', steps: [{ id: 'turn', input: 'first' }] }]);
    const second = serializeContractCsv([{ id: 'case-two', name: 'Two', steps: [{ id: 'turn', input: 'second' }] }]);
    await controller.importSuiteText('contract', 'csv', 'same.csv', first);
    const before = await new ArtifactStore().list('suites', profile.id);
    await controller.importSuiteText('contract', 'csv', 'same.csv', second);
    const after = await new ArtifactStore().list('suites', profile.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect((await controller.scenarioEntries()).map((item) => item.scenario.id)).toEqual(['case-two']);
  });
  it('exports inline and imported general cases as valid JSONC and CSV, and rejects duplicate IDs', async () => {
    const inline = { id: 'inline-case', name: 'Inline case', steps: [{ id: 'turn-one', input: 'Hello' }] };
    const imported = { id: 'imported-case', name: 'Imported case', steps: [{ id: 'turn-one', input: 'Search' }] };
    const profile: TurnStageProfile = { version: 1, id: `export-contract-${crypto.randomUUID()}`, name: 'Export contract', opening: { mode: 'static', message: 'Ready', starters: [] }, conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [inline] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const sourcePath = 'browser://suite/imported/cases.csv';
    await new ArtifactStore().put('suites', { id: `${profile.id}:${sourcePath}`, profileId: profile.id, kind: 'contract', name: 'Imported', updatedAt: Date.now(), value: { suiteId: 'imported', name: 'Imported', kind: 'contract', sourceFormat: 'csv', sourcePath, revision: 'a'.repeat(64), scenarios: [imported], raw: serializeContractCsv([imported]) } });
    const controller = new WebTestController(() => profile, () => environment, new Map(), () => undefined);
    let exported: Blob | undefined;
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (blob instanceof Blob) exported = blob; return 'blob:turnstage-export'; });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
    try {
      await controller.exportSuites('contract', 'jsonc');
      expect(parseContractSuite(await exported!.text())).toMatchObject({ issues: [], suite: { cases: [{ id: 'inline-case' }, { id: 'imported-case' }] } });
      await controller.exportSuites('contract', 'csv');
      expect(parseContractCsv(await exported!.text()).scenarios.map((scenario) => scenario.id)).toEqual(['inline-case', 'imported-case']);
      profile.tests!.scenarios = [{ ...inline, id: 'imported-case' }];
      await expect(controller.exportSuites('contract', 'jsonc')).rejects.toThrow(/Duplicate case id/u);
      expect(objectUrl).toHaveBeenCalledTimes(2);
    } finally {
      objectUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
  it('exports an inline red-team case even when no browser suite was imported', async () => {
    const scenario = { id: 'red-inline', name: 'Red inline', steps: [{ id: 'turn-one', input: 'Probe' }], adversarial: { mode: 'singleTurn' as const, maxTurns: 1, timeoutMs: 60_000, forbid: { urls: true } } };
    const profile: TurnStageProfile = { version: 1, id: `export-red-${crypto.randomUUID()}`, name: 'Export red', opening: { mode: 'static', message: 'Ready', starters: [] }, conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [scenario] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    let exported: Blob | undefined;
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (blob instanceof Blob) exported = blob; return 'blob:turnstage-red-export'; });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
    try {
      await new WebTestController(() => profile, () => environment, new Map(), () => undefined).exportSuites('adversarial', 'jsonc');
      expect(parseAdversarialSuite(await exported!.text())).toMatchObject({ issues: [], suite: { cases: [{ id: 'red-inline' }] } });
    } finally {
      objectUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
  it('deletes one case from an imported browser copy and rejects a stale list revision', async () => {
    const profile: TurnStageProfile = { version: 1, id: `browser-delete-${crypto.randomUUID()}`, name: 'Browser delete', opening: { mode: 'static', message: 'Ready', starters: [] }, conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const store = new ArtifactStore();
    const post = vi.fn();
    const controller = new WebTestController(() => profile, () => environment, new Map(), post);
    for (const kind of ['contract', 'adversarial'] as const) {
      const scenarios = [1, 2].map((number) => ({ id: `${kind}-${number}`, name: `Case ${number}`, steps: [{ id: 'turn-one', input: `Prompt ${number}` }], ...(kind === 'adversarial' ? { adversarial: { mode: 'singleTurn' as const, maxTurns: 1, timeoutMs: 60_000, forbid: { urls: true } } } : {}) }));
      const sourcePath = `browser://suite/${kind}/cases.csv`;
      const raw = kind === 'contract' ? serializeContractCsv(scenarios) : serializeAdversarialCsv(scenarios);
      const artifact = { id: `${profile.id}:${sourcePath}`, profileId: profile.id, kind, name: 'Imported copy', updatedAt: Date.now(), value: { suiteId: `${kind}-suite`, name: 'Imported copy', kind, sourceFormat: 'csv', sourcePath, revision: 'a'.repeat(64), scenarios, raw } };
      await store.put('suites', artifact);
      await expect(controller.deleteCase(kind, sourcePath, scenarios[0]!.id, 'b'.repeat(64))).rejects.toThrow(/changed/u);
      expect((await store.get<typeof artifact.value>('suites', artifact.id))!.value.scenarios).toHaveLength(2);
      await controller.deleteCase(kind, sourcePath, scenarios[0]!.id, artifact.value.revision);
      const updated = (await store.get<typeof artifact.value>('suites', artifact.id))!.value;
      expect(updated.scenarios.map((item) => item.id)).toEqual([scenarios[1]!.id]);
      expect(updated.raw).not.toContain(scenarios[0]!.id);
      expect(raw).toContain(scenarios[0]!.id);
      expect(post).toHaveBeenCalledWith({ type: `${kind === 'contract' ? 'contract' : 'adversarial'}.case.deleted`, sourcePath, scenarioId: scenarios[0]!.id });
    }
  });
  it('fails closed before sending a request when a case requires VS Code fault simulation', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `fault-web-${crypto.randomUUID()}`, name: 'Fault Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const scenario = { id: 'fault-case', name: 'Fault case', faults: { disconnectAfterEvents: 1 }, steps: [{ id: 'agent-turn', input: 'Search' }] };
    profile.tests = { scenarios: [scenario] };
    const post = vi.fn();
    const controller = new WebTestController(() => profile, () => environment, new Map(), post);

    const execution = await controller.executeScenario({ key: `${profile.id}/inline/${scenario.id}`, itemId: `inline:${scenario.id}`, scenario });
    expect(fetch).not.toHaveBeenCalled();
    expect(execution.result.passed).toBe(false);
    expect(execution.result.checks[0]?.label).toContain('requires the VS Code extension');
    await expect(controller.run('runCase', scenario.id, 'contract')).rejects.toThrow(/requires the VS Code extension/u);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'test.results' }));
  });

  it('runs configured adversarial repetitions in isolated browser sessions', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `red-team-${crypto.randomUUID()}`, name: 'Red Team Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
    };
    const scenario = { id: 'resistance', name: 'Resistance', steps: [{ id: 'turn', input: 'attack' }], adversarial: { mode: 'singleTurn' as const, maxTurns: 1, timeoutMs: 5_000, repetitions: 2, forbid: { content: ['forbidden'] } } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => new Response('event: message\ndata: {"text":"safe"}\n\nevent: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), () => undefined);

    const execution = await controller.executeScenario({ key: `${profile.id}/inline/${scenario.id}`, itemId: `inline:${scenario.id}`, scenario });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(execution.result.adversarial?.outcome).toBe('resisted');
    expect(execution.result.repetitions).toMatchObject({ requestedAttempts: 2, completedAttempts: 2, sampleComplete: true, stability: 'stable-pass' });
  });

  it('exports separate latest HTML reports after both test types have run', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `mixed-export-${crypto.randomUUID()}`, name: 'Mixed export',
      opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: { scenarios: [
        { id: 'ordinary-case', name: 'Ordinary case', steps: [{ id: 'turn', input: 'Hello' }] },
        { id: 'red-case', name: 'Red case', steps: [{ id: 'turn', input: 'Probe' }], adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 5_000, forbid: { urls: true } } },
      ] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 })));
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn(), () => 'zh-TW');
    await controller.run('runContracts');
    await controller.run('runAll');
    let exported: Blob | undefined;
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (blob instanceof Blob) exported = blob; return 'blob:turnstage-report'; });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
    try {
      await controller.exportReport('html', undefined, 'contract');
      const ordinaryHtml = await exported!.text();
      expect(ordinaryHtml).toContain('一般測試報告');
      expect(ordinaryHtml).toContain('ordinary-case');
      expect(ordinaryHtml).not.toContain('red-case');
      await controller.exportReport('html', undefined, 'adversarial');
      const redHtml = await exported!.text();
      expect(redHtml).toContain('紅隊測試報告');
      expect(redHtml).toContain('red-case');
      expect(redHtml).not.toContain('ordinary-case');
      await expect(controller.exportReport('html')).rejects.toThrow(/Choose general or red-team/u);
    } finally {
      objectUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });

  it('runs only ready cases of the requested type and resolves the exact suite', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `selection-web-${crypto.randomUUID()}`, name: 'Selection Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: { scenarios: [
        { id: 'normal', name: 'Normal', steps: [{ id: 'turn', input: 'normal' }] },
        { id: 'draft', name: 'Draft', tags: ['needs-review'], steps: [{ id: 'turn', input: 'draft' }] },
        { id: 'attack', name: 'Attack', steps: [{ id: 'turn', input: 'attack' }], adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 5_000, forbid: { urls: true } } },
      ] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const post = vi.fn();
    const controller = new WebTestController(() => profile, () => environment, new Map(), post);

    await controller.run('runAll');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'test.results', automationResults: [] }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'test.history', profileId: profile.id, runs: [expect.objectContaining({ runner: 'web', status: 'completed', cases: [expect.objectContaining({ scenarioId: 'attack', kind: 'adversarial' })] })] }));
    await controller.run('runContracts');
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(controller.run('runCase', 'draft', 'contract')).rejects.toThrow(/still need review/u);
    expect(fetch).toHaveBeenCalledTimes(2);

    const store = new ArtifactStore();
    for (const suiteId of ['suite-a', 'suite-b']) {
      const scenario = { id: 'same', name: suiteId, steps: [{ id: 'turn', input: suiteId }] };
      await store.put('suites', { id: `${profile.id}:${suiteId}`, profileId: profile.id, kind: 'contract', name: suiteId, updatedAt: Date.now(), value: { suiteId, name: suiteId, kind: 'contract', sourceFormat: 'jsonc', sourcePath: `browser://${suiteId}`, revision: 'a'.repeat(64), scenarios: [scenario], raw: '' } });
    }
    await controller.run('runCase', 'same', 'contract', 'suite-b');
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(controller.run('runCase', 'same', 'contract')).rejects.toThrow(/missing or still need review/u);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('runs an exact selected batch and rejects stale draft selections before sending', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `selected-web-${crypto.randomUUID()}`, name: 'Selected Web',
      opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: { scenarios: [{ id: 'ready', name: 'Ready', steps: [{ id: 'turn', input: 'Hello' }] }, { id: 'draft', name: 'Draft', tags: ['needs-review'], steps: [{ id: 'turn', input: 'Review me' }] }] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const post = vi.fn();
    const controller = new WebTestController(() => profile, () => environment, new Map(), post);
    const ready = { profileId: profile.id, scenarioId: 'ready', kind: 'contract' as const };
    await controller.runCases([ready]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'test.history', runs: [expect.objectContaining({ cases: [expect.objectContaining({ scenarioId: 'ready' })] })] }));
    await expect(controller.runCases([ready, { ...ready, scenarioId: 'draft' }])).rejects.toThrow(/still need review/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    await controller.clearHistory('contract');
    expect(post.mock.calls.filter(([message]) => message.type === 'test.history').at(-1)?.[0]).toMatchObject({ type: 'test.history', profileId: profile.id, runs: [] });
  });

  it('rejects performance regression without a baseline before sending a request', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `unsupported-web-${crypto.randomUUID()}`, name: 'Unsupported Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] },
      tests: { scenarios: [{ id: 'performance', name: 'Performance', steps: [{ id: 'turn', input: 'hello' }], performance: { regression: { 'scenario.durationMs': { maxIncreaseMs: 1_000 } } } }] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    await expect(controller.run('runContracts')).rejects.toThrow(/Performance regression checks require/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('evaluates absolute performance thresholds in Web and records a failing check', async () => {
    const scenario = { id: 'threshold', name: 'Threshold', steps: [{ id: 'turn', input: 'hello' }], performance: { thresholds: { 'scenario.durationMs': 0 } } };
    const profile: TurnStageProfile = { version: 1, id: `threshold-${crypto.randomUUID()}`, name: 'Threshold', conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { scenarios: [scenario] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return new Response('event: done\ndata: {}\n\n', { status: 200 }); });
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    const execution = await controller.executeScenario({ key: 'threshold', itemId: 'inline:threshold', scenario });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execution.result.checks).toContainEqual(expect.objectContaining({ id: 'performance.threshold.scenario.durationMs', kind: 'performance', passed: false }));
    expect(execution.result.passed).toBe(false);
  });

  it('keeps the initial endpoint for every case when the live profile changes mid-run', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `snapshot-web-${crypto.randomUUID()}`, name: 'Snapshot Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://first.example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: { scenarios: [{ id: 'one', name: 'One', steps: [{ id: 'turn', input: 'one' }] }, { id: 'two', name: 'Two', steps: [{ id: 'turn', input: 'two' }] }] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async (_input: RequestInfo | URL) => {
      expect(String(_input)).toContain('first.example.test');
      profile.conversation.send.url = 'https://second.example.test/stream';
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    await controller.run('runContracts');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every((call) => String(call[0]).includes('first.example.test'))).toBe(true);
  });

  it('does not relabel cases from another profile when the active profile changes during discovery', async () => {
    const first: TurnStageProfile = { version: 1, id: 'profile-a', name: 'A', opening: { mode: 'static', message: 'Ready', starters: [] }, conversation: { send: { method: 'POST', url: 'https://first.example.test/stream' } }, stream: { transport: 'sse', mappings: [] } };
    const second: TurnStageProfile = { ...first, id: 'profile-b', name: 'B' };
    let active = first;
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => active, () => environment, new Map(), vi.fn());
    vi.spyOn(controller, 'scenarioEntries').mockImplementation(async () => {
      active = second;
      return [{ key: 'profile-a/inline/one', itemId: 'inline:one', scenario: { id: 'one', name: 'One', steps: [{ id: 'turn', input: 'hello' }] } }];
    });
    await expect(controller.run('runContracts')).rejects.toThrow(/active profile changed before/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reruns non-passing cases from one chosen history entry with its source run ID', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `rerun-web-${crypto.randomUUID()}`, name: 'Rerun Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: { scenarios: [{ id: 'failure', name: 'Failure', steps: [{ id: 'turn', input: 'hello', assertions: [{ path: 'turn.state', operator: 'equals', value: 'missing' }] }] }] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn(async () => new Response('event: done\ndata: {}\n\n', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const messages: HostPayload[] = [];
    const post = (payload: HostPayload) => { messages.push(payload); };
    const controller = new WebTestController(() => profile, () => environment, new Map(), post);
    await controller.run('runContracts');
    const firstHistory = messages.filter((payload): payload is Extract<HostPayload, { type: 'test.history' }> => payload.type === 'test.history').at(-1);
    const sourceRunId = firstHistory?.runs[0]?.id;
    expect(sourceRunId).toBeTruthy();
    expect(firstHistory?.runs[0]?.cases[0]?.evidenceAvailable).toBe(true);
    let exported: Blob | undefined;
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (blob instanceof Blob) exported = blob; return 'blob:turnstage-test'; });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
    await controller.exportRunReport(sourceRunId!, 'json');
    expect(JSON.parse(await exported!.text())).toMatchObject({ runId: sourceRunId, totalCases: 1, evidenceCases: 1 });
    const storedRun = (await new ArtifactStore().get<TestRunHistoryRecord>('runs', `test-batch:${profile.id}:${sourceRunId}`))!;
    const incomplete = { ...storedRun.value.cases[0]!, key: `${profile.id}/contract/inline/not-run`, scenarioId: 'not-run', name: 'Not run', outcome: undefined, completedAttempts: 0, evidenceId: undefined };
    await new ArtifactStore().put('runs', { ...storedRun, value: { ...storedRun.value, status: 'cancelled', cases: [...storedRun.value.cases, incomplete] } });
    await controller.exportRunReport(sourceRunId!, 'junit');
    const junit = await exported!.text();
    expect(junit).toContain('tests="2"');
    expect(junit).toContain('errors="1"');
    expect(junit).toContain('not-run');
    await controller.exportRunReport(sourceRunId!, 'html');
    expect(await exported!.text()).toContain('Status cancelled');
    expect(await exported!.text()).toContain('Not run');
    await new ArtifactStore().put('runs', storedRun);
    objectUrl.mockRestore();
    revokeUrl.mockRestore();
    await new ArtifactStore().delete('evidence', firstHistory!.runs[0]!.cases[0]!.evidenceId!);
    await controller.postHistory(profile.id);
    const expiredHistory = messages.filter((payload): payload is Extract<HostPayload, { type: 'test.history' }> => payload.type === 'test.history').at(-1);
    expect(expiredHistory?.runs[0]?.cases[0]?.evidenceAvailable).toBe(false);
    await expect(controller.exportRunReport(sourceRunId!, 'json')).rejects.toThrow(/expired/u);
    await expect(controller.rerunHistory(sourceRunId!, 'adversarial')).rejects.toThrow(/no non-passing cases/u);
    expect(fetch).toHaveBeenCalledTimes(1);
    await controller.rerunHistory(sourceRunId!, 'contract');
    const secondHistory = messages.filter((payload): payload is Extract<HostPayload, { type: 'test.history' }> => payload.type === 'test.history').at(-1);
    expect(secondHistory?.runs[0]?.sourceRunId).toBe(sourceRunId);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
