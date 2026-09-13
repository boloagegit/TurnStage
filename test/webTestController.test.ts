import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import type { HostPayload } from '../src/shared/protocol';
import type { TestRunHistoryRecord } from '../src/shared/testRunHistory';
import { WebTestController } from '../web/src/webTestController';
import { ArtifactStore } from '../web/src/artifactStore';
import { serializeContractCsv } from '../src/extension/testing/contractCsv';
import { parseContractCsv } from '../src/extension/testing/contractCsv';
import { parseContractSuite } from '../src/extension/testing/contractSuite';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import { parseAdversarialSuite } from '../src/extension/testing/adversarialSuite';

afterEach(() => vi.unstubAllGlobals());

describe('WebTestController', () => {
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

  it('rejects unsupported comparison and performance cases without a network request', async () => {
    const profile: TurnStageProfile = {
      version: 1, id: `unsupported-web-${crypto.randomUUID()}`, name: 'Unsupported Web', opening: { mode: 'static', message: 'Ready', starters: [] },
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } }, stream: { transport: 'sse', mappings: [] },
      tests: { scenarios: [{ id: 'performance', name: 'Performance', steps: [{ id: 'turn', input: 'hello' }], performance: { thresholds: { 'scenario.durationMs': 1_000 } } }] },
    };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new WebTestController(() => profile, () => environment, new Map(), vi.fn());
    await expect(controller.run('runContracts')).rejects.toThrow(/Performance checks are not available in Web/u);
    expect(fetch).not.toHaveBeenCalled();
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
    expect(await exported!.text()).toContain('Status: cancelled');
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
