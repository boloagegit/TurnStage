import type * as vscode from 'vscode';
import type { AdversarialCaseCatalog, LinkedAdversarialCaseSummary } from '../../shared/protocol';
import type { ScenarioDefinition, TurnStageProfile } from '../../shared/types';
import { loadAdversarialSuite } from './adversarialSuiteRepository';

/**
 * Load only enough linked-suite metadata to fill the Webview catalog. Prompts,
 * assertions, and rule values never cross into the Webview catalog payload.
 */
export async function loadLinkedAdversarialCaseCatalog(
  profileUri: vscode.Uri,
  profile: TurnStageProfile,
  resolveExternal?: (reference: string) => vscode.Uri | undefined,
): Promise<AdversarialCaseCatalog> {
  const entries: LinkedAdversarialCaseSummary[] = [];
  const issues: AdversarialCaseCatalog['issues'] = [];
  let total = 0;
  for (const sourcePath of profile.tests?.adversarialSuites ?? []) {
    try {
      const loaded = await loadAdversarialSuite(profileUri, sourcePath, resolveExternal);
      total += loaded.scenarios.length;
      entries.push(...loaded.scenarios.map((scenario) => ({ ...summarizeLinkedCase(sourcePath, loaded.suite.id, loaded.suite.name, scenario), revision: loaded.revision })));
    } catch (error) {
      issues.push({ sourcePath, message: boundedMessage(error) });
    }
  }

  return { entries, total, truncated: false, issues };
}

function summarizeLinkedCase(sourcePath: string, suiteId: string, suiteName: string, scenario: ScenarioDefinition): LinkedAdversarialCaseSummary {
  const adversarial = scenario.adversarial!;
  const prohibit = adversarial.forbid;
  return {
    sourcePath,
    suiteId,
    suiteName,
    scenarioId: scenario.id,
    scenarioName: scenario.name || scenario.id,
    tags: (scenario.tags ?? []).slice(0, 100),
    capture: scenario.capture ? structuredClone(scenario.capture) : undefined,
    mode: adversarial.mode ?? (scenario.steps.length > 1 ? 'multiTurn' : 'singleTurn'),
    turns: scenario.steps.length,
    maxTurns: adversarial.maxTurns ?? Math.max(1, scenario.steps.length),
    repetitions: adversarial.repetitions ?? 1,
    timeoutMs: adversarial.timeoutMs ?? 60_000,
    prohibit: {
      content: prohibit.content?.length ?? 0,
      events: prohibit.events?.length ?? 0,
      urls: Boolean(prohibit.urls),
      ctas: Boolean(prohibit.ctas),
      tools: Boolean(prohibit.tools),
    },
  };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message, (character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 ? ' ' : character; }).join('').slice(0, 4096);
}
