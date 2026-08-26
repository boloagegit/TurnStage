import * as vscode from 'vscode';
import { ProfileRepository, type ProfileEntry } from '../config/profileRepository';
import type { WorkspaceSection } from '../../shared/protocol';

/**
 * The sections exposed by a profile in the native VS Code tree. Keep these
 * identifiers aligned with SettingsWorkspace so a tree selection can be
 * forwarded to the editor without another translation layer.
 */
export const PROFILE_SECTIONS = [
  { id: 'test', label: 'Test', icon: 'beaker' },
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'opening-flow', label: 'Opening & Flow', icon: 'play-circle' },
  { id: 'request', label: 'Request', icon: 'send' },
  { id: 'stream-mapping', label: 'Stream & Mapping', icon: 'radio-tower' },
  { id: 'chat-ui', label: 'Chat UI', icon: 'comment-discussion' },
  { id: 'history-errors', label: 'History & Errors', icon: 'history' },
  { id: 'security', label: 'Security', icon: 'shield' },
] as const;

export type ProfileSectionId = WorkspaceSection;

export class ProfileTreeItem extends vscode.TreeItem {
  override readonly contextValue = 'turnstageProfile';
  constructor(readonly entry: ProfileEntry) {
    super(entry.profile?.name ?? vscode.workspace.asRelativePath(entry.uri), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = entry.uri.toString();
    this.description = entry.profile?.environment ?? 'Invalid';
    this.resourceUri = entry.uri;
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'comment-discussion');
    this.tooltip = new vscode.MarkdownString(`**${this.label}**\n\n${entry.uri.toString()}\n\nTransport: ${entry.profile?.stream?.transport ?? 'unknown'}\n\nValidation: ${entry.error ? 'Invalid' : 'Ready'}`);
    this.command = { command: 'vscode.openWith', title: 'Open', arguments: [entry.uri, 'turnstage.profileEditor'] };
  }
}

export class ProfileSectionTreeItem extends vscode.TreeItem {
  override readonly contextValue = 'turnstageProfileSection';

  constructor(readonly profileUri: vscode.Uri, readonly section: typeof PROFILE_SECTIONS[number]) {
    super(section.label, vscode.TreeItemCollapsibleState.None);
    this.id = `${profileUri.toString()}#${section.id}`;
    this.iconPath = new vscode.ThemeIcon(section.icon);
    this.tooltip = `${section.label} settings`;
    this.command = {
      command: 'turnstage.openProfileSection',
      title: `Open ${section.label}`,
      arguments: [profileUri, section.id],
    };
  }
}

export type ProfileTreeNode = ProfileTreeItem | ProfileSectionTreeItem;

export class ProfileTreeProvider implements vscode.TreeDataProvider<ProfileTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ProfileTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watcher?: vscode.FileSystemWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  constructor(private readonly repository: ProfileRepository, private readonly discovered?: (entries: ProfileEntry[]) => Promise<void> | void) {
    if (vscode.workspace.workspaceFolders?.length) {
      this.watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/turnstage/profiles/*.turnstage.jsonc');
      for (const event of [this.watcher.onDidCreate, this.watcher.onDidChange, this.watcher.onDidDelete]) event(() => this.scheduleRefresh());
    }
  }
  getTreeItem(element: ProfileTreeNode): vscode.TreeItem { return element; }
  async getChildren(element?: ProfileTreeNode): Promise<ProfileTreeNode[]> {
    if (element instanceof ProfileTreeItem) return PROFILE_SECTIONS.map((section) => new ProfileSectionTreeItem(element.entry.uri, section));
    if (element) return [];
    const entries = await this.repository.discover();
    await this.discovered?.(entries);
    return entries.map((entry) => new ProfileTreeItem(entry));
  }
  refresh(): void { this.emitter.fire(undefined); }
  private scheduleRefresh(): void { if (this.debounce) clearTimeout(this.debounce); this.debounce = setTimeout(() => this.refresh(), 150); }
  dispose(): void { if (this.debounce) clearTimeout(this.debounce); this.watcher?.dispose(); this.emitter.dispose(); }
}
