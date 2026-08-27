import type { ChatMessage, Citation, FormDefinition, NormalizedEvent, SessionSnapshot } from '../../shared/types';
import { localize } from '../l10n';

function id(prefix: string, sequence: number): string { return `${prefix}-${sequence}`; }
function assistant(snapshot: SessionSnapshot, sequence: number): ChatMessage {
  let message = [...snapshot.messages].reverse().find((item) => item.role === 'assistant' && ['pending', 'streaming'].includes(item.status));
  if (!message) { message = { id: id('assistant', sequence), role: 'assistant', status: 'streaming', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [] }; snapshot.messages.push(message); }
  return message;
}
function upsertPart(message: ChatMessage, type: string, create: () => Record<string, unknown>): Record<string, unknown> {
  let part = message.parts.find((item) => item.type === type); if (!part) { part = { type, ...create() }; message.parts.push(part as any); } return part;
}
function normalizeEntity<T extends { id?: string }>(value: unknown, prefix: string, sequence: number): T { const entity = value && typeof value === 'object' ? { ...(value as any) } : {}; entity.id ??= id(prefix, sequence); return entity; }

function linkEventToMessage(message: ChatMessage, event: NormalizedEvent): void {
  const rawSequence = typeof event.rawSequence === 'number' ? event.rawSequence : event.sequence;
  const current = Array.isArray(message.metadata?.rawSequences)
    ? message.metadata.rawSequences.filter((value): value is number => typeof value === 'number')
    : [];
  if (current.includes(rawSequence)) return;
  message.metadata = { ...message.metadata, rawSequences: [...current, rawSequence] };
}

export function reduceEvent(snapshot: SessionSnapshot, event: NormalizedEvent): void {
  if (snapshot.normalizedEvents.some((item) => item.sequence === event.sequence && item.type === event.type && item.mappingRuleId === event.mappingRuleId)) return;
  snapshot.normalizedEvents.push(event);
  const message = assistant(snapshot, event.sequence);
  linkEventToMessage(message, event);
  switch (event.type) {
    case 'conversation.started': snapshot.conversationId = String(event.conversationId ?? snapshot.conversationId ?? ''); if (event.assistantMessageId) message.id = String(event.assistantMessageId); snapshot.turnState = 'streaming'; break;
    case 'conversation.title.updated': snapshot.title = String(event.title ?? ''); break;
    case 'content.text.delta': case 'content.markdown.delta': { const type = event.type.includes('markdown') ? 'markdown' : 'text'; const part = upsertPart(message, type, () => ({ text: '' })); part.text = String(part.text ?? '') + String(event.text ?? ''); message.status = 'streaming'; break; }
    case 'content.citation': { const part = { type: 'citation-reference', citationId: String(event.citationId ?? '') }; message.parts.push(part); break; }
    case 'progress.started': case 'progress.updated': { const part = upsertPart(message, 'progress', () => ({ text: '', status: 'running' })); part.text = String(event.text ?? part.text ?? ''); part.status = 'running'; break; }
    case 'progress.completed': { const part = upsertPart(message, 'progress', () => ({})); part.status = 'completed'; break; }
    case 'tool.started': { const toolCallId = String(event.toolCallId ?? id('tool', event.sequence)); let part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId); if (!part) { part = { type: 'tool-call', toolCallId, name: String(event.name ?? localize('Tool')), arguments: event.arguments, status: 'running', startedAt: event.receivedAt }; message.parts.push(part); } break; }
    case 'tool.arguments.delta': { const toolCallId = String(event.toolCallId ?? ''); const part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId) ?? upsertPart(message, 'tool-call', () => ({ toolCallId, status: 'running' })); part.arguments = String(part.arguments ?? '') + String(event.arguments ?? ''); break; }
    case 'tool.completed': case 'tool.failed': { const toolCallId = String(event.toolCallId ?? ''); let part = message.parts.find((item) => item.type === 'tool-call' && item.toolCallId === toolCallId); if (!part) { part = { type: 'tool-call', toolCallId, name: localize('Tool'), status: 'pending' }; message.parts.push(part); } part.status = event.type.endsWith('failed') ? 'failed' : 'completed'; part.result = event.result; part.error = event.error; part.completedAt = event.receivedAt; break; }
    case 'citation.upsert': { const citation = normalizeEntity<Citation>(event.citation, 'citation', event.sequence); const existing = message.citations.find((item) => item.id === citation.id); if (existing) Object.assign(existing, citation); else message.citations.push(citation); break; }
    case 'citation.attach': { const citation = normalizeEntity<Citation>(event.citation, 'citation', event.sequence); if (!message.citations.some((item) => item.id === citation.id)) message.citations.push(citation); break; }
    case 'followup.upsert': { const followup = normalizeEntity<any>(event.followup, 'followup', event.sequence); const existing = message.followups.find((item) => item.id === followup.id); if (existing) Object.assign(existing, followup); else message.followups.push(followup); break; }
    case 'followup.remove': message.followups = message.followups.filter((item) => item.id !== event.followupId); break;
    case 'action.upsert': { const action = normalizeEntity<any>(event.action, 'action', event.sequence); const existing = message.actions.find((item) => item.id === action.id); if (existing) Object.assign(existing, action); else message.actions.push(action); break; }
    case 'action.remove': message.actions = message.actions.filter((item) => item.id !== event.actionId); break;
    case 'form.upsert': { const form = normalizeEntity<FormDefinition>(event.form, 'form', event.sequence); const existing = message.parts.find((part) => part.type === 'form' && (part.form as FormDefinition | undefined)?.id === form.id); if (existing) existing.form = { ...(existing.form as FormDefinition), ...form }; else message.parts.push({ type: 'form', form }); break; }
    case 'diagnostic.updated': message.parts.push({ type: 'diagnostic', diagnostic: event.diagnostic }); break;
    case 'usage.updated': message.parts.push({ type: 'usage', usage: event.usage }); break;
    case 'stream.completed': snapshot.turnState = 'completed'; break;
    case 'stream.failed': snapshot.turnState = 'failed'; snapshot.errors.push({ type: 'StreamError', message: typeof event.error === 'string' ? event.error : JSON.stringify(event.error), retrySafe: true }); break;
    case 'stream.aborted': snapshot.turnState = 'aborted'; break;
  }
}

export function createSnapshot(trusted: boolean): SessionSnapshot {
  return { sessionId: crypto.randomUUID(), sessionState: 'notStarted', turnState: 'idle', messages: [], rawEvents: [], normalizedEvents: [], metrics: { eventCount: 0, byteCount: 0, parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, errors: [], droppedEventCount: 0, trusted, controls: {} };
}
