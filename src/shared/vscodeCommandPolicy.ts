const blockedLifecycleCommands = new Set([
  'vscode.openfolder',
  'workbench.action.reloadwindow',
  'workbench.action.restartextensionhost',
  'workbench.action.closewindow',
  'workbench.action.quit',
  'workbench.action.files.openfolder',
  'workbench.action.files.openfilefolder',
  'workbench.action.remote.close',
]);

/** Commands that can replace, restart, or close the current VS Code window. */
export function isBlockedLifecycleCommand(command: string): boolean {
  return blockedLifecycleCommands.has(command.trim().toLowerCase());
}
