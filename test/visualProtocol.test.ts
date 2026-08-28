import { describe, expect, it } from 'vitest';
import { isHostMessage, isWebviewMessage, PROTOCOL_VERSION } from '../src/shared/protocol';

const envelope = { protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'editor-1', requestId: 'request-1' };
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

describe('visual protocol payload bounds', () => {
  it('accepts bounded visual capture and result payloads', () => {
    expect(isWebviewMessage({
      ...envelope,
      type: 'visual.baseline.save',
      dataUrl: pngDataUrl,
      viewport: { id: 'mobile', width: 390, height: 844 },
    }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({
      ...envelope,
      type: 'visual.compare',
      dataUrl: pngDataUrl,
      viewport: { id: 'desktop', width: 2560, height: 2160 },
    }, 'editor-1')).toBe(true);
    expect(isHostMessage({
      ...envelope,
      type: 'visual.result',
      operation: 'compare',
      status: 'failed',
      differencePercent: 12.5,
      baselinePath: '.turnstage/baselines/profile.desktop.png',
      diffPath: '.turnstage/baselines/profile.desktop.diff.png',
    }, 'editor-1')).toBe(true);
  });

  it('rejects malformed captures and out-of-range viewport dimensions', () => {
    const valid = {
      ...envelope,
      type: 'visual.compare' as const,
      dataUrl: pngDataUrl,
      viewport: { id: 'desktop', width: 1024, height: 768 },
    };
    expect(isWebviewMessage({ ...valid, dataUrl: 'data:image/jpeg;base64,AAAA' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...valid, viewport: { ...valid.viewport, width: 0 } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...valid, viewport: { ...valid.viewport, width: 2561 } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...valid, viewport: { ...valid.viewport, height: 2161 } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...valid, viewport: { ...valid.viewport, height: 768.5 } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...valid, viewport: { ...valid.viewport, id: 'x'.repeat(101) } }, 'editor-1')).toBe(false);
  });

  it('rejects captures above the bounded data URL size and invalid result percentages', () => {
    const valid = {
      ...envelope,
      type: 'visual.compare' as const,
      dataUrl: pngDataUrl,
      viewport: { id: 'desktop', width: 1024, height: 768 },
    };
    const maxDataUrlLength = 32 * 1024 * 1024 + 64;
    const oversized = `data:image/png;base64,${'A'.repeat(maxDataUrlLength)}`;
    expect(isWebviewMessage({ ...valid, dataUrl: oversized }, 'editor-1')).toBe(false);

    const result = {
      ...envelope,
      type: 'visual.result' as const,
      operation: 'compare' as const,
      status: 'passed' as const,
      baselinePath: 'baseline.png',
    };
    expect(isHostMessage({ ...result, differencePercent: -0.1 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...result, differencePercent: 100.1 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...result, differencePercent: Number.NaN }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...result, baselinePath: 'x'.repeat(1025) }, 'editor-1')).toBe(false);
  });
});
