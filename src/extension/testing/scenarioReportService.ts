import * as vscode from 'vscode';
import type { ScenarioReportFormat, ScenarioReportingDefinition } from '../../shared/types';
import { localize } from '../l10n';
import { isSafeReportDirectory } from './scenarioConfig';
import { createScenarioReport, serializeAdversarialEventsCsv, serializeAdversarialFindingsCsv, serializeAdversarialNetworkCsv, serializeAdversarialSummaryCsv, serializeAdversarialTurnsCsv, serializeScenarioHtml, serializeScenarioJson, serializeScenarioJUnit, type ScenarioExecutionRecord } from './scenarioReport';
import type { VisualRegressionService } from './visualRegression';
import { createProvenanceManifest, type ProvenanceFileInput } from './provenance';

const MAX_VISUAL_ARTIFACT_BYTES = 24 * 1024 * 1024;

interface ConfiguredReportGroup {
  profileId: string;
  profileUri: vscode.Uri;
  reporting: ScenarioReportingDefinition;
  records: ScenarioExecutionRecord[];
}

export interface ScenarioReportScope {
  runId?: string;
  profileIds?: readonly string[];
}

export interface CopilotArtifactProvider {
  snapshot(): unknown;
}

export class ScenarioReportService {
  private records: ScenarioExecutionRecord[] = [];
  private scope: ScenarioReportScope = {};

  constructor(private readonly output: vscode.OutputChannel, private readonly visualRegression?: VisualRegressionService, private readonly runnerVersion = 'unknown', private readonly copilotArtifacts?: CopilotArtifactProvider) {}

  record(records: readonly ScenarioExecutionRecord[], scope: ScenarioReportScope = {}): void {
    this.records = [...records];
    this.scope = {
      ...(scope.runId ? { runId: scope.runId } : {}),
      profileIds: [...new Set(scope.profileIds ?? records.map((record) => record.profileId))],
    };
  }
  hasRecords(): boolean { return this.records.length > 0; }

  async exportLast(format: ScenarioReportFormat): Promise<vscode.Uri | undefined> {
    if (!this.records.length) return undefined;
    const extension = reportExtension(format);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`turnstage-contract-results.${extension}`),
      filters: format === 'junit' ? { [localize('JUnit XML')]: ['xml'] } : format === 'html' ? { HTML: ['html'] } : { [localize('JSON')]: ['json'] },
    });
    if (!uri) return undefined;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serialize(format, this.records)));
    return uri;
  }

  async exportEvidenceBundle(): Promise<vscode.Uri | undefined> {
    if (!this.records.length) return undefined;
    const visual = this.visualRegression?.getLatest(this.scope);
    let includeVisual = false;
    if (visual) {
      const choice = await vscode.window.showQuickPick([
        { label: localize('Sanitized report only'), description: localize('Recommended. Excludes chat screenshots.'), includeVisual: false },
        { label: localize('Include latest visual artifacts'), description: localize('May contain visible conversation content.'), includeVisual: true },
      ], { title: localize('Evidence Bundle Contents') });
      if (!choice) return undefined;
      includeVisual = choice.includeVisual;
    }
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: localize('Export Evidence Bundle') });
    if (!selected?.[0]) return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = vscode.Uri.joinPath(selected[0], `turnstage-evidence-${stamp}-${crypto.randomUUID().slice(0, 8)}`);
    await vscode.workspace.fs.createDirectory(directory);
    const generatedAt = new Date().toISOString();
    const fileNames = ['index.html', 'report.json', 'junit.xml', 'adversarial-summary.csv', 'adversarial-turns.csv', 'adversarial-findings.csv', 'network.csv', 'events.csv', 'diagnostics.json'];
    if (includeVisual && visual) { fileNames.push('visual-baseline.png'); if (visual.diffUri) fileNames.push('visual-diff.png'); }
    const files: Array<[string, string | Uint8Array]> = [
      ['index.html', serializeScenarioHtml(this.records, generatedAt)],
      ['report.json', serializeScenarioJson(this.records, generatedAt)],
      ['junit.xml', serializeScenarioJUnit(this.records, generatedAt)],
      ['adversarial-summary.csv', serializeAdversarialSummaryCsv(this.records)],
      ['adversarial-turns.csv', serializeAdversarialTurnsCsv(this.records)],
      ['adversarial-findings.csv', serializeAdversarialFindingsCsv(this.records)],
      ['network.csv', serializeAdversarialNetworkCsv(this.records)],
      ['events.csv', serializeAdversarialEventsCsv(this.records)],
      ['diagnostics.json', `${JSON.stringify(scopeCopilotArtifacts(this.copilotArtifacts?.snapshot(), this.scope), null, 2)}\n`],
    ];
    if (includeVisual && visual) {
      files.push(['visual-baseline.png', await readBoundedVisualArtifact(visual.baselineUri)]);
      if (visual.diffUri) files.push(['visual-diff.png', await readBoundedVisualArtifact(visual.diffUri)]);
    }
    const report = createScenarioReport(this.records, generatedAt);
    files.push(['manifest.json', `${JSON.stringify({ format: 'turnstage-evidence-bundle', version: 5, generatedAt, files: [...fileNames, 'manifest.json', 'provenance.json'], privacy: { rawEvents: false, payloads: false, urls: false, headers: false, messageContent: false, secrets: false, profileEditContent: false, advisoryResponseContent: false, visualChatContent: includeVisual, causalMetadata: true, failureFingerprints: true }, summary: report.summary }, null, 2)}\n`]);
    const provenanceFiles: ProvenanceFileInput[] = files.map(([path, contents]) => ({ path, contents }));
    const provenance = createProvenanceManifest({
      runId: this.scope.runId ?? crypto.randomUUID(),
      generatedAt,
      runnerKind: 'extension',
      runnerVersion: this.runnerVersion,
      extensionVersion: this.runnerVersion,
      selectedTestIds: this.records.map((record) => `${record.profileId}/${record.scenarioId}`),
      policy: { evidenceBundleVersion: 5, visualChatContent: includeVisual },
      result: report,
      evidence: { summary: report.summary },
      evidenceFiles: provenanceFiles,
    });
    files.push(['provenance.json', `${JSON.stringify(provenance, null, 2)}\n`]);
    for (const [name, contents] of files) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, name), typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
    this.output.appendLine(`[info] [tests] ${localize('Exported sanitized evidence bundle to {path}.', { path: vscode.workspace.asRelativePath(directory) })}`);
    return directory;
  }

  async writeConfigured(groups: readonly ConfiguredReportGroup[]): Promise<void> {
    for (const group of groups) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(group.profileUri);
      if (!workspaceFolder || !isSafeReportDirectory(group.reporting.outputDirectory)) {
        this.output.appendLine(`[warn] [tests] ${localize('Skipped CI report for {profile}: outputDirectory must be workspace-relative and cannot contain traversal.', { profile: group.profileId })}`);
        continue;
      }
      const segments = group.reporting.outputDirectory.split('/').filter(Boolean);
      const directory = vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
      await vscode.workspace.fs.createDirectory(directory);
      for (const format of [...new Set(group.reporting.formats)].filter((value): value is ScenarioReportFormat => value === 'json' || value === 'junit' || value === 'html')) {
        const extension = reportExtension(format);
        const target = vscode.Uri.joinPath(directory, `${safeFilePart(group.profileId)}.turnstage-contract-results.${extension}`);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serialize(format, group.records)));
        this.output.appendLine(`[info] [tests] ${localize('Wrote {format} contract report to {path}.', { format: format.toUpperCase(), path: vscode.workspace.asRelativePath(target) })}`);
      }
    }
  }
}

async function readBoundedVisualArtifact(uri: vscode.Uri): Promise<Uint8Array> {
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_VISUAL_ARTIFACT_BYTES) throw new Error(localize('Visual artifacts cannot exceed 24 MiB.'));
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_VISUAL_ARTIFACT_BYTES) throw new Error(localize('Visual artifacts cannot exceed 24 MiB.'));
  return bytes;
}

function serialize(format: ScenarioReportFormat, records: readonly ScenarioExecutionRecord[]): string {
  return format === 'junit' ? serializeScenarioJUnit(records) : format === 'html' ? serializeScenarioHtml(records) : serializeScenarioJson(records);
}

function reportExtension(format: ScenarioReportFormat): string { return format === 'junit' ? 'xml' : format; }

function safeFilePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100) || 'profile'; }

export type { ConfiguredReportGroup };

function scopeCopilotArtifacts(value: unknown, scope: ScenarioReportScope): Record<string, unknown> {
  if (!isRecord(value) || value.sanitized !== true) {
    return { version: 'CopilotArtifactSnapshotV1', sanitized: true, diagnoses: [], profilePatches: [], qualityReviews: [] };
  }
  const profileIds = new Set((scope.profileIds ?? []).filter((profileId): profileId is string => typeof profileId === 'string' && profileId.length > 0));
  const diagnoses = Array.isArray(value.diagnoses)
    ? value.diagnoses.filter((item): item is Record<string, unknown> => {
      if (!isRecord(item)) return false;
      if (scope.runId && item.runId !== scope.runId) return false;
      if (profileIds.size && (typeof item.profileId !== 'string' || !profileIds.has(item.profileId))) return false;
      return true;
    })
    : [];
  const profilePatches = Array.isArray(value.profilePatches)
    ? value.profilePatches.filter((item): item is Record<string, unknown> => matchesCopilotArtifactScope(item, scope.runId, profileIds))
    : [];
  const qualityReviews = Array.isArray(value.qualityReviews)
    ? value.qualityReviews.filter((item): item is Record<string, unknown> => matchesCopilotArtifactScope(item, scope.runId, profileIds))
    : [];
  return {
    version: typeof value.version === 'string' ? value.version : 'CopilotArtifactSnapshotV1',
    sanitized: true,
    diagnoses,
    profilePatches,
    qualityReviews,
  };
}

function matchesCopilotArtifactScope(item: unknown, runId: string | undefined, profileIds: Set<string>): item is Record<string, unknown> {
  if (!isRecord(item)) return false;
  // A run-scoped bundle must never claim an artifact without a trusted run id.
  if (runId && (typeof item.runId !== 'string' || item.runId !== runId)) return false;
  if (profileIds.size && (typeof item.profileId !== 'string' || !profileIds.has(item.profileId))) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
