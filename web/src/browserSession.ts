import type { ControlDefinition, InteractionContext, LocalRun, NetworkExchange, NormalizedEvent, PreparedRequest, RawStreamEvent, ReplaySnapshot, SessionSnapshot, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { MappingEngine } from '../../src/extension/mapping/mappingEngine';
import { RequestBuilder } from '../../src/extension/request/requestBuilder';
import { getPath } from '../../src/extension/request/templateResolver';
import { selectOpeningFallback } from '../../src/extension/opening/fallbackResolver';
import { normalizeOpeningResponseBlocks } from '../../src/extension/opening/responseBlockNormalizer';
import { normalizeOpeningStarters } from '../../src/extension/opening/starterNormalizer';
import { createSnapshot, reduceEvent } from '../../src/extension/runtime/reducer';
import { MetricsCollector } from '../../src/extension/runtime/metrics';
import { NdjsonParser, SseParser, toRawEvent } from '../../src/extension/transport/streamParser';
import { fetchWithRedirectPolicy } from '../../src/extension/transport/fetchPolicy';
import { ReplayEngine, type ReplaySpeed } from '../../src/extension/replay/replayEngine';
import { redactHeaders, redactKnownSecrets } from '../../src/shared/redaction';
import { browserUuid } from './browserCrypto';

const MAX_OPENING_RESPONSE_BYTES = 1024 * 1024;
const MAX_NETWORK_RESPONSE_PREVIEW_CHARS = 64 * 1024;
const MAX_EVENTS = 5000;
const MAX_MESSAGES = 500;
const MAX_NETWORK_ENTRIES = 50;
const MAX_RAW_BYTES = 10 * 1024 * 1024;

export interface BrowserSessionState {
  snapshot: SessionSnapshot;
  requestPreview?: unknown;
  networkEntries: NetworkExchange[];
}

export class BrowserSession {
  private state: BrowserSessionState = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
  private abortController?: AbortController;
  private openingAbortController?: AbortController;
  private stopAbortController?: AbortController;
  private activeOpening?: Promise<void>;
  private activeStop?: Promise<void>;
  private generation = 0;
  private rawBytes = 0;
  private readonly rawSizes: number[] = [];
  private currentTurn?: { clientRequestId: string; startedAt: number; text: string; interaction: InteractionContext };
  private requestDispatched = false;
  private requestSecretValues: string[] = [];
  private readonly secretControls = new Map<string, unknown>();
  private readonly networkPreviews = new Map<string, string>();
  private sequence = 0;
  private replay?: ReplayEngine;
  private turnIndex = 0;

  constructor(
    private profile: TurnStageProfile,
    private environment: TurnStageEnvironment,
    private readonly secrets: Map<string, string>,
    private readonly changed: (state: BrowserSessionState) => void,
  ) { this.resetControls(); }

  updateProfile(profile: TurnStageProfile, environment: TurnStageEnvironment): void {
    this.cancelActive();
    this.profile = profile;
    this.environment = environment;
    this.state = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
    this.sequence = 0;
    this.turnIndex = 0;
    this.rawBytes = 0;
    this.rawSizes.length = 0;
    this.currentTurn = undefined;
    this.requestSecretValues = [];
    this.resetControls();
    this.emit();
  }

  get current(): BrowserSessionState { return this.publicValue(structuredClone(this.state)); }
  get snapshot(): SessionSnapshot { return this.current.snapshot; }
  get requestPreview(): unknown { return this.current.requestPreview; }
  getNetworkEntries(): NetworkExchange[] { return this.current.networkEntries; }

  setEphemeralControls(values: Record<string, unknown>): void {
    for (const [id, value] of Object.entries(values)) {
      const definition = this.profile.controls?.find((item) => item.id === id);
      if (definition && definition.persist !== 'secret' && isControlValue(definition, value)) this.state.snapshot.controls[id] = structuredClone(value);
    }
    this.emit();
  }

  dispose(): void { this.cancelActive(); this.replay?.dispose(); }

  async startSession(): Promise<void> { await this.start(); }

  async start(): Promise<void> {
    if (this.activeOpening) return this.activeOpening;
    if (this.state.snapshot.sessionState === 'ready') return;
    const generation = this.generation;
    const operation = this.performStart(generation);
    this.activeOpening = operation;
    try { await operation; }
    finally { if (this.activeOpening === operation) this.activeOpening = undefined; }
  }

  private async performStart(generation: number): Promise<void> {
    if (this.profile.environment && this.environment.id !== this.profile.environment) {
      this.state.snapshot.sessionState = 'failed';
      this.state.snapshot.errors = [{ type: 'MissingEnvironment', message: `Environment ${this.profile.environment} is not available. Import it with this Profile or ask the server administrator to provide it.` }];
      this.emit();
      return;
    }
    const opening = this.profile.opening;
    if (opening?.mode === 'request' && opening.request) {
      this.state.snapshot.sessionState = 'loadingOpening';
      this.state.snapshot.errors = [];
      this.emit();
      const startedAt = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let network: NetworkExchange | undefined;
      let responseStatus: number | undefined;
      let openingData: unknown;
      let missingMessage = false;
      try {
        const request = await new RequestBuilder(async (name) => this.secret(name)).build(opening.request, {
          controls: this.templateControls(),
          env: this.environment.variables,
          profile: { id: this.profile.id, name: this.profile.name },
          runtime: { simulationContext: {} },
        });
        if (generation !== this.generation) return;
        const browserRequest = enforceBrowserTls(request);
        this.registerSecrets(browserRequest);
        this.state.requestPreview = browserRequest.redacted;
        network = this.beginNetwork(browserRequest.redacted, startedAt, 'opening');
        this.emit();
        const controller = new AbortController();
        this.openingAbortController = controller;
        timeoutHandle = setTimeout(() => controller.abort(new DOMException('Opening request timed out.', 'TimeoutError')), request.timeoutMs ?? 120_000);
        const response = await fetchWithRedirectPolicy(browserRequest, controller.signal);
        if (generation !== this.generation) return;
        responseStatus = response.status;
        network.status = response.status;
        network.responseHeaders = redactKnownSecrets(redactHeaders(Object.fromEntries(response.headers.entries())), [...this.secrets.values(), ...(browserRequest.secretValues ?? [])]) as Record<string, string>;
        network.timing.headers = Date.now() - startedAt;
        network.state = 'streaming';
        this.emit();
        const body = await readBoundedOpeningText(response, MAX_OPENING_RESPONSE_BYTES);
        if (generation !== this.generation) return;
        network.transferredBytes = body.bytes;
        const safeText = redactKnownSecrets(body.text, [...this.secrets.values(), ...(browserRequest.secretValues ?? [])]) as string;
        network.responseBodyPreview = safeText.slice(0, MAX_NETWORK_RESPONSE_PREVIEW_CHARS);
        network.responseBodyTruncated = body.truncated || safeText.length > MAX_NETWORK_RESPONSE_PREVIEW_CHARS;
        try { openingData = body.text ? JSON.parse(body.text) : {}; } catch { openingData = body.text; }
        if (body.truncated) throw new Error('Opening response exceeded the maximum allowed size.');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const message = getPath(openingData, opening.response?.messagePath ?? '$.message');
        const starters = getPath(openingData, opening.response?.startersPath ?? '$.options');
        if (typeof message !== 'string') { missingMessage = true; throw new Error('Opening response did not contain a message.'); }
        const blocks = normalizeOpeningResponseBlocks(openingData, opening.response?.blocks);
        this.state.snapshot.opening = redactKnownSecrets({ message, starters: normalizeOpeningStarters(starters), ...(blocks.length ? { blocks } : {}) }, [...this.secrets.values(), ...(browserRequest.secretValues ?? [])]) as NonNullable<SessionSnapshot['opening']>;
        this.state.snapshot.sessionState = 'ready';
        network.state = 'completed';
        network.completedAt = Date.now();
        network.timing.total = network.completedAt - startedAt;
      } catch (error) {
        if (generation !== this.generation) return;
        if (this.openingAbortController?.signal.aborted && (this.openingAbortController.signal.reason as DOMException | undefined)?.name !== 'TimeoutError' && !responseStatus) {
          if (network) { network.state = 'aborted'; network.completedAt = Date.now(); network.timing.total = network.completedAt - startedAt; }
          this.state.snapshot.sessionState = 'failed';
          this.state.snapshot.errors.push({ type: 'OpeningAborted', message: 'Opening request was stopped.' });
          this.emit();
          return;
        }
        const fallback = selectOpeningFallback(opening, openingData, { status: responseStatus, missingMessage, errorType: error instanceof TypeError ? 'BrowserNetworkError' : 'OpeningError' })
          ?? (opening.failurePolicy?.useFallbackOnNetworkError ? opening.fallbacks?.[0] : undefined);
        if (network) {
          network.state = missingMessage && fallback ? 'completed' : 'failed';
          network.completedAt = Date.now();
          network.timing.total = network.completedAt - startedAt;
          if (network.state === 'failed') network.error = { type: responseStatus === undefined ? 'BrowserNetworkError' : 'OpeningError', message: browserErrorMessage(error), ...(responseStatus === undefined ? {} : { status: responseStatus }) };
        }
        if (fallback) {
          this.state.snapshot.opening = { message: fallback.message, starters: normalizeOpeningStarters(fallback.starters) };
          this.state.snapshot.sessionState = 'ready';
        } else {
          this.state.snapshot.sessionState = 'failed';
          this.state.snapshot.errors.push({ type: error instanceof TypeError ? 'BrowserNetworkError' : 'OpeningError', message: browserErrorMessage(error), retrySafe: true });
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (generation === this.generation) this.openingAbortController = undefined;
      }
      this.emit();
      return;
    }
    this.state.snapshot.sessionState = 'ready';
    if (opening?.mode === 'static') {
      this.state.snapshot.opening = { message: opening.message ?? '', starters: normalizeOpeningStarters(opening.starters) };
    }
    this.emit();
  }

  useOpeningFallback(): void {
    const fallback = this.profile.opening?.fallbacks?.[0];
    if (!fallback) return;
    this.state.snapshot.opening = { message: fallback.message, starters: normalizeOpeningStarters(fallback.starters) };
    this.state.snapshot.sessionState = 'ready';
    this.state.snapshot.errors = [];
    this.emit();
  }

  setControl(id: string, value: unknown): void {
    const definition = this.profile.controls?.find((item) => item.id === id);
    if (!definition || !isControlValue(definition, value)) return;
    if (definition.persist === 'secret') this.secretControls.set(this.controlKey(definition), value);
    else this.state.snapshot.controls[id] = value;
    if (definition.persist === 'workspace' || definition.persist === 'global') {
      try { localStorage.setItem(this.controlKey(definition), JSON.stringify({ version: 1, type: definition.type, value })); } catch { /* Private browsing may block storage. */ }
    }
    this.emit();
  }

  clear(): void {
    this.cancelActive();
    this.state.snapshot.messages = [];
    this.state.snapshot.rawEvents = [];
    this.state.snapshot.normalizedEvents = [];
    this.state.snapshot.errors = [];
    this.state.snapshot.turnState = 'idle';
    this.state.requestPreview = undefined;
    this.state.networkEntries = [];
    this.sequence = 0;
    this.turnIndex = 0;
    this.rawBytes = 0;
    this.rawSizes.length = 0;
    this.emit();
  }

  async newConversation(): Promise<void> {
    this.cancelActive();
    const previousControls = this.state.snapshot.controls;
    this.state = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
    this.sequence = 0;
    this.turnIndex = 0;
    this.rawBytes = 0;
    this.rawSizes.length = 0;
    this.resetControls();
    for (const definition of this.profile.controls ?? []) {
      if (!definition.resetOnNewConversation && previousControls[definition.id] !== undefined) this.state.snapshot.controls[definition.id] = previousControls[definition.id];
      if (definition.resetOnNewConversation) {
        if (definition.persist === 'secret') {
          if (definition.default === undefined) this.secretControls.delete(this.controlKey(definition));
          else this.secretControls.set(this.controlKey(definition), definition.default);
        } else {
          this.state.snapshot.controls[definition.id] = definition.default;
          if (definition.persist === 'workspace' || definition.persist === 'global') {
            try { localStorage.removeItem(this.controlKey(definition)); } catch { /* Storage may be unavailable. */ }
          }
        }
      }
    }
    await this.start();
  }

  async abort(): Promise<void> {
    if (this.state.snapshot.sessionState === 'loadingOpening') {
      this.cancelActive();
      const network = this.state.networkEntries.at(-1);
      if (network?.kind === 'opening' && network.state !== 'completed') network.state = 'aborted';
      this.state.snapshot.sessionState = 'failed';
      this.state.snapshot.errors.push({ type: 'OpeningAborted', message: 'Opening request was stopped.' });
      this.emit();
      return;
    }
    if (!this.abortController) return;
    if (this.activeStop) return this.activeStop;
    this.state.snapshot.turnState = 'stopping';
    this.emit();
    this.abortController.abort();
    const operation = this.requestDispatched ? this.sendRemoteStop() : Promise.resolve();
    this.activeStop = operation;
    try { await operation; }
    finally { if (this.activeStop === operation) this.activeStop = undefined; }
  }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    text = text.trim();
    if (!text || this.state.snapshot.sessionState !== 'ready' || ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(this.state.snapshot.turnState)) return;
    const startedAt = Date.now();
    const generation = this.generation;
    const clientRequestId = browserUuid();
    this.currentTurn = { clientRequestId, startedAt, text, interaction };
    const turnIndex = this.turnIndex++;
    const metrics = new MetricsCollector();
    let timeoutKind: 'request' | 'idle' | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: ReturnType<typeof setTimeout> | undefined;
    let turnNetwork: NetworkExchange | undefined;
    metrics.start();
    this.abortController = new AbortController();
    const controller = this.abortController;
    this.state.snapshot.turnState = 'submitting';
    this.state.snapshot.errors = [];
    this.emit();
    try {
      const context = {
        input: { text },
        conversation: { id: this.state.snapshot.conversationId, messages: this.state.snapshot.messages },
        opening: this.state.snapshot.opening,
        controls: this.templateControls(),
        env: this.environment.variables,
        profile: { id: this.profile.id, name: this.profile.name },
        runtime: { simulationContext: {} },
        turn: { clientRequestId, startedAt, interaction },
      };
      const request = await new RequestBuilder(async (name) => this.secret(name)).build(this.profile.conversation.send, context);
      if (generation !== this.generation) return;
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const browserRequest = enforceBrowserTls(request);
      this.registerSecrets(browserRequest);
      this.state.requestPreview = browserRequest.redacted;
      this.state.snapshot.messages.push({ id: `user-${clientRequestId}`, role: 'user', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text }], citations: [], actions: [], followups: [], metadata: { clientRequestId } });
      this.state.snapshot.messages.push({ id: `assistant-${clientRequestId}`, role: 'assistant', status: 'pending', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [], timing: {}, metadata: { clientRequestId } });
      this.boundCollections();
      this.state.snapshot.turnState = 'waitingStart';
      timeoutHandle = setTimeout(() => { timeoutKind = 'request'; controller.abort(); }, request.timeoutMs ?? 120_000);
      const resetIdleTimeout = () => {
        if (idleHandle) clearTimeout(idleHandle);
        if (request.idleTimeoutMs) idleHandle = setTimeout(() => { timeoutKind = 'idle'; controller.abort(); }, request.idleTimeoutMs);
      };
      const network = this.beginNetwork(browserRequest.redacted, startedAt, 'stream');
      turnNetwork = network;
      this.requestDispatched = true;
      this.emit();
      const response = await this.fetchWithReconnect(browserRequest, this.abortController.signal, network, metrics);
      if (generation !== this.generation) return;
      network.status = response.status;
      network.responseHeaders = this.publicValue(redactHeaders(Object.fromEntries(response.headers.entries()))) as Record<string, string>;
      network.timing.headers = Date.now() - startedAt;
      metrics.headers(network.timing.headers);
      if (!response.ok) {
        const body = await readBoundedOpeningText(response, MAX_NETWORK_RESPONSE_PREVIEW_CHARS);
        if (generation !== this.generation) return;
        network.transferredBytes += body.bytes;
        this.appendNetworkResponse(network, body.text);
        this.finishNetworkPreview(network);
        network.responseBodyTruncated = network.responseBodyTruncated || body.truncated;
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('The browser did not expose a response stream.');
      network.state = 'streaming';
      resetIdleTimeout();
      const protocol = this.profile.stream.transport === 'fixture' ? 'ndjson' : this.profile.stream.transport;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = protocol === 'sse' ? new SseParser() : undefined;
      const ndjson = protocol === 'ndjson' ? new NdjsonParser() : undefined;
      let firstChunk = true;
      stream: while (true) {
        const next = await reader.read();
        if (generation !== this.generation) { void reader.cancel(); return; }
        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        resetIdleTimeout();
        metrics.chunk(next.value.byteLength, firstChunk ? Date.now() - startedAt : 0);
        if (firstChunk) network.timing.firstChunk = Date.now() - startedAt;
        firstChunk = false;
        network.transferredBytes += next.value.byteLength;
        this.appendNetworkResponse(network, chunk);
        const records: StreamRecord[] = sse ? sse.feed(chunk).map((item) => ({ raw: item.raw, sse: item })) : ndjson ? ndjson.feed(chunk).map((raw) => ({ raw })) : [{ raw: chunk }];
        for (const record of records) {
          if (!this.accept(record.raw, protocol, startedAt, metrics, record.sse, network, clientRequestId, turnIndex)) {
            void reader.cancel();
            break stream;
          }
        }
        this.state.snapshot.metrics = { ...metrics.value };
        this.boundCollections();
        this.emit();
      }
      const tail: StreamRecord[] = sse ? sse.finish().map((item) => ({ raw: item.raw, sse: item })) : ndjson ? ndjson.finish().map((raw) => ({ raw })) : [];
      for (const record of tail) this.accept(record.raw, protocol, startedAt, metrics, record.sse, network, clientRequestId, turnIndex);
      if (!['completed', 'failed', 'aborted'].includes(this.state.snapshot.turnState)) {
        if (this.profile.stream.unexpectedEndPolicy === 'completeWithWarning') {
          this.state.snapshot.errors.push({ type: 'UnexpectedStreamEndWarning', message: 'The stream ended without a terminal event.' });
          this.state.snapshot.turnState = 'completed';
        } else throw new Error('The stream ended without a terminal event.');
      }
      this.finishNetworkPreview(network);
      network.state = 'completed';
      network.completedAt = Date.now();
      network.timing.total = network.completedAt - startedAt;
      this.finishAssistant(this.state.snapshot.turnState === 'completed' ? 'completed' : 'failed');
    } catch (error) {
      if (generation !== this.generation) return;
      if ((error as DOMException)?.name === 'AbortError' && !timeoutKind) this.state.snapshot.turnState = 'aborted';
      else {
        this.state.snapshot.turnState = 'failed';
        this.state.snapshot.errors.push({ type: timeoutKind ? timeoutKind === 'idle' ? 'IdleTimeoutError' : 'RequestTimeoutError' : error instanceof TypeError ? 'BrowserNetworkError' : 'RequestError', message: timeoutKind ? timeoutKind === 'idle' ? 'The browser response stream was idle for longer than the configured limit.' : 'The browser request exceeded its configured timeout.' : browserErrorMessage(error), retrySafe: true });
      }
      const network = turnNetwork;
      if (network && network.state !== 'completed') {
        this.finishNetworkPreview(network);
        network.state = this.state.snapshot.turnState === 'aborted' ? 'aborted' : 'failed';
        network.completedAt = Date.now();
        network.timing.total = network.completedAt - startedAt;
      }
      this.finishAssistant(this.state.snapshot.turnState === 'aborted' ? 'aborted' : 'failed');
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (idleHandle) clearTimeout(idleHandle);
      if (generation === this.generation) {
        metrics.finish(this.state.snapshot.turnState === 'aborted' ? 'user_cancel' : undefined);
        this.state.snapshot.metrics = { ...metrics.value };
        this.abortController = undefined;
        this.currentTurn = undefined;
        this.requestDispatched = false;
        this.emit();
      }
    }
  }

  replayRun(run: LocalRun, speed: ReplaySpeed): boolean {
    if (!run.rawEvents?.length || ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(this.state.snapshot.turnState)) return false;
    this.replay?.dispose();
    const snapshot = createSnapshot(true, browserUuid);
    const recorded = run.snapshot;
    if (recorded) {
      const lastUser = recorded.messages.map((message) => message.role).lastIndexOf('user');
      snapshot.messages = lastUser >= 0 ? structuredClone(recorded.messages.slice(0, lastUser + 1)) : [];
      snapshot.opening = structuredClone(recorded.opening);
      snapshot.conversationId = recorded.conversationId;
      snapshot.title = recorded.title;
    }
    snapshot.controls = structuredClone(this.state.snapshot.controls);
    snapshot.sessionState = 'ready';
    snapshot.turnState = 'streaming';
    this.state = { snapshot, requestPreview: structuredClone(run.request), networkEntries: [] };
    this.sequence = 0;
    this.rawBytes = 0;
    this.rawSizes.length = 0;
    const replay = new ReplayEngine(structuredClone(run.rawEvents), speed, async (raw) => this.acceptReplay(raw), (value) => {
      this.state.snapshot.replay = { runId: run.id, ...value } as ReplaySnapshot;
      this.emit();
    });
    this.replay = replay;
    void replay.play().then(() => {
      if (this.replay !== replay) return;
      this.state.snapshot.metrics = structuredClone(run.metrics);
      this.state.snapshot.turnState = replay.getState().status === 'completed' ? run.result.type : replay.getState().status === 'stopped' ? 'aborted' : 'failed';
      this.finishAssistant(this.state.snapshot.turnState === 'completed' ? 'completed' : this.state.snapshot.turnState === 'aborted' ? 'aborted' : 'failed');
      this.emit();
    }).catch(() => {
      this.state.snapshot.turnState = 'failed';
      this.state.snapshot.errors.push({ type: 'ReplayError', message: 'Replay failed while processing recorded browser events.' });
      this.emit();
    });
    return true;
  }

  pauseReplay(): void { this.replay?.pause(); }
  resumeReplay(): void { this.replay?.resume(); }
  stepReplay(): void { void this.replay?.step(); }
  stopReplay(): void { this.replay?.stop(); }
  setReplaySpeed(speed: ReplaySpeed): void { this.replay?.setSpeed(speed); }

  private acceptReplay(raw: RawStreamEvent): boolean {
    const replayed = structuredClone(raw);
    replayed.sequence = ++this.sequence;
    const result = new MappingEngine(this.profile.stream).map(replayed);
    replayed.mappingRuleId = result.ruleIds[0];
    replayed.mappingError = result.errors[0]?.message;
    this.pushRaw(replayed);
    for (const event of result.events) reduceEvent(this.state.snapshot, this.publicValue(event) as NormalizedEvent);
    this.boundCollections();
    return !['completed', 'failed', 'aborted'].includes(this.state.snapshot.turnState);
  }

  private accept(rawText: string, protocol: RawStreamEvent['protocol'], startedAt: number, metrics: MetricsCollector, sse: Parameters<typeof toRawEvent>[4], network: NetworkExchange, turnId: string, turnIndex: number): boolean {
    const raw = toRawEvent(protocol, rawText, ++this.sequence, startedAt, sse, this.profile.stream.dataFormat ?? 'json');
    raw.turnId = turnId;
    raw.turnIndex = turnIndex;
    raw.turnSequence = network.eventCount + 1;
    network.eventCount += 1;
    metrics.raw(raw);
    if ((sse?.data ?? rawText) === this.profile.stream.doneValue) {
      this.pushRaw(raw);
      this.state.snapshot.turnState = 'completed';
      return false;
    }
    const result = new MappingEngine(this.profile.stream).map(raw);
    raw.mappingRuleId = result.ruleIds[0];
    raw.mappingError = result.errors[0]?.message;
    this.pushRaw(raw);
    if (result.errors.length) metrics.mappingError(result.errors.length);
    if (!result.events.length) metrics.unmatched();
    for (const event of result.events) { metrics.normalized(event); reduceEvent(this.state.snapshot, this.publicValue(event) as NormalizedEvent); }
    this.boundCollections();
    return !['completed', 'failed', 'aborted'].includes(this.state.snapshot.turnState);
  }

  private beginNetwork(request: BrowserSessionState['requestPreview'] extends infer T ? T : never, startedAt: number, kind: NetworkExchange['kind']): NetworkExchange {
    const preview = request as { method: string; url: string; headers: Record<string, string>; body?: unknown };
    const entry: NetworkExchange = { id: browserUuid(), kind, attempt: 1, state: 'pending', method: preview.method, url: preview.url, requestHeaders: preview.headers, requestBody: preview.body, startedAt, timing: {}, transferredBytes: 0, eventCount: 0 };
    this.state.networkEntries.push(entry);
    while (this.state.networkEntries.length > MAX_NETWORK_ENTRIES) {
      const removed = this.state.networkEntries.shift();
      if (removed) this.networkPreviews.delete(removed.id);
    }
    return entry;
  }

  private async fetchWithReconnect(request: PreparedRequest, signal: AbortSignal, network: NetworkExchange, metrics: MetricsCollector): Promise<Response> {
    const policy = request.reconnect;
    const maxAttempts = Math.min(5, Math.max(0, policy?.maxAttempts ?? 0));
    const retryStatuses = policy?.retryOnStatuses?.length ? policy.retryOnStatuses : [429, 502, 503, 504];
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetchWithRedirectPolicy(request, signal);
        if (response.ok || attempt >= maxAttempts || !retryStatuses.includes(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        if (signal.aborted || attempt >= maxAttempts || !(error instanceof TypeError)) throw error;
      }
      network.attempt = attempt + 2;
      metrics.reconnectCount(attempt + 1);
      const base = Math.min(10_000, Math.max(0, policy?.baseDelayMs ?? 500));
      const delay = Math.min(Math.max(base, policy?.maxDelayMs ?? 10_000), base * 2 ** attempt);
      await abortableDelay(delay, signal);
    }
  }

  private async sendRemoteStop(): Promise<void> {
    const generation = this.generation;
    const stop = this.profile.conversation.stop;
    const turn = this.currentTurn;
    if (stop?.strategy !== 'abortThenRequest' || !stop.request || !turn) return;
    const context = {
      input: { text: turn.text },
      conversation: { id: this.state.snapshot.conversationId, messages: this.state.snapshot.messages },
      opening: this.state.snapshot.opening,
      controls: this.templateControls(),
      env: this.environment.variables,
      profile: { id: this.profile.id, name: this.profile.name },
      runtime: { simulationContext: {} },
      turn: { clientRequestId: turn.clientRequestId, startedAt: turn.startedAt, interaction: turn.interaction },
    };
    const missing = (stop.requiredContext ?? []).filter((path) => getPath(context, path) === undefined);
    if (missing.length) {
      this.state.snapshot.errors.push({ type: 'RemoteStopWarning', message: `Local stream stopped; remote stop skipped because context is missing: ${missing.join(', ')}.` });
      this.emit();
      return;
    }
    let network: NetworkExchange | undefined;
    const startedAt = Date.now();
    try {
      const request = enforceBrowserTls(await new RequestBuilder(async (name) => this.secret(name)).build(stop.request, context));
      if (generation !== this.generation) return;
      this.registerSecrets(request);
      network = this.beginNetwork(request.redacted, startedAt, 'stop');
      this.stopAbortController = new AbortController();
      const controller = this.stopAbortController;
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30_000);
      try {
        const response = await fetchWithRedirectPolicy(request, controller.signal);
        if (generation !== this.generation) return;
        network.status = response.status;
        network.responseHeaders = this.publicValue(redactHeaders(Object.fromEntries(response.headers.entries()))) as Record<string, string>;
        const body = await readBoundedOpeningText(response, MAX_NETWORK_RESPONSE_PREVIEW_CHARS);
        if (generation !== this.generation) return;
        network.transferredBytes = body.bytes;
        this.appendNetworkResponse(network, body.text);
        this.finishNetworkPreview(network);
        network.responseBodyTruncated = network.responseBodyTruncated || body.truncated;
        network.state = response.ok ? 'completed' : 'failed';
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (generation !== this.generation) return;
      if (network) network.state = 'failed';
      this.state.snapshot.errors.push({ type: 'RemoteStopWarning', message: `Local stream stopped; remote stop failed: ${browserErrorMessage(error)}` });
    } finally {
      if (generation === this.generation) {
        if (network) { network.completedAt = Date.now(); network.timing.total = network.completedAt - startedAt; }
        this.stopAbortController = undefined;
        this.emit();
      }
    }
  }

  private appendNetworkResponse(network: NetworkExchange, chunk: string): void {
    const previous = this.networkPreviews.get(network.id) ?? '';
    const combined = previous + chunk;
    const bounded = combined.slice(0, MAX_NETWORK_RESPONSE_PREVIEW_CHARS);
    this.networkPreviews.set(network.id, bounded);
    if (combined.length > MAX_NETWORK_RESPONSE_PREVIEW_CHARS) network.responseBodyTruncated = true;
  }

  private finishNetworkPreview(network: NetworkExchange): void {
    if (!this.networkPreviews.has(network.id)) return;
    network.responseBodyPreview = this.publicValue(this.networkPreviews.get(network.id) ?? '') as string;
    this.networkPreviews.delete(network.id);
  }

  private pushRaw(raw: RawStreamEvent): void {
    const safe = this.publicValue(raw) as RawStreamEvent;
    const bytes = new TextEncoder().encode(JSON.stringify(safe)).byteLength;
    this.state.snapshot.rawEvents.push(safe);
    this.rawSizes.push(bytes);
    this.rawBytes += bytes;
    while (this.state.snapshot.rawEvents.length > MAX_EVENTS || this.rawBytes > MAX_RAW_BYTES) {
      this.state.snapshot.rawEvents.shift();
      this.rawBytes -= this.rawSizes.shift() ?? 0;
      this.state.snapshot.droppedEventCount++;
    }
  }

  private boundCollections(): void {
    const snapshot = this.state.snapshot;
    if (snapshot.normalizedEvents.length > MAX_EVENTS) {
      const overflow = snapshot.normalizedEvents.length - MAX_EVENTS;
      snapshot.normalizedEvents.splice(0, overflow);
      snapshot.droppedNormalizedEventCount = (snapshot.droppedNormalizedEventCount ?? 0) + overflow;
    }
    if (snapshot.messages.length > MAX_MESSAGES) {
      const overflow = snapshot.messages.length - MAX_MESSAGES;
      snapshot.messages.splice(0, overflow);
      snapshot.droppedMessageCount = (snapshot.droppedMessageCount ?? 0) + overflow;
    }
    if (snapshot.errors.length > 500) snapshot.errors.splice(0, snapshot.errors.length - 500);
  }

  private registerSecrets(request: PreparedRequest): void { this.requestSecretValues = [...new Set([...this.requestSecretValues, ...(request.secretValues ?? [])])]; }
  private publicValue<T>(value: T): T { return redactKnownSecrets(value, [...this.secrets.values(), ...this.requestSecretValues, ...this.secretControls.values()]) as T; }
  private cancelActive(): void {
    this.generation++;
    this.openingAbortController?.abort();
    this.abortController?.abort();
    this.stopAbortController?.abort();
    this.replay?.dispose();
    this.replay = undefined;
    this.openingAbortController = undefined;
    this.abortController = undefined;
    this.stopAbortController = undefined;
    this.activeOpening = undefined;
    this.activeStop = undefined;
    this.currentTurn = undefined;
    this.requestDispatched = false;
    this.networkPreviews.clear();
  }

  private finishAssistant(status: 'completed' | 'failed' | 'aborted'): void {
    const message = [...this.state.snapshot.messages].reverse().find((item) => item.role === 'assistant' && (item.status === 'pending' || item.status === 'streaming'));
    if (!message) return;
    message.status = status;
    message.completedAt = Date.now();
    for (const part of message.parts) {
      if ((part.type === 'progress' || part.type === 'tool-call') && ['running', 'pending'].includes(String(part.status))) part.status = status;
    }
    if (status === 'failed' && this.profile.errorPolicy?.showErrorPart !== false) {
      const error = this.state.snapshot.errors.at(-1);
      if (error) message.parts.push({ type: 'error', text: error.message });
    }
  }

  private resetControls(): void {
    this.state.snapshot.controls = Object.fromEntries((this.profile.controls ?? []).filter((control) => control.persist !== 'secret').map((control) => {
      let value: unknown;
      if (control.persist === 'workspace' || control.persist === 'global') {
        try {
          const stored = JSON.parse(localStorage.getItem(this.controlKey(control)) ?? 'null') as { version?: number; type?: string; value?: unknown } | null;
          if (stored?.version === 1 && stored.type === control.type && isControlValue(control, stored.value)) value = stored.value;
        } catch { /* Missing or invalid browser storage falls back to the Profile default. */ }
      }
      return [control.id, value ?? control.default];
    }));
    for (const control of this.profile.controls ?? []) if (control.persist === 'secret' && !this.secretControls.has(this.controlKey(control)) && control.default !== undefined) this.secretControls.set(this.controlKey(control), control.default);
  }

  private templateControls(): Record<string, unknown> {
    const controls = { ...this.state.snapshot.controls };
    for (const definition of this.profile.controls ?? []) if (definition.persist === 'secret') controls[definition.id] = this.secretControls.get(this.controlKey(definition));
    return controls;
  }

  private controlKey(control: ControlDefinition): string { return `turnstage.web.control.${control.persist}.${this.profile.id}.${control.id}`; }

  private secret(name: string): string | undefined { return this.secrets.get(this.environment.secretReferences?.[name] ?? name); }

  private emit(): void { this.changed(this.current); }
}

interface StreamRecord { raw: string; sse?: Parameters<typeof toRawEvent>[4] }

function enforceBrowserTls(request: PreparedRequest): PreparedRequest {
  if (!request.tls?.allowInvalidCertificates) return request;
  // The browser always validates HTTPS certificates. A VS Code-only opt-out in
  // a shared Profile must not prevent otherwise valid HTTP or HTTPS requests.
  const redacted = { ...request.redacted };
  delete redacted.tls;
  return { ...request, tls: undefined, redacted };
}

function browserErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return `${error.message} Check browser connectivity, TLS certificate trust, and CORS for this target.`;
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedOpeningText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = Math.max(0, maxBytes - bytes);
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += value.byteLength;
      if (value.byteLength > remaining) { truncated = true; break; }
    }
    text += decoder.decode();
    return { text, bytes, truncated };
  } finally {
    if (truncated) { try { await reader.cancel(); } catch { /* The bounded reader intentionally stops early. */ } }
    reader.releaseLock();
  }
}

function isControlValue(definition: ControlDefinition, value: unknown): boolean {
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  return definition.type !== 'select' || !definition.options?.length || definition.options.some((option) => option.value === value);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timeout); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
