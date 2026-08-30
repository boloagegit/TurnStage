import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const writes: Array<{ path: string; text: string }> = [];
  const directories: string[] = [];
  const uri = (path: string) => ({ path, fsPath: path, toString: () => `file://${path}` });
  return {
    writes,
    directories,
    uri,
    vscode: {
      Uri: { file: uri, joinPath: (base: { path: string }, ...segments: string[]) => uri([base.path.replace(/\/$/, ''), ...segments].join('/')) },
      window: { showSaveDialog: vi.fn(async () => uri('/chosen/report.json')), showOpenDialog: vi.fn(async () => [uri('/chosen')]), showQuickPick: vi.fn() },
      workspace: {
        fs: {
          createDirectory: vi.fn(async (target: { path: string }) => { directories.push(target.path); }),
          writeFile: vi.fn(async (target: { path: string }, bytes: Uint8Array) => { writes.push({ path: target.path, text: new TextDecoder().decode(bytes) }); }),
          copy: vi.fn(),
        },
        getWorkspaceFolder: vi.fn(() => ({ uri: uri('/workspace') })),
        asRelativePath: (target: { path: string }) => target.path.replace('/workspace/', ''),
      },
    },
  };
});

vi.mock('vscode', () => mock.vscode);

import { ScenarioReportService, type ConfiguredReportGroup } from '../src/extension/testing/scenarioReportService';

describe('ScenarioReportService', () => {
  beforeEach(() => {
    mock.writes.length = 0;
    mock.directories.length = 0;
    vi.clearAllMocks();
  });

  it('writes configured JSON, JUnit, and HTML reports only below the workspace directory', async () => {
    const output = { appendLine: vi.fn() };
    const service = new ScenarioReportService(output as never);
    const group: ConfiguredReportGroup = {
      profileId: 'safe-profile',
      profileUri: mock.uri('/workspace/.vscode/turnstage/profiles/profile.turnstage.jsonc') as never,
      reporting: { formats: ['json', 'junit', 'html'], outputDirectory: '.turnstage/reports' },
      records: [{ profileId: 'safe-profile', profileName: 'Private', scenarioId: 'safe-scenario', scenarioName: 'Private', status: 'error' }],
    };

    await service.writeConfigured([group]);

    expect(mock.directories).toEqual(['/workspace/.turnstage/reports']);
    expect(mock.writes.map((entry) => entry.path)).toEqual([
      '/workspace/.turnstage/reports/safe-profile.turnstage-contract-results.json',
      '/workspace/.turnstage/reports/safe-profile.turnstage-contract-results.xml',
      '/workspace/.turnstage/reports/safe-profile.turnstage-contract-results.html',
    ]);
    expect(mock.writes[0]?.text).toContain('"format": "turnstage-contract-report"');
    expect(mock.writes[1]?.text).toContain('<testsuite');
    expect(mock.writes[2]?.text).toContain('<!doctype html>');
  });

  it('skips invalid configured directories and manually exports the last safe projection', async () => {
    const output = { appendLine: vi.fn() };
    const service = new ScenarioReportService(output as never);
    await service.writeConfigured([{
      profileId: 'safe-profile',
      profileUri: mock.uri('/workspace/profile.turnstage.jsonc') as never,
      reporting: { formats: ['json'], outputDirectory: '../outside' },
      records: [],
    }]);
    expect(mock.writes).toEqual([]);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('Skipped CI report'));

    service.record([{ profileId: 'safe-profile', profileName: 'Private', scenarioId: 'safe-scenario', scenarioName: 'Private', status: 'passed' }]);
    expect(service.hasRecords()).toBe(true);
    const exported = await service.exportLast('json');
    expect(exported).toMatchObject({ path: '/chosen/report.json' });
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]?.text).not.toContain('Private');
  });

  it('exports a new sanitized evidence folder with an offline HTML entry point and manifest', async () => {
    const output = { appendLine: vi.fn() };
    const service = new ScenarioReportService(output as never, undefined, '0.13.0', { snapshot: () => ({ version: 'CopilotArtifactSnapshotV1', sanitized: true, diagnoses: [{ artifactId: 'safe-diagnosis', kind: 'diagnosis', runId: 'copilot-run', profileId: 'safe-profile', summary: 'Bounded timeout evidence.' }], profilePatches: [], qualityReviews: [] }) });
    service.record([{ profileId: 'safe-profile', profileName: 'Private Name', scenarioId: 'safe-scenario', scenarioName: 'Private Scenario', status: 'passed' }]);

    const directory = await service.exportEvidenceBundle();

    expect(directory?.path).toMatch(/^\/chosen\/turnstage-evidence-/);
    expect(mock.writes.map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1)).sort()).toEqual(['adversarial-findings.csv', 'adversarial-summary.csv', 'adversarial-turns.csv', 'diagnostics.json', 'events.csv', 'index.html', 'junit.xml', 'manifest.json', 'network.csv', 'provenance.json', 'report.json']);
    const html = mock.writes.find((entry) => entry.path.endsWith('/index.html'))?.text ?? '';
    const manifest = mock.writes.find((entry) => entry.path.endsWith('/manifest.json'))?.text ?? '';
    const diagnostics = mock.writes.find((entry) => entry.path.endsWith('/diagnostics.json'))?.text ?? '';
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('Private Name');
    expect(manifest).toContain('"visualChatContent": false');
    expect(manifest).toContain('"version": 5');
    expect(manifest).toContain('"profileEditContent": false');
    expect(manifest).toContain('"advisoryResponseContent": false');
    expect(diagnostics).toContain('Bounded timeout evidence.');
    expect(diagnostics).not.toContain('Private Name');
    const provenance = JSON.parse(mock.writes.find((entry) => entry.path.endsWith('/provenance.json'))?.text ?? '{}') as { format?: string; files?: unknown[]; manifestDigest?: string };
    expect(provenance).toMatchObject({ format: 'turnstage-provenance-manifest' });
    expect(provenance.files).toHaveLength(10);
    expect(provenance.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('filters Copilot diagnostics to the recorded run and profile scope', async () => {
    const output = { appendLine: vi.fn() };
    const service = new ScenarioReportService(output as never, undefined, '0.13.0', { snapshot: () => ({
      version: 'CopilotArtifactSnapshotV1',
      sanitized: true,
      diagnoses: [
        { artifactId: 'keep', kind: 'diagnosis', runId: 'run-a', profileId: 'profile-a', summary: 'Keep this diagnosis.' },
        { artifactId: 'drop', kind: 'diagnosis', runId: 'run-b', profileId: 'profile-b', summary: 'Drop this diagnosis.' },
      ],
      profilePatches: [
        { artifactId: 'keep-patch', kind: 'profilePatch', profileId: 'profile-a', runId: 'run-a', summary: 'Keep this patch.' },
        { artifactId: 'wrong-run-patch', kind: 'profilePatch', profileId: 'profile-a', runId: 'run-b', summary: 'Drop this patch.' },
        { artifactId: 'missing-run-patch', kind: 'profilePatch', profileId: 'profile-a', summary: 'Drop this unbound patch.' },
        { artifactId: 'wrong-profile-patch', kind: 'profilePatch', profileId: 'profile-b', runId: 'run-a', summary: 'Drop this profile.' },
      ],
      qualityReviews: [
        { artifactId: 'keep-quality', kind: 'qualityReview', profileId: 'profile-a', runId: 'run-a', summary: 'Keep this review.' },
        { artifactId: 'wrong-run-quality', kind: 'qualityReview', profileId: 'profile-a', runId: 'run-b', summary: 'Drop this review.' },
        { artifactId: 'missing-run-quality', kind: 'qualityReview', profileId: 'profile-a', summary: 'Drop this unbound review.' },
        { artifactId: 'wrong-profile-quality', kind: 'qualityReview', profileId: 'profile-b', runId: 'run-a', summary: 'Drop this profile.' },
      ],
    }) });
    service.record([{ profileId: 'profile-a', profileName: 'Profile A', scenarioId: 'case-a', scenarioName: 'Case A', status: 'passed' }], { runId: 'run-a' });

    await service.exportEvidenceBundle();

    const diagnostics = JSON.parse(mock.writes.find((entry) => entry.path.endsWith('/diagnostics.json'))?.text ?? '{}') as { diagnoses?: Array<{ summary?: string }>; profilePatches?: Array<{ artifactId?: string }>; qualityReviews?: Array<{ artifactId?: string }> };
    expect(diagnostics.diagnoses?.map((item) => item.summary)).toEqual(['Keep this diagnosis.']);
    expect(diagnostics.profilePatches?.map((item) => item.artifactId)).toEqual(['keep-patch']);
    expect(diagnostics.qualityReviews?.map((item) => item.artifactId)).toEqual(['keep-quality']);
  });
});
