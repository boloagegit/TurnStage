import type { InteractionContext, LocalRun, RawStreamEvent, SessionSnapshot, TurnStageProfile } from './types';

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
  | { type: 'action.invoke'; actionId: string; sourceMessageId?: string }
  | { type: 'form.submit'; formId: string; values: Record<string, unknown>; sourceMessageId?: string }
  | { type: 'form.cancel'; formId: string }
  | { type: 'run.replay.play'; runId: string; speed: 0.25 | 0.5 | 1 | 2 | 4 }
  | { type: 'run.replay.pause' }
  | { type: 'run.replay.resume' }
  | { type: 'run.replay.stop' }
  | { type: 'run.replay.step' }
  | { type: 'run.replay.speed'; speed: 0.25 | 0.5 | 1 | 2 | 4 }
  | { type: 'run.export'; runId: string }
);

export type HostMessage = Envelope & (
  | { type: 'host.ready'; trusted: boolean; remoteName?: string; locale: string; direction: 'ltr' | 'rtl' }
  | { type: 'workspace.section'; section: WorkspaceSection }
  | { type: 'profile.snapshot'; profile?: TurnStageProfile; parseError?: string; version: number; environments: string[] }
  | { type: 'profile.validation'; diagnostics: Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }> }
  | { type: 'session.snapshot'; snapshot: SessionSnapshot; runs: LocalRun[]; requestPreview?: unknown }
  | { type: 'mapping.test.result'; result: MappingTestResult }
  | { type: 'request.error'; error: { type: string; message: string } }
  | { type: 'run.exported'; path: string }
  | { type: 'workspaceTrust.changed'; trusted: boolean }
);
export type WebviewPayload = WithoutEnvelope<WebviewMessage>;
export type HostPayload = WithoutEnvelope<HostMessage>;

export function isWebviewMessage(value: unknown, instanceId: string): value is WebviewMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.protocolVersion === PROTOCOL_VERSION && message.editorInstanceId === instanceId && typeof message.requestId === 'string' && typeof message.type === 'string';
}

export function isWorkspaceSection(value: unknown): value is WorkspaceSection {
  return typeof value === 'string' && (WORKSPACE_SECTIONS as readonly string[]).includes(value);
}
