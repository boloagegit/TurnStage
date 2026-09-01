import type {
  ScenarioCheckResult,
  ScenarioComparisonDefinition,
  ScenarioEvidenceLocation,
  ScenarioRunEvidence,
} from '../../shared/types';
import { localize } from '../l10n';

const MAX_PATH_SEGMENTS = 24;
const MAX_DIFFERENCES = 100;
const DEFAULT_IGNORE_PATHS = [
  'messages[*].id',
  'messages[*].createdAt',
  'messages[*].completedAt',
  'messages[*].timing',
  'messages[*].metadata.clientRequestId',
  'messages[*].citations[*].id',
  'messages[*].actions[*].id',
  'messages[*].followups[*].id',
  'events.normalized[*].sequence',
  'events.normalized[*].receivedAt',
  'events.normalized[*].rawSequence',
  'events.normalized[*].turnId',
];
const comparisonRoots = new Set(['session', 'messages', 'events', 'errors', 'network']);

export interface ScenarioDifference {
  path: string;
  baseline?: unknown;
  candidate?: unknown;
}

export interface ScenarioComparisonEvaluation {
  checks: ScenarioCheckResult[];
  differenceCount: number;
  differencePaths: string[];
}

export function compareScenarioEvidence(
  baseline: ScenarioRunEvidence,
  candidate: ScenarioRunEvidence,
  definition: ScenarioComparisonDefinition,
): ScenarioComparisonEvaluation {
  const baselineValue = semanticSnapshot(baseline);
  const candidateValue = semanticSnapshot(candidate);
  for (const path of [...DEFAULT_IGNORE_PATHS, ...(definition.ignorePaths ?? [])]) {
    const segments = parseComparisonPath(path);
    if (!segments.length) continue;
    removePath(baselineValue, segments);
    removePath(candidateValue, segments);
  }
  const differences: ScenarioDifference[] = [];
  collectDifferences(baselineValue, candidateValue, '', differences);
  if (!differences.length) {
    return {
      differenceCount: 0,
      differencePaths: [],
      checks: [{
        id: 'comparison.semantic-equivalence',
        label: localize('Candidate matches the baseline after ignored dynamic fields'),
        passed: true,
        kind: 'comparison',
        actual: 'equivalent',
        expected: 'equivalent',
        location: { kind: 'profile', path: 'tests' },
      }],
    };
  }
  return {
    differenceCount: differences.length,
    differencePaths: differences.map((difference) => difference.path || '$'),
    checks: differences.slice(0, MAX_DIFFERENCES).map((difference, index) => ({
      id: `comparison.difference-${index + 1}`,
      label: localize('Candidate differs from baseline at {path}', { path: difference.path || '$' }),
      passed: false,
      kind: 'comparison',
      actual: bounded(difference.candidate),
      expected: bounded(difference.baseline),
      location: inferLocation(difference.path, candidate),
    })),
  };
}

export function isValidComparisonPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const segments = parseComparisonPath(path);
  return segments.length > 0
    && typeof segments[0] === 'string'
    && comparisonRoots.has(segments[0])
    && !segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor');
}

function semanticSnapshot(evidence: ScenarioRunEvidence): Record<string, unknown> {
  return structuredClone({
    session: {
      state: evidence.snapshot.sessionState,
      turnState: evidence.snapshot.turnState,
      title: evidence.snapshot.title,
      opening: evidence.snapshot.opening,
    },
    messages: evidence.snapshot.messages,
    events: { normalized: evidence.snapshot.normalizedEvents },
    errors: evidence.snapshot.errors,
    network: evidence.networkEntries.map((entry) => ({
      kind: entry.kind,
      attempt: entry.attempt,
      method: entry.method,
      variantId: entry.variantId,
      protocol: entry.protocol,
      state: entry.state,
      status: entry.status,
      eventCount: entry.eventCount,
    })),
  });
}

function parseComparisonPath(path: string): Array<string | number | '*'> {
  const input = path.trim().replace(/^\$\.?/, '');
  if (!input || input.length > 512) return [];
  const segments: Array<string | number | '*'> = [];
  let consumed = '';
  const matcher = /(?:^|\.)([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+|\*)\]/g;
  for (const match of input.matchAll(matcher)) {
    if (segments.length >= MAX_PATH_SEGMENTS) return [];
    consumed += match[0];
    const value = match[1] ?? match[2];
    segments.push(value === '*' ? '*' : /^\d+$/.test(value!) ? Number(value) : value!);
  }
  return consumed === input ? segments : [];
}

function removePath(value: unknown, segments: Array<string | number | '*'>, index = 0): void {
  if (!value || typeof value !== 'object' || index >= segments.length) return;
  const segment = segments[index]!;
  if (index === segments.length - 1) {
    if (segment === '*' && Array.isArray(value)) value.length = 0;
    else if (typeof segment === 'number' && Array.isArray(value)) delete value[segment];
    else if (typeof segment === 'string' && !Array.isArray(value)) delete (value as Record<string, unknown>)[segment];
    return;
  }
  if (segment === '*') {
    if (Array.isArray(value)) value.forEach((child) => removePath(child, segments, index + 1));
    return;
  }
  const child = Array.isArray(value) && typeof segment === 'number' ? value[segment] : !Array.isArray(value) && typeof segment === 'string' ? (value as Record<string, unknown>)[segment] : undefined;
  removePath(child, segments, index + 1);
}

function collectDifferences(baseline: unknown, candidate: unknown, path: string, out: ScenarioDifference[]): void {
  if (out.length >= MAX_DIFFERENCES) return;
  if (Object.is(baseline, candidate)) return;
  if (Array.isArray(baseline) || Array.isArray(candidate)) {
    if (!Array.isArray(baseline) || !Array.isArray(candidate)) { out.push({ path, baseline, candidate }); return; }
    const length = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < length && out.length < MAX_DIFFERENCES; index++) collectDifferences(baseline[index], candidate[index], `${path}[${index}]`, out);
    return;
  }
  if (isRecord(baseline) && isRecord(candidate)) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
    for (const key of keys) collectDifferences(baseline[key], candidate[key], path ? `${path}.${key}` : key, out);
    return;
  }
  out.push({ path, baseline, candidate });
}

function inferLocation(path: string, evidence: ScenarioRunEvidence): ScenarioEvidenceLocation {
  const eventIndex = /^events\.normalized\[(\d+)\]/.exec(path)?.[1];
  if (eventIndex !== undefined) {
    const event = evidence.snapshot.normalizedEvents[Number(eventIndex)];
    return { kind: 'normalizedEvent', sequence: event?.sequence, rawSequence: event?.rawSequence };
  }
  const messageIndex = /^messages\[(\d+)\]/.exec(path)?.[1];
  if (messageIndex !== undefined) return { kind: 'message', messageId: evidence.snapshot.messages[Number(messageIndex)]?.id };
  const networkIndex = /^network\[(\d+)\]/.exec(path)?.[1];
  if (networkIndex !== undefined) return { kind: 'network', networkId: evidence.networkEntries[Number(networkIndex)]?.id };
  return { kind: 'profile', path: path || 'tests' };
}

function bounded(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 4_096);
  if (Array.isArray(value)) return value.slice(0, 100).map(bounded);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [key, bounded(child)]));
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
