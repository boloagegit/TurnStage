import * as vscode from 'vscode';
import type { Citation, TurnStageProfile } from '../../shared/types';
import { errors } from '../errors';
import { localize } from '../l10n';

export class SecretService {
  private readonly indexKey = 'turnstage.secretNames';
  constructor(private readonly context: vscode.ExtensionContext) {}
  async set(name: string, value: string): Promise<void> { await this.context.secrets.store(`turnstage.${name}`, value); await this.setIndex([...new Set([...this.names(), name])]); }
  async get(name: string): Promise<string | undefined> { return this.context.secrets.get(`turnstage.${name}`); }
  async remove(name: string): Promise<void> { await this.context.secrets.delete(`turnstage.${name}`); await this.setIndex(this.names().filter((item) => item !== name)); }
  names(): string[] { return this.context.globalState.get<string[]>(this.indexKey, []); }
  private async setIndex(names: string[]): Promise<void> { await this.context.globalState.update(this.indexKey, names.sort()); }
}

const sensitiveHeaders = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);
export const SECRET_REDACTION = '••••••••';
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitiveHeaders.has(key.toLowerCase()) ? redactValue(value) : value]));
}
function redactValue(value: string): string { const prefix = value.match(/^\S+\s+/)?.[0] ?? ''; return `${prefix}${SECRET_REDACTION}`; }
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sensitiveHeaders.has(key.toLowerCase()) || /secret|token|password/i.test(key) ? SECRET_REDACTION : redactDeep(child)]));
}

export function redactKnownSecrets(value: unknown, secrets: readonly unknown[]): unknown {
  if (value === undefined || value === null || !secrets.length) return value;
  if (typeof value === 'string') {
    return secrets.reduce<string>((result, secret) => {
      if (typeof secret !== 'string' || !secret.length) return result;
      return result.split(secret).join(SECRET_REDACTION);
    }, value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return secrets.some((secret) => Object.is(secret, value)) ? SECRET_REDACTION : value;
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, secrets));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactKnownSecrets(item, secrets)]));
  return value;
}

export class UriPolicy {
  async open(citation: Citation, profile: TurnStageProfile, profileUri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw errors.trust();
    if (citation.kind === 'url' && citation.uri) {
      const uri = vscode.Uri.parse(citation.uri, true);
      const schemes = profile.security?.allowedUriSchemes ?? ['https'];
      if (!schemes.includes(uri.scheme) || ['javascript', 'command', 'data'].includes(uri.scheme)) throw new Error(localize('URI scheme {scheme} is not allowed.', { scheme: uri.scheme }));
      const domains = profile.security?.allowedDomains;
      if (domains?.length && !domains.includes(uri.authority)) throw new Error(localize('Domain {domain} is not allowed.', { domain: uri.authority }));
      await vscode.env.openExternal(uri); return;
    }
    if ((citation.kind === 'file' || citation.kind === 'symbol') && citation.path) {
      const folder = vscode.workspace.getWorkspaceFolder(profileUri);
      if (!folder) throw new Error(localize('The profile is not inside a workspace folder.'));
      const uri = vscode.Uri.joinPath(folder.uri, citation.path);
      const relative = vscode.workspace.asRelativePath(uri, false);
      if (relative.startsWith('..')) throw new Error(localize('Files outside the workspace are not allowed.'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    }
  }
}
