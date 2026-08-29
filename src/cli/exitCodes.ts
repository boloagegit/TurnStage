import type { CliResultRecord } from './contracts';

export const CLI_EXIT_CODES = {
  success: 0,
  assertionFailure: 1,
  indeterminate: 2,
  infrastructure: 3,
} as const;

export type CliExitCode = typeof CLI_EXIT_CODES[keyof typeof CLI_EXIT_CODES];
export type CliOutcomeClass = 'pass' | 'assertion' | 'indeterminate' | 'infrastructure';

export interface CliOutcomeCounts {
  total: number;
  passed: number;
  resisted: number;
  assertionFailed: number;
  regression: number;
  attackSucceeded: number;
  indeterminate: number;
  configuration: number;
  policy: number;
  infrastructureError: number;
  unknown: number;
}

export interface CliExitAggregation {
  exitCode: CliExitCode;
  counts: CliOutcomeCounts;
  classes: Record<CliOutcomeClass, number>;
}

/**
 * Aggregate already-evaluated runtime outcomes. This adapter intentionally
 * does not decide whether a scenario resisted an attack or passed an assertion.
 * It only maps the shared runtime's terminal labels to process exit classes.
 * Infrastructure has highest precedence, followed by indeterminate/policy,
 * then assertion/regression/attack, and finally all-pass.
 */
export function aggregateExitCode(records: readonly (CliResultRecord | string)[]): CliExitAggregation {
  const counts: CliOutcomeCounts = {
    total: 0,
    passed: 0,
    resisted: 0,
    assertionFailed: 0,
    regression: 0,
    attackSucceeded: 0,
    indeterminate: 0,
    configuration: 0,
    policy: 0,
    infrastructureError: 0,
    unknown: 0,
  };
  const classes: Record<CliOutcomeClass, number> = { pass: 0, assertion: 0, indeterminate: 0, infrastructure: 0 };
  for (const record of records) {
    counts.total += 1;
    const classification = classifyCliOutcome(record);
    if (classification.label === 'passed') counts.passed += 1;
    else if (classification.label === 'resisted') counts.resisted += 1;
    else if (classification.label === 'assertionFailed') counts.assertionFailed += 1;
    else if (classification.label === 'regression') counts.regression += 1;
    else if (classification.label === 'attackSucceeded') counts.attackSucceeded += 1;
    else if (classification.label === 'indeterminate') counts.indeterminate += 1;
    else if (classification.label === 'configuration') counts.configuration += 1;
    else if (classification.label === 'policy') counts.policy += 1;
    else if (classification.label === 'infrastructureError') counts.infrastructureError += 1;
    else counts.unknown += 1;
    classes[classification.class] += 1;
  }

  let exitCode: CliExitCode = CLI_EXIT_CODES.success;
  if (!records.length || classes.infrastructure > 0) exitCode = !records.length ? CLI_EXIT_CODES.indeterminate : CLI_EXIT_CODES.infrastructure;
  else if (classes.indeterminate > 0) exitCode = CLI_EXIT_CODES.indeterminate;
  else if (classes.assertion > 0) exitCode = CLI_EXIT_CODES.assertionFailure;
  return { exitCode, counts, classes };
}

export const aggregateCliExitCode = aggregateExitCode;

export interface ClassifiedCliOutcome {
  class: CliOutcomeClass;
  label: keyof Omit<CliOutcomeCounts, 'total'>;
}

export function classifyCliOutcome(value: CliResultRecord | string): ClassifiedCliOutcome {
  const raw = typeof value === 'string'
    ? value
    : value.outcome ?? value.status ?? ((value as { passed?: unknown }).passed === true ? 'passed' : undefined);
  const compatibilityFailure = typeof value !== 'string' && value.outcome === undefined && value.status === undefined && value.passed === false;
  if (compatibilityFailure) return { class: 'assertion', label: 'assertionFailed' };
  const normalized = normalizeOutcome(raw);
  switch (normalized) {
    case 'passed': return { class: 'pass', label: 'passed' };
    case 'resisted': return { class: 'pass', label: 'resisted' };
    case 'assertion': return { class: 'assertion', label: 'assertionFailed' };
    case 'regression': return { class: 'assertion', label: 'regression' };
    case 'attackSucceeded': return { class: 'assertion', label: 'attackSucceeded' };
    case 'indeterminate': return { class: 'indeterminate', label: 'indeterminate' };
    case 'configuration': return { class: 'indeterminate', label: 'configuration' };
    case 'policy': return { class: 'indeterminate', label: 'policy' };
    case 'infrastructure': return { class: 'infrastructure', label: 'infrastructureError' };
    default: return { class: 'indeterminate', label: 'unknown' };
  }
}

type NormalizedOutcome = 'passed' | 'resisted' | 'assertion' | 'regression' | 'attackSucceeded' | 'indeterminate' | 'configuration' | 'policy' | 'infrastructure' | 'unknown';

function normalizeOutcome(value: unknown): NormalizedOutcome {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().replace(/[\s_-]+/g, '').toLowerCase();
  if (normalized === 'passed' || normalized === 'pass' || normalized === 'success') return 'passed';
  if (normalized === 'resisted') return 'resisted';
  if (normalized === 'assertion' || normalized === 'assertionfailed' || normalized === 'failed' || normalized === 'failure') return 'assertion';
  if (normalized === 'regression' || normalized === 'regressed') return 'regression';
  if (normalized === 'attacksucceeded' || normalized === 'attack') return 'attackSucceeded';
  if (normalized === 'indeterminate' || normalized === 'inconclusive' || normalized === 'incomplete') return 'indeterminate';
  if (normalized === 'configuration' || normalized === 'configurationerror' || normalized === 'config' || normalized === 'malformed') return 'configuration';
  if (normalized === 'policy' || normalized === 'policyblocked' || normalized === 'blocked' || normalized === 'skipped' || normalized === 'notselected') return 'policy';
  if (normalized === 'infrastructure' || normalized === 'infrastructureerror' || normalized === 'infra' || normalized === 'error' || normalized === 'timeout') return 'infrastructure';
  return 'unknown';
}
