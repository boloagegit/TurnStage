import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * Returns a function with a permanent identity that always invokes the latest
 * callback. Use it for handlers passed to memoized rows so that parent renders
 * caused by streaming deltas do not invalidate every row.
 */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback);
  useInsertionEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
