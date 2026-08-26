import * as vscode from 'vscode';
import { findNodeAtLocation } from 'jsonc-parser';
import { ProfileCodec } from './profileCodec';
import { copyFileName, copyProfileId, duplicateProfileGroups, duplicateProfileText, importedProfileFileName } from './profileManagement';
import type { TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { localize } from '../l10n';

export interface ProfileEntry {
  uri: vscode.Uri;
  profile?: TurnStageProfile;
  error?: string;
  idOffset?: number;
  idLength?: number;
}

export class ProfileRepository {
  private readonly codec = new ProfileCodec();
  async discover(): Promise<ProfileEntry[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const glob = vscode.workspace.getConfiguration('turnstage').get('profileGlob', '.vscode/turnstage/profiles/*.turnstage.jsonc');
    const uris = await vscode.workspace.findFiles(glob, '**/{node_modules,.git}/**', 500);
    return Promise.all(uris.map((uri) => this.read(uri)));
  }
  async read(uri: vscode.Uri): Promise<ProfileEntry> {
    try {
      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      const text = openDocument?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const parsed = this.codec.parse(text);
      const idNode = parsed.tree ? findNodeAtLocation(parsed.tree, ['id']) : undefined;
      const stringPadding = idNode?.type === 'string' ? 1 : 0;
      return {
        uri,
        profile: parsed.profile,
        error: parsed.errors.length ? localize('Invalid JSONC') : undefined,
        idOffset: idNode ? idNode.offset + stringPadding : undefined,
        idLength: idNode ? Math.max(1, idNode.length - stringPadding * 2) : undefined,
      };
    } catch (error) { return { uri, error: error instanceof Error ? error.message : String(error) }; }
  }

  async import(source: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri> {
    const bytes = await vscode.workspace.fs.readFile(source);
    const text = new TextDecoder().decode(bytes);
    const parsed = this.codec.parse(text);
    if (!parsed.profile || parsed.errors.length) throw new Error(localize('The selected file is not valid JSONC.'));
    if (!parsed.profile.id?.trim()) throw new Error(localize('The selected file does not contain a profile id.'));
    const directory = this.profileDirectory(workspaceFolder.uri);
    await vscode.workspace.fs.createDirectory(directory);
    const target = await this.availableUri(vscode.Uri.joinPath(directory, importedProfileFileName(uriBaseName(source))));
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
  }

  async duplicate(source: vscode.Uri): Promise<vscode.Uri> {
    const entry = await this.read(source);
    if (!entry.profile || entry.error) throw new Error(localize('Only a valid TurnStage profile can be duplicated.'));
    const text = await this.readText(source);
    const entries = await this.discover();
    const usedIds = new Set(entries.flatMap((item) => item.profile?.id ? [item.profile.id] : []));
    let copyNumber = 1;
    let id = copyProfileId(entry.profile.id, copyNumber);
    while (usedIds.has(id)) id = copyProfileId(entry.profile.id, ++copyNumber);
    const name = `${entry.profile.name?.trim() || entry.profile.id} Copy${copyNumber === 1 ? '' : ` ${copyNumber}`}`;
    const duplicateText = duplicateProfileText(text, id, name);
    const target = await this.availableUri(source, true);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(duplicateText));
    return target;
  }

  async isDiscoveredProfile(uri: vscode.Uri): Promise<boolean> {
    return (await this.discover()).some((entry) => entry.uri.toString() === uri.toString());
  }

  duplicateGroups(entries: ProfileEntry[]) {
    return duplicateProfileGroups(entries.map((entry) => ({ item: entry, id: entry.profile?.id })));
  }

  profileDirectory(workspaceFolderUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceFolderUri, '.vscode', 'turnstage', 'profiles');
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
    return document?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }

  private async availableUri(uri: vscode.Uri, isCopy = false): Promise<vscode.Uri> {
    if (!isCopy && !await exists(uri)) return uri;
    const directory = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/') + 1) });
    const fileName = uriBaseName(uri);
    for (let copyNumber = 1; copyNumber < 10_000; copyNumber++) {
      const candidate = vscode.Uri.joinPath(directory, copyFileName(fileName, copyNumber));
      if (!await exists(candidate)) return candidate;
    }
    throw new Error(localize('Could not create a duplicate-safe profile filename.'));
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

function uriBaseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

export class EnvironmentRepository {
  private readonly codec = new ProfileCodec();
  async discover(profileUri?: vscode.Uri): Promise<Array<{ uri: vscode.Uri; environment: TurnStageEnvironment }>> {
    // Built-in starter profiles are virtual documents. They intentionally use
    // the built-in local environment and have no neighbouring environment
    // directory that VS Code can search with a RelativePattern.
    if (profileUri?.scheme === 'turnstage-demo') return [];
    const pattern = profileUri ? new vscode.RelativePattern(vscode.Uri.joinPath(profileUri, '..', '..'), 'environments/*.environment.jsonc') : '**/.vscode/turnstage/environments/*.environment.jsonc';
    const uris = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git}/**', 100);
    const entries = await Promise.all(uris.map(async (uri) => {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      return { uri, environment: this.codec.parse(text).profile as unknown as TurnStageEnvironment };
    }));
    return entries.filter((entry) => entry.environment?.id);
  }
}
