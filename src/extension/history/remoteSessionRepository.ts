import type * as vscode from 'vscode';
import type { RemoteSessionReference } from '../../shared/types';

export class RemoteSessionRepository {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(key: string): RemoteSessionReference[] { return this.context.globalState.get<RemoteSessionReference[]>(key, []); }

  async save(key: string, reference: RemoteSessionReference): Promise<RemoteSessionReference[]> {
    const references = [reference, ...this.list(key).filter((item) => item.conversationId !== reference.conversationId)].slice(0, 50);
    await this.context.globalState.update(key, references);
    return references;
  }
}
