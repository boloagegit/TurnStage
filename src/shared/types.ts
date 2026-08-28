export type JsonObject = Record<string, unknown>;

export interface TurnStageProfile {
  $schema?: string;
  version: number;
  id: string;
  name: string;
  description?: string;
  environment?: string;
  controls?: ControlDefinition[];
  opening?: OpeningDefinition;
  conversation: { send: RequestDefinition; stop?: StopDefinition };
  stream: StreamDefinition;
  ui?: UiDefinition;
  history?: {
    remoteSessions?: { mode: 'referenceOnly'; scope?: Array<'profile' | 'actor' | 'environment'> };
    localRuns?: { enabled?: boolean; maxRuns?: number; recordRawEvents?: boolean; recordNormalizedEvents?: boolean; recordChatSnapshot?: boolean };
  };
  errorPolicy?: { preservePartialContent?: boolean; showErrorPart?: boolean; keepConversationId?: boolean; allowContinuation?: boolean; releaseAllLocks?: boolean };
  security?: { allowedUriSchemes?: string[]; allowedDomains?: string[]; allowedCommands?: string[] };
  metrics?: { enabled?: string[]; messageEnabled?: string[] };
}

export interface ControlDefinition {
  id: string;
  type: 'select' | 'boolean' | 'text';
  label: string;
  default?: unknown;
  persist?: 'workspace' | 'global' | 'none' | 'secret';
  resetOnNewConversation?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface Starter {
  id: string;
  label: string;
  prompt: string;
  behavior: 'send' | 'fill' | 'action';
  actionId?: string;
}

export interface OpeningDefinition {
  mode: 'static' | 'request' | 'disabled';
  trigger?: 'sessionStart';
  message?: string;
  starters?: Starter[];
  request?: Omit<RequestDefinition, 'variants'>;
  response?: { messagePath?: string; startersPath?: string };
  fallbacks?: Array<{ match?: MatchCondition; message: string; starters?: Starter[] }>;
  failurePolicy?: { allowRetry?: boolean; useFallbackOnNetworkError?: boolean };
}

export interface MatchCondition {
  path?: string;
  operator?: 'equals' | 'notEquals' | 'exists' | 'notExists' | 'oneOf' | 'contains' | 'startsWith' | 'endsWith' | 'regex';
  value?: unknown;
  event?: string;
}

export interface RequestVariant {
  id: string;
  when?: MatchCondition;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RequestDefinition {
  method: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  variants?: RequestVariant[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  reconnect?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; retryOnStatuses?: number[] };
  redirectPolicy?: 'same-origin' | 'follow' | 'error';
  maxRedirects?: number;
}

export interface StopDefinition {
  strategy: 'abortOnly' | 'abortThenRequest';
  request?: RequestDefinition;
  requiredContext?: string[];
  onMissingContext?: 'localAbortWithWarning';
  preservePartialContent?: boolean;
  appendSystemNotice?: boolean;
}

export interface MappingRule {
  id: string;
  match: MatchCondition;
  emit: Record<string, unknown> & { type: string };
  continue?: boolean;
}

export interface StreamDefinition {
  transport: 'sse' | 'ndjson' | 'json' | 'text-stream' | 'fixture';
  dataFormat?: 'json' | 'text';
  mappingMode?: 'firstMatch' | 'allMatches';
  unexpectedEndPolicy?: 'fail' | 'completeWithWarning';
  doneValue?: string;
  mappings: MappingRule[];
}

export interface UiDefinition {
  layout?: { preset?: 'chat-only' | 'split-inspector' | 'chat-with-metrics' | 'compact'; inspectorPosition?: 'right' | 'bottom'; inspectorWidth?: number };
  composer?: { placeholder?: string; multiline?: boolean; enterBehavior?: 'send' | 'newline'; shiftEnterBehavior?: 'send' | 'newline'; showStopWhileStreaming?: boolean };
  streaming?: { effect?: 'none' | 'caret' | 'dots' | 'shimmer'; speedMs?: number; intensityPercent?: number };
  locks?: { whileTurnActive?: { disable?: string[]; allow?: string[] } };
  components?: Record<string, { visible?: boolean; label?: string; collapsible?: boolean; defaultCollapsed?: boolean; [key: string]: unknown }>;
  messageActions?: string[];
  messageActionVisibility?: 'always' | 'interaction';
}

export interface TurnStageEnvironment {
  version: number;
  id: string;
  name: string;
  variables: Record<string, unknown>;
  secretReferences?: Record<string, string>;
}

export type SessionState = 'notStarted' | 'loadingOpening' | 'ready' | 'resetting' | 'failed';
export type TurnState = 'idle' | 'submitting' | 'waitingStart' | 'streaming' | 'stopping' | 'completed' | 'failed' | 'aborted';

export interface InteractionContext {
  kind: 'manual' | 'starter' | 'followup' | 'responseAction' | 'formSubmit' | 'retry';
  sourceMessageId?: string;
  starterId?: string;
  followupId?: string;
  actionId?: string;
  actionKey?: string;
  formId?: string;
  formValues?: Record<string, unknown>;
}

export interface RawStreamEvent {
  sequence: number;
  receivedAt: number;
  elapsedMs: number;
  protocol: 'sse' | 'ndjson' | 'json' | 'text-stream' | 'fixture';
  sse?: { event?: string; id?: string; retry?: number };
  raw: string;
  data: unknown;
  parseError?: string;
  mappingRuleId?: string;
  mappingError?: string;
}

export interface NormalizedEvent {
  version: 1;
  type: string;
  sequence: number;
  receivedAt: number;
  rawSequence?: number;
  mappingRuleId?: string;
  [key: string]: unknown;
}

export interface Citation {
  id: string;
  title?: string;
  kind?: 'url' | 'file' | 'symbol' | 'artifact';
  uri?: string;
  path?: string;
  snippet?: string;
  description?: string;
  sourceName?: string;
  [key: string]: unknown;
}

export interface Followup { id: string; label: string; prompt: string; behavior: 'send' | 'fill' | 'action'; tooltip?: string; actionId?: string; payload?: JsonObject }
export interface ResponseAction { id: string; label: string; actionId: string; appearance?: 'primary' | 'secondary' | 'link'; tooltip?: string; payload?: JsonObject; confirm?: { title: string; message: string } }
export interface FormDefinition { type: 'form'; id: string; title: string; fields: FormField[]; submit: { action: string; messageTemplate: string; interactionKind: 'formSubmit' } }
export interface FormField { id: string; type: 'text' | 'textarea' | 'tel' | 'email' | 'number' | 'select' | 'checkbox'; label: string; required?: boolean; maxLength?: number; pattern?: string; options?: Array<{ label: string; value: string }> }

export interface MessagePart { type: string; text?: string; [key: string]: unknown }
export type MessageMetricFormat = 'number' | 'duration' | 'bytes' | 'percent' | 'text';
export type MessageMetricAggregation = 'first' | 'last' | 'sum' | 'min' | 'max' | 'count';
export interface MessageMetric {
  id: string;
  label?: string;
  value: string | number | boolean;
  unit?: string;
  format?: MessageMetricFormat;
  aggregation?: MessageMetricAggregation;
  sampleCount?: number;
}
export interface MessageTiming {
  /** Time from request start until the first rendered text or markdown delta. */
  ttft?: number;
  /** Time from request start until the turn reaches a terminal state. */
  totalDuration?: number;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
  completedAt?: number;
  parts: MessagePart[];
  citations: Citation[];
  actions: ResponseAction[];
  followups: Followup[];
  /** TurnStage-owned timing values. Kept separate from server-mapped custom metrics. */
  timing?: MessageTiming;
  metrics?: MessageMetric[];
  metadata?: JsonObject;
}

export interface MetricsSnapshot {
  requestStartedAt?: number;
  headersLatency?: number;
  firstChunkLatency?: number;
  firstEventLatency?: number;
  ttft?: number;
  streamDuration?: number;
  totalDuration?: number;
  eventCount: number;
  byteCount: number;
  averageEventGap?: number;
  maxEventGap?: number;
  parseErrorCount: number;
  mappingErrorCount: number;
  unmatchedEventCount: number;
  /** Number of reconnect attempts made after the initial request attempt. */
  reconnectCount?: number;
  abortReason?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  sessionState: SessionState;
  turnState: TurnState;
  conversationId?: string;
  title?: string;
  opening?: { message: string; starters: Starter[] };
  messages: ChatMessage[];
  rawEvents: RawStreamEvent[];
  normalizedEvents: NormalizedEvent[];
  metrics: MetricsSnapshot;
  errors: RuntimeErrorData[];
  droppedEventCount: number;
  droppedNormalizedEventCount?: number;
  droppedMessageCount?: number;
  trusted: boolean;
  controls: Record<string, unknown>;
  replay?: ReplaySnapshot;
  remoteSessions?: RemoteSessionReference[];
}

export interface ReplaySnapshot {
  runId: string;
  status: 'idle' | 'playing' | 'paused' | 'completed' | 'stopped';
  speed: 0.25 | 0.5 | 1 | 2 | 4;
  index: number;
  total: number;
}

export interface RemoteSessionReference {
  conversationId: string;
  title: string;
  createdAt: number;
  actorId?: string;
  environmentId?: string;
}

export interface RuntimeErrorData { type: string; message: string; suggestion?: string; status?: number; ruleId?: string; rawSequence?: number; retrySafe?: boolean }
export type TurnResult = { type: 'completed' } | { type: 'failed'; error: RuntimeErrorData } | { type: 'aborted'; reason: string };

export interface PreparedRequest { method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs?: number; idleTimeoutMs?: number; reconnect?: RequestDefinition['reconnect']; redirectPolicy?: RequestDefinition['redirectPolicy']; maxRedirects?: number; /** Host-only values used to scrub previews, events, errors, and persisted runs. */ secretValues?: string[]; redacted: { method: string; url: string; headers: Record<string, string>; body?: unknown; variantId?: string } }

export interface LocalRun {
  id: string;
  profileId: string;
  createdAt: number;
  request?: PreparedRequest['redacted'];
  rawEvents?: RawStreamEvent[];
  normalizedEvents?: NormalizedEvent[];
  snapshot?: SessionSnapshot;
  metrics: MetricsSnapshot;
  result: TurnResult;
}

/** Bounded metadata for the Runs list; full run payloads remain host-side. */
export interface LocalRunSummary {
  id: string;
  profileId: string;
  createdAt: number;
  metrics: MetricsSnapshot;
  result: TurnResult;
  replayable: boolean;
  hasSnapshot: boolean;
  rawEventCount?: number;
  normalizedEventCount?: number;
  messageCount?: number;
  errorCount?: number;
  request?: { method?: string; url?: string; variantId?: string };
}
