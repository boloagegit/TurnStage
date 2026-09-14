// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/webview/clipboardText';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('copyText', () => {
  it('uses a user-gesture copy when the secure-context clipboard API is absent', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const copied = vi.fn(() => true);
    document.execCommand = copied;
    await copyText('HTTP copy');
    expect(copied).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('reports failure if both clipboard paths are unavailable', async () => {
    document.execCommand = vi.fn(() => false);
    await expect(copyText('text')).rejects.toThrow('Clipboard unavailable');
  });
});
