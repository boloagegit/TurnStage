import type { InteractionContext, LocalRun, NetworkExchange, RawStreamEvent, ReplaySnapshot, SessionSnapshot, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { MappingEngine } from '../../src/extension/mapping/mappingEngine';
import { RequestBuilder } from '../../src/extension/request/requestBuilder';
import { getPath } from '../../src/extension/request/templateResolver';
import { createSnapshot, reduceEvent } from '../../src/extension/runtime/reducer';
import { MetricsCollector } from '../../src/extension/runtime/metrics';
import { NdjsonParser, SseParser, toRawEvent } from '../../src/extension/transport/streamParser';
import { fetchWithRedirectPolicy } from '../../src/extension/transport/fetchPolicy';
import { ReplayEngine, type ReplaySpeed } from '../../src/extension/replay/replayEngine';

export interface BrowserSessionState {
  snapshot: SessionSnapshot;
  requestPreview?: unknown;
  networkEntries: NetworkExchange[];
}

export class BrowserSession {
  private state: BrowserSessionState = { snapshot: createSnapshot(true), networkEntries: [] };
  private abortController?: AbortController;
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
    this.abortController?.abort();
    this.profile = profile;
    this.environment = environment;
    this.state = { snapshot: createSnapshot(true), networkEntries: [] };
    this.sequence = 0;
    this.turnIndex = 0;
    this.resetControls();
    this.emit();
  }

  get current(): BrowserSessionState { return this.state; }
  get snapshot(): SessionSnapshot { return this.state.snapshot; }
  get requestPreview(): unknown { return this.state.requestPreview; }
  getNetworkEntries(): NetworkExchange[] { return structuredClone(this.state.networkEntries); }

  setEphemeralControls(values: Record<string, unknown>): void {
    this.state.snapshot.controls = { ...this.state.snapshot.controls, ...structuredClone(values) };
    this.emit();
  }

  async startSession(): Promise<void> { await this.start(); }

  async start(): Promise<void> {
    const opening = this.profile.opening;
    if (opening?.mode === 'request' && opening.request) {
      this.state.snapshot.sessionState = 'loadingOpening';
      this.state.snapshot.errors = [];
      this.emit();
      const startedAt = Date.now();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = await new RequestBuilder(async (name) => this.secret(name)).build(opening.request, {
          controls: this.state.snapshot.controls,
          env: this.environment.variables,
          profile: { id: this.profile.id, name: this.profile.name },
          runtime: { simulationContext: {} },
        });
        if (request.tls?.allowInvalidCertificates) throw new Error('Browsers cannot disable TLS certificate validation.');
        if (!this.authorize(request.url, 'opening', Boolean(request.secretValues?.length))) throw new Error('The browser request was not authorized.');
        const network = this.beginNetwork(request.redacted, startedAt, 'opening');
        const controller = new AbortController();
        timeoutHandle = setTimeout(() => controller.abort(new DOMException('Opening request timed out.', 'TimeoutError')), request.timeoutMs ?? 120_000);
        const response = await fetchWithRedirectPolicy(request, controller.signal);
        network.status = response.status;
        network.responseHeaders = Object.fromEntries(response.headers.entries());
        network.timing.headers = Date.now() - startedAt;
        network.transferredBytes = Number(response.headers.get('content-length') ?? 0);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as unknown;
        const message = getPath(data, opening.response?.messagePath ?? '$.message');
        const starters = getPath(data, opening.response?.startersPath ?? '$.options');
        if (typeof message !== 'string') throw new Error('Opening response did not contain a message.');
        this.state.snapshot.opening = { message, starters: Array.isArray(starters) ? starters.filter(isStarter) : [] };
        this.state.snapshot.sessionState = 'ready';
        network.state = 'completed';
        network.completedAt = Date.now();
        network.timing.total = network.completedAt - startedAt;
      } catch (error) {
        const fallback = opening.fallbacks?.[0];
        if (opening.failurePolicy?.useFallbackOnNetworkError && fallback) {
          this.state.snapshot.opening = { message: fallback.message, starters: fallback.starters ?? [] };
          this.state.snapshot.sessionState = 'ready';
        } else {
          this.state.snapshot.sessionState = 'failed';
          this.state.snapshot.errors.push({ type: error instanceof TypeError ? 'BrowserNetworkError' : 'OpeningError', message: browserErrorMessage(error), retrySafe: true });
        }
        const network = this.state.networkEntries.at(-1);
        if (network?.kind === 'opening' && network.state !== 'completed') network.state = 'failed';
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      this.emit();
      return;
    }
    this.state.snapshot.sessionState = 'ready';
    if (opening?.mode === 'static') {
      this.state.snapshot.opening = { message: opening.message ?? '', starters: opening.starters ?? [] };
    }
    this.emit();
  }

  useOpeningFallback(): void {
    const fallback = this.profile.opening?.fallbacks?.[0];
    if (!fallback) return;
    this.state.snapshot.opening = { message: fallback.message, starters: fallback.starters ?? [] };
    this.state.snapshot.sessionState = 'ready';
    this.state.snapshot.errors = [];
    this.emit();
  }

  setControl(id: string, value: unknown): void {
    this.state.snapshot.controls[id] = value;
    this.emit();
  }

  clear(): void {
    this.state.snapshot.messages = [];
    this.state.snapshot.rawEvents = [];
    this.state.snapshot.normalizedEvents = [];
    this.state.snapshot.errors = [];
    this.state.snapshot.turnState = 'idle';
    this.state.requestPreview = undefined;
    this.state.networkEntries = [];
    this.sequence = 0;
    this.turnIndex = 0;
    this.emit();
  }

  async newConversation(): Promise<void> {
    this.state = { snapshot: createSnapshot(true), networkEntries: [] };
    this.sequence = 0;
    this.turnIndex = 0;
    this.resetControls();
    await this.start();
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    text = text.trim();
    if (!text || ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(this.state.snapshot.turnState)) return;
    const startedAt = Date.now();
    const clientRequestId = crypto.randomUUID();
    const turnIndex = this.turnIndex++;
    const metrics = new MetricsCollector();
    let timeoutKind: 'request' | 'idle' | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: ReturnType<typeof setTimeout> | undefined;
    metrics.start();
    this.state.snapshot.turnState = 'submitting';
    this.state.snapshot.errors = [];
    this.emit();
    try {
      const context = {
        input: { text },
        conversation: { id: this.state.snapshot.conversationId, messages: this.state.snapshot.messages },
        opening: this.state.snapshot.opening,
        controls: this.state.snapshot.controls,
        env: this.environment.variables,
        profile: { id: this.profile.id, name: this.profile.name },
        runtime: { simulationContext: {} },
        turn: { clientRequestId, startedAt, interaction },
      };
      const request = await new RequestBuilder(async (name) => this.secret(name)).build(this.profile.conversation.send, context);
      if (request.tls?.allowInvalidCertificates) throw new Error('Browsers cannot disable TLS certificate validation.');
      if (!this.authorize(request.url, 'conversation', Boolean(request.secretValues?.length))) throw new Error('The browser request was not authorized.');
      this.state.requestPreview = request.redacted;
      this.state.snapshot.messages.push({ id: `user-${clientRequestId}`, role: 'user', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text }], citations: [], actions: [], followups: [], metadata: { clientRequestId } });
      this.state.snapshot.messages.push({ id: `assistant-${clientRequestId}`, role: 'assistant', status: 'pending', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [], timing: {}, metadata: { clientRequestId } });
      this.state.snapshot.turnState = 'waitingStart';
      this.abortController = new AbortController();
      timeoutHandle = setTimeout(() => { timeoutKind = 'request'; this.abortController?.abort(); }, request.timeoutMs ?? 120_000);
      const resetIdleTimeout = () => {
        if (idleHandle) clearTimeout(idleHandle);
        if (request.idleTimeoutMs) idleHandle = setTimeout(() => { timeoutKind = 'idle'; this.abortController?.abort(); }, request.idleTimeoutMs);
      };
      const network = this.beginNetwork(request.redacted, startedAt, 'stream');
      this.emit();
      const response = await fetchWithRedirectPolicy(request, this.abortController.signal);
      network.status = response.status;
      network.responseHeaders = Object.fromEntries(response.headers.entries());
      network.timing.headers = Date.now() - startedAt;
      metrics.headers(network.timing.headers);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        if (next.done) break;
        const chunk = decoder.decode(next.value, { stream: true });
        resetIdleTimeout();
        metrics.chunk(next.value.byteLength, firstChunk ? Date.now() - startedAt : 0);
        if (firstChunk) network.timing.firstChunk = Date.now() - startedAt;
        firstChunk = false;
        network.transferredBytes += next.value.byteLength;
        const records: StreamRecord[] = sse ? sse.feed(chunk).map((item) => ({ raw: item.raw, sse: item })) : ndjson ? ndjson.feed(chunk).map((raw) => ({ raw })) : [{ raw: chunk }];
        for (const record of records) {
          if (!this.accept(record.raw, protocol, startedAt, metrics, record.sse, network, clientRequestId, turnIndex)) {
            void reader.cancel();
            break stream;
          }
        }
        this.state.snapshot.metrics = { ...metrics.value };
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
      network.state = 'completed';
      this.finishAssistant(this.state.snapshot.turnState === 'completed' ? 'completed' : 'failed');
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError' && !timeoutKind) this.state.snapshot.turnState = 'aborted';
      else {
        this.state.snapshot.turnState = 'failed';
        this.state.snapshot.errors.push({ type: timeoutKind ? timeoutKind === 'idle' ? 'IdleTimeoutError' : 'RequestTimeoutError' : error instanceof TypeError ? 'BrowserNetworkError' : 'RequestError', message: timeoutKind ? timeoutKind === 'idle' ? 'The browser response stream was idle for longer than the configured limit.' : 'The browser request exceeded its configured timeout.' : browserErrorMessage(error), retrySafe: true });
      }
      const network = this.state.networkEntries.at(-1);
      if (network && network.state !== 'completed') network.state = this.state.snapshot.turnState === 'aborted' ? 'aborted' : 'failed';
      this.finishAssistant(this.state.snapshot.turnState === 'aborted' ? 'aborted' : 'failed');
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (idleHandle) clearTimeout(idleHandle);
      metrics.finish(this.state.snapshot.turnState === 'aborted' ? 'user_cancel' : undefined);
      this.state.snapshot.metrics = { ...metrics.value };
      this.abortController = undefined;
      this.emit();
    }
  }

  replayRun(run: LocalRun, speed: ReplaySpeed): boolean {
    if (!run.rawEvents?.length || ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(this.state.snapshot.turnState)) return false;
    this.replay?.dispose();
    const snapshot = createSnapshot(true);
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
    this.state.snapshot.rawEvents.push(replayed);
    const result = new MappingEngine(this.profile.stream).map(replayed);
    replayed.mappingRuleId = result.ruleIds[0];
    replayed.mappingError = result.errors[0]?.message;
    for (const event of result.events) reduceEvent(this.state.snapshot, event);
    return !['completed', 'failed', 'aborted'].includes(this.state.snapshot.turnState);
  }

  private accept(rawText: string, protocol: RawStreamEvent['protocol'], startedAt: number, metrics: MetricsCollector, sse: Parameters<typeof toRawEvent>[4], network: NetworkExchange, turnId: string, turnIndex: number): boolean {
    const raw = toRawEvent(protocol, rawText, ++this.sequence, startedAt, sse, this.profile.stream.dataFormat ?? 'json');
    raw.turnId = turnId;
    raw.turnIndex = turnIndex;
    raw.turnSequence = this.state.snapshot.rawEvents.filter((item) => item.turnId === turnId).length + 1;
    this.state.snapshot.rawEvents.push(raw);
    network.eventCount += 1;
    metrics.raw(raw);
    if ((sse?.data ?? rawText) === this.profile.stream.doneValue) {
      this.state.snapshot.turnState = 'completed';
      return false;
    }
    const result = new MappingEngine(this.profile.stream).map(raw);
    raw.mappingRuleId = result.ruleIds[0];
    raw.mappingError = result.errors[0]?.message;
    if (result.errors.length) metrics.mappingError(result.errors.length);
    if (!result.events.length) metrics.unmatched();
    for (const event of result.events) { metrics.normalized(event); reduceEvent(this.state.snapshot, event); }
    return !['completed', 'failed', 'aborted'].includes(this.state.snapshot.turnState);
  }

  private beginNetwork(request: BrowserSessionState['requestPreview'] extends infer T ? T : never, startedAt: number, kind: NetworkExchange['kind']): NetworkExchange {
    const preview = request as { method: string; url: string; headers: Record<string, string>; body?: unknown };
    const entry: NetworkExchange = { id: crypto.randomUUID(), kind, attempt: 1, state: 'pending', method: preview.method, url: preview.url, requestHeaders: preview.headers, requestBody: preview.body, startedAt, timing: {}, transferredBytes: 0, eventCount: 0 };
    this.state.networkEntries.push(entry);
    return entry;
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
    this.state.snapshot.controls = Object.fromEntries((this.profile.controls ?? []).map((control) => [control.id, control.default]));
  }

  private secret(name: string): string | undefined { return this.secrets.get(this.environment.secretReferences?.[name] ?? name); }
  private authorize(rawUrl: string, purpose: 'opening' | 'conversation', hasSecrets: boolean): boolean {
    const url = new URL(rawUrl);
    const loopback = url.hostname === 'localhost' || url.hostname === '::1' || /^127\./u.test(url.hostname);
    const automaticRemoteOpening = purpose === 'opening' && !loopback;
    const cleartextSecrets = url.protocol === 'http:' && hasSecrets && !loopback;
    if (!automaticRemoteOpening && !cleartextSecrets) return true;
    if (typeof window === 'undefined') return false;
    return window.confirm([`Allow TurnStage Web to connect to ${url.origin}?`, automaticRemoteOpening ? 'This request starts automatically when the Profile opens.' : '', cleartextSecrets ? 'This request sends secret values over unencrypted HTTP.' : ''].filter(Boolean).join('\n\n'));
  }

  private emit(): void { this.changed(structuredClone(this.state)); }
}

interface StreamRecord { raw: string; sse?: Parameters<typeof toRawEvent>[4] }

function browserErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return `${error.message} The target must allow this browser origin through CORS.`;
  return error instanceof Error ? error.message : String(error);
}

function isStarter(value: unknown): value is NonNullable<SessionSnapshot['opening']>['starters'][number] {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.label === 'string' && typeof item.prompt === 'string' && (item.behavior === 'send' || item.behavior === 'fill');
}
