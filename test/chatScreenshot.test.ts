import { describe, expect, it } from 'vitest';
import { decodeChatScreenshot, MAX_CHAT_SCREENSHOT_BYTES, normalizeScreenshotFileName } from '../src/extension/editors/chatScreenshot';
import { screenshotFileName } from '../src/webview/chatScreenshot';

describe('chat screenshots', () => {
  it('creates a bounded filesystem-safe suggested name', () => {
    expect(screenshotFileName('../Demo profile', new Date('2026-08-28T07:00:00.123Z'))).toBe('turnstage-Demo-profile-2026-08-28T07-00-00-123Z.png');
    expect(normalizeScreenshotFileName('../unsafe name.PNG')).toBe('unsafe-name.png');
  });

  it('accepts a bounded PNG payload and rejects malformed, non-PNG, or oversized data', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(decodeChatScreenshot(`data:image/png;base64,${signature.toString('base64')}`)).toEqual(signature);
    expect(() => decodeChatScreenshot('data:image/jpeg;base64,aaaa')).toThrow('not a PNG');
    expect(() => decodeChatScreenshot('data:image/png;base64,%%%')).toThrow('malformed');
    const oversized = Buffer.alloc(MAX_CHAT_SCREENSHOT_BYTES + 1); oversized.set(signature);
    expect(() => decodeChatScreenshot(`data:image/png;base64,${oversized.toString('base64')}`)).toThrow('too large');
  });
});
