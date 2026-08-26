import * as vscode from 'vscode';
import type { LocalRun } from '../../shared/types';

export class LocalRunRepository {
  constructor(private readonly context: vscode.ExtensionContext) {}
  private uri(profileId: string): vscode.Uri { return vscode.Uri.joinPath(this.context.globalStorageUri, 'runs', `${profileId}.json`); }
  async list(profileId: string): Promise<LocalRun[]> {
    try { return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri(profileId)))) as LocalRun[]; } catch { return []; }
  }
  async save(run: LocalRun, retention: number): Promise<void> {
    const runs = [run, ...(await this.list(run.profileId)).filter((item) => item.id !== run.id)].slice(0, retention);
    const uri = this.uri(run.profileId); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..')); await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(runs)));
  }
  async export(run: LocalRun): Promise<vscode.Uri | undefined> {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${run.profileId}-${run.id}.turnstage-run.json`), filters: { 'TurnStage Run': ['json'] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(run, null, 2))); return uri;
  }
}
