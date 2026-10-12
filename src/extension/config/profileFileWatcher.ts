import * as vscode from 'vscode';
import { profileGlob, type ProfileRepository } from './profileRepository';

/**
 * Watches workspace Profiles through each folder's `turnstage.profileGlob` and the user Profile folder.
 * Watchers are rebuilt when the glob or the workspace folders change, and `onChange` runs after every rebuild.
 */
export class ProfileFileWatcher implements vscode.Disposable {
  private watchers: vscode.Disposable[] = [];
  private readonly listeners: vscode.Disposable[];

  constructor(private readonly repository: ProfileRepository, private readonly onChange: () => void) {
    this.rebuild();
    this.listeners = [
      vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('turnstage.profileGlob')) this.rebuildAndNotify(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuildAndNotify()),
    ];
  }

  dispose(): void {
    for (const disposable of [...this.watchers, ...this.listeners]) disposable.dispose();
    this.watchers = [];
  }

  private rebuildAndNotify(): void {
    this.rebuild();
    this.onChange();
  }

  private rebuild(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    const patterns = (vscode.workspace.workspaceFolders ?? []).map((folder) => new vscode.RelativePattern(folder, profileGlob(folder.uri)));
    const userDirectory = this.repository.userProfileDirectory();
    if (userDirectory) patterns.push(new vscode.RelativePattern(userDirectory, '*.turnstage.jsonc'));
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.watchers.push(watcher, ...[watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete].map((event) => event(() => this.onChange())));
    }
  }
}
