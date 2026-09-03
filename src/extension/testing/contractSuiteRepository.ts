import * as vscode from 'vscode';
import type { ContractSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { isExternalAdversarialSuiteReference } from './externalAdversarialSuiteReference';
import { isSafeContractSuitePath } from './contractSuite';
import { parseContractSource } from './contractSource';

export const MAX_CONTRACT_SUITE_BYTES = 5 * 1024 * 1024;
export interface LoadedContractSuite { uri: vscode.Uri; path: string; suite: ContractSuiteDefinition; scenarios: ScenarioDefinition[] }

export async function loadContractSuite(profileUri: vscode.Uri, path: string, resolveExternal?: (reference: string) => vscode.Uri | undefined): Promise<LoadedContractSuite> {
  if (!isSafeContractSuitePath(path)) throw new Error(`Test suite path is not a safe workspace-relative .tests.jsonc, .tests.json, or CSV path: ${path}`);
  const external: boolean = isExternalAdversarialSuiteReference(path);
  const folder = external ? undefined : vscode.workspace.getWorkspaceFolder(profileUri);
  if (!external && !folder) throw new Error(`Test suite ${path} cannot be resolved because the profile is not inside a workspace folder.`);
  const uri = external ? resolveExternal?.(path) : vscode.Uri.joinPath(folder!.uri, ...path.split('/'));
  if (!uri) throw new Error('External test suite access is not authorized on this machine. Link the file again from the Profile editor.');
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${path} exceeds the 5 MB limit.`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_CONTRACT_SUITE_BYTES) throw new Error(`Test suite ${path} exceeds the 5 MB limit.`);
  const parsed = parseContractSource(external ? uri.path : path, new TextDecoder().decode(bytes));
  if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.join('\n') || `Test suite ${path} is empty.`);
  return { uri, path, suite: parsed.suite, scenarios: parsed.scenarios };
}
