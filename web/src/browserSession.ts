import type { InteractionContext, LocalRun, NetworkExchange, PreparedRequest, RawStreamEvent, ReplaySnapshot, SessionSnapshot, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
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

export interface BrowserSessionState {
  snapshot: SessionSnapshot;
  requestPreview?: unknown;
  networkEntries: NetworkExchange[];
}

export class BrowserSession {
  private state: BrowserSessionState = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
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
    this.state = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
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
      let network: NetworkExchange | undefined;
      let responseStatus: number | undefined;
      let openingData: unknown;
      let missingMessage = false;
      try {
        const request = await new RequestBuilder(async (name) => this.secret(name)).build(opening.request, {
          controls: this.state.snapshot.controls,
          env: this.environment.variables,
          profile: { id: this.profile.id, name: this.profile.name },
          runtime: { simulationContext: {} },
        });
        const browserRequest = enforceBrowserTls(request);
        this.state.requestPreview = browserRequest.redacted;
        network = this.beginNetwork(browserRequest.redacted, startedAt, 'opening');
        this.emit();
        const controller = new AbortController();
        timeoutHandle = setTimeout(() => controller.abort(new DOMException('Opening request timed out.', 'TimeoutError')), request.timeoutMs ?? 120_000);
        const response = await fetchWithRedirectPolicy(browserRequest, controller.signal);
        responseStatus = response.status;
        network.status = response.status;
        network.responseHeaders = redactKnownSecrets(redactHeaders(Object.fromEntries(response.headers.entries())), [...this.secrets.values(), ...(browserRequest.secretValues ?? [])]) as Record<string, string>;
        network.timing.headers = Date.now() - startedAt;
        network.state = 'streaming';
        this.emit();
        const body = await readBoundedOpeningText(response, MAX_OPENING_RESPONSE_BYTES);
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
    this.state = { snapshot: createSnapshot(true, browserUuid), networkEntries: [] };
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
    const clientRequestId = browserUuid();
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
      const browserRequest = enforceBrowserTls(request);
      this.state.requestPreview = browserRequest.redacted;
      this.state.snapshot.messages.push({ id: `user-${clientRequestId}`, role: 'user', status: 'completed', createdAt: Date.now(), completedAt: Date.now(), parts: [{ type: 'text', text }], citations: [], actions: [], followups: [], metadata: { clientRequestId } });
      this.state.snapshot.messages.push({ id: `assistant-${clientRequestId}`, role: 'assistant', status: 'pending', createdAt: Date.now(), parts: [], citations: [], actions: [], followups: [], timing: {}, metadata: { clientRequestId } });
      this.state.snapshot.turnState = 'waitingStart';
      this.abortController = new AbortController();
      timeoutHandle = setTimeout(() => { timeoutKind = 'request'; this.abortController?.abort(); }, request.timeoutMs ?? 120_000);
      const resetIdleTimeout = () => {
        if (idleHandle) clearTimeout(idleHandle);
        if (request.idleTimeoutMs) idleHandle = setTimeout(() => { timeoutKind = 'idle'; this.abortController?.abort(); }, request.idleTimeoutMs);
      };
      const network = this.beginNetwork(browserRequest.redacted, startedAt, 'stream');
      this.emit();
      const response = await fetchWithRedirectPolicy(browserRequest, this.abortController.signal);
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
    const entry: NetworkExchange = { id: browserUuid(), kind, attempt: 1, state: 'pending', method: preview.method, url: preview.url, requestHeaders: preview.headers, requestBody: preview.body, startedAt, timing: {}, transferredBytes: 0, eventCount: 0 };
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

  private emit(): void { this.changed(structuredClone(this.state)); }
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
