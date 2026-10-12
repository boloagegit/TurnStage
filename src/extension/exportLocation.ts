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

/**
 * The system browser runs on the user's machine, so it can open an exported file only when the Extension Host
 * shares that filesystem. On SSH, WSL, container, or virtual workspaces the file lives on the remote side.
 */
export function canOpenInLocalBrowser(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && !vscode.env.remoteName;
}

