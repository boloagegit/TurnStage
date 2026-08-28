import type { InteractionContext, LocalRunSummary, RawStreamEvent, SessionSnapshot, TurnStageProfile } from './types';

export const PROTOCOL_VERSION = 1 as const;

export const WORKSPACE_SECTIONS = [
  'test',
  'general',
  'opening-flow',
  'request',
  'stream-mapping',
  'chat-ui',
  'history-errors',
  'security'
] as const;
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number];

interface Envelope { protocolVersion: 1; editorInstanceId: string; requestId: string }
type WithoutEnvelope<T> = T extends unknown ? Omit<T, keyof Envelope> : never;

/** The small, serialisable payload used by the Events editor's sample tester. */
export interface MappingTestInput {
  protocol: RawStreamEvent['protocol'];
  raw: string;
  data: unknown;
  eventName?: string;
}

export interface MappingTestResult {
  ruleIds: string[];
  normalized: unknown[];
  errors: Array<{ ruleId: string; message: string }>;
  parseError?: string;
}

export type WebviewMessage = Envelope & (
  | { type: 'webview.ready' }
  | { type: 'profile.validate' }
  | { type: 'profile.openAsText' }
  | { type: 'profile.patch'; path: Array<string | number>; value: unknown }
  | { type: 'control.set'; controlId: string; value: unknown }
  | { type: 'session.start' }
  | { type: 'opening.retry' }
  | { type: 'opening.useFallback' }
  | { type: 'output.open' }
  | { type: 'mapping.test'; event: MappingTestInput }
  | { type: 'request.send'; text: string; interaction: InteractionContext }
  | { type: 'request.abort' }
  | { type: 'conversation.new' }
  | { type: 'conversation.clear' }
  | { type: 'history.remote.apply'; conversationId: string }
  | { type: 'citation.open'; citationId: string }
  | { type: 'uri.open'; uri: string }
  | { type: 'action.invoke'; actionId: string; sourceMessageId?: string }
  | { type: 'form.submit'; formId: string; values: Record<string, unknown>; sourceMessageId?: string }
  | { type: 'form.cancel'; formId: string }
  | { type: 'run.replay.play'; runId: string; speed: 0.25 | 0.5 | 1 | 2 | 4 }
  | { type: 'run.replay.pause' }
  | { type: 'run.replay.resume' }
  | { type: 'run.replay.stop' }
  | { type: 'run.replay.step' }
  | { type: 'run.replay.speed'; speed: 0.25 | 0.5 | 1 | 2 | 4 }
  | { type: 'run.import' }
  | { type: 'run.export'; runId: string }
  | { type: 'chat.screenshot.save'; dataUrl: string; suggestedName: string }
);

export type HostMessage = Envelope & (
  | { type: 'host.ready'; trusted: boolean; remoteName?: string; locale: string; direction: 'ltr' | 'rtl' }
  | { type: 'workspace.section'; section: WorkspaceSection }
  | { type: 'profile.snapshot'; profile?: TurnStageProfile; parseError?: string; version: number; environments: string[] }
  | { type: 'profile.validation'; diagnostics: Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }> }
  | { type: 'profile.validated'; valid: boolean }
  | { type: 'session.snapshot'; snapshot: SessionSnapshot; runs: LocalRunSummary[]; requestPreview?: unknown }
  | { type: 'mapping.test.result'; result: MappingTestResult }
  | { type: 'request.error'; error: { type: string; message: string } }
  | { type: 'form.accepted'; formId: string; sourceMessageId?: string }
  | { type: 'run.imported'; path: string; runId: string; duplicate: boolean }
  | { type: 'run.exported'; path: string }
  | { type: 'chat.screenshot.saved'; path: string }
  | { type: 'workspaceTrust.changed'; trusted: boolean }
);
export type WebviewPayload = WithoutEnvelope<WebviewMessage>;
export type HostPayload = WithoutEnvelope<HostMessage>;

const MAX_ID_LENGTH = 1024;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 34 * 1024 * 1024;
const MAX_VALUE_DEPTH = 24;
const MAX_VALUE_NODES = 20_000;
const interactionKinds = new Set<InteractionContext['kind']>(['manual', 'starter', 'followup', 'responseAction', 'formSubmit', 'retry']);
const streamProtocols = new Set<RawStreamEvent['protocol']>(['sse', 'ndjson', 'json', 'text-stream', 'fixture']);
const replaySpeeds = new Set([0.25, 0.5, 1, 2, 4]);

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isBoundedString(value: unknown, max = MAX_ID_LENGTH): value is string { return typeof value === 'string' && value.length <= max; }
function optionalBoundedString(value: unknown): boolean { return value === undefined || isBoundedString(value); }

/** Bound depth and node count before host code traverses attacker-controlled values. */
function isStructuredValue(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return true;
    if (typeof item === 'string') return item.length <= MAX_TEXT_LENGTH;
    if (typeof item !== 'object') return false;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.length <= MAX_VALUE_NODES && item.every((child) => visit(child, depth + 1));
    const entries = Object.entries(item as Record<string, unknown>);
    return entries.length <= MAX_VALUE_NODES && entries.every(([key, child]) => key.length <= MAX_ID_LENGTH && visit(child, depth + 1));
  };
  return visit(value, 0);
}

function isInteractionContext(value: unknown): value is InteractionContext {
  if (!isRecord(value) || typeof value.kind !== 'string' || !interactionKinds.has(value.kind as InteractionContext['kind'])) return false;
  if (!['sourceMessageId', 'starterId', 'followupId', 'actionId', 'actionKey', 'formId'].every((key) => optionalBoundedString(value[key]))) return false;
  return value.formValues === undefined || (isRecord(value.formValues) && isStructuredValue(value.formValues));
}

function hasEnvelope(message: Record<string, unknown>, instanceId: string): boolean {
  return message.protocolVersion === PROTOCOL_VERSION
    && message.editorInstanceId === instanceId
    && isBoundedString(message.requestId)
    && message.requestId.length > 0
    && typeof message.type === 'string';
}

export function isWebviewMessage(value: unknown, instanceId: string): value is WebviewMessage {
  if (!isRecord(value) || !hasEnvelope(value, instanceId)) return false;
  const message = value;
  switch (message.type) {
    case 'webview.ready': case 'profile.validate': case 'profile.openAsText': case 'session.start': case 'opening.retry': case 'opening.useFallback': case 'output.open': case 'request.abort': case 'conversation.new': case 'conversation.clear': case 'run.replay.pause': case 'run.replay.resume': case 'run.replay.stop': case 'run.replay.step': case 'run.import': return true;
    case 'profile.patch': return Array.isArray(message.path) && message.path.length > 0 && message.path.length <= MAX_VALUE_DEPTH && message.path.every((part) => (isBoundedString(part) && !['__proto__', 'prototype', 'constructor'].includes(part)) || (Number.isInteger(part) && Number(part) >= 0 && Number(part) <= 10_000)) && isStructuredValue(message.value);
    case 'control.set': return isBoundedString(message.controlId) && isStructuredValue(message.value);
    case 'mapping.test': return isRecord(message.event) && typeof message.event.protocol === 'string' && streamProtocols.has(message.event.protocol as RawStreamEvent['protocol']) && isBoundedString(message.event.raw, 262_144) && optionalBoundedString(message.event.eventName) && isStructuredValue(message.event.data);
    case 'request.send': return isBoundedString(message.text, MAX_TEXT_LENGTH) && isInteractionContext(message.interaction);
    case 'history.remote.apply': return isBoundedString(message.conversationId);
    case 'citation.open': return isBoundedString(message.citationId);
    case 'uri.open': return isBoundedString(message.uri, MAX_TEXT_LENGTH);
    case 'action.invoke': return isBoundedString(message.actionId) && optionalBoundedString(message.sourceMessageId);
    case 'form.submit': return isBoundedString(message.formId) && isRecord(message.values) && isStructuredValue(message.values) && optionalBoundedString(message.sourceMessageId);
    case 'form.cancel': return isBoundedString(message.formId);
    case 'run.replay.play': return isBoundedString(message.runId) && typeof message.speed === 'number' && replaySpeeds.has(message.speed);
    case 'run.replay.speed': return typeof message.speed === 'number' && replaySpeeds.has(message.speed);
    case 'run.export': return isBoundedString(message.runId);
    case 'chat.screenshot.save': return isBoundedString(message.dataUrl, MAX_SCREENSHOT_DATA_URL_LENGTH) && message.dataUrl.startsWith('data:image/png;base64,') && isBoundedString(message.suggestedName, 200) && /^[a-zA-Z0-9._-]+\.png$/i.test(message.suggestedName);
    default: return false;
  }
}

/** Defensive validation for messages crossing from the Extension Host into the Webview. */
export function isHostMessage(value: unknown, instanceId: string): value is HostMessage {
  if (!isRecord(value) || !hasEnvelope(value, instanceId)) return false;
  const message = value;
  switch (message.type) {
    case 'host.ready': return typeof message.trusted === 'boolean' && optionalBoundedString(message.remoteName) && isBoundedString(message.locale, 64) && (message.direction === 'ltr' || message.direction === 'rtl');
    case 'workspace.section': return isWorkspaceSection(message.section);
    case 'profile.snapshot': return (message.profile === undefined || (isRecord(message.profile) && isStructuredValue(message.profile))) && optionalBoundedString(message.parseError) && Number.isInteger(message.version) && Array.isArray(message.environments) && message.environments.every((item) => isBoundedString(item));
    case 'profile.validation': return Array.isArray(message.diagnostics) && message.diagnostics.length <= 10_000 && message.diagnostics.every((item) => isRecord(item) && (item.severity === 'error' || item.severity === 'warning') && isBoundedString(item.message, MAX_TEXT_LENGTH) && Number.isInteger(item.offset) && Number(item.offset) >= 0 && Number.isInteger(item.length) && Number(item.length) >= 0);
    case 'profile.validated': return typeof message.valid === 'boolean';
    case 'session.snapshot': return isRecord(message.snapshot) && Array.isArray(message.runs) && isStructuredValue(message.snapshot) && isStructuredValue(message.runs) && (message.requestPreview === undefined || isStructuredValue(message.requestPreview));
    case 'mapping.test.result': return isRecord(message.result) && isStructuredValue(message.result);
    case 'request.error': return isRecord(message.error) && isBoundedString(message.error.type) && isBoundedString(message.error.message, MAX_TEXT_LENGTH);
    case 'form.accepted': return isBoundedString(message.formId) && optionalBoundedString(message.sourceMessageId);
    case 'run.imported': return isBoundedString(message.path, MAX_TEXT_LENGTH) && isBoundedString(message.runId) && typeof message.duplicate === 'boolean';
    case 'run.exported': return isBoundedString(message.path, MAX_TEXT_LENGTH);
    case 'chat.screenshot.saved': return isBoundedString(message.path, MAX_TEXT_LENGTH);
    case 'workspaceTrust.changed': return typeof message.trusted === 'boolean';
    default: return false;
  }
}

export function isWorkspaceSection(value: unknown): value is WorkspaceSection {
  return typeof value === 'string' && (WORKSPACE_SECTIONS as readonly string[]).includes(value);
}
