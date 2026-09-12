import * as vscode from 'vscode';
import type { Citation, TurnStageProfile } from '../../shared/types';
import { errors } from '../errors';
import { localize } from '../l10n';

export { SECRET_REDACTION, redactDeep, redactHeaders, redactKnownSecrets, secretRepresentations } from '../../shared/redaction';

export class SecretService {
  private readonly indexKey = 'turnstage.secretNames';
  constructor(private readonly context: vscode.ExtensionContext) {}
  async set(name: string, value: string): Promise<void> { await this.context.secrets.store(`turnstage.${name}`, value); await this.setIndex([...new Set([...this.names(), name])]); }
  async get(name: string): Promise<string | undefined> { return this.context.secrets.get(`turnstage.${name}`); }
  async remove(name: string): Promise<void> { await this.context.secrets.delete(`turnstage.${name}`); await this.setIndex(this.names().filter((item) => item !== name)); }
  names(): string[] { return this.context.globalState.get<string[]>(this.indexKey, []); }
  private async setIndex(names: string[]): Promise<void> { await this.context.globalState.update(this.indexKey, names.sort()); }
}

export class UriPolicy {
  async open(citation: Citation, profile: TurnStageProfile, profileUri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw errors.trust();
    if ((citation.kind === 'url' || citation.kind === 'artifact') && citation.uri) {
      const uri = vscode.Uri.parse(citation.uri, true);
      const schemes = profile.security?.allowedUriSchemes ?? ['https'];
      if (!schemes.includes(uri.scheme) || ['javascript', 'command', 'data'].includes(uri.scheme)) throw new Error(localize('URI scheme {scheme} is not allowed.', { scheme: uri.scheme }));
      const domains = profile.security?.allowedDomains;
      if (domains?.length && !domains.includes(uri.authority)) throw new Error(localize('Domain {domain} is not allowed.', { domain: uri.authority }));
      await vscode.env.openExternal(uri); return;
    }
    if ((citation.kind === 'file' || citation.kind === 'symbol' || citation.kind === 'artifact') && citation.path) {
      const folder = vscode.workspace.getWorkspaceFolder(profileUri);
      if (!folder) throw new Error(localize('The profile is not inside a workspace folder.'));
      if (!isSafeWorkspaceRelativePath(citation.path)) throw new Error(localize('Files outside the workspace are not allowed.'));
      const uri = vscode.Uri.joinPath(folder.uri, citation.path);
      if (!isUriWithin(folder.uri, uri)) throw new Error(localize('Files outside the workspace are not allowed.'));
      const document = await vscode.workspace.openTextDocument(uri);
      const range = citationRange(citation.range);
      if (range) await vscode.window.showTextDocument(document, { selection: range });
      else await vscode.window.showTextDocument(document);
    }
  }
}

export function isSafeWorkspaceRelativePath(value: string): boolean {
  if (!value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  return value.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function isUriWithin(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) return false;
  const rootPath = root.path.replace(/\/+$/u, '');
  return candidate.path === rootPath || candidate.path.startsWith(`${rootPath}/`);
}

function citationRange(value: unknown): vscode.Range | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = citationPosition(record.start ?? record);
  const end = citationPosition(record.end) ?? start;
  return start && end ? new vscode.Range(start, end) : undefined;
}

function citationPosition(value: unknown): vscode.Position | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const line = typeof record.line === 'number' ? record.line : typeof record.startLine === 'number' ? record.startLine : undefined;
  const character = typeof record.character === 'number' ? record.character : typeof record.column === 'number' ? record.column : typeof record.startColumn === 'number' ? record.startColumn : 0;
  if (!Number.isInteger(line) || !Number.isInteger(character) || Number(line) < 0 || Number(character) < 0) return undefined;
  return new vscode.Position(Number(line), Number(character));
}
