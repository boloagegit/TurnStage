import { useEffect } from 'react';
import type { TestOperationSnapshot } from '../../shared/protocol';

/** Other ways in (the peeking robot, the first all-pass hint) ask for the game through this window event. */
const OPEN_EVENT = 'turnstage:easter-egg';
const HINT_KEY = 'turnstage.easterEgg.hinted';

export function requestEasterEgg(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** True the first time only: the all-pass hint is shown once per view storage, and never after the game was found. */
export function takeEasterEggHint(): boolean {
  try {
    if (localStorage.getItem(HINT_KEY)) return false;
    localStorage.setItem(HINT_KEY, '1');
    return true;
  } catch { return false; }
}

/** A finished run in which every case passed. */
export function allCasesPassed(operation: TestOperationSnapshot): boolean {
  const progress = operation.progress;
  return operation.state === 'completed' && Boolean(progress) && progress!.totalCases > 0 && progress!.passedCases === progress!.totalCases && !progress!.failedCases;
}

function markEasterEggFound(): void {
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* The hint may show once more; nothing else depends on it. */ }
}

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
      if (progress === SEQUENCE.length) { progress = 0; markEasterEggFound(); onUnlock(); }
    };
    const onRequest = () => { markEasterEggFound(); onUnlock(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(OPEN_EVENT, onRequest);
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener(OPEN_EVENT, onRequest); };
  }, [enabled, onUnlock]);
}
