import * as vscode from 'vscode';
import { ProfileRepository, type ProfileEntry, type ProfileScope } from '../config/profileRepository';

export class ProfileTreeItem extends vscode.TreeItem {
  override readonly contextValue = 'turnstageProfile';
  constructor(readonly entry: ProfileEntry) {
    super(entry.profile?.name ?? vscode.workspace.asRelativePath(entry.uri), vscode.TreeItemCollapsibleState.None);
    this.id = entry.uri.toString();
    this.description = entry.overridden ? vscode.l10n.t('Overridden') : entry.profile?.environment ?? vscode.l10n.t('Invalid');
    this.resourceUri = entry.uri;
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'comment-discussion');
    this.tooltip = [
      vscode.l10n.t('Profile: {name}', { name: String(this.label) }),
      entry.uri.toString(),
      vscode.l10n.t('Transport: {transport}', { transport: entry.profile?.stream?.transport ?? vscode.l10n.t('Unknown') }),
      vscode.l10n.t('Validation: {status}', { status: entry.error ? vscode.l10n.t('Invalid') : vscode.l10n.t('Ready') }),
      entry.overridden ? vscode.l10n.t('A Workspace profile with the same id is the effective project override.') : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n\n');
    this.command = { command: 'vscode.openWith', title: vscode.l10n.t('Open'), arguments: [entry.uri, 'turnstage.profileEditor'] };
  }
}

export class ProfileScopeTreeItem extends vscode.TreeItem {
  override readonly contextValue: string;
  constructor(readonly scope: ProfileScope, count: number) {
    super(scope === 'workspace' ? vscode.l10n.t('Workspace') : vscode.l10n.t('User'), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `turnstage.scope.${scope}`;
    this.contextValue = `turnstageProfileScope.${scope}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(scope === 'workspace' ? 'folder-library' : 'account');
    this.tooltip = scope === 'workspace'
      ? vscode.l10n.t('Profiles stored in the current workspace.')
      : vscode.l10n.t('Profiles shared across workspaces for this VS Code user.');
  }
}

export type ProfileTreeNode = ProfileScopeTreeItem | ProfileTreeItem;

export class ProfileTreeProvider implements vscode.TreeDataProvider<ProfileTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ProfileTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private entries: ProfileEntry[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  constructor(private readonly repository: ProfileRepository, private readonly discovered?: (entries: ProfileEntry[]) => Promise<void> | void) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const glob = vscode.workspace.getConfiguration('turnstage', folder.uri).get('profileGlob', '.vscode/turnstage/profiles/*.turnstage.jsonc');
      this.watch(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob)));
    }
    const userDirectory = this.repository.userProfileDirectory();
    if (userDirectory) this.watch(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(userDirectory, '*.turnstage.jsonc')));
  }
  getTreeItem(element: ProfileTreeNode): vscode.TreeItem { return element; }
  async getChildren(element?: ProfileTreeNode): Promise<ProfileTreeNode[]> {
    if (element instanceof ProfileScopeTreeItem) return this.entries.filter((entry) => entry.scope === element.scope).map((entry) => new ProfileTreeItem(entry));
    if (element) return [];
    this.entries = await this.repository.discover();
    await this.discovered?.(this.entries);
    if (!this.entries.length) return [];
    const scopes: ProfileScope[] = vscode.workspace.workspaceFolders?.length ? ['workspace', 'user'] : ['user'];
    return scopes.map((scope) => new ProfileScopeTreeItem(scope, this.entries.filter((entry) => entry.scope === scope).length));
  }
  refresh(): void { this.entries = []; this.emitter.fire(undefined); }
  private scheduleRefresh(): void { if (this.debounce) clearTimeout(this.debounce); this.debounce = setTimeout(() => this.refresh(), 150); }
  private watch(watcher: vscode.FileSystemWatcher): void {
    this.watchers.push(watcher);
    for (const event of [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete]) event(() => this.scheduleRefresh());
  }
  dispose(): void { if (this.debounce) clearTimeout(this.debounce); for (const watcher of this.watchers) watcher.dispose(); this.emitter.dispose(); }
}
