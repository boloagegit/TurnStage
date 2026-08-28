const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
export const MAX_CHAT_SCREENSHOT_BYTES = 24 * 1024 * 1024;

export function decodeChatScreenshot(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw new Error('The screenshot payload is not a PNG image.');
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('The screenshot payload is malformed.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_CHAT_SCREENSHOT_BYTES) throw new Error('The screenshot is too large to save.');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('The screenshot payload has an invalid PNG signature.');
  return bytes;
}

export function normalizeScreenshotFileName(value: string): string {
  const base = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 160) || 'turnstage-chat';
  return `${base.replace(/\.png$/i, '')}.png`;
}
