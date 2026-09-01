import * as vscode from 'vscode';
import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { isSafeAdversarialSuitePath } from './adversarialSuite';
import { parseAdversarialSource } from './adversarialSource';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';

const MAX_SUITE_BYTES = 5 * 1024 * 1024;

export interface LoadedAdversarialSuite {
  uri: vscode.Uri;
  path: string;
  suite: AdversarialSuiteDefinition;
  scenarios: ScenarioDefinition[];
}

export async function loadAdversarialSuite(profileUri: vscode.Uri, path: string, resolveExternal?: (reference: string) => vscode.Uri | undefined): Promise<LoadedAdversarialSuite> {
  if (!isSafeAdversarialSuitePath(path)) throw new Error(`Adversarial suite path is not a safe workspace-relative JSONC or CSV path: ${path}`);
  const external: boolean = isExternalAdversarialSuiteReference(path);
  const folder = external ? undefined : vscode.workspace.getWorkspaceFolder(profileUri);
  if (!external && !folder) throw new Error(`Adversarial suite ${path} cannot be resolved because the profile is not inside a workspace folder.`);
  const uri = external ? resolveExternal?.(path) : vscode.Uri.joinPath(folder!.uri, ...path.split('/'));
  if (!uri) throw new Error('External adversarial suite access is not authorized on this machine. Link the file again from the Profile editor.');
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  const parsed = parseAdversarialSource(external ? uri.path : path, new TextDecoder().decode(bytes));
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Adversarial suite ${path} is empty.`);
  return { uri, path, suite: parsed.suite, scenarios: parsed.scenarios };
}
