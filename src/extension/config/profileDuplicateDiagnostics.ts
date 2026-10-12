import * as vscode from 'vscode';
import { ProfileRepository, type ProfileEntry } from './profileRepository';
import { ProfileFileWatcher } from './profileFileWatcher';
import { localize } from '../l10n';
import { logAt } from '../logging';

const duplicateCode = 'duplicate-profile-id';

export class ProfileDuplicateDiagnostics implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly knownUris = new Map<string, vscode.Uri>();
  private debounce?: ReturnType<typeof setTimeout>;

  constructor(private readonly repository: ProfileRepository, private readonly collection: vscode.DiagnosticCollection, private readonly output: vscode.OutputChannel) {
    this.disposables.push(
      new ProfileFileWatcher(repository, () => this.scheduleRefresh()),
      vscode.workspace.onDidOpenTextDocument((document) => { if (isProfile(document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidChangeTextDocument((event) => { if (isProfile(event.document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidSaveTextDocument((document) => { if (isProfile(document.uri)) this.scheduleRefresh(); }),
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
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh().catch((error) => logAt(this.output, 'error', () => `[profiles] duplicate diagnostics refresh failed type=${error instanceof Error ? error.name : 'Error'}`));
    }, 200);
  }

  private async createDiagnostic(entry: ProfileEntry, id: string, conflicts: ProfileEntry[]): Promise<vscode.Diagnostic | undefined> {
    try {
      const document = await vscode.workspace.openTextDocument(entry.uri);
      const offset = entry.idOffset ?? 0;
      const range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + (entry.idLength ?? 1)));
      const others = conflicts.filter((item) => item.uri.toString() !== entry.uri.toString());
      const diagnostic = new vscode.Diagnostic(range, localize('Profile id "{id}" is also used by {profiles}.', { id, profiles: others.map((item) => vscode.workspace.asRelativePath(item.uri)).join(', ') }), vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'TurnStage';
      diagnostic.code = duplicateCode;
      diagnostic.relatedInformation = others.map((item) => new vscode.DiagnosticRelatedInformation(
        new vscode.Location(item.uri, new vscode.Position(0, 0)),
        localize('Conflicting TurnStage profile id "{id}".', { id }),
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
