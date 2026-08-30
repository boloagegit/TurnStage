import type {
  ChatMessage,
  NetworkExchange,
  ScenarioAssertionDefinition,
  ScenarioCheckResult,
  ScenarioEvidenceLocation,
  SessionSnapshot,
} from '../../shared/types';
import { isSafeRegexPattern } from '../../shared/regexSafety';
import { localize } from '../l10n';

const MAX_PATH_SEGMENTS = 24;
const terminalTurnStates = new Set(['completed', 'failed', 'aborted']);
const terminalMessageStates = new Set(['completed', 'failed', 'aborted']);
const assertionRoots = new Set(['session', 'turn', 'conversation', 'assistant', 'messages', 'events', 'metrics', 'errors', 'controls', 'network']);

export interface AssertionEvidence {
  snapshot: SessionSnapshot;
  networkEntries: NetworkExchange[];
}

/**
 * Evaluates bounded JSON-like values only. Assertions intentionally cannot
 * call functions, import modules, or execute JavaScript from a profile.
 */
export function evaluateAssertions(assertions: readonly ScenarioAssertionDefinition[] = [], evidence: AssertionEvidence): ScenarioCheckResult[] {
  const context = assertionContext(evidence);
  return assertions.map((assertion, index) => {
    const actual = resolveAssertionPath(context, assertion.path);
    const passed = evaluateOperator(assertion.operator, actual, assertion.value);
    return {
      id: assertion.id?.trim() || `assertion-${index + 1}`,
      label: assertion.message?.trim() || assertionLabel(assertion),
      passed,
      kind: 'assertion',
      actual: boundedEvidence(actual),
      expected: boundedEvidence(assertion.value),
      location: inferEvidenceLocation(assertion.path, evidence),
    };
  });
}

/** Structural checks that must hold whenever a send promise has settled. */
export function evaluateSessionInvariants(evidence: AssertionEvidence): ScenarioCheckResult[] {
  const { snapshot } = evidence;
  const activeMessages = snapshot.messages.filter((message) => message.status === 'pending' || message.status === 'streaming');
  const latestAssistant = [...snapshot.messages].reverse().find((message) => message.role === 'assistant');
  const runningParts = snapshot.messages.flatMap((message) => message.parts.filter((part) => (part.type === 'progress' || part.type === 'tool-call') && ['pending', 'running'].includes(String(part.status))));
  const metricsValid = Object.values(snapshot.metrics).every((value) => typeof value !== 'number' || (Number.isFinite(value) && value >= 0));
  const turnTerminal = terminalTurnStates.has(snapshot.turnState);
  const assistantStateMatches = !latestAssistant || !turnTerminal || latestAssistant.status === snapshot.turnState;
  const assistantHasCompletedAt = !latestAssistant || !terminalMessageStates.has(latestAssistant.status) || typeof latestAssistant.completedAt === 'number';
  const eventCountCoversBuffer = snapshot.metrics.eventCount >= snapshot.rawEvents.length;

  return [
    invariant('invariant.turn-terminal', localize('Turn released all active-state locks'), turnTerminal, snapshot.turnState, [...terminalTurnStates], { kind: 'message', messageId: latestAssistant?.id }),
    invariant('invariant.messages-terminal', localize('No message remains pending or streaming'), activeMessages.length === 0, activeMessages.map((message) => ({ id: message.id, status: message.status })), [], { kind: 'message', messageId: activeMessages[0]?.id }),
    invariant('invariant.assistant-state', localize('Assistant message matches the terminal turn state'), assistantStateMatches, latestAssistant?.status, snapshot.turnState, { kind: 'message', messageId: latestAssistant?.id }),
    invariant('invariant.assistant-completed-at', localize('Terminal assistant message has a completion time'), assistantHasCompletedAt, latestAssistant?.completedAt, 'number', { kind: 'message', messageId: latestAssistant?.id }),
    invariant('invariant.parts-terminal', localize('Progress and tool parts have no active state'), runningParts.length === 0, runningParts, [], { kind: 'message', messageId: latestAssistant?.id }),
    invariant('invariant.metrics-bounded', localize('Runtime metrics are finite and non-negative'), metricsValid, snapshot.metrics, 'finite non-negative values', { kind: 'profile', path: 'metrics' }),
    invariant('invariant.event-count', localize('Event count covers the retained raw-event buffer'), eventCountCoversBuffer, snapshot.metrics.eventCount, `>= ${snapshot.rawEvents.length}`, { kind: 'rawEvent', sequence: snapshot.rawEvents.at(-1)?.sequence }),
  ];
}

export function resolveAssertionPath(root: unknown, path: string): unknown {
  const segments = parsePath(path);
  let values: unknown[] = [root];
  let wildcard = false;
  for (const segment of segments) {
    if (segment === '*') {
      wildcard = true;
      values = values.flatMap((value) => Array.isArray(value) ? value : []);
      continue;
    }
    values = values.map((value) => {
      if (Array.isArray(value) && typeof segment === 'number') return value[segment];
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof segment === 'string') return (value as Record<string, unknown>)[segment];
      return undefined;
    });
  }
  return wildcard ? values : values[0];
}

export function isSafeAssertionRegex(pattern: unknown): boolean {
  return isSafeRegexPattern(pattern);
}

export function isValidAssertionPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const segments = parsePath(path);
  return segments.length > 0 && typeof segments[0] === 'string' && assertionRoots.has(segments[0]);
}

function assertionContext(evidence: AssertionEvidence): Record<string, unknown> {
  const { snapshot, networkEntries } = evidence;
  const assistant = [...snapshot.messages].reverse().find((message) => message.role === 'assistant');
  return {
    session: { state: snapshot.sessionState, id: snapshot.sessionId, title: snapshot.title },
    turn: { state: snapshot.turnState },
    conversation: { id: snapshot.conversationId },
    assistant: assistant ? { ...assistant, text: messageText(assistant) } : undefined,
    messages: snapshot.messages,
    events: { raw: snapshot.rawEvents, normalized: snapshot.normalizedEvents },
    metrics: snapshot.metrics,
    errors: snapshot.errors,
    controls: snapshot.controls,
    network: networkEntries,
  };
}

function parsePath(path: string): Array<string | number | '*'> {
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

function evaluateOperator(operator: ScenarioAssertionDefinition['operator'], actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'equals': return jsonEqual(actual, expected);
    case 'notEquals': return !jsonEqual(actual, expected);
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'contains': return contains(actual, expected);
    case 'regex': return isSafeAssertionRegex(expected) && new RegExp(String(expected), 'u').test((typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '').slice(0, 4096));
    case 'oneOf': return Array.isArray(expected) && expected.some((item) => jsonEqual(actual, item));
    case 'lessThan': return numericCompare(actual, expected, (left, right) => left < right);
    case 'lessThanOrEqual': return numericCompare(actual, expected, (left, right) => left <= right);
    case 'greaterThan': return numericCompare(actual, expected, (left, right) => left > right);
    case 'greaterThanOrEqual': return numericCompare(actual, expected, (left, right) => left >= right);
    case 'sequenceEquals': return Array.isArray(actual) && Array.isArray(expected) && jsonEqual(actual, expected);
    case 'sequenceContains': return Array.isArray(actual) && Array.isArray(expected) && isOrderedSubsequence(actual, expected);
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected ?? ''));
  if (Array.isArray(actual)) return actual.some((item) => jsonEqual(item, expected));
  if (actual && typeof actual === 'object' && typeof expected === 'string') return Object.prototype.hasOwnProperty.call(actual, expected);
  return false;
}

function isOrderedSubsequence(actual: unknown[], expected: unknown[]): boolean {
  let expectedIndex = 0;
  for (const value of actual) if (expectedIndex < expected.length && jsonEqual(value, expected[expectedIndex])) expectedIndex += 1;
  return expectedIndex === expected.length;
}

function numericCompare(actual: unknown, expected: unknown, compare: (left: number, right: number) => boolean): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && typeof expected === 'number' && Number.isFinite(expected) && compare(actual, expected);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(rightRecord, key) && jsonEqual(value, rightRecord[key]));
}

function inferEvidenceLocation(path: string, evidence: AssertionEvidence): ScenarioEvidenceLocation {
  if (path.startsWith('network')) return { kind: 'network', networkId: evidence.networkEntries.at(-1)?.id };
  if (path.startsWith('events.raw')) return { kind: 'rawEvent', sequence: evidence.snapshot.rawEvents.at(-1)?.sequence };
  if (path.startsWith('events.normalized')) { const event = evidence.snapshot.normalizedEvents.at(-1); return { kind: 'normalizedEvent', sequence: event?.sequence, rawSequence: event?.rawSequence }; }
  if (path.startsWith('assistant') || path.startsWith('messages')) return { kind: 'message', messageId: [...evidence.snapshot.messages].reverse().find((message) => message.role === 'assistant')?.id };
  return { kind: 'profile', path };
}

function invariant(id: string, label: string, passed: boolean, actual: unknown, expected: unknown, location: ScenarioEvidenceLocation): ScenarioCheckResult {
  return { id, label, passed, kind: 'invariant', actual: boundedEvidence(actual), expected: boundedEvidence(expected), location };
}

function messageText(message: ChatMessage): string {
  return message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text ?? '').join('');
}

function assertionLabel(assertion: ScenarioAssertionDefinition): string {
  if (assertion.operator === 'exists' || assertion.operator === 'notExists') return `${assertion.path} ${assertion.operator}`;
  return `${assertion.path} ${assertion.operator} ${compact(assertion.value)}`;
}

function compact(value: unknown): string {
  const rendered = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  return (rendered ?? String(value)).slice(0, 160);
}

function boundedEvidence(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 4_096);
  if (Array.isArray(value)) return value.slice(0, 100).map(boundedEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, child]) => [key, boundedEvidence(child)]));
}
