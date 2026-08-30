import * as vscode from 'vscode';
import type { AdversarialSuiteDefinition, ScenarioDefinition } from '../../shared/types';
import { isSafeAdversarialSuitePath, normalizeAdversarialSuite, parseAdversarialSuite } from './adversarialSuite';

const MAX_SUITE_BYTES = 5 * 1024 * 1024;

export interface LoadedAdversarialSuite {
  uri: vscode.Uri;
  path: string;
  suite: AdversarialSuiteDefinition;
  scenarios: ScenarioDefinition[];
}

export async function loadAdversarialSuite(profileUri: vscode.Uri, path: string): Promise<LoadedAdversarialSuite> {
  if (!isSafeAdversarialSuitePath(path)) throw new Error(`Adversarial suite path is not a safe workspace-relative JSONC path: ${path}`);
  const folder = vscode.workspace.getWorkspaceFolder(profileUri);
  if (!folder) throw new Error(`Adversarial suite ${path} cannot be resolved because the profile is not inside a workspace folder.`);
  const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_SUITE_BYTES) throw new Error(`Adversarial suite ${path} exceeds the 5 MB limit.`);
  const parsed = parseAdversarialSuite(new TextDecoder().decode(bytes));
  if (parsed.parseErrors.length) throw new Error(`Adversarial suite ${path} is not valid JSONC.`);
  if (!parsed.suite) throw new Error(`Adversarial suite ${path} is empty.`);
  if (parsed.issues.length) throw new Error(parsed.issues.map((issue) => `${path}:${issue.path}: ${issue.message}`).join('\n'));
  return { uri, path, suite: parsed.suite, scenarios: normalizeAdversarialSuite(parsed.suite) };
}
