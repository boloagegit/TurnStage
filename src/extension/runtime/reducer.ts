import type { ChatMessage, Citation, FormDefinition, MessageMetric, MessageMetricAggregation, NormalizedEvent, SessionSnapshot } from '../../shared/types';
import { localize } from '../l10n';

const MAX_MESSAGE_TEXT_CHARS = 1024 * 1024;
const MAX_MESSAGE_PARTS = 1000;
const MAX_MESSAGE_ENTITIES = 500;
const MAX_RAW_SEQUENCE_LINKS = 5000;
const MAX_DEDUPLICATION_KEYS = 20_000;
const eventKeys = new WeakMap<SessionSnapshot, Set<string>>();
const rawSequenceKeys = new WeakMap<ChatMessage, Set<number>>();
const truncatedFields = new WeakMap<object, Set<string>>();

function id(prefix: string, sequence: number): string { return `${prefix}-${sequence}`; }
function assistant(snapshot: SessionSnapshot, sequence: number): ChatMessage {
  let message: ChatMessage | undefined;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) { const item = snapshot.messages[index]!; if (item.role === 'assistant' && (item.status === 'pending' || item.status === 'streaming')) { message = item; break; } }
  if (!message) { message = { id: id('assistant', sequence), role: 'assistant', status: 'streaming', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [] }; snapshot.messages.push(message); }
  return message;
}
function targetMessage(snapshot: SessionSnapshot, event: NormalizedEvent): ChatMessage {
  const explicitId = typeof event.messageId === 'string' ? event.messageId : undefined;
  if (explicitId) for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) if (snapshot.messages[index]!.id === explicitId) return snapshot.messages[index]!;
  return assistant(snapshot, event.sequence);
}
function upsertPart(message: ChatMessage, type: string, create: () => Record<string, unknown>): Record<string, unknown> {
  let part = message.parts.find((item) => item.type === type); if (!part) { part = { type, ...create() }; pushBounded(message.parts, part as any, MAX_MESSAGE_PARTS); } return part;
}
function normalizeEntity<T extends { id?: string }>(value: unknown, prefix: string, sequence: number): T { const entity = value && typeof value === 'object' ? { ...(value as any) } : {}; entity.id ??= id(prefix, sequence); return entity; }

function linkEventToMessage(message: ChatMessage, event: NormalizedEvent): void {
  const rawSequence = typeof event.rawSequence === 'number' ? event.rawSequence : event.sequence;
  let current = Array.isArray(message.metadata?.rawSequences) ? message.metadata.rawSequences : undefined;
  if (!current) { current = []; message.metadata = { ...message.metadata, rawSequences: current }; }
  let seen = rawSequenceKeys.get(message);
  if (!seen) { seen = new Set(current.filter((value): value is number => typeof value === 'number')); rawSequenceKeys.set(message, seen); }
  if (seen.has(rawSequence)) return;
  current.push(rawSequence); seen.add(rawSequence);
  if (current.length > MAX_RAW_SEQUENCE_LINKS) { const removed = current.shift(); if (typeof removed === 'number') seen.delete(removed); }
}

export function reduceEvent(snapshot: SessionSnapshot, event: NormalizedEvent): void {
  let seen = eventKeys.get(snapshot);
  if (!seen) { seen = new Set(snapshot.normalizedEvents.map(eventKey)); eventKeys.set(snapshot, seen); }
  else if (seen.size > MAX_DEDUPLICATION_KEYS) { seen = new Set(snapshot.normalizedEvents.map(eventKey)); eventKeys.set(snapshot, seen); }
  const key = eventKey(event);
  if (seen.has(key)) return;
  seen.add(key);
  snapshot.normalizedEvents.push(event);
  const message = targetMessage(snapshot, event);
  linkEventToMessage(message, event);
  switch (event.type) {
    case 'conversation.started': snapshot.conversationId = String(event.conversationId ?? snapshot.conversationId ?? ''); if (event.assistantMessageId) message.id = String(event.assistantMessageId); snapshot.turnState = 'streaming'; break;
    case 'conversation.title.updated': snapshot.title = String(event.title ?? ''); break;
    case 'content.text.delta': case 'content.markdown.delta': { const type = event.type.includes('markdown') ? 'markdown' : 'text'; const part = upsertPart(message, type, () => ({ text: '' })); if (appendBounded(part, 'text', event.text)) snapshot.errors.push({ type: 'ResourceLimitError', message: localize('Assistant content was truncated at the safety limit.') }); message.status = 'streaming'; break; }
    case 'content.citation': { const part = { type: 'citation-reference', citationId: String(event.citationId ?? '') }; pushBounded(message.parts, part, MAX_MESSAGE_PARTS); break; }
    case 'progress.started': case 'progress.updated': { const part = upsertPart(message, 'progress', () => ({ text: '', status: 'running' })); part.text = String(event.text ?? part.text ?? ''); part.status = 'running'; break; }
    case 'progress.completed': { const part = upsertPart(message, 'progress', () => ({})); part.status = 'completed'; break; }
    case 'tool.started': { const toolCallId = String(event.toolCallId ?? id('tool', event.sequence)); let part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId); if (!part) { part = { type: 'tool-call', toolCallId, name: String(event.name ?? localize('Tool')), arguments: event.arguments, status: 'running', startedAt: event.receivedAt }; pushBounded(message.parts, part, MAX_MESSAGE_PARTS); } break; }
    case 'tool.arguments.delta': { const toolCallId = String(event.toolCallId ?? ''); const part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId) ?? upsertPart(message, 'tool-call', () => ({ toolCallId, status: 'running' })); if (appendBounded(part, 'arguments', event.arguments)) snapshot.errors.push({ type: 'ResourceLimitError', message: localize('Tool arguments were truncated at the safety limit.') }); break; }
    case 'tool.completed': case 'tool.failed': { const toolCallId = String(event.toolCallId ?? ''); let part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId); if (!part) { part = { type: 'tool-call', toolCallId, name: localize('Tool'), status: 'pending' }; pushBounded(message.parts, part, MAX_MESSAGE_PARTS); } part.status = event.type.endsWith('failed') ? 'failed' : 'completed'; part.result = event.result; part.error = event.error; part.completedAt = event.receivedAt; break; }
    case 'citation.upsert': { const citation = normalizeEntity<Citation>(event.citation, 'citation', event.sequence); const existing = message.citations.find((item) => item.id === citation.id); if (existing) Object.assign(existing, citation); else pushBounded(message.citations, citation, MAX_MESSAGE_ENTITIES); break; }
    case 'citation.attach': { const citation = normalizeEntity<Citation>(event.citation, 'citation', event.sequence); if (!message.citations.some((item) => item.id === citation.id)) pushBounded(message.citations, citation, MAX_MESSAGE_ENTITIES); break; }
    case 'followup.upsert': { const followup = normalizeEntity<any>(event.followup, 'followup', event.sequence); const existing = message.followups.find((item) => item.id === followup.id); if (existing) Object.assign(existing, followup); else pushBounded(message.followups, followup, MAX_MESSAGE_ENTITIES); break; }
    case 'followup.remove': message.followups = message.followups.filter((item) => item.id !== event.followupId); break;
    case 'action.upsert': { const action = normalizeEntity<any>(event.action, 'action', event.sequence); const existing = message.actions.find((item) => item.id === action.id); if (existing) Object.assign(existing, action); else pushBounded(message.actions, action, MAX_MESSAGE_ENTITIES); break; }
    case 'action.remove': message.actions = message.actions.filter((item) => item.id !== event.actionId); break;
    case 'form.upsert': { const form = normalizeEntity<FormDefinition>(event.form, 'form', event.sequence); const existing = message.parts.find((part) => part.type === 'form' && (part.form as FormDefinition | undefined)?.id === form.id); if (existing) existing.form = { ...(existing.form as FormDefinition), ...form }; else pushBounded(message.parts, { type: 'form', form }, MAX_MESSAGE_PARTS); break; }
    case 'diagnostic.updated': pushBounded(message.parts, { type: 'diagnostic', diagnostic: event.diagnostic }, MAX_MESSAGE_PARTS); break;
    case 'usage.updated': pushBounded(message.parts, { type: 'usage', usage: event.usage }, MAX_MESSAGE_PARTS); break;
    case 'message.metric.updated': upsertMessageMetric(message, event.metric); break;
    case 'stream.completed': snapshot.turnState = 'completed'; break;
    case 'stream.failed': snapshot.turnState = 'failed'; snapshot.errors.push({ type: 'StreamError', message: typeof event.error === 'string' ? event.error : JSON.stringify(event.error), retrySafe: true }); break;
    case 'stream.aborted': snapshot.turnState = 'aborted'; break;
  }
}

function eventKey(event: NormalizedEvent): string { return `${event.sequence}\u0000${event.type}\u0000${event.mappingRuleId ?? ''}`; }
function pushBounded<T>(items: T[], value: T, max: number): void { if (items.length < max) items.push(value); }
function appendBounded(target: Record<string, unknown>, field: string, incoming: unknown): boolean {
  const current = String(target[field] ?? '');
  const value = String(incoming ?? '');
  if (current.length >= MAX_MESSAGE_TEXT_CHARS) return value.length > 0 && markTruncated(target, field);
  target[field] = current + value.slice(0, MAX_MESSAGE_TEXT_CHARS - current.length);
  if (value.length > MAX_MESSAGE_TEXT_CHARS - current.length) return markTruncated(target, field);
  return false;
}
function markTruncated(target: object, field: string): boolean {
  const fields = truncatedFields.get(target) ?? new Set<string>();
  if (fields.has(field)) return false;
  fields.add(field); truncatedFields.set(target, fields); return true;
}

function upsertMessageMetric(message: ChatMessage, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== 'string' || !source.id.trim()) return;
  const aggregation = isMessageMetricAggregation(source.aggregation) ? source.aggregation : 'last';
  const incoming = source.value;
  if (!isMetricValue(incoming) && aggregation !== 'count') return;
  const metrics = message.metrics ??= [];
  const current = metrics.find((item) => item.id === source.id);
  const nextValue = aggregateMetricValue(current?.value, incoming, aggregation);
  if (nextValue === undefined) return;
  const metric: MessageMetric = {
    id: source.id,
    value: nextValue,
    aggregation,
    sampleCount: (current?.sampleCount ?? 0) + 1,
    ...(typeof source.label === 'string' ? { label: source.label } : current?.label ? { label: current.label } : {}),
    ...(typeof source.unit === 'string' ? { unit: source.unit } : current?.unit ? { unit: current.unit } : {}),
    ...(['number', 'duration', 'bytes', 'percent', 'text'].includes(String(source.format)) ? { format: source.format as MessageMetric['format'] } : current?.format ? { format: current.format } : {}),
  };
  if (current) Object.assign(current, metric);
  else if (metrics.length < MAX_MESSAGE_ENTITIES) metrics.push(metric);
}

function aggregateMetricValue(current: MessageMetric['value'] | undefined, incoming: unknown, aggregation: MessageMetricAggregation): MessageMetric['value'] | undefined {
  if (aggregation === 'count') return typeof current === 'number' ? current + 1 : 1;
  if (!isMetricValue(incoming)) return undefined;
  if (aggregation === 'first') return current ?? incoming;
  if (aggregation === 'last') return incoming;
  if (typeof incoming !== 'number' || !Number.isFinite(incoming)) return undefined;
  if (typeof current !== 'number' || !Number.isFinite(current)) return incoming;
  if (aggregation === 'sum') return current + incoming;
  if (aggregation === 'min') return Math.min(current, incoming);
  return Math.max(current, incoming);
}

function isMessageMetricAggregation(value: unknown): value is MessageMetricAggregation {
  return ['first', 'last', 'sum', 'min', 'max', 'count'].includes(String(value));
}

function isMetricValue(value: unknown): value is MessageMetric['value'] {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

export function createSnapshot(trusted: boolean): SessionSnapshot {
  return { sessionId: crypto.randomUUID(), sessionState: 'notStarted', turnState: 'idle', messages: [], rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0, reconnectCount: 0 }, errors: [], droppedEventCount: 0, droppedNormalizedEventCount: 0, droppedMessageCount: 0, trusted, controls: {} };
}

export function resetReducerState(snapshot: SessionSnapshot): void { eventKeys.delete(snapshot); }
