import * as vscode from 'vscode';
import { sanitizeStoredConversations, type ConversationStorage, type StoredConversation } from '../../shared/conversationHistory';
import { sha256Hex } from '../../shared/sha256';

/** Bounded so a corrupt or hand-edited archive cannot stall the editor. */
export const MAX_CONVERSATION_STORAGE_BYTES = 8 * 1024 * 1024;

/**
 * Stores a Profile's conversation archive in extension global storage, one file per
 * workspace + Profile + environment so conversations from different backends never mix.
 */
export class ConversationRepository implements ConversationStorage {
  private readonly uri: vscode.Uri;

  constructor(context: Pick<vscode.ExtensionContext, 'globalStorageUri'>, scope: { workspace: string; profileId: string; environmentId: string }) {
    const name = sha256Hex(JSON.stringify([scope.workspace, scope.profileId, scope.environmentId])).slice(0, 32);
    this.uri = vscode.Uri.joinPath(context.globalStorageUri, 'conversations', `${name}.json`);
  }

  async load(): Promise<StoredConversation[]> {
    try {
      if ((await vscode.workspace.fs.stat(this.uri)).size > MAX_CONVERSATION_STORAGE_BYTES) return [];
      const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri))) as unknown;
      return sanitizeStoredConversations(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { items?: unknown }).items : undefined);
    } catch {
      return [];
    }
  }

  async save(items: StoredConversation[]): Promise<void> {
    let kept = items;
    let bytes = encode(kept);
    // Drop the oldest conversations until the archive fits.
    while (bytes.byteLength > MAX_CONVERSATION_STORAGE_BYTES && kept.length > 1) {
      kept = kept.slice(0, -1);
      bytes = encode(kept);
    }
    if (bytes.byteLength > MAX_CONVERSATION_STORAGE_BYTES) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.uri, '..'));
    await vscode.workspace.fs.writeFile(this.uri, bytes);
  }
}

function encode(items: StoredConversation[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, items }));
}
