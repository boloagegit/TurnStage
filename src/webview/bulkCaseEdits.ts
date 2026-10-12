import { createContext } from 'react';
import type { AdversarialCaseCatalog, ContractCaseCatalog } from '../shared/protocol';
import type { TestCaseIdentity } from '../shared/testSelection';
import type { ScenarioAssertionDefinition, ScenarioDefinition, TurnStageProfile } from '../shared/types';
import { hasAssertion } from './eventCheck';

/** The most tags a case keeps; matches the catalogs, which show at most this many. */
export const MAX_CASE_TAGS = 20;

export type CaseEdit =
  | { type: 'tag'; tag: string }
  | { type: 'delete' }
  | { type: 'markReady' }
  | { type: 'addCheck'; assertion: ScenarioAssertionDefinition };

export function captureNeedsReview(capture: ScenarioDefinition['capture'], tags: readonly string[] = []): boolean {
  return capture?.status === 'needsReview' || tags.includes('needs-review');
}

export function markCaptureReady(scenario: ScenarioDefinition): ScenarioDefinition {
  return {
    ...scenario,
    tags: (scenario.tags ?? []).filter((tag) => tag !== 'needs-review'),
    ...(scenario.capture ? { capture: { ...scenario.capture, status: 'ready' } } : {}),
  };
}

/** The edited case, `'delete'`, or `undefined` when the edit would not change it. */
export function applyCaseEdit(scenario: ScenarioDefinition, edit: CaseEdit): ScenarioDefinition | 'delete' | undefined {
  if (edit.type === 'delete') return 'delete';
  if (edit.type === 'markReady') return captureNeedsReview(scenario.capture, scenario.tags) ? markCaptureReady(scenario) : undefined;
  if (edit.type === 'addCheck') return hasAssertion(scenario.assertions, edit.assertion) ? undefined : { ...scenario, assertions: [...(scenario.assertions ?? []), edit.assertion] };
  const tag = edit.tag.trim();
  const tags = scenario.tags ?? [];
  if (!tag || tags.includes(tag) || tags.length >= MAX_CASE_TAGS) return undefined;
  return { ...scenario, tags: [...tags, tag] };
}

export interface LinkedCaseJob { kind: 'contract' | 'adversarial'; sourcePath: string; scenarioId: string; identity: TestCaseIdentity }

export interface CaseEditPlan {
  /** Replacement for `tests.scenarios` when a case stored in the Profile changes. */
  inlineScenarios?: ScenarioDefinition[];
  inlineChanged: TestCaseIdentity[];
  inlineUnchanged: number;
  /** Linked cases are edited one at a time: load, apply, save against the loaded revision. */
  jobs: LinkedCaseJob[];
  /** Selected cases that no longer exist in the Profile or the linked catalog. */
  missing: number;
}

/** Splits an edit of the selected cases into one Profile patch plus one job per linked case. */
export function planCaseEdits(profile: TurnStageProfile, identities: readonly TestCaseIdentity[], edit: CaseEdit, catalogs: { contract?: ContractCaseCatalog; adversarial?: AdversarialCaseCatalog }): CaseEditPlan {
  const scenarios = profile.tests?.scenarios ?? [];
  const inlineIds = new Map(identities.filter((item) => !item.suiteId).map((item) => [`${item.kind}:${item.scenarioId}`, item]));
  const inlineChanged: TestCaseIdentity[] = [];
  let inlineUnchanged = 0;
  const next: ScenarioDefinition[] = [];
  for (const scenario of scenarios) {
    const identity = inlineIds.get(`${scenario.adversarial ? 'adversarial' : 'contract'}:${scenario.id}`);
    if (!identity) { next.push(scenario); continue; }
    inlineIds.delete(`${identity.kind}:${identity.scenarioId}`);
    const result = applyCaseEdit(scenario, edit);
    if (result === undefined) { inlineUnchanged += 1; next.push(scenario); continue; }
    inlineChanged.push(identity);
    if (result !== 'delete') next.push(result);
  }
  const jobs: LinkedCaseJob[] = [];
  let missing = inlineIds.size;
  for (const identity of identities) {
    if (!identity.suiteId) continue;
    const entries: ReadonlyArray<{ sourcePath: string; suiteId: string; scenarioId: string }> = identity.kind === 'adversarial' ? catalogs.adversarial?.entries ?? [] : catalogs.contract?.entries ?? [];
    const entry = entries.find((item) => item.suiteId === identity.suiteId && item.scenarioId === identity.scenarioId);
    if (entry) jobs.push({ kind: identity.kind, sourcePath: entry.sourcePath, scenarioId: entry.scenarioId, identity });
    else missing += 1;
  }
  return { ...(inlineChanged.length ? { inlineScenarios: next } : {}), inlineChanged, inlineUnchanged, jobs, missing };
}

/** Marks reviewed capture drafts ready from the case lists; absent when the Profile cannot be edited. */
export const MarkCasesReadyContext = createContext<((identities: TestCaseIdentity[]) => void) | undefined>(undefined);
