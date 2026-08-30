import type {
  AdversarialFinding,
  AdversarialForbidDefinition,
  AdversarialIssue,
  ChatMessage,
  NetworkExchange,
  NormalizedEvent,
  ScenarioAdversarialDefinition,
  ScenarioEvidenceLocation,
  ScenarioStepDefinition,
  SessionSnapshot,
} from '../../shared/types';
import { localize } from '../l10n';
import { isSafeAssertionRegex } from './assertionEvaluator';

export interface AdversarialTurnBoundary {
  messageIds: Set<string>;
  eventKeys: Set<string>;
  networkIds: Set<string>;
}

export interface AdversarialTurnEvaluation {
  findings: AdversarialFinding[];
  issues: AdversarialIssue[];
  completed: boolean;
}

const urlPattern = /https?:\/\/[^\s<>"')\]]+/giu;

export function captureAdversarialBoundary(snapshot: SessionSnapshot, networkEntries: readonly NetworkExchange[]): AdversarialTurnBoundary {
  return {
    messageIds: new Set(snapshot.messages.map((message) => message.id)),
    eventKeys: new Set(snapshot.normalizedEvents.map(eventKey)),
    networkIds: new Set(networkEntries.map((entry) => entry.id)),
  };
}

export function mergeAdversarialForbid(base: AdversarialForbidDefinition, additional?: AdversarialForbidDefinition): AdversarialForbidDefinition {
  if (!additional) return structuredClone(base);
  return {
    content: uniqueContentRules([...(base.content ?? []), ...(additional.content ?? [])]),
    urls: Boolean(base.urls || additional.urls),
    ctas: Boolean(base.ctas || additional.ctas),
    tools: Boolean(base.tools || additional.tools),
    events: [...new Set([...(base.events ?? []), ...(additional.events ?? [])])],
  };
}

export function evaluateAdversarialTurn(
  definition: ScenarioAdversarialDefinition,
  step: ScenarioStepDefinition,
  turnIndex: number,
  snapshot: SessionSnapshot,
  networkEntries: readonly NetworkExchange[],
  boundary: AdversarialTurnBoundary,
): AdversarialTurnEvaluation {
  const forbid = mergeAdversarialForbid(definition.forbid, step.additionalForbid);
  const messages = snapshot.messages.filter((message) => message.role === 'assistant' && !boundary.messageIds.has(message.id));
  const events = snapshot.normalizedEvents.filter((event) => !boundary.eventKeys.has(eventKey(event)));
  const networks = networkEntries.filter((entry) => !boundary.networkIds.has(entry.id));
  const findings: AdversarialFinding[] = [];
  const issues: AdversarialIssue[] = [];
  const messageLocation = (message?: ChatMessage): ScenarioEvidenceLocation => ({ kind: 'message', messageId: message?.id });
  const networkLocation: ScenarioEvidenceLocation = { kind: 'network', networkId: networks.at(-1)?.id ?? networkEntries.at(-1)?.id };

  for (const [ruleIndex, rawRule] of (forbid.content ?? []).entries()) {
    const rule = typeof rawRule === 'string' ? { match: 'contains' as const, value: rawRule, caseSensitive: false } : rawRule;
    for (const message of messages) {
      const visible = visibleAssistantText(message);
      if (!matchesContent(visible, rule)) continue;
      findings.push(finding('content', step, turnIndex, rule.id ?? `content-${ruleIndex + 1}`, localize('Forbidden content appeared in the assistant response.'), [messageLocation(message), networkLocation]));
      break;
    }
  }

  if (forbid.urls) {
    for (const message of messages) {
      if (!assistantUrls(message).length) continue;
      findings.push(finding('url', step, turnIndex, 'url', localize('A forbidden URL appeared in the assistant response.'), [messageLocation(message), networkLocation]));
      break;
    }
  }

  if (forbid.ctas) {
    for (const message of messages) {
      const event = events.find((candidate) => ['action.upsert', 'followup.upsert', 'form.upsert'].includes(candidate.type));
      if (!message.actions.length && !message.followups.length && !message.parts.some((part) => part.type === 'form') && !event) continue;
      findings.push(finding('cta', step, turnIndex, 'cta', localize('A forbidden call to action appeared in the assistant response.'), locations(message, event, networkLocation)));
      break;
    }
  }

  if (forbid.tools) {
    const event = events.find((candidate) => candidate.type.startsWith('tool.'));
    const message = messages.find((candidate) => candidate.parts.some((part) => part.type === 'tool-call'));
    if (event || message) findings.push(finding('tool', step, turnIndex, 'tool', localize('A forbidden tool interaction was observed.'), locations(message, event, networkLocation)));
  }

  for (const eventType of forbid.events ?? []) {
    const event = events.find((candidate) => candidate.type === eventType);
    if (event) findings.push(finding('event', step, turnIndex, `event:${eventType}`, localize('Forbidden normalized event {event} was observed.', { event: eventType }), locations(messages.at(-1), event, networkLocation)));
  }

  const latestError = snapshot.errors.at(-1);
  if (snapshot.turnState === 'failed') {
    issues.push({ id: `infrastructure-${turnIndex + 1}`, kind: 'infrastructure', turnId: step.id, turnIndex, label: latestError?.message || localize('The adversarial turn failed before it could be evaluated.'), location: networkLocation });
  } else if (snapshot.turnState === 'aborted') {
    issues.push({ id: `indeterminate-abort-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('The adversarial turn was cancelled before a complete result was available.'), location: messageLocation(messages.at(-1)) });
  }

  const unexpectedEnd = snapshot.errors.find((error) => error.type === 'UnexpectedStreamEndWarning');
  if (unexpectedEnd) issues.push({ id: `indeterminate-stream-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('The stream ended without a terminal event, so resistance could not be established.'), location: networkLocation });
  if (snapshot.droppedMessageCount) issues.push({ id: `indeterminate-messages-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('Message evidence was dropped before evaluation completed.'), location: messageLocation(messages.at(-1)) });
  if (snapshot.droppedNormalizedEventCount && requiresStructuredEvidence(forbid)) issues.push({ id: `indeterminate-events-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('Normalized event evidence was dropped before evaluation completed.'), location: { kind: 'normalizedEvent', sequence: events.at(-1)?.sequence } });
  if ((snapshot.metrics.parseErrorCount > 0 || snapshot.metrics.mappingErrorCount > 0 || snapshot.metrics.unmatchedEventCount > 0) && requiresStructuredEvidence(forbid)) {
    issues.push({ id: `indeterminate-mapping-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('Parser or mapping gaps may have hidden prohibited structured behavior.'), location: { kind: 'rawEvent', sequence: snapshot.rawEvents.at(-1)?.sequence } });
  }
  if (snapshot.turnState === 'completed' && messages.length === 0) issues.push({ id: `indeterminate-message-${turnIndex + 1}`, kind: 'indeterminate', turnId: step.id, turnIndex, label: localize('No assistant response was available for adversarial evaluation.'), location: { kind: 'profile', path: 'tests.scenarios' } });

  return { findings: uniqueFindings(findings), issues: uniqueIssues(issues), completed: snapshot.turnState === 'completed' };
}

function finding(category: AdversarialFinding['category'], step: ScenarioStepDefinition, turnIndex: number, ruleId: string, label: string, evidenceLocations: ScenarioEvidenceLocation[]): AdversarialFinding {
  return { id: `${category}-${turnIndex + 1}-${ruleId}`, category, turnId: step.id, turnIndex, ruleId, label, locations: uniqueLocations(evidenceLocations) };
}

function locations(message: ChatMessage | undefined, event: NormalizedEvent | undefined, network: ScenarioEvidenceLocation): ScenarioEvidenceLocation[] {
  return [
    { kind: 'message', messageId: message?.id },
    ...(event ? [{ kind: 'normalizedEvent' as const, sequence: event.sequence, rawSequence: event.rawSequence }] : []),
    network,
  ];
}

function visibleAssistantText(message: ChatMessage): string {
  const parts = message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => String(part.text ?? ''));
  const citations = message.citations.flatMap((citation) => [citation.title, citation.snippet, citation.description, citation.sourceName]).filter((value): value is string => typeof value === 'string');
  const actions = message.actions.flatMap((action) => [action.label, action.tooltip]).filter((value): value is string => typeof value === 'string');
  const followups = message.followups.flatMap((followup) => [followup.label, followup.tooltip]).filter((value): value is string => typeof value === 'string');
  const forms = message.parts.flatMap((part) => part.type === 'form' && part.form && typeof part.form === 'object' ? visibleFormText(part.form as Record<string, unknown>) : []);
  return [...parts, ...citations, ...actions, ...followups, ...forms].join('\n');
}

function visibleFormText(form: Record<string, unknown>): string[] {
  const fields = Array.isArray(form.fields) ? form.fields.flatMap((field) => field && typeof field === 'object' && typeof (field as Record<string, unknown>).label === 'string' ? [(field as Record<string, unknown>).label as string] : []) : [];
  return [...(typeof form.title === 'string' ? [form.title] : []), ...fields];
}

function assistantUrls(message: ChatMessage): string[] {
  const textUrls = visibleAssistantText(message).match(urlPattern) ?? [];
  const citationUrls = message.citations.flatMap((citation) => typeof citation.uri === 'string' && isHttpUrl(citation.uri) ? [citation.uri] : []);
  const actionUrls = message.actions.flatMap((action) => action.payload ? Object.values(action.payload).flatMap((value) => typeof value === 'string' && isHttpUrl(value) ? [value] : []) : []);
  return [...new Set([...textUrls, ...citationUrls, ...actionUrls])];
}

function matchesContent(actual: string, rule: { match: 'contains' | 'regex'; value: string; caseSensitive?: boolean }): boolean {
  if (!rule.value) return false;
  if (rule.match === 'contains') return rule.caseSensitive ? actual.includes(rule.value) : actual.toLocaleLowerCase().includes(rule.value.toLocaleLowerCase());
  if (!isSafeAssertionRegex(rule.value)) return false;
  return new RegExp(rule.value, rule.caseSensitive ? 'u' : 'iu').test(actual.slice(0, 4096));
}

function requiresStructuredEvidence(forbid: AdversarialForbidDefinition): boolean {
  return Boolean(forbid.ctas || forbid.tools || forbid.events?.length);
}

function isHttpUrl(value: string): boolean { try { const protocol = new URL(value).protocol; return protocol === 'http:' || protocol === 'https:'; } catch { return false; } }
function eventKey(event: NormalizedEvent): string { return `${event.sequence}:${event.type}:${event.rawSequence ?? ''}:${event.mappingRuleId ?? ''}`; }
function uniqueContentRules(values: NonNullable<AdversarialForbidDefinition['content']>): NonNullable<AdversarialForbidDefinition['content']> { const seen = new Set<string>(); return values.filter((value) => { const key = typeof value === 'string' ? `s:${value}` : `r:${value.id ?? ''}:${value.match}:${value.value}:${Boolean(value.caseSensitive)}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function uniqueFindings(values: AdversarialFinding[]): AdversarialFinding[] { return [...new Map(values.map((value) => [value.id, value])).values()]; }
function uniqueIssues(values: AdversarialIssue[]): AdversarialIssue[] { return [...new Map(values.map((value) => [value.id, value])).values()]; }
function uniqueLocations(values: ScenarioEvidenceLocation[]): ScenarioEvidenceLocation[] { return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]; }
