import * as vscode from 'vscode';
import type { ChatMessage, ControlDefinition, InteractionContext, LocalRun, LocalRunSummary, MetricsSnapshot, NormalizedEvent, OpeningDefinition, PreparedRequest, RawStreamEvent, RemoteSessionReference, RuntimeErrorData, SessionSnapshot, TurnResult, TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { MappingEngine } from '../mapping/mappingEngine';
import { RequestBuilder } from '../request/requestBuilder';
import { getPath } from '../request/templateResolver';
import { redactKnownSecrets, type SecretService } from '../security/security';
import { HttpStreamTransport } from '../transport/transport';
import { TurnStageError, errors } from '../errors';
import { fetchWithRedirectPolicy } from '../transport/fetchPolicy';
import { LocalRunRepository, type LocalRunImportResult } from '../history/localRunRepository';
import { RemoteSessionRepository } from '../history/remoteSessionRepository';
import { EventBuffer } from './eventBuffer';
import { MetricsCollector } from './metrics';
import { createSnapshot, reduceEvent } from './reducer';
import { ReplayEngine, type ReplaySpeed } from '../replay/replayEngine';
import { selectOpeningFallback } from '../opening/fallbackResolver';
import { localize } from '../l10n';
import { logAt } from '../logging';

export class SessionController implements vscode.Disposable {
  snapshot: SessionSnapshot;
  controls: Record<string, unknown> = {};
  requestPreview?: PreparedRequest['redacted'];
  private abortController?: AbortController;
  private finalized = true;
  private metrics = new MetricsCollector();
  private readonly mapping: MappingEngine;
  private readonly rawBuffer: EventBuffer<RawStreamEvent>;
  private readonly maxBufferedEvents: number;
  private readonly maxConversationMessages: number;
  private runs: LocalRun[] = [];
  private lastInteraction?: { text: string; interaction: InteractionContext };
  private replayEngine?: ReplayEngine;
  private replayMetrics?: MetricsSnapshot;
  private currentTurn?: { clientRequestId: string; startedAt: number };
  private environmentSecretValues: string[] = [];
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
    this.maxBufferedEvents = config.get('maxBufferedEvents', 5000);
    this.maxConversationMessages = config.get('maxConversationMessages', 500);
    this.rawBuffer = new EventBuffer(this.maxBufferedEvents, config.get('maxBufferedBytes', 10 * 1024 * 1024));
    for (const control of profile.controls ?? []) {
      if (control.persist === 'secret' && !vscode.workspace.isTrusted) continue;
      this.controls[control.id] = this.persistedControl(control) ?? control.default;
    }
    this.refreshSnapshotControls();
  }

  async loadRuns(): Promise<LocalRun[]> {
    await this.migrateGlobalControls();
    await this.loadSecretControls();
    await this.loadEnvironmentSecrets();
    this.runs = vscode.workspace.isTrusted ? (await this.runRepository.list(this.profile.id)).map((run) => this.publicRun(run)) : [];
    this.snapshot.remoteSessions = this.profile.history?.remoteSessions?.mode === 'referenceOnly' ? this.publicRemoteSessions(this.remoteSessionRepository.list(this.remoteSessionKey())) : [];
    return this.runs;
  }
  getRuns(): LocalRun[] { return this.runs; }
  getRunSummaries(): LocalRunSummary[] { return this.runs.map((run) => ({ id: run.id, profileId: run.profileId, createdAt: run.createdAt, metrics: structuredClone(run.metrics), result: structuredClone(run.result), replayable: Boolean(run.rawEvents?.length), hasSnapshot: Boolean(run.snapshot), rawEventCount: run.rawEvents?.length ?? 0, normalizedEventCount: run.normalizedEvents?.length ?? 0, messageCount: run.snapshot?.messages.length ?? 0, errorCount: run.snapshot?.errors.length ?? (run.result.type === 'failed' ? 1 : 0), request: run.request ? { method: run.request.method, url: run.request.url, variantId: run.request.variantId } : undefined })); }
  addBuiltInFixture(rawEvents: RawStreamEvent[]): void {
    const fixtureSnapshot = createSnapshot(vscode.workspace.isTrusted); fixtureSnapshot.controls = this.publicControls();
    const safeRawEvents = rawEvents.map((event) => this.publicRawEvent(event));
    const run: LocalRun = { id: `fixture-${this.profile.id}`, profileId: this.profile.id, createdAt: 0, rawEvents: safeRawEvents, normalizedEvents: [], snapshot: fixtureSnapshot, metrics: { eventCount: rawEvents.length, byteCount: rawEvents.reduce((total, item) => total + Buffer.byteLength(item.raw), 0), parseErrorCount: 0, mappingErrorCount: 0, unmatchedEventCount: 0, reconnectCount: 0 }, result: { type: 'completed' } };
    const safeRun = this.publicRun(run);
    this.runs = [safeRun, ...this.runs.filter((item) => item.id !== safeRun.id)]; this.changed();
  }
  async importRun(): Promise<LocalRunImportResult | undefined> {
    if (isActive(this.snapshot.turnState)) throw new Error(localize('Finish or stop the current request before importing a run.'));
    const retention = this.profile.history?.localRuns?.maxRuns ?? vscode.workspace.getConfiguration('turnstage').get('runRetention', 20);
    const imported = await this.runRepository.import(this.profile.id, retention);
    if (!imported) return undefined;
    const safeRun = this.publicRun(imported.run);
    this.runs = [safeRun, ...this.runs.filter((item) => item.id !== safeRun.id)].slice(0, retention);
    this.changed(true);
    return { ...imported, run: safeRun };
  }
  async setControl(id: string, value: unknown): Promise<void> {
    const definition = this.profile.controls?.find((item) => item.id === id); if (!definition) return;
    if (definition.persist === 'secret' && !vscode.workspace.isTrusted) return;
    if (value !== undefined && !isControlValue(definition, value)) return;
    this.controls[id] = value;
    this.refreshSnapshotControls();
    const persisted = value === undefined ? undefined : persistedControl(definition, value);
    if (definition.persist === 'global') await this.context.globalState.update(this.globalControlKey(id), persisted);
    else if (definition.persist === 'workspace') await this.context.workspaceState.update(this.workspaceControlKey(id), persisted);
    else if (definition.persist === 'secret') {
      if (value === undefined) await this.context.secrets.delete(this.secretControlKey(id));
      else await this.context.secrets.store(this.secretControlKey(id), JSON.stringify(persisted));
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
      this.registerRequestSecrets(request);
      this.requestPreview = this.publicValue(request.redacted);
      const response = await fetchWithTimeout(request);
      const responseText = await response.text(); let data: unknown = responseText;
      try { data = responseText ? JSON.parse(responseText) : {}; } catch { /* fallback matching can still inspect status */ }
      if (!response.ok) { const fallback = selectOpeningFallback(opening, data, { status: response.status }); if (fallback) { this.useOpeningFallback(fallback); return; } throw new TurnStageError('HttpStatusError', localize('Opening request failed with HTTP {status}.', { status: response.status }), { status: response.status, data: this.publicValue(data) }); }
      const message = getPath(data, opening.response?.messagePath ?? '$.message');
      const starters = getPath(data, opening.response?.startersPath ?? '$.options');
      if (typeof message !== 'string') { const fallback = selectOpeningFallback(opening, data, { status: response.status, missingMessage: true }); if (fallback) { this.useOpeningFallback(fallback); return; } throw new TurnStageError('OpeningError', localize('Opening response did not contain a message.')); }
      this.snapshot.opening = this.publicValue({ message, starters: Array.isArray(starters) ? starters as any : [] }); this.snapshot.sessionState = 'ready';
    } catch (error) {
      logAt(this.log, 'error', `[opening] ${this.publicValue(safeMessage(error))}`);
      const type = error instanceof TurnStageError ? error.type : 'NetworkError'; const fallback = selectOpeningFallback(opening, undefined, { errorType: type }) ?? (opening.failurePolicy?.useFallbackOnNetworkError ? opening.fallbacks?.[0] : undefined);
      if (opening.failurePolicy?.useFallbackOnNetworkError && fallback) this.useOpeningFallback(fallback);
      else { this.snapshot.sessionState = 'failed'; this.snapshot.errors.push(this.publicValue(toError(error))); }
    }
    this.changed();
  }
  async retryOpening(): Promise<void> { await this.startSession(); }
  useConfiguredOpeningFallback(): void { this.useOpeningFallback(); }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    text = text.trim(); if (!text || isActive(this.snapshot.turnState)) return;
    if (!vscode.workspace.isTrusted) { this.snapshot.errors.push(toError(errors.trust())); this.changed(); return; }
    const clientRequestId = crypto.randomUUID();
    const startedAt = Date.now();
    this.currentTurn = { clientRequestId, startedAt };
    this.rawBuffer.clear();
    this.snapshot.rawEvents = [];
    this.snapshot.normalizedEvents = [];
    this.snapshot.droppedEventCount = 0;
    this.snapshot.droppedNormalizedEventCount = 0;
    this.snapshot.turnState = 'submitting'; this.snapshot.errors = []; this.finalized = false; this.lastInteraction = { text, interaction }; this.metrics = new MetricsCollector(); this.metrics.start();
    try {
      const request = await this.requestBuilder().build(this.profile.conversation.send, this.contextFor(text, interaction, clientRequestId, startedAt));
      this.registerRequestSecrets(request);
      this.requestPreview = this.publicValue(request.redacted);
      this.snapshot.messages.push({ id: `user-${clientRequestId}`, role: 'user', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] });
      this.snapshot.messages.push({ id: `assistant-${clientRequestId}`, role: 'assistant', status: 'pending', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [], timing: {}, metadata: { clientRequestId } });
      this.boundSnapshotCollections();
      this.snapshot.turnState = 'waitingStart'; this.changed(); this.abortController = new AbortController();
      const transport = new HttpStreamTransport();
      const result = await transport.start(request, this.profile.stream.transport === 'fixture' ? 'ndjson' : this.profile.stream.transport as any, {
        onHeaders: (latency) => { this.metrics.headers(latency); this.changed(); },
        onChunk: (bytes, latency) => { this.metrics.chunk(bytes, latency); },
        onEvent: (raw) => this.acceptRaw(raw),
      }, this.abortController.signal, this.profile.stream.dataFormat ?? 'json');
      this.metrics.reconnectCount(result.reconnectCount ?? 0);
      if (result.aborted) await this.finalizeTurn({ type: 'aborted', reason: 'user_cancel' });
      else if (!this.finalized) {
        if (this.profile.stream.unexpectedEndPolicy === 'completeWithWarning') { this.snapshot.errors.push({ type: 'UnexpectedStreamEndWarning', message: localize('The stream ended without a terminal event.') }); await this.finalizeTurn({ type: 'completed' }); }
        else await this.finalizeTurn({ type: 'failed', error: toError(errors.unexpectedEnd()) });
      }
    } catch (error) {
      if (error instanceof TurnStageError && typeof error.details.reconnectCount === 'number') this.metrics.reconnectCount(error.details.reconnectCount);
      await this.finalizeTurn({ type: error instanceof TurnStageError && error.type === 'UserAbortError' ? 'aborted' : 'failed', ...(error instanceof TurnStageError && error.type === 'UserAbortError' ? { reason: 'user_cancel' } : { error: toError(error) }) } as TurnResult);
    }
  }

  async retry(): Promise<void> { if (this.lastInteraction) await this.send(this.lastInteraction.text, { ...this.lastInteraction.interaction, kind: 'retry' }); }
  async abort(): Promise<void> {
    if (!isActive(this.snapshot.turnState)) return; this.snapshot.turnState = 'stopping'; this.changed(); this.abortController?.abort(errors.abort());
    const stop = this.profile.conversation.stop;
    if (stop?.strategy === 'abortThenRequest' && stop.request && vscode.workspace.isTrusted) {
      const stopContext = this.contextFor('', { kind: 'manual' }, this.currentTurn?.clientRequestId, this.currentTurn?.startedAt); const missing = (stop.requiredContext ?? []).filter((path) => getPath(stopContext, path) === undefined);
      if (missing.length) this.snapshot.errors.push({ type: 'RemoteStopWarning', message: localize('Local stream stopped. Remote stop was skipped because context is missing: {context}.', { context: missing.join(', ') }) });
      else try {
        const request = await this.requestBuilder().build(stop.request, stopContext);
        this.registerRequestSecrets(request);
        await fetchWithTimeout(request);
      }
      catch (error) { this.snapshot.errors.push({ type: 'RemoteStopWarning', message: localize('Local stream stopped; remote stop failed: {error}', { error: this.publicValue(safeMessage(error)) }) }); }
    }
    await this.finalizeTurn({ type: 'aborted', reason: 'user_cancel' });
  }

  async newConversation(): Promise<void> {
    if (isActive(this.snapshot.turnState)) return;
    for (const definition of this.profile.controls ?? []) if (definition.resetOnNewConversation) await this.setControl(definition.id, definition.default);
    const controls = { ...this.controls }; const remoteSessions = this.publicRemoteSessions(this.remoteSessionRepository.list(this.remoteSessionKey())); this.snapshot = createSnapshot(vscode.workspace.isTrusted); this.controls = controls; this.refreshSnapshotControls(); this.snapshot.remoteSessions = remoteSessions; this.rawBuffer.clear(); this.lastInteraction = undefined; await this.startSession();
  }
  clearConversation(): void { if (isActive(this.snapshot.turnState)) return; this.snapshot.messages = []; this.snapshot.conversationId = undefined; this.snapshot.rawEvents = []; this.snapshot.normalizedEvents = []; this.rawBuffer.clear(); this.changed(); }

  applyRemoteSession(conversationId: string): void {
    if (isActive(this.snapshot.turnState)) return;
    const reference = this.snapshot.remoteSessions?.find((item) => item.conversationId === conversationId); if (!reference) return;
    const remoteSessions = this.publicRemoteSessions(this.snapshot.remoteSessions ?? []); this.snapshot = createSnapshot(vscode.workspace.isTrusted); this.refreshSnapshotControls(); this.snapshot.remoteSessions = remoteSessions; this.snapshot.conversationId = reference.conversationId; this.snapshot.title = reference.title; this.snapshot.sessionState = 'ready'; this.rawBuffer.clear(); this.lastInteraction = undefined;
    this.snapshot.messages.push({ id: `remote-reference-${reference.conversationId}`, role: 'system', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text: localize('Previous messages were not loaded. This profile only stores a remote session reference.') }], citations: [], actions: [], followups: [] }); this.changed(true);
  }

  replay(runId: string, speed: ReplaySpeed = 1): 'started' | 'active' | 'notFound' | 'unavailable' {
    if (isActive(this.snapshot.turnState)) return 'active';
    const run = this.runs.find((item) => item.id === runId);
    if (!run) return 'notFound';
    if (!run.rawEvents?.length) return 'unavailable';
    this.replayEngine?.dispose();
    this.snapshot = this.replayStartingSnapshot(run);
    this.replayMetrics = structuredClone(run.metrics);
    this.requestPreview = run.request ? structuredClone(run.request) : undefined;
    this.rawBuffer.clear();
    this.finalized = false; this.metrics = new MetricsCollector(); this.metrics.start();
    this.replayEngine = new ReplayEngine(run.rawEvents ?? [], speed, (raw) => this.acceptRaw(raw), (state) => { this.snapshot.replay = { runId, ...state }; this.changed(); if (state.status === 'completed' && !this.finalized) void this.finalizeTurn(run.result, false); });
    void this.replayEngine.play();
    return 'started';
  }
  pauseReplay(): void { this.replayEngine?.pause(); }
  resumeReplay(): void { this.replayEngine?.resume(); }
  async stepReplay(): Promise<void> { await this.replayEngine?.step(); }
  async stopReplay(): Promise<void> { this.replayEngine?.stop(); if (!this.finalized) await this.finalizeTurn({ type: 'aborted', reason: 'replay_stopped' }, false); }
  setReplaySpeed(speed: ReplaySpeed): void { this.replayEngine?.setSpeed(speed); }

  async finalizeTurn(result: TurnResult, record = true): Promise<void> {
    if (this.finalized) return; this.finalized = true; this.abortController = undefined;
    result = this.publicValue(result);
    const message = [...this.snapshot.messages].reverse().find((item) => item.role === 'assistant' && ['pending', 'streaming'].includes(item.status));
    if (message) {
      const preservePartial = result.type === 'aborted' ? this.profile.conversation.stop?.preservePartialContent ?? this.profile.errorPolicy?.preservePartialContent !== false : this.profile.errorPolicy?.preservePartialContent !== false;
      if (result.type !== 'completed' && !preservePartial) message.parts = [];
      message.status = result.type; message.completedAt = Date.now(); for (const part of message.parts) if ((part.type === 'progress' || part.type === 'tool-call') && ['running', 'pending'].includes(String(part.status))) part.status = result.type === 'completed' ? 'completed' : result.type; if (result.type === 'failed' && this.profile.errorPolicy?.showErrorPart !== false) message.parts.push({ type: 'error', text: result.error.message });
    }
    if (result.type === 'aborted' && this.profile.conversation.stop?.appendSystemNotice && ['user_cancel', 'remote_abort'].includes(result.reason)) {
      const now = Date.now();
      this.snapshot.messages.push({ id: `system-${crypto.randomUUID()}`, role: 'system', status: 'completed', createdAt: now, completedAt: now, parts: [{ type: 'text', text: localize('Conversation stopped.') }], citations: [], actions: [], followups: [] });
    }
    if (result.type === 'failed' && this.profile.errorPolicy?.keepConversationId === false) this.snapshot.conversationId = undefined;
    if (result.type === 'failed') this.snapshot.errors.push(result.error);
    this.snapshot.turnState = result.type;
    this.metrics.finish(result.type === 'aborted' ? result.reason : undefined);
    this.snapshot.metrics = this.replayMetrics ? structuredClone(this.replayMetrics) : { ...this.metrics.value };
    this.syncActiveAssistantTiming(message);
    this.replayMetrics = undefined;
    this.boundSnapshotCollections(); this.changed(true);
    if (this.profile.history?.remoteSessions?.mode === 'referenceOnly' && this.snapshot.conversationId) {
      const reference: RemoteSessionReference = { conversationId: this.snapshot.conversationId, title: this.snapshot.title ?? this.snapshot.conversationId, createdAt: Date.now(), actorId: this.publicActorId(), environmentId: this.environment.id };
      this.snapshot.remoteSessions = this.publicRemoteSessions(await this.remoteSessionRepository.save(this.remoteSessionKey(), reference)); this.changed();
    }
    if (record && this.profile.history?.localRuns?.enabled !== false) {
      const settings = this.profile.history?.localRuns;
      const run: LocalRun = { id: crypto.randomUUID(), profileId: this.profile.id, createdAt: Date.now(), request: this.requestPreview, metrics: { ...this.snapshot.metrics }, result };
      if (settings?.recordRawEvents !== false) run.rawEvents = [...this.snapshot.rawEvents];
      if (settings?.recordNormalizedEvents !== false) run.normalizedEvents = [...this.snapshot.normalizedEvents];
      if (settings?.recordChatSnapshot !== false) run.snapshot = structuredClone(this.snapshot);
      const safeRun = this.publicRun(run);
      const retention = this.profile.history?.localRuns?.maxRuns ?? vscode.workspace.getConfiguration('turnstage').get('runRetention', 20); await this.runRepository.save(safeRun, retention); this.runs = [safeRun, ...this.runs].slice(0, retention); this.changed();
    }
    this.currentTurn = undefined;
  }

  dispose(): void { void this.disposeAndWait(); }
  async disposeAndWait(): Promise<void> {
    this.replayEngine?.dispose();
    if (!isActive(this.snapshot.turnState)) return;
    this.abortController?.abort(new TurnStageError('PanelDisposedError', localize('The editor panel was closed.')));
    await this.finalizeTurn({ type: 'aborted', reason: 'panel_disposed' });
  }

  private async acceptRaw(raw: RawStreamEvent): Promise<boolean> {
    // A backend can accidentally emit duplicate terminal frames or continue
    // writing after completion. Once the turn is finalized, its persisted run
    // and visible snapshot must remain immutable.
    if (this.finalized) return false;
    this.metrics.raw(raw);
    if (raw.data === (this.profile.stream.doneValue ?? '[DONE]')) {
      this.rawBuffer.push(this.publicRawEvent(raw)); this.snapshot.rawEvents = this.rawBuffer.all(); this.snapshot.droppedEventCount = this.rawBuffer.dropped;
      await this.finalizeTurn({ type: 'completed' }); return false;
    }
    const result = this.mapping.map(raw); raw.mappingRuleId = result.ruleIds.join(', ') || undefined; raw.mappingError = result.errors.map((item) => `${item.ruleId}: ${item.message}`).join('; ') || undefined;
    this.rawBuffer.push(this.publicRawEvent(raw)); this.snapshot.rawEvents = this.rawBuffer.all(); this.snapshot.droppedEventCount = this.rawBuffer.dropped;
    if (result.errors.length) { this.metrics.mappingError(result.errors.length); for (const error of result.errors) this.snapshot.errors.push({ type: 'MappingError', message: error.message, ruleId: error.ruleId, rawSequence: raw.sequence }); }
    if (!result.events.length) this.metrics.unmatched();
    for (const event of result.events) {
      this.metrics.normalized(event);
      reduceEvent(this.snapshot, this.publicNormalizedEvent(event));
      this.syncActiveAssistantTiming();
      this.boundSnapshotCollections();
      if (event.type === 'stream.completed') { await this.finalizeTurn({ type: 'completed' }); return false; }
      if (event.type === 'stream.failed') { await this.finalizeTurn({ type: 'failed', error: this.snapshot.errors.at(-1) ?? { type: 'StreamError', message: localize('The stream failed.') } }); return false; }
      if (event.type === 'stream.aborted') { await this.finalizeTurn({ type: 'aborted', reason: 'remote_abort' }); return false; }
    }
    this.snapshot.metrics = { ...this.metrics.value }; this.changed(); return true;
  }

  private contextFor(text: string, interaction: InteractionContext, clientRequestId = this.currentTurn?.clientRequestId ?? crypto.randomUUID(), startedAt = this.currentTurn?.startedAt ?? Date.now()): Record<string, unknown> {
    const messages = this.snapshot.messages; const lastUser = [...messages].reverse().find((item) => item.role === 'user'); const lastAssistant = [...messages].reverse().find((item) => item.role === 'assistant');
    return { input: { text }, conversation: { id: this.snapshot.conversationId, messages, lastUserMessage: lastUser, lastAssistantMessage: lastAssistant }, opening: this.snapshot.opening, controls: this.templateControls(), env: this.environment.variables, profile: { id: this.profile.id, name: this.profile.name }, workspace: { folder: vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() }, runtime: { simulationContext: {} }, turn: { clientRequestId, startedAt, assistantMessageId: lastAssistant?.id, interaction } };
  }
  private boundSnapshotCollections(): void {
    const normalizedOverflow = Math.max(0, this.snapshot.normalizedEvents.length - this.maxBufferedEvents);
    if (normalizedOverflow) {
      this.snapshot.normalizedEvents.splice(0, normalizedOverflow);
      this.snapshot.droppedNormalizedEventCount = (this.snapshot.droppedNormalizedEventCount ?? 0) + normalizedOverflow;
    }
    const messageOverflow = Math.max(0, this.snapshot.messages.length - this.maxConversationMessages);
    if (messageOverflow) {
      this.snapshot.messages.splice(0, messageOverflow);
      this.snapshot.droppedMessageCount = (this.snapshot.droppedMessageCount ?? 0) + messageOverflow;
    }
    if (this.snapshot.errors.length > 500) this.snapshot.errors.splice(0, this.snapshot.errors.length - 500);
  }
  private requestBuilder(): RequestBuilder {
    return new RequestBuilder(async (name) => {
      const storageName = this.environment.secretReferences?.[name] ?? name;
      const value = await this.secrets.get(storageName);
      if (value === undefined && storageName !== name) throw errors.missingSecret(storageName);
      return value;
    });
  }
  private useOpeningFallback(selected?: NonNullable<OpeningDefinition['fallbacks']>[number]): void { const fallback = selected ?? this.profile.opening?.fallbacks?.[0]; if (fallback) { this.snapshot.opening = { message: fallback.message, starters: fallback.starters ?? [] }; this.snapshot.sessionState = 'ready'; } else this.snapshot.sessionState = 'failed'; this.changed(); }
  private legacyControlKey(id: string): string { const workspace = vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() ?? 'no-workspace'; return `turnstage.control.${workspace}.${this.profile.id}.${id}`; }
  private workspaceControlKey(id: string): string { return this.legacyControlKey(id); }
  private globalControlKey(id: string): string { return `turnstage.control.global.${this.profile.id}.${id}`; }
  private secretControlKey(id: string): string { return `turnstage.control.secret.${this.profile.id}.${id}`; }
  private remoteSessionKey(): string {
    const workspace = vscode.workspace.getWorkspaceFolder(this.profileUri)?.uri.toString() ?? 'no-workspace'; const scope = this.profile.history?.remoteSessions?.scope ?? ['profile', 'actor', 'environment']; const parts = [workspace, this.profile.id];
    if (scope.includes('actor')) parts.push(this.isSecretControl('actor') ? 'no-actor' : typeof this.controls.actor === 'string' ? this.controls.actor : 'no-actor');
    if (scope.includes('environment')) parts.push(this.environment.id);
    return `turnstage.remoteSessions.${parts.map((part) => encodeURIComponent(part)).join('.')}`;
  }
  private persistedControl(definition: ControlDefinition): unknown {
    const id = definition.id;
    const stored = definition.persist === 'global'
      ? this.context.globalState.get(this.globalControlKey(id)) ?? this.context.globalState.get(this.legacyControlKey(id))
      : definition.persist === 'workspace' ? this.context.workspaceState.get(this.workspaceControlKey(id)) : undefined;
    return readPersistedControl(definition, stored);
  }
  private async migrateGlobalControls(): Promise<void> {
    for (const definition of this.profile.controls ?? []) {
      if (definition.persist !== 'global' || this.context.globalState.get(this.globalControlKey(definition.id)) !== undefined) continue;
      const legacy = readPersistedControl(definition, this.context.globalState.get(this.legacyControlKey(definition.id)));
      if (legacy !== undefined) await this.context.globalState.update(this.globalControlKey(definition.id), persistedControl(definition, legacy));
    }
  }
  private async loadSecretControls(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      for (const definition of this.profile.controls ?? []) if (definition.persist === 'secret') delete this.controls[definition.id];
      this.refreshSnapshotControls();
      this.changed();
      return;
    }
    for (const definition of this.profile.controls ?? []) {
      if (definition.persist !== 'secret') continue;
      let stored = await this.context.secrets.get(this.secretControlKey(definition.id));
      if (stored === undefined) {
        stored = await this.context.secrets.get(this.legacyControlKey(definition.id));
        if (stored !== undefined) await this.context.secrets.store(this.secretControlKey(definition.id), stored);
      }
      if (stored === undefined) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(stored) as unknown; } catch { parsed = stored; }
      const value = readPersistedControl(definition, parsed);
      if (value !== undefined) this.controls[definition.id] = value;
    }
    this.refreshSnapshotControls();
    this.changed();
  }

  private async loadEnvironmentSecrets(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    const referencedNames = Object.values(this.environment.secretReferences ?? {});
    const templateNames = [...JSON.stringify(this.profile).matchAll(/\$\{secret\.([A-Za-z0-9_.-]+)\}/g)]
      .map((match) => this.environment.secretReferences?.[match[1]!] ?? match[1]!);
    const names = [...new Set([...referencedNames, ...templateNames])];
    const values = await Promise.all(names.map((name) => this.secrets.get(name)));
    this.environmentSecretValues = [...new Set([...this.environmentSecretValues, ...values.filter((value): value is string => Boolean(value))])];
  }

  private refreshSnapshotControls(): void { this.snapshot.controls = this.publicControls(); }
  private syncActiveAssistantTiming(message?: ChatMessage): void {
    const target = message ?? [...this.snapshot.messages].reverse().find((item) => item.role === 'assistant' && ['pending', 'streaming'].includes(item.status));
    if (!target) return;
    const { ttft, totalDuration } = this.snapshot.turnState === 'completed' || this.snapshot.turnState === 'failed' || this.snapshot.turnState === 'aborted'
      ? this.snapshot.metrics
      : this.metrics.value;
    target.timing = {
      ...(ttft !== undefined ? { ttft } : {}),
      ...(totalDuration !== undefined ? { totalDuration } : {}),
    };
  }
  private replayStartingSnapshot(run: LocalRun): SessionSnapshot {
    const currentRemoteSessions = this.publicRemoteSessions(this.snapshot.remoteSessions ?? []);
    const replaySnapshot = createSnapshot(vscode.workspace.isTrusted);
    const recorded = run.snapshot;
    if (recorded) {
      const lastUserIndex = recorded.messages.map((message) => message.role).lastIndexOf('user');
      replaySnapshot.messages = lastUserIndex >= 0 ? structuredClone(recorded.messages.slice(0, lastUserIndex + 1)) : [];
      replaySnapshot.opening = recorded.opening ? structuredClone(recorded.opening) : undefined;
      replaySnapshot.conversationId = recorded.conversationId;
      replaySnapshot.title = recorded.title;
    }
    replaySnapshot.controls = this.publicControls();
    replaySnapshot.remoteSessions = currentRemoteSessions;
    replaySnapshot.sessionState = 'ready';
    replaySnapshot.turnState = 'streaming';
    return replaySnapshot;
  }
  private publicControls(values: Record<string, unknown> = this.controls): Record<string, unknown> {
    const secretIds = new Set((this.profile.controls ?? []).filter((definition) => definition.persist === 'secret').map((definition) => definition.id));
    return Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => !secretIds.has(id)));
  }
  private templateControls(): Record<string, unknown> { return vscode.workspace.isTrusted ? { ...this.controls } : this.publicControls(); }
  private isSecretControl(id: string): boolean { return this.profile.controls?.some((definition) => definition.id === id && definition.persist === 'secret') ?? false; }
  private publicActorId(): string | undefined { return this.isSecretControl('actor') ? undefined : typeof this.controls.actor === 'string' ? this.controls.actor : undefined; }
  private publicRemoteSessions(references: RemoteSessionReference[] = []): RemoteSessionReference[] {
    const safeReferences = Array.isArray(references) ? references : [];
    if (!this.isSecretControl('actor')) return safeReferences.map((reference) => this.publicValue({ ...reference }));
    return safeReferences.map((reference) => {
      const safeReference = this.publicValue({ ...reference });
      delete safeReference.actorId;
      return safeReference;
    });
  }
  private secretControlValues(): unknown[] {
    return (this.profile.controls ?? []).filter((definition) => definition.persist === 'secret').map((definition) => this.controls[definition.id]).filter((value) => value !== undefined && value !== null && value !== '');
  }
  private knownSecretValues(): unknown[] { return [...this.secretControlValues(), ...this.environmentSecretValues]; }
  private registerRequestSecrets(request: PreparedRequest): void { this.environmentSecretValues = [...new Set([...this.environmentSecretValues, ...(request.secretValues ?? [])])]; }
  private publicValue<T>(value: T, secrets: readonly unknown[] = this.knownSecretValues()): T { return redactKnownSecrets(value, secrets) as T; }
  private publicRawEvent(raw: RawStreamEvent, secrets: readonly unknown[] = this.knownSecretValues()): RawStreamEvent {
    const structural = new Set(['sequence', 'receivedAt', 'elapsedMs', 'protocol']);
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, structural.has(key) ? value : this.publicValue(value, secrets)])) as unknown as RawStreamEvent;
  }
  private publicNormalizedEvent(event: NormalizedEvent, secrets: readonly unknown[] = this.knownSecretValues()): NormalizedEvent {
    const structural = new Set(['version', 'sequence', 'receivedAt', 'rawSequence']);
    return Object.fromEntries(Object.entries(event).map(([key, value]) => [key, structural.has(key) ? value : this.publicValue(value, secrets)])) as NormalizedEvent;
  }
  private publicRun(run: LocalRun): LocalRun {
    let safeRun = structuredClone(run);
    const legacySecrets = (this.profile.controls ?? [])
      .filter((definition) => definition.persist === 'secret')
      .map((definition) => safeRun.snapshot?.controls?.[definition.id])
      .filter((value) => value !== undefined && value !== null && value !== '');
    const secrets = [...this.knownSecretValues(), ...legacySecrets];
    safeRun = this.publicValue(safeRun, secrets);
    if (safeRun.request) safeRun.request = this.publicValue(safeRun.request, secrets);
    if (safeRun.rawEvents) safeRun.rawEvents = safeRun.rawEvents.map((event) => this.publicRawEvent(event, secrets));
    if (safeRun.normalizedEvents) safeRun.normalizedEvents = safeRun.normalizedEvents.map((event) => this.publicNormalizedEvent(event, secrets));
    if (safeRun.snapshot) {
      safeRun.snapshot.controls = this.publicControls(safeRun.snapshot.controls ?? {});
      if (Array.isArray(safeRun.snapshot.rawEvents)) safeRun.snapshot.rawEvents = safeRun.snapshot.rawEvents.map((event) => this.publicRawEvent(event, secrets));
      if (Array.isArray(safeRun.snapshot.normalizedEvents)) safeRun.snapshot.normalizedEvents = safeRun.snapshot.normalizedEvents.map((event) => this.publicNormalizedEvent(event, secrets));
      safeRun.snapshot.remoteSessions = this.publicRemoteSessions(safeRun.snapshot.remoteSessions ?? []);
    }
    return safeRun;
  }
}

export function isActive(state: SessionSnapshot['turnState']): boolean { return ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(state); }

interface PersistedControl { version: 1; controlType: ControlDefinition['type']; value: unknown }
function persistedControl(definition: ControlDefinition, value: unknown): PersistedControl { return { version: 1, controlType: definition.type, value }; }
function readPersistedControl(definition: ControlDefinition, stored: unknown): unknown {
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && (stored as Partial<PersistedControl>).version === 1 && 'controlType' in stored && 'value' in stored) {
    const envelope = stored as PersistedControl;
    return envelope.controlType === definition.type && isControlValue(definition, envelope.value) ? envelope.value : undefined;
  }
  return isControlValue(definition, stored) ? stored : undefined;
}
function isControlValue(definition: ControlDefinition, value: unknown): boolean {
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  return definition.type !== 'select' || !definition.options?.length || definition.options.some((option) => option.value === value);
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function toError(error: unknown): RuntimeErrorData { if (error instanceof TurnStageError) return { type: error.type, message: error.message, status: typeof error.details.status === 'number' ? error.details.status : undefined, retrySafe: !['ConfigValidationError', 'MissingSecretError', 'WorkspaceTrustError'].includes(error.type) }; return { type: 'UnexpectedError', message: safeMessage(error), retrySafe: false }; }

async function fetchWithTimeout(request: PreparedRequest): Promise<Response> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
  try { return await fetchWithRedirectPolicy(request, controller.signal); }
  catch (error) { if (controller.signal.aborted) throw new TurnStageError('TimeoutError', localize('The opening request timeout elapsed.')); throw new TurnStageError('NetworkError', safeMessage(error)); }
  finally { clearTimeout(timeout); }
}
