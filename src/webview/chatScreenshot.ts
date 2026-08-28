import { toPng } from 'html-to-image';

const MAX_CAPTURE_PIXELS = 8_000_000;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
export const MAX_CHAT_SCREENSHOT_BYTES = 24 * 1024 * 1024;
const MAX_SCREENSHOT_DATA_URL_LENGTH = Math.ceil(MAX_CHAT_SCREENSHOT_BYTES / 3) * 4 + PNG_DATA_URL_PREFIX.length;

export interface ChatScreenshot {
  dataUrl: string;
}

/** Render the logical Chat viewport, not its scaled preview or surrounding tools. */
export async function captureChatScreenshot(node: HTMLElement): Promise<ChatScreenshot> {
  const width = Math.max(1, Math.round(node.offsetWidth));
  const height = Math.max(1, Math.round(node.offsetHeight));
  const deviceRatio = Math.max(1, window.devicePixelRatio || 1);
  const pixelRatio = Math.max(1, Math.min(2, deviceRatio, Math.sqrt(MAX_CAPTURE_PIXELS / (width * height))));
  await document.fonts?.ready;
  const backgroundColor = getComputedStyle(node).backgroundColor;
  const dataUrl = await toPng(node, {
    width,
    height,
    pixelRatio,
    backgroundColor,
    cacheBust: false,
    style: { transform: 'none', transformOrigin: 'top left' }
  });
  if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH) throw new Error('The screenshot is too large to copy.');
  return { dataUrl };
}

export interface ClipboardWriteDependencies {
  clipboard?: Pick<Clipboard, 'write'>;
  ClipboardItemConstructor?: typeof ClipboardItem;
}

export async function copyChatScreenshotToClipboard(dataUrl: string | Promise<string>, dependencies: ClipboardWriteDependencies = {}): Promise<void> {
  const clipboard = dependencies.clipboard ?? navigator.clipboard;
  const ClipboardItemConstructor = dependencies.ClipboardItemConstructor ?? globalThis.ClipboardItem;
  if (!clipboard?.write || typeof ClipboardItemConstructor !== 'function') throw new Error('Image clipboard access is unavailable.');
  const png = Promise.resolve(dataUrl).then(pngDataUrlToBlob);
  await clipboard.write([new ClipboardItemConstructor({ 'image/png': png })]);
}

export function pngDataUrlToBlob(dataUrl: string): Blob {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw new Error('The screenshot payload is not a PNG image.');
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('The screenshot payload is malformed.');
  const binary = atob(base64);
  if (!binary.length || binary.length > MAX_CHAT_SCREENSHOT_BYTES) throw new Error('The screenshot is too large to copy.');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('The screenshot payload has an invalid PNG signature.');
  return new Blob([bytes], { type: 'image/png' });
}
