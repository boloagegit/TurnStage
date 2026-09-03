import type * as vscode from 'vscode';
import type { ContractCaseCatalog, LinkedContractCaseSummary } from '../../shared/protocol';
import type { ScenarioDefinition, TurnStageProfile } from '../../shared/types';
import { loadContractSuite } from './contractSuiteRepository';

export const MAX_LINKED_CONTRACT_CATALOG_ENTRIES = 100;

/** Load bounded, prompt-free summaries. Full case content is loaded only on selection. */
export async function loadLinkedContractCaseCatalog(profileUri: vscode.Uri, profile: TurnStageProfile, resolveExternal?: (reference: string) => vscode.Uri | undefined): Promise<ContractCaseCatalog> {
  const entries: LinkedContractCaseSummary[] = [];
  const issues: ContractCaseCatalog['issues'] = [];
  let total = 0;
  let truncated = false;
  for (const sourcePath of profile.tests?.contractSuites ?? []) {
    if (entries.length >= MAX_LINKED_CONTRACT_CATALOG_ENTRIES) { truncated = true; break; }
    try {
      const loaded = await loadContractSuite(profileUri, sourcePath, resolveExternal);
      total += loaded.scenarios.length;
      const remaining = MAX_LINKED_CONTRACT_CATALOG_ENTRIES - entries.length;
      entries.push(...loaded.scenarios.slice(0, remaining).map((scenario) => summarize(sourcePath, loaded.suite.id, loaded.suite.name, scenario)));
      if (loaded.scenarios.length > remaining) truncated = true;
    } catch (error) { issues.push({ sourcePath, message: boundedMessage(error) }); }
  }
  return { entries, total, truncated, issues };
}

function summarize(sourcePath: string, suiteId: string, suiteName: string, scenario: ScenarioDefinition): LinkedContractCaseSummary {
  return {
    sourcePath, suiteId, suiteName, scenarioId: scenario.id, scenarioName: scenario.name || scenario.id,
    tags: (scenario.tags ?? []).slice(0, 20), turns: scenario.steps.length,
    assertions: (scenario.assertions?.length ?? 0) + scenario.steps.reduce((sum, step) => sum + (step.assertions?.length ?? 0), 0),
    comparison: Boolean(scenario.comparison), performance: Boolean(scenario.performance), faults: Boolean(scenario.faults),
  };
}
function boundedMessage(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return Array.from(message, (character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 ? ' ' : character; }).join('').slice(0, 4096); }
