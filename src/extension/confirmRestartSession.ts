import * as vscode from 'vscode';

/** Ask before discarding the current in-memory session and opening flow. */
export async function confirmRestartSession(): Promise<boolean> {
  const restartLabel = vscode.l10n.t('Restart');
  const selected = await vscode.window.showWarningMessage(
    vscode.l10n.t('Restart this TurnStage session?'),
    {
      modal: true,
      detail: vscode.l10n.t('Current messages, conversation IDs, and event data will be cleared. Recorded runs are kept.'),
    },
    restartLabel,
  );
  return selected === restartLabel;
}
