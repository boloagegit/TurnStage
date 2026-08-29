import * as vscode from 'vscode';

/**
 * Converts Workspace Trust loss into a real cancellation event so active
 * sessions abort instead of only observing a changed boolean between turns.
 */
export function createTrustAwareCancellation(token: vscode.CancellationToken): { token: vscode.CancellationToken; dispose(): void } {
  const source = new vscode.CancellationTokenSource();
  const subscription = token.onCancellationRequested(() => source.cancel());
  const timer = setInterval(() => {
    if (!vscode.workspace.isTrusted) source.cancel();
  }, 25);
  if (token.isCancellationRequested || !vscode.workspace.isTrusted) source.cancel();
  return {
    token: source.token,
    dispose(): void {
      clearInterval(timer);
      subscription.dispose();
      source.dispose();
    },
  };
}
