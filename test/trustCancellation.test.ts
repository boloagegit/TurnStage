import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  class CancellationTokenSource {
    private cancelled = false;
    private readonly listeners = new Set<() => void>();
    readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } };

    constructor() {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void): { dispose(): void } => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        },
      };
      Object.defineProperty(token, 'isCancellationRequested', { get: () => this.cancelled });
      this.token = token;
    }

    cancel(): void {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const listener of this.listeners) listener();
    }

    dispose(): void { this.listeners.clear(); }
  }
  return { workspace: { isTrusted: true }, CancellationTokenSource };
});

vi.mock('vscode', () => vscodeMock);

import { createTrustAwareCancellation } from '../src/extension/testing/trustCancellation';

describe('Workspace Trust cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vscodeMock.workspace.isTrusted = true;
  });

  afterEach(() => { vi.useRealTimers(); });

  it('emits cancellation when Workspace Trust is lost during an active run', () => {
    let externalListener: (() => void) | undefined;
    const externalToken = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void): { dispose(): void } {
        externalListener = listener;
        return { dispose: () => { externalListener = undefined; } };
      },
    };
    const cancellation = createTrustAwareCancellation(externalToken as never);
    const observed = vi.fn();
    cancellation.token.onCancellationRequested(observed);

    vscodeMock.workspace.isTrusted = false;
    vi.advanceTimersByTime(25);

    expect(cancellation.token.isCancellationRequested).toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    cancellation.dispose();
    expect(externalListener).toBeUndefined();
  });
});
