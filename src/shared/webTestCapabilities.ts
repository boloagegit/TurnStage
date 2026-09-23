import type { ScenarioDefinition } from './types';

export type WebUnsupportedTestFeature = 'faults' | 'comparison' | 'performanceRegression';

export function webNeedsPerformanceBaseline(scenario: ScenarioDefinition): boolean {
  return Boolean(scenario.performance && (scenario.adversarial || Object.keys(scenario.performance.regression ?? {}).length > 0));
}

/** Keep Web affordances and the browser runner on the same capability decision. */
export function webUnsupportedTestFeature(scenario: ScenarioDefinition): WebUnsupportedTestFeature | undefined {
  if (scenario.faults) return 'faults';
  if (scenario.comparison) return 'comparison';
  if (webNeedsPerformanceBaseline(scenario)) return 'performanceRegression';
  return undefined;
}
