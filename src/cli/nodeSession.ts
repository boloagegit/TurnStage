import type {
  InteractionContext,
  NetworkExchange,
  PreparedRequest,
  RawStreamEvent,
  RequestDefinition,
  ScenarioDefinition,
  SessionSnapshot,
  TurnStageEnvironment,
  TurnStageProfile,
} from '../shared/types';
import type { ScenarioSession } from '../extension/testing/scenarioRunner';
import { MappingEngine } from '../extension/mapping/mappingEngine';
import { selectOpeningFallback } from '../extension/opening/fallbackResolver';
import { getPath, resolveTemplate } from '../extension/request/templateResolver';
import { createSnapshot, reduceEvent } from '../extension/runtime/reducer';
import { HttpStreamTransport } from '../extension/transport/transport';
import { fetchBoundedText } from '../extension/transport/boundedFetch';
import { isSafeRegexPattern } from '../shared/regexSafety';

const MAX_EVENTS = 5_000;
const MAX_MESSAGES = 500;
const MAX_OPENING_RESPONSE_BYTES = 64 * 1024;

/** Minimal Node host for the shared Scenario runner. It owns no verdict logic. */
export class NodeScenarioSession implements ScenarioSession {
  readonly snapshot: SessionSnapshot = createSnapshot(true);
  requestPreview?: PreparedRequest['redacted'];
  private readonly mapping: MappingEngine;
  private readonly network: NetworkExchange[] = [];
  private abortController?: AbortController;

  constructor(
    private readonly profile: TurnStageProfile,
    private readonly environment: TurnStageEnvironment,
    private readonly scenario: ScenarioDefinition,
    private readonly workspaceRoot: string,
  ) {
    this.mapping = new MappingEngine(profile.stream);
    this.snapshot.controls = Object.fromEntries((profile.controls ?? []).filter((item) => item.persist !== 'secret').map((item) => [item.id, structuredClone(item.default)]));
  }

  setEphemeralControls(values: Record<string, unknown>): void { this.snapshot.controls = { ...this.snapshot.controls, ...structuredClone(values) }; }

  async startSession(): Promise<void> {
    const opening = this.profile.opening;
    this.snapshot.sessionState = 'loadingOpening';
    if (!opening || opening.mode === 'disabled') { this.snapshot.opening = undefined; this.snapshot.sessionState = 'ready'; return; }
    if (opening.mode === 'static') {
      this.snapshot.opening = { message: opening.message ?? '', starters: structuredClone(opening.starters ?? []) };
      this.snapshot.sessionState = 'ready';
      return;
    }
    const startedAt = Date.now();
    let entry: NetworkExchange | undefined;
    try {
      if (!opening.request) throw new Error('Opening request is missing.');
      const request = await buildRequest(opening.request, this.context('', { kind: 'manual' }, crypto.randomUUID(), startedAt), (name) => this.secret(name));
      this.requestPreview = request.redacted;
      entry = {
        id: `opening-${crypto.randomUUID()}`,
        kind: 'opening', attempt: 1, method: request.method, url: stripQuery(request.url), variantId: request.redacted.variantId,
        state: 'pending', startedAt, requestHeaders: {}, timing: { timeout: request.timeoutMs ?? 30_000 }, transferredBytes: 0, eventCount: 0,
      };
      this.network.push(entry);
      this.abortController = new AbortController();
      const bounded = await fetchBoundedText(request, {
        controller: this.abortController,
        timeoutMs: request.timeoutMs ?? 30_000,
        maxBytes: MAX_OPENING_RESPONSE_BYTES,
        rejectOnTruncate: true,
        timeoutMessage: 'The opening request timeout elapsed.',
        tooLargeMessage: `Opening response exceeded ${MAX_OPENING_RESPONSE_BYTES} bytes.`,
        onHeaders: (response) => {
          entry!.status = response.status;
          entry!.timing.headers = Date.now() - startedAt;
          entry!.state = 'streaming';
        },
        onChunk: (bytes) => { entry!.transferredBytes = bytes; },
        onTruncate: () => { entry!.responseBodyTruncated = true; },
      });
      const { response, text: responseText } = bounded;
      let data: unknown = responseText;
      try { data = responseText ? JSON.parse(responseText) : {}; } catch { /* fallback matching can still inspect the status */ }
      if (!response.ok) {
        const fallback = selectOpeningFallback(opening, data, { status: response.status });
        if (fallback) { entry.state = 'failed'; this.useOpeningFallback(fallback); return; }
        throw new Error(`Opening request failed with HTTP ${response.status}.`);
      }
      const message = getPath(data, opening.response?.messagePath ?? '$.message');
      const starters = getPath(data, opening.response?.startersPath ?? '$.options');
      if (typeof message !== 'string') {
        const fallback = selectOpeningFallback(opening, data, { status: response.status, missingMessage: true });
        if (fallback) { entry.state = 'completed'; this.useOpeningFallback(fallback); return; }
        throw new Error('Opening response did not contain a message.');
      }
      this.snapshot.opening = { message, starters: Array.isArray(starters) ? structuredClone(starters) : [] };
      this.snapshot.sessionState = 'ready';
      entry.state = 'completed';
    } catch (error) {
      const fallback = opening.failurePolicy?.useFallbackOnNetworkError
        ? selectOpeningFallback(opening, undefined, { errorType: error instanceof Error ? error.name : 'NetworkError' }) ?? opening.fallbacks?.[0]
        : undefined;
      if (fallback) this.useOpeningFallback(fallback);
      else {
        this.snapshot.sessionState = 'failed';
        this.snapshot.errors.push({ type: 'OpeningError', message: error instanceof Error ? error.message : 'Opening request failed.' });
        if (entry) { entry.state = 'failed'; entry.error = { type: 'OpeningError', message: 'Opening request failed.' }; }
        throw error;
      }
    } finally {
      this.abortController = undefined;
      if (entry) { entry.completedAt = Date.now(); entry.timing.total = entry.completedAt - startedAt; }
      this.bound();
    }
  }

  async send(text: string, interaction: InteractionContext): Promise<void> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const request = await buildRequest(this.profile.conversation.send, this.context(text, interaction, requestId, startedAt), (name) => this.secret(name));
    this.requestPreview = request.redacted;
    const assistantId = `assistant-${requestId}`;
    this.snapshot.messages.push(
      { id: `user-${requestId}`, role: 'user', status: 'completed', createdAt: startedAt, completedAt: startedAt, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] },
      { id: assistantId, role: 'assistant', status: 'pending', createdAt: startedAt, parts: [], citations: [], actions: [], followups: [] },
    );
    this.snapshot.turnState = 'waitingStart';
    this.abortController = new AbortController();
    const entry: NetworkExchange = {
      id: `network-${requestId}`,
      kind: 'stream', attempt: 1, method: request.method, url: stripQuery(request.url), variantId: request.redacted.variantId,
      protocol: this.profile.stream.transport === 'fixture' ? 'ndjson' : this.profile.stream.transport,
      state: 'pending', startedAt, requestHeaders: {}, timing: {}, transferredBytes: 0, eventCount: 0,
    };
    this.network.push(entry);
    let terminal = false;
    try {
      const protocol = this.profile.stream.transport === 'fixture' ? 'ndjson' : this.profile.stream.transport;
      const transport = new HttpStreamTransport({ faults: this.scenario.faults });
      const result = await transport.start(request, protocol, {
        onHeaders: (latency, _contentType, status) => { entry.status = status; entry.timing.headers = latency; entry.state = 'streaming'; },
        onChunk: (bytes, latency) => { entry.transferredBytes += bytes; if (latency > 0 && entry.timing.firstChunk === undefined) entry.timing.firstChunk = latency; },
        onEvent: async (raw) => {
          entry.eventCount += 1;
          const keepReading = this.acceptRaw(raw);
          if (!keepReading) terminal = true;
          return keepReading;
        },
      }, this.abortController.signal, this.profile.stream.dataFormat ?? 'json');
      if (result.aborted) this.finalize('aborted');
      else if (!terminal) {
        if (this.profile.stream.unexpectedEndPolicy === 'completeWithWarning') {
          this.snapshot.errors.push({ type: 'UnexpectedStreamEndWarning', message: 'The stream ended without a terminal event.' });
          this.finalize('completed');
        } else {
          this.snapshot.errors.push({ type: 'UnexpectedStreamEndError', message: 'The stream ended without a terminal event.' });
          this.finalize('failed');
        }
      }
      const turnState: string = this.snapshot.turnState;
      entry.state = turnState === 'completed' ? 'completed' : turnState === 'aborted' ? 'aborted' : 'failed';
    } catch (error) {
      this.snapshot.errors.push({ type: error instanceof Error ? error.name : 'NetworkError', message: error instanceof Error ? error.message : 'Network execution failed.' });
      this.finalize('failed');
      entry.state = 'failed';
      entry.error = { type: 'NetworkError', message: 'Network execution failed.' };
      throw error;
    } finally {
      entry.completedAt = Date.now();
      entry.timing.total = entry.completedAt - startedAt;
      this.abortController = undefined;
      this.bound();
    }
  }

  async abort(): Promise<void> { this.abortController?.abort(); if (this.snapshot.turnState !== 'completed') this.finalize('aborted'); }
  getNetworkEntries(): NetworkExchange[] { return structuredClone(this.network); }

  private acceptRaw(raw: RawStreamEvent): boolean {
    this.snapshot.rawEvents.push(raw);
    this.snapshot.metrics.eventCount += 1;
    this.snapshot.metrics.byteCount += Buffer.byteLength(raw.raw);
    if (raw.parseError) this.snapshot.metrics.parseErrorCount += 1;
    if (raw.data === (this.profile.stream.doneValue ?? '[DONE]')) { this.finalize('completed'); return false; }
    const mapped = this.mapping.map(raw);
    raw.mappingRuleId = mapped.ruleIds.join(', ') || undefined;
    raw.mappingError = mapped.errors.map((item) => `${item.ruleId}: ${item.message}`).join('; ') || undefined;
    this.snapshot.metrics.mappingErrorCount += mapped.errors.length;
    if (!mapped.events.length) this.snapshot.metrics.unmatchedEventCount += 1;
    for (const event of mapped.events) {
      reduceEvent(this.snapshot, event);
      if (event.type === 'stream.completed') { this.finalize('completed'); return false; }
      if (event.type === 'stream.failed') { this.finalize('failed'); return false; }
      if (event.type === 'stream.aborted') { this.finalize('aborted'); return false; }
    }
    this.bound();
    return true;
  }

  private finalize(state: 'completed' | 'failed' | 'aborted'): void {
    this.snapshot.turnState = state;
    const assistant = [...this.snapshot.messages].reverse().find((item) => item.role === 'assistant' && (item.status === 'pending' || item.status === 'streaming'));
    if (assistant) { assistant.status = state; assistant.completedAt = Date.now(); }
  }

  private context(text: string, interaction: InteractionContext, clientRequestId: string, startedAt: number): Record<string, unknown> {
    const lastUser = [...this.snapshot.messages].reverse().find((item) => item.role === 'user');
    const lastAssistant = [...this.snapshot.messages].reverse().find((item) => item.role === 'assistant');
    return { input: { text }, conversation: { id: this.snapshot.conversationId, messages: this.snapshot.messages, lastUserMessage: lastUser, lastAssistantMessage: lastAssistant }, opening: this.snapshot.opening, controls: this.snapshot.controls, env: this.environment.variables, profile: { id: this.profile.id, name: this.profile.name }, workspace: { folder: this.workspaceRoot }, runtime: { simulationContext: {} }, turn: { clientRequestId, startedAt, assistantMessageId: lastAssistant?.id, interaction } };
  }

  private async secret(name: string): Promise<string | undefined> {
    const storageName = this.environment.secretReferences?.[name] ?? name;
    const environmentName = storageName.startsWith('TURNSTAGE_SECRET_')
      ? storageName
      : `TURNSTAGE_SECRET_${storageName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    return process.env[environmentName];
  }

  private useOpeningFallback(fallback: NonNullable<NonNullable<TurnStageProfile['opening']>['fallbacks']>[number]): void {
    this.snapshot.opening = { message: fallback.message, starters: structuredClone(fallback.starters ?? []) };
    this.snapshot.sessionState = 'ready';
  }

  private bound(): void {
    if (this.snapshot.rawEvents.length > MAX_EVENTS) { const count = this.snapshot.rawEvents.length - MAX_EVENTS; this.snapshot.rawEvents.splice(0, count); this.snapshot.droppedEventCount += count; }
    if (this.snapshot.normalizedEvents.length > MAX_EVENTS) { const count = this.snapshot.normalizedEvents.length - MAX_EVENTS; this.snapshot.normalizedEvents.splice(0, count); this.snapshot.droppedNormalizedEventCount = (this.snapshot.droppedNormalizedEventCount ?? 0) + count; }
    if (this.snapshot.messages.length > MAX_MESSAGES) { const count = this.snapshot.messages.length - MAX_MESSAGES; this.snapshot.messages.splice(0, count); this.snapshot.droppedMessageCount = (this.snapshot.droppedMessageCount ?? 0) + count; }
  }
}

async function buildRequest(definition: RequestDefinition, context: Record<string, unknown>, getSecret: (name: string) => Promise<string | undefined>): Promise<PreparedRequest> {
  const variant = definition.variants?.find((candidate) => matchesVariant(candidate.when, context));
  if (definition.variants?.length && !variant) throw new Error('No request variant matched the current interaction.');
  const secretValues: string[] = [];
  const resolveSecret = async (name: string): Promise<string | undefined> => {
    const value = await getSecret(name);
    if (value) secretValues.push(value);
    return value;
  };
  const url = String(await resolveTemplate(definition.url, context, resolveSecret));
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP and HTTPS requests are supported.');
  const headers = await resolveTemplate({ ...definition.headers, ...variant?.headers }, context, resolveSecret) as Record<string, string>;
  const resolvedBody = await resolveTemplate(variant?.body ?? definition.body, context, resolveSecret);
  return {
    method: definition.method, url, headers, body: resolvedBody === undefined ? undefined : JSON.stringify(resolvedBody),
    timeoutMs: definition.timeoutMs ?? 120_000, idleTimeoutMs: definition.idleTimeoutMs, reconnect: definition.reconnect, redirectPolicy: definition.redirectPolicy, maxRedirects: definition.maxRedirects, secretValues,
    redacted: { method: definition.method, url: stripQuery(url), headers: Object.fromEntries(Object.keys(headers).map((key) => [key, '[REDACTED]'])), body: resolvedBody === undefined ? undefined : '[REDACTED]', variantId: variant?.id },
  };
}

function matchesVariant(condition: NonNullable<RequestDefinition['variants']>[number]['when'], context: Record<string, unknown>): boolean {
  if (!condition) return true;
  const actual = getPath(context, condition.path ?? '');
  const expected = condition.value;
  if (condition.operator === 'exists') return actual !== undefined && actual !== null;
  if (condition.operator === 'notExists') return actual === undefined || actual === null;
  if (condition.operator === 'notEquals') return actual !== expected;
  if (condition.operator === 'oneOf') return Array.isArray(expected) && expected.includes(actual);
  if (condition.operator === 'contains') return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected));
  if (condition.operator === 'startsWith') return String(actual ?? '').startsWith(String(expected));
  if (condition.operator === 'endsWith') return String(actual ?? '').endsWith(String(expected));
  if (condition.operator === 'regex') return isSafeRegexPattern(expected) && new RegExp(expected, 'u').test(String(actual ?? '').slice(0, 4096));
  return actual === expected;
}

function stripQuery(value: string): string { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString(); } catch { return '[invalid-url]'; } }
