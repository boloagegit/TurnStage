import * as vscode from 'vscode';
import { findNodeAtLocation } from 'jsonc-parser';
import { ProfileCodec } from './profileCodec';
import { copyFileName, copyProfileId, duplicateProfileGroups, duplicateProfileText, importedProfileFileName } from './profileManagement';
import type { TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { localize } from '../l10n';

export const MAX_PROFILE_BYTES = 5 * 1024 * 1024;
export const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_DISCOVERED_FILES = 500;
const READ_CONCURRENCY = 8;

export interface ProfileEntry {
  uri: vscode.Uri;
  scope: ProfileScope;
  overridden?: boolean;
  profile?: TurnStageProfile;
  error?: string;
  idOffset?: number;
  idLength?: number;
}

export type ProfileScope = 'workspace' | 'user';
export type ProfileDestination = vscode.WorkspaceFolder | 'user';

export interface EnvironmentEntry {
  uri: vscode.Uri;
  scope: ProfileScope;
  environment: TurnStageEnvironment;
}

export class ProfileRepository {
  private readonly codec = new ProfileCodec();
  constructor(private readonly userStorageUri?: vscode.Uri) {}

  async discover(scope?: ProfileScope): Promise<ProfileEntry[]> {
    const entries: ProfileEntry[] = [];
    if (scope !== 'user' && vscode.workspace.workspaceFolders?.length) {
      const perFolder = await Promise.all(vscode.workspace.workspaceFolders.map(async (folder) => {
        const glob = vscode.workspace.getConfiguration('turnstage', folder.uri).get('profileGlob', '.vscode/turnstage/profiles/*.turnstage.jsonc');
        return vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), '**/{node_modules,.git}/**', 500);
      }));
      const uris = [...new Map(perFolder.flat().map((uri) => [uri.toString(), uri])).values()].slice(0, MAX_DISCOVERED_FILES);
      entries.push(...await mapWithConcurrency(uris, READ_CONCURRENCY, (uri) => this.read(uri, 'workspace')));
    }
    if (scope !== 'workspace') {
      const uris = await filesInDirectory(this.userProfileDirectory(), '.turnstage.jsonc');
      entries.push(...await mapWithConcurrency(uris.slice(0, MAX_DISCOVERED_FILES), READ_CONCURRENCY, (uri) => this.read(uri, 'user')));
    }
    if (scope === undefined) {
      const workspaceIds = new Set(entries.filter((entry) => entry.scope === 'workspace').flatMap((entry) => entry.profile?.id ? [entry.profile.id] : []));
      return entries.map((entry) => entry.scope === 'user' && entry.profile?.id && workspaceIds.has(entry.profile.id) ? { ...entry, overridden: true } : entry);
    }
    return entries;
  }
  async read(uri: vscode.Uri, scope = this.scopeOf(uri)): Promise<ProfileEntry> {
    try {
      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      const text = openDocument?.getText() ?? new TextDecoder().decode(await readBoundedBytes(uri, MAX_PROFILE_BYTES, localize('Profile files cannot exceed 5 MB.')));
      if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new Error(localize('Profile files cannot exceed 5 MB.'));
      const parsed = this.codec.parse(text);
      const idNode = parsed.tree ? findNodeAtLocation(parsed.tree, ['id']) : undefined;
      const stringPadding = idNode?.type === 'string' ? 1 : 0;
      return {
        uri,
        scope,
        profile: parsed.profile,
        error: parsed.errors.length ? localize('Invalid JSONC') : undefined,
        idOffset: idNode ? idNode.offset + stringPadding : undefined,
        idLength: idNode ? Math.max(1, idNode.length - stringPadding * 2) : undefined,
      };
    } catch (error) { return { uri, scope, error: error instanceof Error ? error.message : String(error) }; }
  }

  async import(source: vscode.Uri, destination: ProfileDestination): Promise<vscode.Uri> {
    const bytes = await readBoundedBytes(source, MAX_PROFILE_BYTES, localize('Profile files cannot exceed 5 MB.'));
    const text = new TextDecoder().decode(bytes);
    const parsed = this.codec.parse(text);
    if (!parsed.profile || parsed.errors.length) throw new Error(localize('The selected file is not valid JSONC.'));
    if (!parsed.profile.id?.trim()) throw new Error(localize('The selected file does not contain a profile id.'));
    const directory = this.profileDirectory(destination);
    await vscode.workspace.fs.createDirectory(directory);
    const target = await this.availableUri(vscode.Uri.joinPath(directory, importedProfileFileName(uriBaseName(source))));
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
  }

  async duplicate(source: vscode.Uri): Promise<vscode.Uri> {
    const entry = await this.read(source);
    if (!entry.profile || entry.error) throw new Error(localize('Only a valid TurnStage profile can be duplicated.'));
    const text = await this.readText(source);
    const entries = (await this.discover()).filter((item) => item.scope === entry.scope);
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
    return (['workspace', 'user'] as const).flatMap((scope) => duplicateProfileGroups(entries.filter((entry) => entry.scope === scope).map((entry) => ({ item: entry, id: entry.profile?.id }))));
  }

  profileDirectory(destination: ProfileDestination): vscode.Uri {
    if (destination !== 'user') return vscode.Uri.joinPath(destination.uri, '.vscode', 'turnstage', 'profiles');
    const directory = this.userProfileDirectory();
    if (!directory) throw new Error(localize('User profile storage is unavailable.'));
    return directory;
  }

  userProfileDirectory(): vscode.Uri | undefined {
    return this.userStorageUri ? vscode.Uri.joinPath(this.userStorageUri, 'configuration', 'profiles') : undefined;
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
    const text = document?.getText() ?? new TextDecoder().decode(await readBoundedBytes(uri, MAX_PROFILE_BYTES, localize('Profile files cannot exceed 5 MB.')));
    if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new Error(localize('Profile files cannot exceed 5 MB.'));
    return text;
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

  private scopeOf(uri: vscode.Uri): ProfileScope {
    const userDirectory = this.userProfileDirectory();
    return userDirectory && uri.toString().startsWith(`${userDirectory.toString().replace(/\/$/, '')}/`) ? 'user' : 'workspace';
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
  constructor(private readonly userStorageUri?: vscode.Uri) {}

  async discover(profileUri?: vscode.Uri): Promise<EnvironmentEntry[]> {
    // Built-in starter profiles are virtual documents. They intentionally use
    // the built-in local environment and have no neighbouring environment
    // directory that VS Code can search with a RelativePattern.
    if (profileUri?.scheme === 'turnstage-demo') return [];
    const workspaceFolder = profileUri ? vscode.workspace.getWorkspaceFolder(profileUri) : undefined;
    const pattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, '.vscode/turnstage/environments/*.environment.jsonc')
      : '**/.vscode/turnstage/environments/*.environment.jsonc';
    const includeWorkspace = Boolean(workspaceFolder) || profileUri === undefined;
    const workspaceUris = includeWorkspace && vscode.workspace.workspaceFolders?.length ? await vscode.workspace.findFiles(pattern, '**/{node_modules,.git}/**', 100) : [];
    const userUris = await filesInDirectory(this.userEnvironmentDirectory(), '.environment.jsonc');
    const workspaceEntries = await mapWithConcurrency(workspaceUris.slice(0, MAX_DISCOVERED_FILES), READ_CONCURRENCY, (uri) => this.read(uri, 'workspace'));
    const userEntries = await mapWithConcurrency(userUris.slice(0, MAX_DISCOVERED_FILES), READ_CONCURRENCY, (uri) => this.read(uri, 'user'));
    const effective = new Map<string, EnvironmentEntry>();
    for (const entry of [...workspaceEntries, ...userEntries]) if (entry.environment?.id && !effective.has(entry.environment.id)) effective.set(entry.environment.id, entry);
    return [...effective.values()];
  }

  userEnvironmentDirectory(): vscode.Uri | undefined {
    return this.userStorageUri ? vscode.Uri.joinPath(this.userStorageUri, 'configuration', 'environments') : undefined;
  }

  private async read(uri: vscode.Uri, scope: ProfileScope): Promise<EnvironmentEntry> {
    const text = new TextDecoder().decode(await readBoundedBytes(uri, MAX_ENVIRONMENT_BYTES, localize('Environment files cannot exceed 1 MB.')));
    return { uri, scope, environment: this.codec.parse(text).profile as unknown as TurnStageEnvironment };
  }
}

async function filesInDirectory(directory: vscode.Uri | undefined, suffix: string): Promise<vscode.Uri[]> {
  if (!directory) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    return entries
      .filter(([name, type]) => name.toLowerCase().endsWith(suffix) && (type & vscode.FileType.File) !== 0)
      .map(([name]) => vscode.Uri.joinPath(directory, name));
  } catch {
    return [];
  }
}

async function readBoundedBytes(uri: vscode.Uri, maxBytes: number, message: string): Promise<Uint8Array> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > maxBytes) throw new Error(message);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > maxBytes) throw new Error(message);
  return bytes;
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]!);
    }
  }));
  return output;
}
