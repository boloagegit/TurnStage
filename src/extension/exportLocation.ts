import * as vscode from 'vscode';
import { homedir } from 'node:os';

/**
 * Default location for a save dialog: the workspace folder that owns `near`, the first workspace folder,
 * or the home directory. A bare `Uri.file(name)` would open the dialog at the filesystem root.
 */
export function defaultExportUri(fileName: string, near?: vscode.Uri): vscode.Uri {
  const folder = (near ? vscode.workspace.getWorkspaceFolder(near) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
  return vscode.Uri.joinPath(folder?.uri ?? vscode.Uri.file(homedir()), fileName);
}
