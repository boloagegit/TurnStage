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
  tests?: ProfileTestsDefinition;
}

/** Declarative, profile-owned conversation tests. No field is executable code. */
export interface ProfileTestsDefinition {
  scenarios: ScenarioDefinition[];
  /** Workspace-relative, Git-friendly adversarial suite files. */
  adversarialSuites?: string[];
  /** Optional explicit, workspace-relative CI report output. */
  reporting?: ScenarioReportingDefinition;
  visual?: ScenarioVisualDefinition;
  /** Optional declarative rubrics used only by explicit, advisory Copilot reviews. */
  qualityRubrics?: QualityRubricDefinition[];
}

export interface QualityRubricDefinition {
  id: string;
  name: string;
  description?: string;
  criteria: Array<{
    id: string;
    label: string;
    description: string;
  }>;
}

export interface ScenarioVisualDefinition {
  /** Workspace-relative baseline directory. */
  baselineDirectory: string;
  /** Maximum changed pixels accepted after channel tolerance is applied. */
  maxDifferencePercent?: number;
  /** Per-channel RGBA delta ignored by the comparator. */
  channelTolerance?: number;
}

export type ScenarioReportFormat = 'json' | 'junit' | 'html';

export interface ScenarioReportingDefinition {
  formats: ScenarioReportFormat[];
  /** Workspace-relative directory. Absolute paths and traversal are rejected. */
  outputDirectory: string;
}

/** Bounded, deterministic faults that are available only to isolated scenario sessions. */
export interface ScenarioFaultDefinition {
  /** Delay before each HTTP attempt, including retries. */
  delayBeforeRequestMs?: number;
  /** Delay before each received transport chunk is processed. */
  delayPerChunkMs?: number;
  /** Fail before issuing the HTTP request with a synthetic status. */
  httpStatus?: number;
  /** End the transport after this many parsed events have reached the runtime. */
  disconnectAfterEvents?: number;
  /** Replace this parsed event with a bounded parse-error event. */
  corruptEventAt?: number;
}

export interface ScenarioComparisonTargetDefinition {
  label?: string;
  environment?: string;
  controls?: Record<string, unknown>;
}

export interface ScenarioComparisonDefinition {
  baseline: ScenarioComparisonTargetDefinition;
  candidate: ScenarioComparisonTargetDefinition;
  /** Bounded paths removed from both semantic snapshots before comparison. */
  ignorePaths?: string[];
}

export type ScenarioPerformanceMetric =
  | 'scenario.durationMs'
  | 'metrics.headersLatency'
  | 'metrics.firstChunkLatency'
  | 'metrics.firstEventLatency'
  | 'metrics.ttft'
  | 'metrics.streamDuration'
  | 'metrics.totalDuration'
  | 'metrics.averageEventGap'
  | 'metrics.maxEventGap';

export interface ScenarioRegressionLimit {
  maxIncreaseMs?: number;
  maxIncreasePercent?: number;
}

export interface ScenarioPerformanceDefinition {
  thresholds?: Partial<Record<ScenarioPerformanceMetric, number>>;
  regression?: Partial<Record<ScenarioPerformanceMetric, ScenarioRegressionLimit>>;
}

/** Explicit, explainable links from product code or API surface to behavior tests. */
export interface ScenarioSourceBinding {
  sourceGlobs?: string[];
  components?: string[];
  endpoints?: string[];
  riskTags?: string[];
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description?: string;
  /** Optional grouping labels used by bulk adversarial suites and reports. */
  tags?: string[];
  sourceBinding?: ScenarioSourceBinding;
  /** Control values applied before the opening request and first step. */
  controls?: Record<string, unknown>;
  steps: ScenarioStepDefinition[];
  /** Assertions evaluated once after every step has completed. */
  assertions?: ScenarioAssertionDefinition[];
  comparison?: ScenarioComparisonDefinition;
  performance?: ScenarioPerformanceDefinition;
  /** Candidate-only for comparisons; applies to the sole run otherwise. */
  faults?: ScenarioFaultDefinition;
  /** Optional bounded red-team regression contract. Existing scenarios remain conversation contracts. */
  adversarial?: ScenarioAdversarialDefinition;
}

export interface ScenarioStepDefinition {
  id: string;
  name?: string;
  input: string;
  assertions?: ScenarioAssertionDefinition[];
  /** Additional prohibitions for this turn; case-level prohibitions always remain active. */
  additionalForbid?: AdversarialForbidDefinition;
}

export type AdversarialOutcome = 'resisted' | 'attackSucceeded' | 'indeterminate' | 'infrastructureError';

/**
 * Stability is deliberately separate from the four authoritative attempt
 * outcomes. It describes the sample, not a new outcome for an individual
 * request.
 */
export type AdversarialStability = 'stable-pass' | 'stable-fail' | 'unstable' | 'inconclusive';

export interface AdversarialCaseRunPolicy {
  /** Number of fresh conversations to run for this case. */
  repetitions?: number;
  /** Stop after the first successful attack, leaving the sample explicitly incomplete. */
  failFast?: boolean;
}

export interface AdversarialSuiteRunPolicy {
  /** Default number of fresh conversations for cases that do not override it. */
  defaultRepetitions?: number;
  /** Maximum number of cases that may execute in parallel. */
  maxConcurrency?: number;
  /** Upper bound for planned user-turn requests in one run. */
  maxRequests?: number;
  /** Upper bound for the sum of per-attempt whole-case deadlines. */
  maxDurationMs?: number;
  /** Stop individual cases after the first successful attack. */
  failFast?: boolean;
}

export interface AdversarialContentRule {
  id?: string;
  match: 'contains' | 'regex';
  value: string;
  caseSensitive?: boolean;
}

export interface AdversarialForbidDefinition {
  content?: Array<string | AdversarialContentRule>;
  urls?: boolean;
  ctas?: boolean;
  tools?: boolean;
  /** Exact normalized event types. */
  events?: string[];
}

export interface ScenarioAdversarialDefinition {
  mode?: 'singleTurn' | 'multiTurn';
  /** Hard safety bound. Imported cases exceeding it are invalid rather than truncated. */
  maxTurns?: number;
  /** Whole-case wall-clock deadline, separate from request and idle timeouts. */
  timeoutMs?: number;
  /** Defaults to true. */
  stopOnAttackSucceeded?: boolean;
  /** Optional number of fresh conversations for a repeated adversarial run. */
  repetitions?: number;
  /** Explicitly stop after the first attack; the aggregate remains incomplete. */
  failFast?: boolean;
  forbid: AdversarialForbidDefinition;
}

export interface AdversarialFinding {
  id: string;
  category: 'content' | 'url' | 'cta' | 'tool' | 'event';
  turnId: string;
  turnIndex: number;
  ruleId?: string;
  label: string;
  locations: ScenarioEvidenceLocation[];
}

export interface AdversarialIssue {
  id: string;
  kind: 'indeterminate' | 'infrastructure';
  turnId?: string;
  turnIndex?: number;
  label: string;
  location: ScenarioEvidenceLocation;
}

export interface AdversarialRunEvaluation {
  outcome: AdversarialOutcome;
  attemptedTurns: number;
  completedTurns: number;
  plannedTurns: number;
  maxTurns: number;
  timeoutMs: number;
  findings: AdversarialFinding[];
  issues: AdversarialIssue[];
}

export interface AdversarialAttemptSummary {
  attempt: number;
  outcome: AdversarialOutcome;
  durationMs: number;
  attemptedTurns: number;
  completedTurns: number;
  startedAt: number;
  completedAt: number;
  /** TurnStage-owned time to first displayable content, when observed. */
  ttftMs?: number;
  /** Evidence remains in the in-memory run/evidence store by default. */
  evidenceId?: string;
}

export interface AdversarialRepetitionSummary {
  requestedAttempts: number;
  completedAttempts: number;
  skippedAttempts: number;
  sampleComplete: boolean;
  outcome: AdversarialOutcome;
  stability: AdversarialStability;
  counts: Record<AdversarialOutcome, number>;
  attempts: AdversarialAttemptSummary[];
}

export interface AdversarialResultSummary {
  profileId: string;
  suiteId?: string;
  scenarioId: string;
  scenarioName: string;
  outcome: AdversarialOutcome;
  durationMs: number;
  attemptedTurns: number;
  completedTurns: number;
  plannedTurns: number;
  findingCount: number;
  issueCount: number;
  primaryFinding?: Pick<AdversarialFinding, 'category' | 'turnId' | 'turnIndex' | 'ruleId' | 'label'>;
  primaryIssue?: Pick<AdversarialIssue, 'kind' | 'turnId' | 'turnIndex' | 'label'>;
  evidenceId: string;
  primaryLocation: ScenarioEvidenceLocation;
  availableLocations: ScenarioEvidenceLocation[];
  repetitions?: Pick<AdversarialRepetitionSummary, 'requestedAttempts' | 'completedAttempts' | 'skippedAttempts' | 'sampleComplete' | 'stability' | 'counts'>;
  reliability?: AdversarialReliabilitySummary;
}

export interface AdversarialReliabilitySummary {
  requestedAttempts: number;
  completedAttempts: number;
  evaluableAttempts: number;
  coveragePercent: number;
  resistanceRate?: number;
  attackRate?: number;
  resistanceInterval?: { confidenceLevel: number; status: 'available' | 'smallSample' | 'zeroDenominator' | 'invalid'; lower?: number; upper?: number };
  ttftP95Ms?: number;
  durationP95Ms?: number;
  verdict: 'meetsTarget' | 'doesNotMeetTarget' | 'insufficientEvidence';
  reasons: string[];
}

export interface AdversarialSuiteDefinition {
  $schema?: string;
  format: 'turnstage-adversarial-suite';
  version: 1;
  id: string;
  name: string;
  description?: string;
  sourceBinding?: ScenarioSourceBinding;
  /** Existing defaults remain supported; runPolicy is the explicit run-level policy. */
  defaults?: Partial<Pick<ScenarioAdversarialDefinition, 'maxTurns' | 'timeoutMs' | 'stopOnAttackSucceeded' | 'repetitions' | 'failFast'>> & { defaultRepetitions?: number; maxRequests?: number; maxDurationMs?: number; forbid?: AdversarialForbidDefinition };
  runPolicy?: AdversarialSuiteRunPolicy;
  cases: AdversarialSuiteCaseDefinition[];
}

export interface AdversarialSuiteCaseDefinition {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  sourceBinding?: ScenarioSourceBinding;
  enabled?: boolean;
  controls?: Record<string, unknown>;
  mode?: 'singleTurn' | 'multiTurn';
  maxTurns?: number;
  timeoutMs?: number;
  stopOnAttackSucceeded?: boolean;
  /** Shorthand per-case repetition override. */
  repetitions?: number;
  /** Shorthand per-case fail-fast override. */
  failFast?: boolean;
  runPolicy?: AdversarialCaseRunPolicy;
  forbid?: AdversarialForbidDefinition;
  turns: Array<Omit<ScenarioStepDefinition, 'assertions'>>;
}

export interface ScenarioRunGroupRecord {
  format: 'turnstage-run-group';
  version: 1;
  id: string;
  profileId: string;
  suiteId?: string;
  scenarioId: string;
  scenarioName?: string;
  createdAt: number;
  updatedAt: number;
  requestedAttempts: number;
  completedAttempts: number;
  plannedTurns: number;
  plannedRequests: number;
  maximumDurationMs: number;
  sampleComplete: boolean;
  outcome: AdversarialOutcome;
  stability: AdversarialStability;
  counts: Record<AdversarialOutcome, number>;
  attempts: AdversarialAttemptSummary[];
}

export type ScenarioAssertionOperator =
  | 'equals'
  | 'notEquals'
  | 'exists'
  | 'notExists'
  | 'contains'
  | 'regex'
  | 'oneOf'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'sequenceEquals'
  | 'sequenceContains';

export interface ScenarioAssertionDefinition {
  id?: string;
  /** A bounded data path such as turn.state, assistant.text, or events.normalized[*].type. */
  path: string;
  operator: ScenarioAssertionOperator;
  value?: unknown;
  message?: string;
}

export type ScenarioEvidenceLocation =
  | { kind: 'network'; networkId?: string }
  | { kind: 'rawEvent'; sequence?: number }
  | { kind: 'normalizedEvent'; sequence?: number; rawSequence?: number }
  | { kind: 'message'; messageId?: string }
  | { kind: 'profile'; path?: string };

export type EvidenceTimelinePhase = 'request' | 'headers' | 'firstChunk' | 'firstEvent' | 'firstMappedEvent' | 'ttft' | 'finding' | 'terminal' | 'error';
export type EvidenceTimelineStatus = 'normal' | 'warning' | 'failure' | 'unknown';

/** Sanitized causal metadata sent to the Webview only for selected evidence. */
export interface EvidenceTimelineEntry {
  id: string;
  phase: EvidenceTimelinePhase;
  status: EvidenceTimelineStatus;
  label: string;
  at: number;
  elapsedMs: number;
  location?: ScenarioEvidenceLocation;
  metadata?: {
    networkKind?: NetworkExchange['kind'];
    networkState?: NetworkExchange['state'];
    protocol?: NetworkExchange['protocol'];
    statusCode?: number;
    eventType?: string;
    errorType?: string;
    ruleId?: string;
    correlationId?: string;
  };
}

export interface EvidenceTimelineSummary {
  version: 1;
  baseTime: number;
  entries: EvidenceTimelineEntry[];
  completeness: 'complete' | 'partial' | 'missing';
  missingPhases: EvidenceTimelinePhase[];
  truncated: boolean;
}

export interface ScenarioCheckResult {
  id: string;
  label: string;
  passed: boolean;
  kind: 'assertion' | 'invariant' | 'comparison' | 'performance' | 'adversarial';
  actual?: unknown;
  expected?: unknown;
  location: ScenarioEvidenceLocation;
}

export interface ScenarioStepResult {
  stepId: string;
  name: string;
  durationMs: number;
  checks: ScenarioCheckResult[];
}

export interface ScenarioRunEvidence {
  profileId: string;
  scenarioId: string;
  snapshot: SessionSnapshot;
  networkEntries: NetworkExchange[];
  requestPreview?: PreparedRequest['redacted'];
  faults?: ScenarioFaultDefinition;
}

export interface ScenarioRunResult {
  scenarioId: string;
  passed: boolean;
  durationMs: number;
  steps: ScenarioStepResult[];
  checks: ScenarioCheckResult[];
  evidence: ScenarioRunEvidence;
  adversarial?: AdversarialRunEvaluation;
  /** Present when the result is the aggregate projection of repeated attempts. */
  repetitions?: AdversarialRepetitionSummary;
  comparison?: {
    baselineLabel: string;
    candidateLabel: string;
    baselineDurationMs: number;
    candidateDurationMs: number;
    differenceCount: number;
    /** Bounded semantic field paths only; values remain in memory-only evidence. */
    differencePaths: string[];
  };
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

export type NetworkExchangeKind = 'opening' | 'stream' | 'stop';
export type NetworkExchangeState = 'pending' | 'streaming' | 'completed' | 'failed' | 'aborted';
export interface NetworkExchange {
  id: string;
  kind: NetworkExchangeKind;
  attempt: number;
  method: string;
  url: string;
  variantId?: string;
  protocol?: RawStreamEvent['protocol'];
  state: NetworkExchangeState;
  startedAt: number;
  completedAt?: number;
  status?: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBodyPreview?: string;
  responseBodyTruncated?: boolean;
  error?: RuntimeErrorData;
  timing: {
    headers?: number;
    firstChunk?: number;
    total?: number;
    timeout?: number;
    idleTimeout?: number;
    retryDelay?: number;
  };
  transferredBytes: number;
  eventCount: number;
  correlation?: NetworkCorrelation;
}

export interface NetworkCorrelation {
  traceId?: string;
  spanId?: string;
  traceFlags?: string;
  traceSource?: 'request' | 'response';
  requestId?: string;
  requestIdHeader?: string;
}

export interface ConnectionDoctorFinding {
  id: string;
  category: 'http' | 'protocol' | 'timing' | 'stream' | 'mapping' | 'terminal';
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ConnectionDoctorSummary {
  protocol: 'sse' | 'ndjson' | 'json' | 'text-stream' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  status?: number;
  rawEventCount: number;
  normalizedEventCount: number;
  mappedEventCount: number;
  unmatchedEventCount: number;
  parseErrorCount: number;
  mappingErrorCount: number;
  terminalEventSeen: boolean;
  terminalMapped: boolean;
  safe: boolean;
  findings: ConnectionDoctorFinding[];
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
