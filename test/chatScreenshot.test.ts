import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { copyChatScreenshotToClipboard, MAX_CHAT_SCREENSHOT_BYTES, pngDataUrlToBlob } from '../src/webview/chatScreenshot';

describe('chat screenshots', () => {
  it('creates a bounded PNG blob and rejects malformed, non-PNG, or oversized data', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const blob = pngDataUrlToBlob(`data:image/png;base64,${signature.toString('base64')}`);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(signature.length);
    expect(() => pngDataUrlToBlob('data:image/jpeg;base64,aaaa')).toThrow('not a PNG');
    expect(() => pngDataUrlToBlob('data:image/png;base64,%%%')).toThrow('malformed');
    const oversized = Buffer.alloc(MAX_CHAT_SCREENSHOT_BYTES + 1); oversized.set(signature);
    expect(() => pngDataUrlToBlob(`data:image/png;base64,${oversized.toString('base64')}`)).toThrow('too large');
  });

  it('writes the generated PNG to the image clipboard', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    let clipboardItems: ClipboardItem[] = [];
    let representations: Record<string, ClipboardItemData> = {};
    class TestClipboardItem {
      constructor(items: Record<string, ClipboardItemData>) { representations = items; }
    }
    await copyChatScreenshotToClipboard(dataUrl, {
      clipboard: { write: async (items) => { clipboardItems = items; } },
      ClipboardItemConstructor: TestClipboardItem as unknown as typeof ClipboardItem
    });
    expect(clipboardItems).toHaveLength(1);
    const png = await representations['image/png'];
    expect(png).toBeInstanceOf(Blob);
    if (png instanceof Blob) expect(png.type).toBe('image/png');
  });
});
