import type { AdversarialResultSummary, CampaignDashboardV1, ConnectionDoctorSummary, EvidenceTimelineSummary, InteractionContext, LocalRunSummary, NetworkExchange, RawStreamEvent, ScenarioEvidenceLocation, SessionSnapshot, TurnStageProfile } from './types';

export const PROTOCOL_VERSION = 1 as const;

export const WORKSPACE_SECTIONS = [
  'test',
  'general',
  'opening-flow',
  'request',
  'stream-mapping',
  'chat-ui',
  'scenario-tests',
  'history-errors',
  'security'
] as const;
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number];
export type InspectorTargetTab = 'Network' | 'Raw Events' | 'Normalized';

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

export type TestOperationAction = 'runAll' | 'rerunFailed' | 'rerunUnstable' | 'rerunIncomplete';
export type TestOperationState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export interface TestOperationProgress {
  totalCases: number;
  completedCases: number;
  totalAttempts: number;
  completedAttempts: number;
  activeCaseNames?: string[];
}
export interface TestOperationSnapshot { action: TestOperationAction; state: TestOperationState; detail?: string; progress?: TestOperationProgress }

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
  | { type: 'run.delete'; runId: string }
  | { type: 'run.clear' }
  | { type: 'adversarial.file'; action: 'importCsv' | 'importJsonc' | 'importJsonl' | 'linkSuite' | 'linkJsonc' | 'exportCsv' | 'exportJsonc' | 'exportJsonl' | 'csvTemplate' }
  | { type: 'adversarial.openLinkedSuite'; path: string }
  | { type: 'test.runAll' }
  | { type: 'test.rerun'; status: 'failed' | 'unstable' | 'incomplete' }
  | { type: 'test.cancel' }
  | { type: 'test.timeline.open'; evidenceId: string }
  | { type: 'test.evidence.open'; evidenceId: string; location: ScenarioEvidenceLocation }
  | { type: 'test.report.export'; format: 'json' | 'junit' | 'html'; evidenceId?: string }
  | { type: 'test.evidenceBundle.export' }
  | { type: 'campaign.preview'; campaignId: string }
  | { type: 'campaign.run'; campaignId: string }
  | { type: 'campaign.cancel'; campaignId: string }
  | { type: 'campaign.resume'; campaignId: string; runId: string }
  | { type: 'campaign.acceptBaseline'; campaignId: string; runId: string }
  | { type: 'campaign.exportResults'; campaignId: string; runId: string }
  | { type: 'campaign.copilotSummary'; campaignId: string; runId: string }
  | { type: 'copilot.diagnose'; evidenceId: string; mode: 'failure' | 'performance' | 'stability' | 'comparison' }
  | { type: 'copilot.qualityReview'; evidenceIds: string[] }
  | { type: 'copilot.profileDoctor' }
  | { type: 'connection.analyze' }
  | { type: 'adversarial.capture' }
  | { type: 'visual.baseline.save'; dataUrl: string; viewport: { id: string; width: number; height: number } }
  | { type: 'visual.compare'; dataUrl: string; viewport: { id: string; width: number; height: number } }
);

export type HostMessage = Envelope & (
  | { type: 'host.ready'; trusted: boolean; remoteName?: string; locale: string; direction: 'ltr' | 'rtl' }
  | { type: 'workspace.section'; section: WorkspaceSection }
  | { type: 'inspector.focus'; tab: InspectorTargetTab; evidenceId?: string; networkId?: string; sequence?: number; messageId?: string }
  | { type: 'profile.snapshot'; profile?: TurnStageProfile; parseError?: string; version: number; environments: string[] }
  | { type: 'profile.validation'; diagnostics: Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }> }
  | { type: 'profile.validated'; valid: boolean }
  | { type: 'session.snapshot'; snapshot: SessionSnapshot; runs: LocalRunSummary[]; requestPreview?: unknown; networkEntries?: NetworkExchange[] }
  | { type: 'mapping.test.result'; result: MappingTestResult }
  | { type: 'request.error'; error: { type: string; message: string } }
  | { type: 'action.feedback'; actionId: string; sourceMessageId: string; status: 'success' | 'error'; message: string }
  | { type: 'form.accepted'; formId: string; sourceMessageId?: string }
  | { type: 'run.imported'; path: string; runId: string; duplicate: boolean }
  | { type: 'run.exported'; path: string }
  | { type: 'run.history.changed'; deletedCount: number; deletedBytes: number }
  | { type: 'adversarial.operation'; action: 'importCsv' | 'importJsonc' | 'importJsonl' | 'linkSuite' | 'linkJsonc' | 'exportCsv' | 'exportJsonc' | 'exportJsonl' | 'csvTemplate'; status: 'completed' | 'cancelled'; detail: string; path?: string }
  | { type: 'test.operation'; operation: TestOperationSnapshot }
  | { type: 'test.results'; results: AdversarialResultSummary[] }
  | { type: 'campaign.dashboard'; dashboard: CampaignDashboardV1 }
  | { type: 'campaign.preview'; campaignId: string; selectedCases: number; plannedAttempts: number; plannedRequests: number; maximumDurationMs: number; maxConcurrency: number; warnings: string[] }
  | { type: 'test.timeline'; evidenceId: string; timeline: EvidenceTimelineSummary }
  | { type: 'test.exported'; kind: 'report' | 'evidenceBundle'; path: string }
  | { type: 'connection.result'; result: ConnectionDoctorSummary }
  | { type: 'adversarial.captured'; detail: string }
  | { type: 'visual.result'; operation: 'baseline' | 'compare'; status: 'saved' | 'passed' | 'failed'; differencePercent?: number; baselinePath: string; diffPath?: string }
  | { type: 'workspaceTrust.changed'; trusted: boolean }
);
export type WebviewPayload = WithoutEnvelope<WebviewMessage>;
export type HostPayload = WithoutEnvelope<HostMessage>;

const MAX_ID_LENGTH = 1024;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_VALUE_DEPTH = 24;
const MAX_VALUE_NODES = 20_000;
const MAX_HOST_VALUE_NODES = 250_000;
const MAX_PNG_DATA_URL_LENGTH = 32 * 1024 * 1024 + 64;
const interactionKinds = new Set<InteractionContext['kind']>(['manual', 'starter', 'followup', 'responseAction', 'formSubmit', 'retry']);
const streamProtocols = new Set<RawStreamEvent['protocol']>(['sse', 'ndjson', 'json', 'text-stream', 'fixture']);
const replaySpeeds = new Set([0.25, 0.5, 1, 2, 4]);

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isBoundedString(value: unknown, max = MAX_ID_LENGTH): value is string { return typeof value === 'string' && value.length <= max; }
function isBoundedId(value: unknown): value is string { return isBoundedString(value) && Boolean(value.trim()); }
function optionalBoundedString(value: unknown): boolean { return value === undefined || isBoundedString(value); }

/** Bound depth and node count before host code traverses attacker-controlled values. */
function isStructuredValue(value: unknown, maxNodes = MAX_VALUE_NODES): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > maxNodes || depth > MAX_VALUE_DEPTH) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return true;
    if (typeof item === 'string') return item.length <= MAX_TEXT_LENGTH;
    if (typeof item !== 'object') return false;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.length <= maxNodes && item.every((child) => visit(child, depth + 1));
    const entries = Object.entries(item as Record<string, unknown>);
    return entries.length <= maxNodes && entries.every(([key, child]) => key.length <= MAX_ID_LENGTH && visit(child, depth + 1));
  };
  return visit(value, 0);
}

function isInteractionContext(value: unknown): value is InteractionContext {
  if (!isRecord(value) || typeof value.kind !== 'string' || !interactionKinds.has(value.kind as InteractionContext['kind'])) return false;
  if (!['sourceMessageId', 'starterId', 'followupId', 'actionId', 'actionKey', 'formId'].every((key) => optionalBoundedString(value[key]))) return false;
  return value.formValues === undefined || (isRecord(value.formValues) && isStructuredValue(value.formValues));
}

function isVisualCapture(message: Record<string, unknown>): boolean {
  if (!isBoundedString(message.dataUrl, MAX_PNG_DATA_URL_LENGTH) || !message.dataUrl.startsWith('data:image/png;base64,')) return false;
  if (!isRecord(message.viewport) || !isBoundedString(message.viewport.id, 100)) return false;
  return Number.isInteger(message.viewport.width) && Number(message.viewport.width) >= 1 && Number(message.viewport.width) <= 2560
    && Number.isInteger(message.viewport.height) && Number(message.viewport.height) >= 1 && Number(message.viewport.height) <= 2160;
}

function isConnectionDoctorResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!['sse', 'ndjson', 'json', 'text-stream', 'unknown'].includes(String(value.protocol)) || !['high', 'medium', 'low'].includes(String(value.confidence)) || typeof value.safe !== 'boolean') return false;
  if (value.status !== undefined && (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599)) return false;
  const counts = ['rawEventCount', 'normalizedEventCount', 'mappedEventCount', 'unmatchedEventCount', 'parseErrorCount', 'mappingErrorCount'];
  if (!counts.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 1_000_000)) return false;
  if (typeof value.terminalEventSeen !== 'boolean' || typeof value.terminalMapped !== 'boolean') return false;
  return Array.isArray(value.findings) && value.findings.length <= 32 && value.findings.every((finding) => isRecord(finding)
    && isBoundedString(finding.id)
    && ['http', 'protocol', 'timing', 'stream', 'mapping', 'terminal'].includes(String(finding.category))
    && ['info', 'warning', 'error'].includes(String(finding.severity))
    && isBoundedString(finding.message, MAX_TEXT_LENGTH));
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
    case 'webview.ready': case 'profile.validate': case 'profile.openAsText': case 'session.start': case 'opening.retry': case 'opening.useFallback': case 'output.open': case 'request.abort': case 'conversation.new': case 'conversation.clear': case 'run.replay.pause': case 'run.replay.resume': case 'run.replay.stop': case 'run.replay.step': case 'run.import': case 'run.clear': case 'test.runAll': case 'test.cancel': case 'test.evidenceBundle.export': case 'adversarial.capture': case 'copilot.profileDoctor': case 'connection.analyze': return true;
    case 'adversarial.file': return ['importCsv', 'importJsonc', 'importJsonl', 'linkSuite', 'linkJsonc', 'exportCsv', 'exportJsonc', 'exportJsonl', 'csvTemplate'].includes(String(message.action));
    case 'adversarial.openLinkedSuite': return isBoundedString(message.path, 4096) && Boolean(message.path.trim());
    case 'test.rerun': return ['failed', 'unstable', 'incomplete'].includes(String(message.status));
    case 'test.timeline.open': return isBoundedString(message.evidenceId);
    case 'test.evidence.open': return isBoundedString(message.evidenceId) && isEvidenceLocation(message.location);
    case 'test.report.export': return ['json', 'junit', 'html'].includes(String(message.format)) && optionalBoundedString(message.evidenceId);
    case 'campaign.preview': case 'campaign.run': case 'campaign.cancel': return isBoundedId(message.campaignId);
    case 'campaign.resume': case 'campaign.acceptBaseline': case 'campaign.exportResults': case 'campaign.copilotSummary': return isBoundedId(message.campaignId) && isBoundedId(message.runId);
    case 'copilot.diagnose': return isBoundedString(message.evidenceId) && ['failure', 'performance', 'stability', 'comparison'].includes(String(message.mode));
    case 'copilot.qualityReview': return Array.isArray(message.evidenceIds) && message.evidenceIds.length >= 1 && message.evidenceIds.length <= 10 && message.evidenceIds.every((id) => isBoundedString(id)) && new Set(message.evidenceIds).size === message.evidenceIds.length;
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
    case 'run.delete': return isBoundedId(message.runId);
    case 'visual.baseline.save': case 'visual.compare': return isVisualCapture(message);
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
    case 'inspector.focus': return (message.tab === 'Network' || message.tab === 'Raw Events' || message.tab === 'Normalized') && optionalBoundedString(message.evidenceId) && optionalBoundedString(message.networkId) && optionalBoundedString(message.messageId) && (message.sequence === undefined || (Number.isInteger(message.sequence) && Number(message.sequence) >= 0));
    case 'profile.snapshot': return (message.profile === undefined || (isRecord(message.profile) && isStructuredValue(message.profile, MAX_HOST_VALUE_NODES))) && optionalBoundedString(message.parseError) && Number.isInteger(message.version) && Array.isArray(message.environments) && message.environments.every((item) => isBoundedString(item));
    case 'profile.validation': return Array.isArray(message.diagnostics) && message.diagnostics.length <= 10_000 && message.diagnostics.every((item) => isRecord(item) && (item.severity === 'error' || item.severity === 'warning') && isBoundedString(item.message, MAX_TEXT_LENGTH) && Number.isInteger(item.offset) && Number(item.offset) >= 0 && Number.isInteger(item.length) && Number(item.length) >= 0);
    case 'profile.validated': return typeof message.valid === 'boolean';
    case 'session.snapshot': return isRecord(message.snapshot) && Array.isArray(message.runs) && isStructuredValue(message.snapshot, MAX_HOST_VALUE_NODES) && isStructuredValue(message.runs, MAX_HOST_VALUE_NODES) && (message.requestPreview === undefined || isStructuredValue(message.requestPreview, MAX_HOST_VALUE_NODES)) && (message.networkEntries === undefined || (Array.isArray(message.networkEntries) && isStructuredValue(message.networkEntries, MAX_HOST_VALUE_NODES)));
    case 'mapping.test.result': return isRecord(message.result) && isStructuredValue(message.result, MAX_HOST_VALUE_NODES);
    case 'request.error': return isRecord(message.error) && isBoundedString(message.error.type) && isBoundedString(message.error.message, MAX_TEXT_LENGTH);
    case 'action.feedback': return isBoundedString(message.actionId) && isBoundedString(message.sourceMessageId) && (message.status === 'success' || message.status === 'error') && isBoundedString(message.message, MAX_TEXT_LENGTH);
    case 'form.accepted': return isBoundedString(message.formId) && optionalBoundedString(message.sourceMessageId);
    case 'run.imported': return isBoundedString(message.path, MAX_TEXT_LENGTH) && isBoundedString(message.runId) && typeof message.duplicate === 'boolean';
    case 'run.exported': return isBoundedString(message.path, MAX_TEXT_LENGTH);
    case 'run.history.changed': return Number.isInteger(message.deletedCount) && Number(message.deletedCount) >= 0 && Number(message.deletedCount) <= 100 && Number.isSafeInteger(message.deletedBytes) && Number(message.deletedBytes) >= 0 && Number(message.deletedBytes) <= 100 * 1024 * 1024;
    case 'adversarial.operation': return ['importCsv', 'importJsonc', 'importJsonl', 'linkSuite', 'linkJsonc', 'exportCsv', 'exportJsonc', 'exportJsonl', 'csvTemplate'].includes(String(message.action)) && (message.status === 'completed' || message.status === 'cancelled') && isBoundedString(message.detail, MAX_TEXT_LENGTH) && optionalBoundedString(message.path);
    case 'test.operation': return isRecord(message.operation)
      && ['runAll', 'rerunFailed', 'rerunUnstable', 'rerunIncomplete'].includes(String(message.operation.action))
      && ['running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(String(message.operation.state))
      && optionalBoundedString(message.operation.detail)
      && (message.operation.progress === undefined || isTestOperationProgress(message.operation.progress));
    case 'test.results': return isAdversarialResults(message.results) && isStructuredValue(message.results, MAX_HOST_VALUE_NODES);
    case 'campaign.dashboard': return isRecord(message.dashboard) && isStructuredValue(message.dashboard, MAX_HOST_VALUE_NODES);
    case 'campaign.preview': return isBoundedString(message.campaignId) && [message.selectedCases, message.plannedAttempts, message.plannedRequests, message.maximumDurationMs, message.maxConcurrency].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0) && Array.isArray(message.warnings) && message.warnings.length <= 100 && message.warnings.every((entry) => isBoundedString(entry, 4096));
    case 'test.timeline': return isBoundedString(message.evidenceId) && isRecord(message.timeline) && isStructuredValue(message.timeline, MAX_HOST_VALUE_NODES);
    case 'test.exported': return (message.kind === 'report' || message.kind === 'evidenceBundle') && isBoundedString(message.path, MAX_TEXT_LENGTH);
    case 'connection.result': return isConnectionDoctorResult(message.result) && isStructuredValue(message.result, MAX_HOST_VALUE_NODES);
    case 'adversarial.captured': return isBoundedString(message.detail, MAX_TEXT_LENGTH);
    case 'visual.result': return (message.operation === 'baseline' || message.operation === 'compare') && ['saved', 'passed', 'failed'].includes(String(message.status)) && optionalBoundedString(message.baselinePath) && optionalBoundedString(message.diffPath) && (message.differencePercent === undefined || (typeof message.differencePercent === 'number' && Number.isFinite(message.differencePercent) && message.differencePercent >= 0 && message.differencePercent <= 100));
    case 'workspaceTrust.changed': return typeof message.trusted === 'boolean';
    default: return false;
  }
}

function isTestOperationProgress(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counts = [value.totalCases, value.completedCases, value.totalAttempts, value.completedAttempts];
  if (!counts.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) <= 100_000)) return false;
  if (Number(value.completedCases) > Number(value.totalCases) || Number(value.completedAttempts) > Number(value.totalAttempts)) return false;
  return value.activeCaseNames === undefined || (Array.isArray(value.activeCaseNames) && value.activeCaseNames.length <= 8 && value.activeCaseNames.every((entry) => isBoundedString(entry, 256)));
}

function isAdversarialResults(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 500) return false;
  return value.every((result) => {
    if (!isRecord(result)
      || !isBoundedString(result.profileId) || !optionalBoundedString(result.suiteId)
      || !isBoundedString(result.scenarioId) || !isBoundedString(result.scenarioName, 4096)
      || !['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'].includes(String(result.outcome))
      || !boundedNonNegativeNumber(result.durationMs)
      || ![result.attemptedTurns, result.completedTurns, result.plannedTurns, result.findingCount, result.issueCount].every((entry) => boundedNonNegativeInteger(entry, 1_000_000))
      || !isBoundedString(result.evidenceId) || !isEvidenceLocation(result.primaryLocation)) return false;
    if (!Array.isArray(result.availableLocations) || result.availableLocations.length > 32 || !result.availableLocations.every(isEvidenceLocation)) return false;
    if (result.repetitions === undefined) return true;
    if (!isRecord(result.repetitions)) return false;
    const repetitions = result.repetitions;
    const counts = repetitions.counts;
    if (!boundedNonNegativeInteger(repetitions.requestedAttempts, 100) || Number(repetitions.requestedAttempts) < 1
      || !boundedNonNegativeInteger(repetitions.completedAttempts, Number(repetitions.requestedAttempts))
      || !boundedNonNegativeInteger(repetitions.skippedAttempts, Number(repetitions.requestedAttempts))
      || typeof repetitions.sampleComplete !== 'boolean'
      || !['stable-pass', 'stable-fail', 'unstable', 'inconclusive'].includes(String(repetitions.stability))
      || !isRecord(counts)
      || !['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'].every((outcome) => boundedNonNegativeInteger(counts[outcome], 100))) return false;
    const attempts = repetitions.attempts;
    if (attempts === undefined) return true;
    return Array.isArray(attempts) && attempts.length <= 100 && attempts.every((attempt) => isRecord(attempt)
      && Number.isSafeInteger(attempt.attempt) && Number(attempt.attempt) >= 1 && Number(attempt.attempt) <= 100
      && ['resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'].includes(String(attempt.outcome))
      && boundedNonNegativeNumber(attempt.durationMs)
      && boundedNonNegativeInteger(attempt.attemptedTurns, 1_000_000)
      && boundedNonNegativeInteger(attempt.completedTurns, 1_000_000)
      && optionalBoundedString(attempt.evidenceId)
      && (attempt.primaryLocation === undefined || isEvidenceLocation(attempt.primaryLocation))
      && (attempt.availableLocations === undefined || (Array.isArray(attempt.availableLocations) && attempt.availableLocations.length <= 32 && attempt.availableLocations.every(isEvidenceLocation))));
  });
}

function boundedNonNegativeInteger(value: unknown, max: number): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max; }
function boundedNonNegativeNumber(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }

function isEvidenceLocation(value: unknown): boolean {
  if (!isRecord(value) || !['network', 'rawEvent', 'normalizedEvent', 'message', 'profile'].includes(String(value.kind))) return false;
  return optionalBoundedString(value.networkId) && optionalBoundedString(value.messageId) && optionalBoundedString(value.path)
    && (value.sequence === undefined || (Number.isInteger(value.sequence) && Number(value.sequence) >= 0))
    && (value.rawSequence === undefined || (Number.isInteger(value.rawSequence) && Number(value.rawSequence) >= 0));
}

export function isWorkspaceSection(value: unknown): value is WorkspaceSection {
  return typeof value === 'string' && (WORKSPACE_SECTIONS as readonly string[]).includes(value);
}
