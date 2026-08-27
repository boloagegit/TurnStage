import * as vscode from 'vscode';
import type { InteractionContext, LocalRun, OpeningDefinition, PreparedRequest, RawStreamEvent, RemoteSessionReference, RuntimeErrorData, SessionSnapshot, TurnResult, TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { MappingEngine } from '../mapping/mappingEngine';
import { RequestBuilder } from '../request/requestBuilder';
import { getPath } from '../request/templateResolver';
import { type SecretService } from '../security/security';
import { HttpStreamTransport } from '../transport/transport';
import { TurnStageError, errors } from '../errors';
import { LocalRunRepository } from '../history/localRunRepository';
import { RemoteSessionRepository } from '../history/remoteSessionRepository';
import { EventBuffer } from './eventBuffer';
import { MetricsCollector } from './metrics';
import { createSnapshot, reduceEvent } from './reducer';
import { ReplayEngine, type ReplaySpeed } from '../replay/replayEngine';
import { selectOpeningFallback } from '../opening/fallbackResolver';
import { localize } from '../l10n';

export class SessionController implements vscode.Disposable {
  snapshot: SessionSnapshot;
  controls: Record<string, unknown> = {};
  requestPreview?: PreparedRequest['redacted'];
  private abortController?: AbortController;
  private finalized = true;
  private metrics = new MetricsCollector();
  private readonly mapping: MappingEngine;
  private readonly rawBuffer: EventBuffer<RawStreamEvent>;
  private runs: LocalRun[] = [];
  private lastInteraction?: { text: string; interaction: InteractionContext };
  private replayEngine?: ReplayEngine;
  private readonly remoteSessionRepository: RemoteSessionRepository;

  constructor(
    readonly profile: TurnStageProfile,
    readonly profileUri: vscode.Uri,
    readonly environment: TurnStageEnvironment,
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: SecretService,
    private readonly runRepository: LocalRunRepository,
    private readonly changed: (immediate?: boolean) => void,
    private readonly log: vscode.OutputChannel,
  ) {
    this.snapshot = createSnapshot(vscode.workspace.isTrusted);
    this.remoteSessionRepository = new RemoteSessionRepository(context);
    this.mapping = new MappingEngine(profile.stream);
    const config = vscode.workspace.getConfiguration('turnstage');
    this.rawBuffer = new EventBuffer(config.get('maxBufferedEvents', 5000), config.get('maxBufferedBytes', 10 * 1024 * 1024));
    for (const control of profile.controls ?? []) this.controls[control.id] = this.persistedControl(control.id, control.persist) ?? control.default;
    this.snapshot.controls = { ...this.controls };
  }

  async loadRuns(): Promise<LocalRun[]> {
    await this.migrateGlobalControls();
    await this.loadSecretControls();
    this.runs = await this.runRepository.list(this.profile.id);
    this.snapshot.remoteSessions = this.profile.history?.remoteSessions?.mode === 'referenceOnly' ? this.remoteSessionRepository.list(this.remoteSessionKey()) : [];
    return this.runs;
  }
  getRuns(): LocalRun[] { return this.runs; }
  addBuiltInFixture(rawEvents: RawStreamEvent[]): void {
    const fixtureSnapshot = createSnapshot(vscode.workspace.isTrusted); fixtureSnapshot.controls = { ...this.controls };
    const run: LocalRun = { id: `fixture-${this.profile.id}`, profileId: this.profile.id, createdAt: 0, rawEvents, normalizedEvents: [], snapshot: fixtureSnapshot, metrics: { eventCount: rawEvents.length, byteCount: rawEvents.reduce((total, item) => total + Buffer.byteLength(item.raw), 0), parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0 }, result: { type: 'completed' } };
    this.runs = [run, ...this.runs.filter((item) => item.id !== run.id)]; this.changed();
  }
  async setControl(id: string, value: unknown): Promise<void> {
    const definition = this.profile.controls?.find((item) => item.id === id); if (!definition) return;
    this.controls[id] = value;
    this.snapshot.controls = { ...this.controls };
    if (definition.persist === 'global') await this.context.globalState.update(this.globalControlKey(id), value);
    else if (definition.persist === 'workspace') await this.context.workspaceState.update(this.workspaceControlKey(id), value);
    else if (definition.persist === 'secret') {
      if (value === undefined) await this.context.secrets.delete(this.secretControlKey(id));
      else await this.context.secrets.store(this.secretControlKey(id), JSON.stringify(value));
    }
    if (id === 'actor' && this.profile.history?.remoteSessions?.scope?.includes('actor')) this.snapshot.remoteSessions = this.remoteSessionRepository.list(this.remoteSessionKey());
    this.changed();
  }

  async startSession(forceFallback = false): Promise<void> {
    if (this.profile.opening?.mode === 'request' && !vscode.workspace.isTrusted) { this.snapshot.errors.push(toError(errors.trust())); this.snapshot.sessionState = 'failed'; this.changed(); return; }
    this.snapshot.sessionState = 'loadingOpening'; this.snapshot.errors = []; this.changed();
    const opening = this.profile.opening;
    if (!opening || opening.mode === 'disabled') { this.snapshot.opening = undefined; this.snapshot.sessionState = 'ready'; this.changed(); return; }
    if (opening.mode === 'static') { this.snapshot.opening = { message: opening.message ?? '', starters: opening.starters ?? [] }; this.snapshot.sessionState = 'ready'; this.changed(); return; }
    if (forceFallback) { this.useOpeningFallback(); return; }
    try {
      if (!opening.request) throw errors.request(localize('Opening request is missing.'));
      const request = await this.requestBuilder().build(opening.request as any, this.contextFor('', { kind: 'manual' }));
      this.requestPreview = request.redacted;
      const response = await fetchWithTimeout(request);
      const responseText = await response.text(); let data: unknown = responseText;
      try { data = responseText ? JSON.parse(responseText) : {}; } catch { /* fallback matching can still inspect status */ }
      if (!response.ok) { const fallback = selectOpeningFallback(opening, data, { status: response.status }); if (fallback) { this.useOpeningFallback(fallback); return; } throw new TurnStageError('HttpStatusError', `Opening request failed with HTTP ${response.status}.`, { status: response.status, data }); }
      const message = getPath(data, opening.response?.messagePath ?? '$.message');
      const starters = getPath(data, opening.response?.startersPath ?? '$.options');
      if (typeof message !== 'string') { const fallback = selectOpeningFallback(opening, data, { status: response.status, missingMessage: true }); if (fallback) { this.useOpeningFallback(fallback); return; } throw new TurnStageError('OpeningError', 'Opening response did not contain a message.'); }
      this.snapshot.opening = { message, starters: Array.isArray(starters) ? starters as any : [] }; this.snapshot.sessionState = 'ready';
    } catch (error) {
      this.log.appendLine(`[opening] ${safeMessage(error)}`);
      const type = error instanceof TurnStageError ? error.type : 'NetworkError'; const fallback = selectOpeningFallback(opening, undefined, { errorType: type }) ?? (opening.failurePolicy?.useFallbackOnNetworkError ? opening.fallbacks?.[0] : undefined);
      if (opening.failurePolicy?.useFallbackOnNetworkError && fallback) this.useOpeningFallback(fallback);
      else { this.snapshot.sessionState = 'failed'; this.snapshot.errors.push(toError(error)); }
    }
    this.changed();
  }
  async retryOpening(): Promise<void> { await this.startSession(); }
  useConfiguredOpeningFallback(): void { this.useOpeningFallback(); }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    text = text.trim(); if (!text || isActive(this.snapshot.turnState)) return;
    if (!vscode.workspace.isTrusted) { this.snapshot.errors.push(toError(errors.trust())); this.changed(); return; }
    this.snapshot.turnState = 'submitting'; this.snapshot.errors = []; this.finalized = false; this.lastInteraction = { text, interaction }; this.metrics = new MetricsCollector(); this.metrics.start();
    const clientRequestId = crypto.randomUUID();
    try {
      const request = await this.requestBuilder().build(this.profile.conversation.send, this.contextFor(text, interaction, clientRequestId));
      this.requestPreview = request.redacted;
      this.snapshot.messages.push({ id: `user-${clientRequestId}`, role: 'user', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] });
      this.snapshot.messages.push({ id: `assistant-${clientRequestId}`, role: 'assistant', status: 'pending', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [], metadata: { clientRequestId } });
      this.snapshot.turnState = 'waitingStart'; this.changed(); this.abortController = new AbortController();
      const transport = new HttpStreamTransport();
      const result = await transport.start(request, this.profile.stream.transport === 'fixture' ? 'ndjson' : this.profile.stream.transport as any, {
        onHeaders: (latency) => { this.metrics.headers(latency); this.changed(); },
        onChunk: (bytes, latency) => { this.metrics.chunk(bytes, latency); },
        onEvent: async (raw) => this.acceptRaw(raw),
      }, this.abortController.signal);
      if (result.aborted) await this.finalizeTurn({ type: 'aborted', reason: 'user_cancel' });
      else if (!this.finalized) {
        if (this.profile.stream.unexpectedEndPolicy === 'completeWithWarning') { this.snapshot.errors.push({ type: 'UnexpectedStreamEndWarning', message: localize('The stream ended without a terminal event.') }); await this.finalizeTurn({ type: 'completed' }); }
        else await this.finalizeTurn({ type: 'failed', error: toError(errors.unexpectedEnd()) });
      }
    } catch (error) { await this.finalizeTurn({ type: error instanceof TurnStageError && error.type === 'UserAbortError' ? 'aborted' : 'failed', ...(error instanceof TurnStageError && error.type === 'UserAbortError' ? { reason: 'user_cancel' } : { error: toError(error) }) } as TurnResult); }
  }

  async retry(): Promise<void> { if (this.lastInteraction) await this.send(this.lastInteraction.text, { ...this.lastInteraction.interaction, kind: 'retry' }); }
  async abort(): Promise<void> {
    if (!isActive(this.snapshot.turnState)) return; this.snapshot.turnState = 'stopping'; this.changed(); this.abortController?.abort(errors.abort());
    const stop = this.profile.conversation.stop;
    if (stop?.strategy === 'abortThenRequest' && stop.request && vscode.workspace.isTrusted) {
      const stopContext = this.contextFor('', { kind: 'manual' }); const missing = (stop.requiredContext ?? []).filter((path) => getPath(stopContext, path) === undefined);
      if (missing.length) this.snapshot.errors.push({ type: 'RemoteStopWarning', message: localize('Local stream stopped. Remote stop was skipped because context is missing: {context}.', { context: missing.join(', ') }) });
      else try { const request = await this.requestBuilder().build(stop.request, stopContext); await fetch(request.url, { method: request.method, headers: request.headers, body: request.body }); }
      catch (error) { this.snapshot.errors.push({ type: 'RemoteStopWarning', message: localize('Local stream stopped; remote stop failed: {error}', { error: safeMessage(error) }) }); }
    }
    await this.finalizeTurn({ type: 'aborted', reason: 'user_cancel' });
  }

  async newConversation(): Promise<void> {
    if (isActive(this.snapshot.turnState)) return;
    for (const definition of this.profile.controls ?? []) if (definition.resetOnNewConversation) await this.setControl(definition.id, definition.default);
    const controls = { ...this.controls }; const remoteSessions = this.remoteSessionRepository.list(this.remoteSessionKey()); this.snapshot = createSnapshot(vscode.workspace.isTrusted); this.controls = controls; this.snapshot.controls = controls; this.snapshot.remoteSessions = remoteSessions; this.rawBuffer.clear(); this.lastInteraction = undefined; await this.startSession();
  }
  clearConversation(): void { if (isActive(this.snapshot.turnState)) return; this.snapshot.messages = []; this.snapshot.conversationId = undefined; this.snapshot.rawEvents = []; this.snapshot.normalizedEvents = []; this.rawBuffer.clear(); this.changed(); }

  applyRemoteSession(conversationId: string): void {
    if (isActive(this.snapshot.turnState)) return;
    const reference = this.snapshot.remoteSessions?.find((item) => item.conversationId === conversationId); if (!reference) return;
    const remoteSessions = this.snapshot.remoteSessions; this.snapshot = createSnapshot(vscode.workspace.isTrusted); this.snapshot.controls = { ...this.controls }; this.snapshot.remoteSessions = remoteSessions; this.snapshot.conversationId = reference.conversationId; this.snapshot.title = reference.title; this.snapshot.sessionState = 'ready'; this.rawBuffer.clear(); this.lastInteraction = undefined;
    this.snapshot.messages.push({ id: `remote-reference-${reference.conversationId}`, role: 'system', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text: localize('Previous messages were not loaded. This profile only stores a remote session reference.') }], citations: [], actions: [], followups: [] }); this.changed(true);
  }

  replay(runId: string, speed: ReplaySpeed = 1): void {
    if (isActive(this.snapshot.turnState)) return; const run = this.runs.find((item) => item.id === runId); if (!run) return;
    this.replayEngine?.dispose(); const remoteSessions = this.snapshot.remoteSessions; this.snapshot = createSnapshot(vscode.workspace.isTrusted); this.snapshot.controls = { ...this.controls }; this.snapshot.remoteSessions = remoteSessions; this.snapshot.sessionState = 'ready'; this.snapshot.turnState = 'streaming'; this.finalized = false; this.metrics = new MetricsCollector(); this.metrics.start();
    this.replayEngine = new ReplayEngine(run.rawEvents ?? [], speed, (raw) => this.acceptRaw(raw), (state) => { this.snapshot.replay = { runId, ...state }; this.changed(); if (state.status === 'completed' && !this.finalized) void this.finalizeTurn(run.result, false); });
    void this.replayEngine.play();
  }
  pauseReplay(): void { this.replayEngine?.pause(); }
  resumeReplay(): void { this.replayEngine?.resume(); }
  async stepReplay(): Promise<void> { await this.replayEngine?.step(); }
  async stopReplay(): Promise<void> { this.replayEngine?.stop(); if (!this.finalized) await this.finalizeTurn({ type: 'aborted', reason: 'replay_stopped' }, false); }
  setReplaySpeed(speed: ReplaySpeed): void { this.replayEngine?.setSpeed(speed); }

  async finalizeTurn(result: TurnResult, record = true): Promise<void> {
    if (this.finalized) return; this.finalized = true; this.abortController = undefined;
    const message = [...this.snapshot.messages].reverse().find((item) => item.role === 'assistant' && ['pending', 'streaming'].includes(item.status));
    if (message) {
      const preservePartial = result.type === 'aborted' ? this.profile.conversation.stop?.preservePartialContent ?? this.profile.errorPolicy?.preservePartialContent !== false : this.profile.errorPolicy?.preservePartialContent !== false;
      if (result.type !== 'completed' && !preservePartial) message.parts = [];
      message.status = result.type; message.completedAt = Date.now(); for (const part of message.parts) if ((part.type === 'progress' || part.type === 'tool-call') && ['running', 'pending'].includes(String(part.status))) part.status = result.type === 'completed' ? 'completed' : result.type; if (result.type === 'failed' && this.profile.errorPolicy?.showErrorPart !== false) message.parts.push({ type: 'error', text: result.error.message });
    }
    if (result.type === 'failed' && this.profile.errorPolicy?.keepConversationId === false) this.snapshot.conversationId = undefined;
    if (result.type === 'failed') this.snapshot.errors.push(result.error); this.snapshot.turnState = result.type; this.metrics.finish(result.type === 'aborted' ? result.reason : undefined); this.snapshot.metrics = { ...this.metrics.value }; this.changed(true);
    if (this.profile.history?.remoteSessions?.mode === 'referenceOnly' && this.snapshot.conversationId) {
      const reference: RemoteSessionReference = { conversationId: this.snapshot.conversationId, title: this.snapshot.title ?? this.snapshot.conversationId, createdAt: Date.now(), actorId: typeof this.controls.actor === 'string' ? this.controls.actor : undefined, environmentId: this.environment.id };
      this.snapshot.remoteSessions = await this.remoteSessionRepository.save(this.remoteSessionKey(), reference); this.changed();
    }
    if (record && this.profile.history?.localRuns?.enabled !== false) {
      const settings = this.profile.history?.localRuns;
      const run: LocalRun = { id: crypto.randomUUID(), profileId: this.profile.id, createdAt: Date.now(), request: this.requestPreview, metrics: { ...this.snapshot.metrics }, result };
      if (settings?.recordRawEvents !== false) run.rawEvents = [...this.snapshot.rawEvents];
      if (settings?.recordNormalizedEvents !== false) run.normalizedEvents = [...this.snapshot.normalizedEvents];
      if (settings?.recordChatSnapshot !== false) run.snapshot = structuredClone(this.snapshot);
      const retention = this.profile.history?.localRuns?.maxRuns ?? vscode.workspace.getConfiguration('turnstage').get('runRetention', 20); await this.runRepository.save(run, retention); this.runs = [run, ...this.runs].slice(0, retention); this.changed();
    }
  }

  dispose(): void { this.replayEngine?.dispose(); if (isActive(this.snapshot.turnState)) { this.abortController?.abort(new TurnStageError('PanelDisposedError', localize('The editor panel was closed.'))); void this.finalizeTurn({ type: 'aborted', reason: 'panel_disposed' }); } }

  private async acceptRaw(raw: RawStreamEvent): Promise<void> {
    this.metrics.raw(raw); this.rawBuffer.push(raw); this.snapshot.rawEvents = this.rawBuffer.all(); this.snapshot.droppedEventCount = this.rawBuffer.dropped;
    if (raw.data === (this.profile.stream.doneValue ?? '[DONE]')) { await this.finalizeTurn({ type: 'completed' }); return; }
    const result = this.mapping.map(raw); raw.mappingRuleId = result.ruleIds.join(', ') || undefined; raw.mappingError = result.errors.map((item) => `${item.ruleId}: ${item.message}`).join('; ') || undefined;
    if (result.errors.length) { this.metrics.mappingError(result.errors.length); for (const error of result.errors) this.snapshot.errors.push({ type: 'MappingError', message: error.message, ruleId: error.ruleId, rawSequence: raw.sequence }); }
    if (!result.events.length) this.metrics.unmatched();
    for (const event of result.events) { this.metrics.normalized(event); reduceEvent(this.snapshot, event); if (event.type === 'stream.completed') { await this.finalizeTurn({ type: 'completed' }); return; } if (event.type === 'stream.failed') { await this.finalizeTurn({ type: 'failed', error: this.snapshot.errors.at(-1) ?? { type: 'StreamError', message: localize('The stream failed.') } }); return; } if (event.type === 'stream.aborted') { await this.finalizeTurn({ type: 'aborted', reason: 'remote_abort' }); return; } }
    this.snapshot.metrics = { ...this.metrics.value }; this.changed();
  }

  private contextFor(text: string, interaction: InteractionContext, clientRequestId = crypto.randomUUID()): Record<string, unknown> {
    const messages = this.snapshot.messages; const lastUser = [...messages].reverse().find((item) => item.role === 'user'); const lastAssistant = [...messages].reverse().find((item) => item.role === 'assistant');
    return { input: { text }, conversation: { id: this.snapshot.conversationId, messages, lastUserMessage: lastUser, lastAssistantMessage: lastAssistant }, opening: this.snapshot.opening, controls: this.controls, env: this.environment.variables, profile: { id: this.profile.id, name: this.profile.name }, workspace: { folder: vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() }, runtime: { simulationContext: {} }, turn: { clientRequestId, assistantMessageId: lastAssistant?.id, interaction } };
  }
  private requestBuilder(): RequestBuilder { return new RequestBuilder((name) => this.secrets.get(this.environment.secretReferences?.[name] ?? name)); }
  private useOpeningFallback(selected?: NonNullable<OpeningDefinition['fallbacks']>[number]): void { const fallback = selected ?? this.profile.opening?.fallbacks?.[0]; if (fallback) { this.snapshot.opening = { message: fallback.message, starters: fallback.starters ?? [] }; this.snapshot.sessionState = 'ready'; } else this.snapshot.sessionState = 'failed'; this.changed(); }
  private legacyControlKey(id: string): string { const workspace = vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() ?? 'no-workspace'; return `turnstage.control.${workspace}.${this.profile.id}.${id}`; }
  private workspaceControlKey(id: string): string { return this.legacyControlKey(id); }
  private globalControlKey(id: string): string { return `turnstage.control.global.${this.profile.id}.${id}`; }
  private secretControlKey(id: string): string { return `turnstage.control.secret.${this.profile.id}.${id}`; }
  private remoteSessionKey(): string {
    const workspace = vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() ?? 'no-workspace'; const scope = this.profile.history?.remoteSessions?.scope ?? ['profile', 'actor', 'environment']; const parts = [workspace, this.profile.id];
    if (scope.includes('actor')) parts.push(typeof this.controls.actor === 'string' ? this.controls.actor : 'no-actor');
    if (scope.includes('environment')) parts.push(this.environment.id);
    return `turnstage.remoteSessions.${parts.map((part) => encodeURIComponent(part)).join('.')}`;
  }
  private persistedControl(id: string, persist?: string): unknown {
    if (persist === 'global') return this.context.globalState.get(this.globalControlKey(id)) ?? this.context.globalState.get(this.legacyControlKey(id));
    return persist === 'workspace' ? this.context.workspaceState.get(this.workspaceControlKey(id)) : undefined;
  }
  private async migrateGlobalControls(): Promise<void> {
    for (const definition of this.profile.controls ?? []) {
      if (definition.persist !== 'global' || this.context.globalState.get(this.globalControlKey(definition.id)) !== undefined) continue;
      const legacy = this.context.globalState.get(this.legacyControlKey(definition.id));
      if (legacy !== undefined) await this.context.globalState.update(this.globalControlKey(definition.id), legacy);
    }
  }
  private async loadSecretControls(): Promise<void> {
    for (const definition of this.profile.controls ?? []) {
      if (definition.persist !== 'secret') continue;
      let stored = await this.context.secrets.get(this.secretControlKey(definition.id));
      if (stored === undefined) {
        stored = await this.context.secrets.get(this.legacyControlKey(definition.id));
        if (stored !== undefined) await this.context.secrets.store(this.secretControlKey(definition.id), stored);
      }
      if (stored === undefined) continue;
      try { this.controls[definition.id] = JSON.parse(stored) as unknown; } catch { this.controls[definition.id] = stored; }
    }
    this.snapshot.controls = { ...this.controls };
    this.changed();
  }
}

export function isActive(state: SessionSnapshot['turnState']): boolean { return ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(state); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function toError(error: unknown): RuntimeErrorData { if (error instanceof TurnStageError) return { type: error.type, message: error.message, status: typeof error.details.status === 'number' ? error.details.status : undefined, retrySafe: !['ConfigValidationError', 'MissingSecretError', 'WorkspaceTrustError'].includes(error.type) }; return { type: 'UnexpectedError', message: safeMessage(error), retrySafe: false }; }

async function fetchWithTimeout(request: PreparedRequest): Promise<Response> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
  try { return await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal }); }
  catch (error) { if (controller.signal.aborted) throw new TurnStageError('TimeoutError', 'The opening request timeout elapsed.'); throw new TurnStageError('NetworkError', safeMessage(error)); }
  finally { clearTimeout(timeout); }
}
