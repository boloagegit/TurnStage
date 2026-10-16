import { useEffect } from 'react';

const SEQUENCE = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

/** True for keys typed into a field, where arrows and letters belong to the text, not to the code. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Feeds one key into the code; returns the new progress, or SEQUENCE.length when the code is complete. */
export function advanceKonami(progress: number, key: string): number {
  const next = key.toLowerCase();
  if (next === SEQUENCE[progress]) return progress + 1;
  // Extra presses of the opening ↑ keep the code at "↑↑" instead of starting over.
  if (next === 'arrowup') return progress === 2 ? 2 : 1;
  return 0;
}

/** Calls `onUnlock` when ↑↑↓↓←→←→BA is typed outside a text field. Keys still do whatever they normally do. */
export function useKonamiCode(onUnlock: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let progress = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || typingTarget(event.target)) { progress = 0; return; }
      progress = advanceKonami(progress, event.key);
      if (progress === SEQUENCE.length) { progress = 0; onUnlock(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled, onUnlock]);
}
