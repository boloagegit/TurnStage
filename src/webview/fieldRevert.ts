import type React from 'react';

/** Marks an Escape-driven revert so the blur that follows does not commit the discarded draft. */
export function revertField(event: React.KeyboardEvent, reverting: React.MutableRefObject<boolean>): void {
  reverting.current = true;
  event.preventDefault();
  event.stopPropagation();
}

export function consumeRevert(reverting: React.MutableRefObject<boolean>): boolean {
  if (!reverting.current) return false;
  reverting.current = false;
  return true;
}
