const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusReturnTarget {
  element?: HTMLElement;
  ancestors: HTMLElement[];
}

/** Remember the element that opened a dialog together with its ancestors. */
export function captureFocusReturnTarget(): FocusReturnTarget {
  const element = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
  const ancestors: HTMLElement[] = [];
  for (let current = element?.parentElement; current && current !== document.body; current = current.parentElement) ancestors.push(current);
  return { element, ancestors };
}

/**
 * Return focus after a dialog closes. When the opener was removed (for example
 * a row deleted by the confirmed action), focus the first control in the
 * closest surviving container instead of letting focus fall to <body>.
 */
export function restoreFocus(target: FocusReturnTarget): void {
  if (target.element?.isConnected) {
    target.element.focus({ preventScroll: true });
    watchForOpenerRemoval(target);
    return;
  }
  focusSurvivingContainer(target);
}

/**
 * Host-applied edits (for example deleting a case through a Profile patch)
 * remove the opener after the dialog has already closed. Follow focus to the
 * surviving container if that happens shortly afterwards while it still has focus.
 */
function watchForOpenerRemoval(target: FocusReturnTarget): void {
  const element = target.element;
  if (!element || typeof MutationObserver === 'undefined') return;
  const stop = () => { observer.disconnect(); document.removeEventListener('focusin', onFocusIn, true); clearTimeout(timer); };
  const onFocusIn = (event: FocusEvent) => { if (event.target !== element) stop(); };
  const observer = new MutationObserver(() => {
    if (element.isConnected) return;
    stop();
    if (!document.activeElement || document.activeElement === document.body) focusSurvivingContainer(target);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', onFocusIn, true);
  const timer = setTimeout(stop, 5_000);
}

function focusSurvivingContainer(target: FocusReturnTarget): void {
  const container = target.ancestors.find((ancestor) => ancestor.isConnected && !ancestor.closest('[inert]'));
  if (!container) return;
  const next = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].find((candidate) => candidate.getClientRects().length > 0) ?? container.querySelector<HTMLElement>(FOCUSABLE);
  (next ?? (container.tabIndex >= -1 && container.hasAttribute('tabindex') ? container : undefined))?.focus({ preventScroll: true });
}
