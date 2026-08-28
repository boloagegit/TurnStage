import * as vscode from 'vscode';
import { PNG } from 'pngjs';
import type { ScenarioVisualDefinition, TurnStageProfile } from '../../shared/types';
import { localize } from '../l10n';
import { isSafeReportDirectory } from './scenarioConfig';

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_PNG_BYTES = 24 * 1024 * 1024;
const DEFAULT_VISUAL: ScenarioVisualDefinition = { baselineDirectory: '.turnstage/baselines', maxDifferencePercent: 0.1, channelTolerance: 16 };

export interface VisualViewport { id: string; width: number; height: number }
export interface VisualRegressionResult { operation: 'baseline' | 'compare'; status: 'saved' | 'passed' | 'failed'; differencePercent?: number; baselineUri: vscode.Uri; diffUri?: vscode.Uri }

export class VisualRegressionService {
  private latest?: VisualRegressionResult;
  constructor(private readonly context: vscode.ExtensionContext) {}

  getLatest(): VisualRegressionResult | undefined { return this.latest; }

  async saveBaseline(profile: TurnStageProfile, profileUri: vscode.Uri, viewport: VisualViewport, dataUrl: string): Promise<VisualRegressionResult | undefined> {
    const bytes = decodePng(dataUrl);
    const baselineUri = this.baselineUri(profile, profileUri, viewport);
    if (await exists(baselineUri)) {
      const replace = localize('Replace Baseline');
      const selected = await vscode.window.showWarningMessage(localize('Replace the visual baseline for {profile} at {width} × {height}?', { profile: profile.name, width: viewport.width, height: viewport.height }), { modal: true }, replace);
      if (selected !== replace) return undefined;
    }
    await vscode.workspace.fs.createDirectory(baselineUri.with({ path: baselineUri.path.slice(0, baselineUri.path.lastIndexOf('/')) }));
    await vscode.workspace.fs.writeFile(baselineUri, bytes);
    this.latest = { operation: 'baseline', status: 'saved', baselineUri };
    return this.latest;
  }

  async compare(profile: TurnStageProfile, profileUri: vscode.Uri, viewport: VisualViewport, dataUrl: string): Promise<VisualRegressionResult> {
    const currentBytes = decodePng(dataUrl);
    const baselineUri = this.baselineUri(profile, profileUri, viewport);
    let baselineBytes: Uint8Array;
    try { baselineBytes = await vscode.workspace.fs.readFile(baselineUri); }
    catch { throw new Error(localize('No visual baseline exists for this profile and viewport.')); }
    const definition = visualDefinition(profile);
    const compared = comparePng(baselineBytes, currentBytes, definition.channelTolerance ?? DEFAULT_VISUAL.channelTolerance!);
    const passed = compared.differencePercent <= (definition.maxDifferencePercent ?? DEFAULT_VISUAL.maxDifferencePercent!);
    let diffUri: vscode.Uri | undefined;
    if (!passed) {
      diffUri = baselineUri.with({ path: baselineUri.path.replace(/\.png$/, '.diff.png') });
      await vscode.workspace.fs.writeFile(diffUri, compared.diff);
    }
    this.latest = { operation: 'compare', status: passed ? 'passed' : 'failed', differencePercent: compared.differencePercent, baselineUri, diffUri };
    return this.latest;
  }

  private baselineUri(profile: TurnStageProfile, profileUri: vscode.Uri, viewport: VisualViewport): vscode.Uri {
    const definition = visualDefinition(profile);
    if (!isSafeReportDirectory(definition.baselineDirectory)) throw new Error(localize('Visual baseline directory must be workspace-relative and cannot contain traversal.'));
    const workspace = vscode.workspace.getWorkspaceFolder(profileUri);
    const root = workspace?.uri ?? this.context.globalStorageUri;
    const segments = definition.baselineDirectory.split('/').filter(Boolean);
    const viewportId = safePart(viewport.id);
    return vscode.Uri.joinPath(root, ...segments, `${safePart(profile.id)}.${viewportId}.${viewport.width}x${viewport.height}.png`);
  }
}

export function comparePng(baselineBytes: Uint8Array, currentBytes: Uint8Array, channelTolerance = 16): { differencePercent: number; changedPixels: number; totalPixels: number; diff: Uint8Array } {
  const baseline = PNG.sync.read(Buffer.from(baselineBytes));
  const current = PNG.sync.read(Buffer.from(currentBytes));
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const diff = new PNG({ width, height });
  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const output = (y * width + x) * 4;
      const baselineIndex = x < baseline.width && y < baseline.height ? (y * baseline.width + x) * 4 : -1;
      const currentIndex = x < current.width && y < current.height ? (y * current.width + x) * 4 : -1;
      const changed = baselineIndex < 0 || currentIndex < 0 || [0, 1, 2, 3].some((channel) => Math.abs(baseline.data[baselineIndex + channel]! - current.data[currentIndex + channel]!) > channelTolerance);
      if (changed) {
        changedPixels++;
        diff.data[output] = 255; diff.data[output + 1] = 0; diff.data[output + 2] = 64; diff.data[output + 3] = 255;
      } else {
        const luminance = Math.round((current.data[currentIndex]! + current.data[currentIndex + 1]! + current.data[currentIndex + 2]!) / 3);
        diff.data[output] = luminance; diff.data[output + 1] = luminance; diff.data[output + 2] = luminance; diff.data[output + 3] = 96;
      }
    }
  }
  const totalPixels = width * height;
  return { differencePercent: totalPixels ? changedPixels / totalPixels * 100 : 0, changedPixels, totalPixels, diff: PNG.sync.write(diff) };
}

function visualDefinition(profile: TurnStageProfile): ScenarioVisualDefinition { return { ...DEFAULT_VISUAL, ...(profile.tests?.visual ?? {}) }; }
function decodePng(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith(PNG_PREFIX)) throw new Error(localize('Visual capture is not a PNG image.'));
  const base64 = dataUrl.slice(PNG_PREFIX.length);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error(localize('Visual capture is malformed.'));
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_PNG_BYTES) throw new Error(localize('Visual capture exceeds the 24 MiB safety limit.'));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error(localize('Visual capture has an invalid PNG signature.'));
  return bytes;
}
async function exists(uri: vscode.Uri): Promise<boolean> { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } }
function safePart(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100) || 'visual'; }
