import * as vscode from 'vscode';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';

const STORAGE_KEY = 'turnstage.externalAdversarialSuites.v1';
const MAX_GRANTS = 100;

interface ExternalSuiteGrant {
  version: 1;
  reference: string;
  profileUri: string;
  uri: string;
  createdAt: number;
}

export class ExternalAdversarialSuiteRepository {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async grant(profileUri: vscode.Uri, suiteUri: vscode.Uri): Promise<string> {
    const grants = this.read();
    const profile = profileUri.toString();
    const uri = suiteUri.toString();
    const existing = grants.find((grant) => grant.profileUri === profile && grant.uri === uri);
    if (existing) return existing.reference;
    const fileName = suiteUri.path.split('/').filter(Boolean).at(-1) ?? 'suite.csv';
    const reference = `external:${crypto.randomUUID()}:${encodeURIComponent(fileName).slice(0, 180)}`;
    const next: ExternalSuiteGrant[] = [{ version: 1 as const, reference, profileUri: profile, uri, createdAt: Date.now() }, ...grants].slice(0, MAX_GRANTS);
    await this.context.workspaceState.update(STORAGE_KEY, next);
    return reference;
  }

  resolve(profileUri: vscode.Uri, reference: string): vscode.Uri | undefined {
    if (!isExternalAdversarialSuiteReference(reference)) return undefined;
    const grant = this.read().find((candidate) => candidate.reference === reference && candidate.profileUri === profileUri.toString());
    if (!grant) return undefined;
    try { return vscode.Uri.parse(grant.uri, true); } catch { return undefined; }
  }

  private read(): ExternalSuiteGrant[] {
    const stored = this.context.workspaceState.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is ExternalSuiteGrant => {
      if (!item || typeof item !== 'object') return false;
      const grant = item as Partial<ExternalSuiteGrant>;
      return grant.version === 1 && isExternalAdversarialSuiteReference(grant.reference) && typeof grant.profileUri === 'string' && grant.profileUri.length <= 4096 && typeof grant.uri === 'string' && grant.uri.length <= 4096 && typeof grant.createdAt === 'number' && Number.isFinite(grant.createdAt);
    }).slice(0, MAX_GRANTS);
  }
}

export { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';
