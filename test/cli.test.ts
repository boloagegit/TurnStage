import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from '../src/cli/args';
import type { CliExecutionRuntime, CliIo } from '../src/cli/contracts';
import { aggregateExitCode } from '../src/cli/exitCodes';
import { createCliOutputDocument, renderCliOutput } from '../src/cli/output';
import { executeHeadlessCli, runHeadlessCli } from '../src/cli/runner';
import { NodeCliRuntime } from '../src/cli/nodeRuntime';
import { NodeScenarioSession } from '../src/cli/nodeSession';
import { serializeAdversarialCsv } from '../src/extension/testing/adversarialCsv';
import { parseAdversarialSource } from '../src/extension/testing/adversarialSource';
import { serializeContractCsv } from '../src/extension/testing/contractCsv';
import { ProfileValidator, validateAdversarialScenariosAgainstProfile } from '../src/extension/config/profileValidator';
import { builtInEnvironment } from '../src/extension/config/defaultEnvironment';
import { createProvenanceManifest } from '../src/extension/testing/provenance';
import type { ScenarioDefinition, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';

describe('headless CLI contract', () => {
  it('aggregates mixed outcomes deterministically while preserving outcome counts', () => {
    expect(aggregateExitCode(['passed', 'resisted'])).toMatchObject({ exitCode: 0, counts: { total: 2, passed: 1, resisted: 1 } });
    expect(aggregateExitCode(['failed', 'attackSucceeded'])).toMatchObject({ exitCode: 1, counts: { assertionFailed: 1, attackSucceeded: 1 } });
    expect(aggregateExitCode(['attackSucceeded', 'indeterminate'])).toMatchObject({ exitCode: 2, counts: { attackSucceeded: 1, indeterminate: 1 } });
    expect(aggregateExitCode(['attackSucceeded', 'infrastructureError'])).toMatchObject({ exitCode: 3, counts: { attackSucceeded: 1, infrastructureError: 1 } });
    expect(aggregateExitCode([])).toMatchObject({ exitCode: 2, counts: { total: 0 } });
    expect(aggregateExitCode([{ id: 'legacy-pass', passed: true }, { id: 'legacy-fail', passed: false }])).toMatchObject({ exitCode: 1, counts: { passed: 1, assertionFailed: 1 } });
    expect(aggregateExitCode(['new-runtime-label'])).toMatchObject({ exitCode: 2, counts: { unknown: 1 } });
  });

  it('parses selectors, policy overrides, aliases, and output choices', () => {
    const parsed = parseCliArgs(['run', '--profile', 'profile-a', '--case=one,two', '--changed-file', 'src/chat.ts', '--repetitions', '10', '--concurrency=4', '--timeout', '5000', '--junit', '--include-unbound', 'profile.turnstage.jsonc']);
    expect(parsed).toMatchObject({ ok: true, options: { command: 'run', format: 'junit', configFiles: ['profile.turnstage.jsonc'], selectors: { profiles: ['profile-a'], cases: ['one', 'two'], changedFiles: ['src/chat.ts'] }, policy: { repetitions: 10, concurrency: 4, timeoutMs: 5000, failFast: false }, includeUnbound: true } });
  });

  it('fails closed for malformed values and keeps verify separate from run selectors', () => {
    expect(parseCliArgs(['run', '--repetitions', '0'])).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('--repetitions')]) });
    expect(parseCliArgs(['run', '--unknown'])).toMatchObject({ ok: false, errors: [expect.stringContaining('Unknown option')] });
    expect(parseCliArgs(['verify', '--manifest', 'evidence/manifest.json', '--case', 'should-not-run'])).toMatchObject({ ok: false, errors: [expect.stringContaining('run-only options')] });
    expect(parseCliArgs(['verify', 'evidence/manifest.json'])).toMatchObject({ ok: true, options: { command: 'verify', manifestPath: 'evidence/manifest.json' } });
    expect(parseCliArgs(['--help'])).toMatchObject({ ok: true, options: { command: 'help' } });
  });

  it('serializes only bounded result metadata and escapes JUnit/HTML output', () => {
    const result = { runId: 'run-1', records: [{ id: 'case<&', outcome: 'attackSucceeded', durationMs: 12, failureId: 'finding-1' }, { id: 'safe', outcome: 'resisted', status: 'passed' }] };
    const document = createCliOutputDocument(result);
    expect(document.summary).toMatchObject({ total: 2, attackSucceeded: 1, resisted: 1 });
    expect(renderCliOutput(result, 'junit')).toContain('case&lt;&amp;');
    expect(renderCliOutput(result, 'html')).toContain('case&lt;&amp;');
    expect(renderCliOutput({ ...result, records: [{ id: 'case', outcome: 'failed', failureId: 'stable-finding', details: 'secret-detail' } as never] }, 'json')).not.toContain('secret-detail');
  });

  it('injects execution and file output without owning runtime or verdict semantics', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const files: Array<{ path: string; text: string }> = [];
    const io: CliIo = { writeStdout: (text) => { stdout.push(text); }, writeStderr: (text) => { stderr.push(text); }, writeFile: (path, text) => { files.push({ path, text }); } };
    const execute = vi.fn(async (request) => {
      expect(request.selectors.cases).toEqual(['case-1']);
      return { runId: 'run-1', records: [{ id: 'case-1', outcome: 'resisted' }] };
    });
    const runtime: CliExecutionRuntime = { execute };
    await expect(runHeadlessCli(['run', '--case', 'case-1'], runtime, io)).resolves.toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(stdout.join('')).toContain('"exitCode": 0');
    expect(stderr).toEqual([]);

    const fileResult = await executeHeadlessCli(['run', '--case', 'case-1', '--output', 'result.json'], runtime, io);
    expect(fileResult.exitCode).toBe(0);
    expect(files[0]).toMatchObject({ path: 'result.json' });
  });

  it('returns infrastructure for runtime failure and indeterminate for missing file writer', async () => {
    const stderr: string[] = [];
    const io: CliIo = { writeStdout: () => undefined, writeStderr: (text) => { stderr.push(text); } };
    const failing: CliExecutionRuntime = { execute: async () => { throw new Error('provider secret must not be printed'); } };
    await expect(runHeadlessCli(['run'], failing, io)).resolves.toBe(3);
    expect(stderr.join(' ')).not.toContain('provider secret');
    const result = await executeHeadlessCli(['run', '--output', 'result.json'], { execute: async () => ({ records: [{ id: 'case', outcome: 'resisted' }] }) }, io);
    expect(result.exitCode).toBe(2);
  });

  it('verifies a bundle provenance manifest and detects a changed evidence file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'turnstage-cli-verify-'));
    try {
      const reportPath = join(directory, 'report.json');
      const manifestPath = join(directory, 'provenance.json');
      const report = '{"status":"resisted"}\n';
      await writeFile(reportPath, report);
      const manifest = createProvenanceManifest({ runId: 'run', runnerKind: 'cli', runnerVersion: 'test', selectedTestIds: ['case'], evidenceFiles: [{ path: 'report.json', contents: report }] });
      await writeFile(manifestPath, JSON.stringify(manifest));
      const runtime = new NodeCliRuntime('test', directory);
      await expect(runtime.verify({ command: 'verify', manifestPath: 'provenance.json' })).resolves.toMatchObject({ verification: { valid: true, manifestValid: true } });
      await writeFile(reportPath, '{"status":"changed"}\n');
      await expect(runtime.verify({ command: 'verify', manifestPath: 'provenance.json' })).resolves.toMatchObject({ verification: { valid: false, manifestValid: true } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('executes a linked multi-attempt CSV suite without converting the source file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'turnstage-cli-csv-'));
    const profile: TurnStageProfile = {
      version: 1,
      id: 'csv-profile',
      name: 'CSV profile',
      conversation: { send: { method: 'POST', url: 'https://example.test/stream', timeoutMs: 1_000, variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
      stream: {
        transport: 'sse', doneValue: '[DONE]',
        mappings: [{ id: 'text', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } }],
      },
      tests: { adversarialSuites: ['security.adversarial.csv'], scenarios: [] },
    };
    const scenarios: ScenarioDefinition[] = [{
      id: 'csv-case', name: 'CSV case', steps: [{ id: 'turn-1', input: 'Probe' }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 1_000, repetitions: 2, forbid: { content: ['blocked-marker'] } },
    }];
    const fetchMock = vi.fn(async () => new Response('data: {"text":"Safe response"}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await writeFile(join(directory, 'profile.turnstage.jsonc'), JSON.stringify(profile));
      const csv = serializeAdversarialCsv(scenarios);
      await writeFile(join(directory, 'security.adversarial.csv'), csv);
      expect(new ProfileValidator().validate(profile, undefined, [builtInEnvironment()])).toEqual([]);
      const parsed = parseAdversarialSource('security.adversarial.csv', csv);
      expect(parsed.issues).toEqual([]);
      expect(validateAdversarialScenariosAgainstProfile(profile, parsed.scenarios, [builtInEnvironment()])).toEqual([]);
      const result = await new NodeCliRuntime('test', directory).execute({
        command: 'run', configFiles: ['profile.turnstage.jsonc'],
        selectors: { profiles: [], suites: [], cases: [], tags: [], changedFiles: [] },
        policy: { failFast: false, concurrency: 1, maxRequests: 10 },
        impact: { workspaceRoot: directory, includeUnbound: true },
      });

      expect(result.records).toEqual([expect.objectContaining({ id: expect.stringMatching(/^csv-profile\/security-/u), outcome: 'resisted' })]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(directory, 'security.adversarial.csv'), 'utf8'))).toBe(csv);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('executes a linked functional CSV suite in place with its stable suite selector', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'turnstage-cli-contract-csv-'));
    const profile: TurnStageProfile = {
      version: 1,
      id: 'functional-csv-profile',
      name: 'Functional CSV profile',
      conversation: { send: { method: 'POST', url: 'https://example.test/stream', timeoutMs: 1_000, variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
      stream: {
        transport: 'sse', doneValue: '[DONE]',
        mappings: [{ id: 'text', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } }],
      },
      tests: { contractSuites: ['regression.tests.csv'], scenarios: [] },
    };
    const scenarios: ScenarioDefinition[] = [{
      id: 'linked-functional-case', name: 'Linked functional case', tags: ['linked'],
      steps: [{ id: 'turn-1', input: 'Run the linked contract', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }],
    }];
    const csv = serializeContractCsv(scenarios);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"text":"Expected response"}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    try {
      await writeFile(join(directory, 'profile.turnstage.jsonc'), JSON.stringify(profile));
      await writeFile(join(directory, 'regression.tests.csv'), csv);
      const result = await new NodeCliRuntime('test', directory).execute({
        command: 'run', configFiles: ['profile.turnstage.jsonc'],
        selectors: { profiles: ['functional-csv-profile'], suites: [], cases: ['linked-functional-case'], tags: [], changedFiles: [] },
        policy: { failFast: false, concurrency: 1, maxRequests: 10 },
        impact: { workspaceRoot: directory, includeUnbound: true },
      });

      expect(result.records).toEqual([expect.objectContaining({ id: expect.stringMatching(/^functional-csv-profile\/regression-/u), outcome: 'passed' })]);
      expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(directory, 'regression.tests.csv'), 'utf8'))).toBe(csv);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps captured drafts out of headless execution until review is complete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'turnstage-cli-captured-draft-'));
    const profile: TurnStageProfile = {
      version: 1,
      id: 'captured-draft-profile',
      name: 'Captured draft profile',
      conversation: { send: { method: 'POST', url: 'https://example.test/stream', timeoutMs: 1_000, variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
      stream: { transport: 'sse', doneValue: '[DONE]', mappings: [{ id: 'text', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } }] },
      tests: { scenarios: [{
        id: 'captured-draft', name: 'Captured draft', tags: ['captured', 'needs-review'],
        capture: { status: 'needsReview', source: 'conversation', capturedAt: '2026-09-04T00:00:00.000Z', profileId: 'captured-draft-profile', profileDigest: 'a'.repeat(64) },
        steps: [{ id: 'turn-1', input: 'Do not execute this draft', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }],
      }] },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await writeFile(join(directory, 'profile.turnstage.jsonc'), JSON.stringify(profile));
      const result = await new NodeCliRuntime('test', directory).execute({
        command: 'run', configFiles: ['profile.turnstage.jsonc'],
        selectors: { profiles: [], suites: [], cases: [], tags: [], changedFiles: [] },
        policy: { failFast: false, concurrency: 1, maxRequests: 10 },
        impact: { workspaceRoot: directory, includeUnbound: true },
      });

      expect(result.records).toEqual([{ id: 'selection', outcome: 'policy' }]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('executes request-backed openings in the Node runtime and records bounded network evidence', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ welcome: 'Ready for CI.', choices: [{ id: 'start', label: 'Start', prompt: 'Hello', behavior: 'send' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const session = new NodeScenarioSession(requestOpeningProfile(), cliEnvironment(), cliScenario(), '/workspace');
      await session.startSession();
      expect(session.snapshot).toMatchObject({ sessionState: 'ready', opening: { message: 'Ready for CI.', starters: [{ id: 'start' }] } });
      expect(session.getNetworkEntries()).toEqual([expect.objectContaining({ kind: 'opening', state: 'completed', status: 200, transferredBytes: expect.any(Number) })]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a configured fallback for a failed request-backed opening without exposing its response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAVAILABLE', privateDetail: 'must-not-be-evidence' }), { status: 503 })));
    try {
      const profile = requestOpeningProfile();
      profile.opening!.fallbacks = [{ match: { path: 'response.status', operator: 'equals', value: 503 }, message: 'Offline fallback.' }];
      const session = new NodeScenarioSession(profile, cliEnvironment(), cliScenario(), '/workspace');
      await session.startSession();
      expect(session.snapshot).toMatchObject({ sessionState: 'ready', opening: { message: 'Offline fallback.' } });
      expect(JSON.stringify(session.getNetworkEntries())).not.toContain('must-not-be-evidence');
      expect(session.getNetworkEntries()[0]).toMatchObject({ state: 'failed', status: 503 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves only explicitly prefixed CLI secrets and never arbitrary process environment names', async () => {
    const arbitraryName = 'TURNSTAGE_REVIEW_ARBITRARY_ENV';
    const prefixedName = 'TURNSTAGE_SECRET_CLI_REVIEW_TOKEN';
    process.env[arbitraryName] = 'must-not-resolve';
    process.env[prefixedName] = 'prefixed-canary';
    try {
      const profile = requestOpeningProfile();
      const environment: TurnStageEnvironment = {
        ...cliEnvironment(),
        secretReferences: { arbitrary: arbitraryName, allowed: 'cli-review-token' },
      };
      const session = new NodeScenarioSession(profile, environment, cliScenario(), '/workspace') as unknown as { secret(name: string): Promise<string | undefined> };
      await expect(session.secret('arbitrary')).resolves.toBeUndefined();
      await expect(session.secret('allowed')).resolves.toBe('prefixed-canary');
    } finally {
      delete process.env[arbitraryName];
      delete process.env[prefixedName];
    }
  });
});

function requestOpeningProfile(): TurnStageProfile {
  return {
    version: 1,
    id: 'cli-request-opening',
    name: 'CLI request opening',
    environment: 'local',
    opening: {
      mode: 'request',
      request: { method: 'POST', url: '${env.baseUrl}/opening', timeoutMs: 1_000, body: { actor: 'ci' } },
      response: { messagePath: '$.welcome', startersPath: '$.choices' },
    },
    conversation: { send: { method: 'POST', url: '${env.baseUrl}/stream' } },
    stream: { transport: 'sse', mappings: [] },
    tests: { scenarios: [] },
  };
}

function cliEnvironment(): TurnStageEnvironment {
  return { version: 1, id: 'local', name: 'Local', variables: { baseUrl: 'https://example.test' } };
}

function cliScenario(): ScenarioDefinition {
  return { id: 'cli-case', name: 'CLI case', steps: [] };
}
