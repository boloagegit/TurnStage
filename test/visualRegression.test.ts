import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';

const mock = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  const uri = (path: string): any => ({ path, fsPath: path, toString: () => `file://${path}`, with: ({ path: nextPath }: { path: string }) => uri(nextPath) });
  return {
    files,
    uri,
    vscode: {
      Uri: { joinPath: (base: { path: string }, ...segments: string[]) => uri([base.path.replace(/\/$/, ''), ...segments].join('/')) },
      window: { showWarningMessage: vi.fn(async (_message: string, _options: unknown, replace: string) => replace) },
      workspace: {
        getWorkspaceFolder: vi.fn(() => ({ uri: uri('/workspace') })),
        fs: {
          stat: vi.fn(async (target: { path: string }) => { if (!files.has(target.path)) throw new Error('missing'); return {}; }),
          createDirectory: vi.fn(),
          writeFile: vi.fn(async (target: { path: string }, bytes: Uint8Array) => { files.set(target.path, bytes); }),
          readFile: vi.fn(async (target: { path: string }) => { const value = files.get(target.path); if (!value) throw new Error('missing'); return value; }),
        },
      },
    },
  };
});

vi.mock('vscode', () => mock.vscode);

import { comparePng, VisualRegressionService } from '../src/extension/testing/visualRegression';

function png(width: number, height: number, pixels: Record<string, [number, number, number, number]> = {}): Uint8Array {
  const image = new PNG({ width, height });
  image.data.fill(0);
  for (const [key, rgba] of Object.entries(pixels)) {
    const [x, y] = key.split(',').map(Number);
    const offset = (y! * width + x!) * 4;
    image.data.set(rgba, offset);
  }
  return PNG.sync.write(image);
}

describe('PNG visual regression comparison', () => {
  it('reports identical images as a zero-difference comparison', () => {
    const baseline = png(2, 2, { '0,0': [20, 40, 60, 255], '1,1': [200, 180, 160, 255] });

    const result = comparePng(baseline, baseline);

    expect(result).toMatchObject({ differencePercent: 0, changedPixels: 0, totalPixels: 4 });
    expect(PNG.sync.read(Buffer.from(result.diff))).toMatchObject({ width: 2, height: 2 });
  });

  it('marks changed pixels and computes their percentage', () => {
    const baseline = png(2, 2, { '0,0': [20, 40, 60, 255] });
    const current = png(2, 2, { '0,0': [20, 40, 60, 255], '1,0': [255, 12, 80, 255] });

    const result = comparePng(baseline, current);
    const diff = PNG.sync.read(Buffer.from(result.diff));

    expect(result).toMatchObject({ differencePercent: 25, changedPixels: 1, totalPixels: 4 });
    expect(Array.from(diff.data.slice(4, 8))).toEqual([255, 0, 64, 255]);
  });

  it('treats pixels outside either image as changed on dimension mismatch', () => {
    const baseline = png(1, 1, { '0,0': [20, 40, 60, 255] });
    const current = png(2, 1, { '0,0': [20, 40, 60, 255], '1,0': [20, 40, 60, 255] });

    const result = comparePng(baseline, current);

    expect(result).toMatchObject({ differencePercent: 50, changedPixels: 1, totalPixels: 2 });
    expect(PNG.sync.read(Buffer.from(result.diff))).toMatchObject({ width: 2, height: 1 });
  });

  it('stores a viewport-specific baseline and writes a diff for a failed comparison', async () => {
    mock.files.clear();
    const service = new VisualRegressionService({ globalStorageUri: mock.uri('/global') } as never);
    const profile = { version: 1, id: 'visual-profile', name: 'Visual', conversation: { send: {} }, stream: {}, tests: { scenarios: [], visual: { baselineDirectory: '.turnstage/baselines', maxDifferencePercent: 0, channelTolerance: 0 } } } as never;
    const profileUri = mock.uri('/workspace/.vscode/turnstage/profiles/visual.turnstage.jsonc');
    const viewport = { id: 'mobile-m', width: 375, height: 667 };
    const baseline = png(1, 1, { '0,0': [0, 0, 0, 255] });
    const current = png(1, 1, { '0,0': [255, 255, 255, 255] });
    const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

    const saved = await service.saveBaseline(profile, profileUri, viewport, dataUrl(baseline));
    const compared = await service.compare(profile, profileUri, viewport, dataUrl(current));

    expect(saved?.baselineUri.path).toBe('/workspace/.turnstage/baselines/visual-profile.mobile-m.375x667.png');
    expect(compared).toMatchObject({ status: 'failed', differencePercent: 100 });
    expect(compared.diffUri?.path).toBe('/workspace/.turnstage/baselines/visual-profile.mobile-m.375x667.diff.png');
    expect(mock.files.has(compared.diffUri!.path)).toBe(true);
    expect(service.getLatest({ profileIds: ['visual-profile'] })).toMatchObject({ profileId: 'visual-profile' });
    expect(service.getLatest({ profileIds: ['other-profile'] })).toBeUndefined();
    expect(service.getLatest({ runId: 'copilot-run' })).toBeUndefined();
  });
});
