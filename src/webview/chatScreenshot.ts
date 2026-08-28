import { toPng } from 'html-to-image';

const MAX_CAPTURE_PIXELS = 8_000_000;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 34 * 1024 * 1024;

export interface ChatScreenshot {
  dataUrl: string;
  suggestedName: string;
}

/** Render the logical Chat viewport, not its scaled preview or surrounding tools. */
export async function captureChatScreenshot(node: HTMLElement, profileId: string, now = new Date()): Promise<ChatScreenshot> {
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
  if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_LENGTH) throw new Error('The screenshot is too large to save.');
  return { dataUrl, suggestedName: screenshotFileName(profileId, now) };
}

export function screenshotFileName(profileId: string, now = new Date()): string {
  const safeProfileId = profileId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'profile';
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `turnstage-${safeProfileId}-${timestamp}.png`;
}
