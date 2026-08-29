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
