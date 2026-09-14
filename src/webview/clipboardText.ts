/** Copy text on secure origins, with a user-gesture fallback for HTTP pages. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* HTTP and permission-restricted browsers may still allow a gesture copy. */ }
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  document.body.append(input);
  try {
    input.select();
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    previousFocus?.focus();
  }
}
