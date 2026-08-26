import * as vscode from 'vscode';
import { ProfileRepository, type ProfileEntry } from './profileRepository';

const duplicateCode = 'duplicate-profile-id';

export class ProfileDuplicateDiagnostics implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly knownUris = new Map<string, vscode.Uri>();
  private debounce?: ReturnType<typeof setTimeout>;

  constructor(private readonly repository: ProfileRepository, private readonly collection: vscode.DiagnosticCollection) {
    const watcher = vscode.workspace.createFileSystemWatcher(vscode.workspace.getConfiguration('turnstage').get('profileGlob', '.vscode/turnstage/profiles/*.turnstage.jsonc'));
    for (const event of [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete]) this.disposables.push(event(() => this.scheduleRefresh()));
    this.disposables.push(
      watcher,
      vscode.workspace.onDidOpenTextDocument((document) => { if (isProfile(document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidChangeTextDocument((event) => { if (isProfile(event.document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidSaveTextDocument((document) => { if (isProfile(document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('turnstage.profileGlob')) this.scheduleRefresh(); }),
    );
  }

  async refresh(discoveredEntries?: ProfileEntry[]): Promise<void> {
    const entries = discoveredEntries ?? await this.repository.discover();
    const diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();
    for (const entry of entries) {
      this.knownUris.set(entry.uri.toString(), entry.uri);
      diagnosticsByUri.set(entry.uri.toString(), []);
    }
    for (const group of this.repository.duplicateGroups(entries)) {
      for (const entry of group.items) {
        const diagnostic = await this.createDiagnostic(entry, group.id, group.items);
        if (diagnostic) diagnosticsByUri.get(entry.uri.toString())?.push(diagnostic);
      }
    }
    for (const [key, uri] of this.knownUris) {
      const retained = [...(this.collection.get(uri) ?? [])].filter((diagnostic) => diagnostic.code !== duplicateCode);
      const duplicates = diagnosticsByUri.get(key) ?? [];
      if (retained.length || duplicates.length) this.collection.set(uri, [...retained, ...duplicates]);
      else this.collection.delete(uri);
      if (!diagnosticsByUri.has(key)) this.knownUris.delete(key);
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 200);
  }

  private async createDiagnostic(entry: ProfileEntry, id: string, conflicts: ProfileEntry[]): Promise<vscode.Diagnostic | undefined> {
    try {
      const document = await vscode.workspace.openTextDocument(entry.uri);
      const offset = entry.idOffset ?? 0;
      const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + (entry.idLength ?? 1)));
      const others = conflicts.filter((item) => item.uri.toString() !== entry.uri.toString());
      const diagnostic = new vscode.Diagnostic(range, `Profile id "${id}" is also used by ${others.map((item) => vscode.workspace.asRelativePath(item.uri)).join(', ')}.`, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'TurnStage';
      diagnostic.code = duplicateCode;
      diagnostic.relatedInformation = others.map((item) => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(item.uri, new vscode.Position(0, 0)),
        `Conflicting TurnStage profile id "${id}".`,
      ));
      return diagnostic;
    } catch {
      return undefined;
    }
  }
}

function isProfile(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.turnstage.jsonc');
}
