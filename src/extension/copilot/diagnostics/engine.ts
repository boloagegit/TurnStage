import {
  COMPARISON_METRICS,
  DIAGNOSTIC_CAPSULE_VERSION,
  DIAGNOSTIC_FOCUSES,
  DIAGNOSTIC_OUTCOMES,
  DIAGNOSIS_RESULT_VERSION,
  TIMING_STAGES,
  type BaselineCandidateExplanationV1,
  type BaselineCandidateInput,
  type DiagnosticAssertionSummaryV1,
  type DiagnosticCapsuleV1,
  type DiagnosticErrorInput,
  type DiagnosticErrorSummaryV1,
  type DiagnosticEvidenceInput,
  type DiagnosticEvidenceRefV1,
  type DiagnosticFindingV1,
  type DiagnosticFocus,
  type DiagnosticInput,
  type DiagnosticMetricsInput,
  type DiagnosticMetricsV1,
  type DiagnosticNextActionV1,
  type DiagnosticOutcome,
  type DiagnosticRepetitionInput,
  type DiagnosticSource,
  type DiagnosticTimingInput,
  type DiagnosticTransportInput,
  type DiagnosticTransportV1,
  type DiagnosticVariantSummaryV1,
  type DiagnosticVariantInput,
  type DiagnosisResultV1,
  type EvidenceLevel,
  type MetricComparisonV1,
  type RepeatAnalysisV1,
  type RootCauseCategory,
  type TimingLadderV1,
  type TimingStage,
  type TimingStageObservationV1,
} from './contracts';

const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 160;
const MAX_ERROR_COUNT = 32;
const MAX_EVIDENCE_COUNT = 64;
const MAX_FINDING_COUNT = 12;
const MAX_ACTION_COUNT = 8;
const MAX_ATTEMPTS = 100;
const MAX_CONFIG_ISSUES = 32;
const MAX_FAILED_ASSERTIONS = 32;
const MAX_ELAPSED_MS = 86_400_000;
const MAX_COUNTER = 1_000_000_000;
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_SUMMARY_LENGTH = 512;

const EVIDENCE_RANK: Record<EvidenceLevel, number> = { strong: 3, moderate: 2, limited: 1 };
const ROOT_CAUSE_RANK: Record<RootCauseCategory, number> = {
  config: 0,
  auth: 1,
  proxy: 2,
  network: 3,
  backend: 4,
  timeout: 5,
  parser: 6,
  mapping: 7,
  variant: 8,
  assertion: 9,
  incomplete: 10,
  cancel: 11,
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const SAFE_PATH = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*(?:\.[A-Za-z0-9_$][A-Za-z0-9_$.-]*)*$/;

const OUTCOME_SET = new Set<string>(DIAGNOSTIC_OUTCOMES);
const FOCUS_SET = new Set<string>(DIAGNOSTIC_FOCUSES);
const STAGE_SET = new Set<string>(TIMING_STAGES);

/**
 * Convert the host's existing metrics and bounded transport metadata into a
 * deterministic, disclosure-safe capsule.  This function never copies an
 * arbitrary string from the input into the result.
 */
export function createDiagnosticCapsule(input: DiagnosticInput): DiagnosticCapsuleV1 {
  const timing = buildTimingLadder(input.timing, input.metrics, input.transport);
  const metrics = normalizeMetrics(input.metrics, timing);
  const transport = normalizeTransport(input.transport);
  const errors = normalizeErrors(input.errors, input.transport);
  const evidence = normalizeEvidence(input.evidence);
  const configIssues = normalizeConfigIssues(input.configIssues);
  const assertions = normalizeAssertions(input.assertions);
  const variant = normalizeVariant(input.variant, input.transport);
  const repetition = input.repetition === undefined ? undefined : analyzeRepetitions(input.repetition);

  return {
    version: DIAGNOSTIC_CAPSULE_VERSION,
    sanitized: true,
    runId: safeRequiredId(input.runId, 'unknown-run'),
    caseId: safeId(input.caseId),
    profileId: safeId(input.profileId),
    attempt: boundedInteger(input.attempt, 1, MAX_ATTEMPTS),
    outcome: normalizeOutcome(input.outcome),
    timing,
    metrics,
    transport,
    errors,
    evidence,
    configIssues,
    assertions,
    variant,
    repetition,
  };
}

/** Alias retained for callers that prefer a builder-style name. */
export const buildDiagnosticCapsule = createDiagnosticCapsule;

/**
 * Infer only explainable root-cause signals.  The result is intentionally
 * advisory: it does not alter a formal test outcome or an exit code.
 */
export function diagnoseRun(input: DiagnosticInput): DiagnosisResultV1 {
  const capsule = createDiagnosticCapsule(input);
  const focus = normalizeFocus(input.focus);
  const comparison = input.baseline !== undefined && input.candidate !== undefined
    ? explainBaselineCandidate(input.baseline, input.candidate)
    : undefined;
  const findings = inferFindings(capsule, boundedTimeout(input.timeoutMs), comparison);
  const primaryFinding = findings[0];
  const evidenceLevel = primaryFinding?.evidenceLevel ?? (capsule.timing.stages.some((stage) => stage.observed) ? 'limited' : 'limited');
  const status = diagnosisStatus(capsule, findings);
  const nextActions = nextActionsFor(findings, capsule);
  const defaultSummary = boundedSummary(primaryFinding
    ? `${primaryFinding.label}. ${primaryFinding.reason}`
    : status === 'complete'
      ? 'No deterministic root-cause signal was observed in the available TurnStage evidence.'
      : 'Insufficient TurnStage evidence to identify a deterministic root cause.');
  const summary = focusedSummary(focus, defaultSummary, capsule.repetition, comparison);

  return {
    version: DIAGNOSIS_RESULT_VERSION,
    sanitized: true,
    runId: capsule.runId,
    focus,
    status,
    evidenceLevel,
    summary,
    capsule,
    findings,
    primaryFinding,
    nextActions,
    repetition: capsule.repetition,
    comparison,
  };
}

function normalizeFocus(value: unknown): DiagnosticFocus {
  return typeof value === 'string' && FOCUS_SET.has(value) ? value as DiagnosticFocus : 'failure';
}

function focusedSummary(focus: DiagnosticFocus, fallback: string, repetition?: RepeatAnalysisV1, comparison?: BaselineCandidateExplanationV1): string {
  if (focus === 'stability') return boundedSummary(repetition?.explanation ?? `Stability focus: ${fallback}`);
  if (focus === 'comparison') return boundedSummary(comparison?.summary ?? `Comparison focus: ${fallback}`);
  if (focus === 'performance') return boundedSummary(`Performance focus: ${fallback}`);
  if (focus === 'configuration') return boundedSummary(`Configuration focus: ${fallback}`);
  return fallback;
}

/** Short alias for integration surfaces and tests. */
export const diagnose = diagnoseRun;

/**
 * Preserve every timing stage in a fixed order. Missing and invalid stages
 * are represented explicitly so a Copilot explanation cannot mistake a
 * missing measurement for a fast measurement.
 */
export function buildTimingLadder(
  timingInput?: DiagnosticTimingInput,
  metricsInput?: DiagnosticMetricsInput,
  transportInput?: DiagnosticTransportInput,
): TimingLadderV1 {
  const timing = timingInput ?? {};
  const metrics = metricsInput ?? {};
  const transport = transportInput ?? {};
  const explicit = new Map<TimingStage, unknown>([
    ['request', timing.request],
    ['headers', timing.headers],
    ['firstChunk', timing.firstChunk],
    ['firstRawEvent', timing.firstRawEvent],
    ['firstNormalizedContent', timing.firstNormalizedContent],
    ['firstVisibleText', timing.firstVisibleText],
    ['terminal', timing.terminal],
  ]);

  const fallback = new Map<TimingStage, { value: unknown; source: DiagnosticSource }>([
    ['headers', { value: metrics.headersLatency ?? transport.headersLatency, source: metrics.headersLatency !== undefined ? 'metrics' : 'network' }],
    ['firstChunk', { value: metrics.firstChunkLatency ?? transport.firstChunkLatency, source: metrics.firstChunkLatency !== undefined ? 'metrics' : 'network' }],
    ['firstRawEvent', { value: metrics.firstEventLatency, source: 'metrics' }],
    ['firstNormalizedContent', { value: metrics.firstNormalizedContentLatency, source: 'normalizedEvent' }],
    ['firstVisibleText', { value: metrics.firstVisibleTextLatency ?? metrics.ttft, source: 'metrics' }],
    ['terminal', { value: metrics.totalDuration ?? transport.terminalLatency, source: metrics.totalDuration !== undefined ? 'metrics' : 'network' }],
  ]);
  const stages: TimingStageObservationV1[] = [];
  const anomalies: string[] = [];
  let anyObserved = false;
  let previousElapsed: number | undefined;

  for (const stage of TIMING_STAGES) {
    const explicitValue = explicit.get(stage);
    const hasExplicitValue = explicitValue !== undefined;
    const candidate = hasExplicitValue ? { value: explicitValue, source: 'result' as const } : fallback.get(stage);
    if (stage === 'request' && !hasExplicitValue) {
      // requestStartedAt is an absolute timestamp and is never exposed. It
      // only proves that the zero point existed.
      const requestStarted = finiteNumber(metrics.requestStartedAt);
      if (requestStarted !== undefined || hasAnyTimingCandidate(fallback)) {
        stages.push({ stage, observed: true, elapsedMs: 0, source: requestStarted === undefined ? 'result' : 'metrics', note: 'observed' });
        anyObserved = true;
        previousElapsed = 0;
        continue;
      }
    }
    if (!candidate || candidate.value === undefined) {
      stages.push({ stage, observed: false, note: 'missing' });
      continue;
    }
    const elapsed = boundedElapsed(candidate.value);
    if (elapsed === undefined) {
      stages.push({ stage, observed: false, note: 'invalid' });
      anomalies.push(`invalid-stage:${stage}`);
      continue;
    }
    if (previousElapsed !== undefined && elapsed < previousElapsed) {
      anomalies.push(`timing-order:${stage}`);
    }
    stages.push({ stage, observed: true, elapsedMs: elapsed, source: candidate.source, note: 'observed' });
    anyObserved = true;
    previousElapsed = elapsed;
  }

  // A non-empty timing value proves that a request existed even when the
  // runtime did not retain requestStartedAt in its bounded snapshot.
  if (!stages[0]?.observed && anyObserved) {
    stages[0] = { stage: 'request', observed: true, elapsedMs: 0, source: 'result', note: 'observed' };
  }
  return {
    stages,
    missingStages: stages.filter((stage) => !stage.observed).map((stage) => stage.stage),
    orderingValid: anomalies.every((anomaly) => !anomaly.startsWith('timing-order:')),
    anomalies: uniqueStrings(anomalies, TIMING_STAGES.length),
  };
}

/**
 * Reduce repeated attempts to a bounded stability statement. A partial sample
 * is never promoted to stable, even when all completed attempts agree.
 */
export function analyzeRepetitions(input: DiagnosticRepetitionInput): RepeatAnalysisV1 {
  const rawAttempts = Array.isArray(input.attempts) ? input.attempts : [];
  const attempts = rawAttempts.slice(0, MAX_ATTEMPTS);
  const counts = emptyOutcomeCounts();
  const ordered = attempts.map((rawAttempt, index) => {
    const attempt = asRecord(rawAttempt);
    return { attempt, index, ordinal: boundedInteger(attempt.attempt, 1, MAX_ATTEMPTS) ?? index + 1 };
  })
    .sort((left, right) => left.ordinal - right.ordinal || left.index - right.index);
  for (const entry of ordered) counts[normalizeOutcome(entry.attempt.outcome)]++;

  const explicitRequested = boundedInteger(input.requestedAttempts, 1, MAX_ATTEMPTS);
  const requestedAttempts = Math.max(explicitRequested ?? 0, Math.min(rawAttempts.length, MAX_ATTEMPTS), 1);
  const completedAttempts = attempts.length;
  const skippedAttempts = Math.max(0, requestedAttempts - completedAttempts);
  const explicitComplete = typeof input.sampleComplete === 'boolean' ? input.sampleComplete : undefined;
  const truncatedBeforeRequestedSample = rawAttempts.length > MAX_ATTEMPTS && explicitRequested === undefined;
  const sampleComplete = explicitComplete === true && completedAttempts === requestedAttempts
    ? true
    : explicitComplete === false
      ? false
      : completedAttempts === requestedAttempts && !truncatedBeforeRequestedSample;
  const hasPass = counts.resisted + counts.passed > 0;
  const hasFail = counts.attackSucceeded + counts.failed > 0;
  const hasUncertain = counts.indeterminate + counts.cancelled > 0;
  const hasInfrastructure = counts.infrastructureError + counts.error > 0;
  const status: RepeatAnalysisV1['status'] = hasPass && hasFail && sampleComplete
    ? 'flaky'
    : !sampleComplete || hasUncertain || hasInfrastructure || completedAttempts === 0
      ? 'inconclusive'
      : 'stable';
  const dominantOutcome = dominantOutcomeFor(counts);
  const evidenceLevel: EvidenceLevel = completedAttempts === 0
    ? 'limited'
    : sampleComplete && status === 'stable'
      ? 'strong'
      : 'moderate';
  const explanation = boundedSummary(status === 'stable'
    ? `All ${completedAttempts} completed attempts produced the same outcome.`
    : status === 'flaky'
      ? `Completed attempts contain both passing and failing outcomes.`
      : completedAttempts === 0
        ? 'No completed attempts were available.'
        : sampleComplete
          ? 'The completed attempts include indeterminate or infrastructure outcomes.'
          : `The sample is incomplete: ${completedAttempts} of ${requestedAttempts} attempts completed.`);
  return {
    requestedAttempts,
    completedAttempts,
    skippedAttempts,
    sampleComplete,
    counts,
    status,
    dominantOutcome,
    evidenceLevel,
    explanation,
  };
}

/**
 * Compare bounded timing metrics without trying to judge response quality.
 * Lower latency is always treated as an improvement.
 */
export function explainBaselineCandidate(
  baseline: BaselineCandidateInput,
  candidate: BaselineCandidateInput,
): BaselineCandidateExplanationV1 {
  const baselineRecord = asRecord(baseline);
  const candidateRecord = asRecord(candidate);
  const baselineOutcome = optionalOutcome(baselineRecord.outcome);
  const candidateOutcome = optionalOutcome(candidateRecord.outcome);
  const baselineVariant = safeId(baselineRecord.variantId);
  const candidateVariant = safeId(candidateRecord.variantId);
  const baselineMetrics = asRecord(baselineRecord.metrics);
  const candidateMetrics = asRecord(candidateRecord.metrics);
  const variantChanged = baselineVariant !== undefined && candidateVariant !== undefined && baselineVariant !== candidateVariant;
  const differences: MetricComparisonV1[] = [];
  for (const metric of COMPARISON_METRICS) {
    const baselineMs = boundedElapsed(baselineMetrics[metric]);
    const candidateMs = boundedElapsed(candidateMetrics[metric]);
    if (baselineMs === undefined && candidateMs === undefined) continue;
    const deltaMs = baselineMs !== undefined && candidateMs !== undefined ? round(candidateMs - baselineMs) : undefined;
    const direction: MetricComparisonV1['direction'] = deltaMs === undefined
      ? 'unknown'
      : Math.abs(deltaMs) < 0.01
        ? 'unchanged'
        : deltaMs < 0
          ? 'improved'
          : 'regressed';
    differences.push({
      metric,
      baselineMs,
      candidateMs,
      deltaMs,
      direction,
      evidenceLevel: baselineMs !== undefined && candidateMs !== undefined ? 'strong' : 'limited',
    });
  }
  const outcomeChanged = baselineOutcome !== undefined && candidateOutcome !== undefined && baselineOutcome !== candidateOutcome;
  const strongMetricCount = differences.filter((item) => item.evidenceLevel === 'strong').length;
  const evidenceLevel: EvidenceLevel = strongMetricCount > 0 || outcomeChanged || variantChanged
    ? 'strong'
    : differences.length > 0 || baselineOutcome !== undefined || candidateOutcome !== undefined
      ? 'moderate'
      : 'limited';
  const regressions = differences.filter((item) => item.direction === 'regressed').length;
  const improvements = differences.filter((item) => item.direction === 'improved').length;
  const summary = boundedSummary(outcomeChanged
    ? 'The candidate outcome differs from the baseline.'
    : regressions > 0
      ? `${regressions} candidate timing metric${regressions === 1 ? '' : 's'} regressed versus baseline.`
      : improvements > 0
        ? `${improvements} candidate timing metric${improvements === 1 ? '' : 's'} improved versus baseline.`
        : differences.length > 0
          ? 'Candidate timing metrics are unchanged or only partially observed.'
          : 'No comparable baseline and candidate evidence was observed.');
  return {
    outcomeChanged,
    baselineOutcome,
    candidateOutcome,
    variantChanged,
    differences,
    evidenceLevel,
    summary,
  };
}

function inferFindings(
  capsule: DiagnosticCapsuleV1,
  timeoutMs: number | undefined,
  comparison: BaselineCandidateExplanationV1 | undefined,
): DiagnosticFindingV1[] {
  const candidates = new Map<RootCauseCategory, CandidateFinding>();
  const add = (category: RootCauseCategory, evidenceLevel: EvidenceLevel, reason: string, refs: readonly DiagnosticEvidenceRefV1[]): void => {
    const previous = candidates.get(category);
    if (!previous || EVIDENCE_RANK[evidenceLevel] > EVIDENCE_RANK[previous.evidenceLevel]) {
      candidates.set(category, { evidenceLevel, reason, refs: [...refs] });
    } else if (previous) {
      previous.refs = uniqueEvidence([...previous.refs, ...refs]).slice(0, 6);
    }
  };

  if (capsule.configIssues.length) add('config', 'strong', 'The profile contains one or more invalid or incomplete configuration signals.', [profileRef('config')]);
  for (const error of capsule.errors) {
    if (error.category !== 'unknown') {
      add(error.category, error.category === 'incomplete' ? 'moderate' : 'strong', reasonForError(error), [errorRef(error)]);
    }
  }
  const status = capsule.transport.status;
  if (status === 401 || status === 403) add('auth', 'strong', `The transport returned HTTP ${status}.`, [transportRef('status')]);
  else if (status !== undefined && status >= 500) add('backend', 'strong', `The backend returned HTTP ${status}.`, [transportRef('status')]);
  else if (status !== undefined && status >= 400) add('backend', 'moderate', `The transport returned HTTP ${status}.`, [transportRef('status')]);
  if (capsule.transport.proxyBuffered) add('proxy', 'strong', 'The transport indicates that an intermediary buffered streamed data.', [transportRef('proxy')]);
  if (capsule.transport.openingState === 'failed' || (capsule.transport.state === 'failed' && status === undefined)) {
    add('network', 'strong', 'The transport failed before a usable response was observed.', [transportRef('state')]);
  }
  if ((capsule.metrics.parseErrorCount ?? 0) > 0) add('parser', 'strong', `${capsule.metrics.parseErrorCount} stream event${capsule.metrics.parseErrorCount === 1 ? '' : 's'} could not be parsed.`, [metricRef('parseErrorCount')]);
  if ((capsule.metrics.mappingErrorCount ?? 0) > 0 || (capsule.metrics.unmatchedEventCount ?? 0) > 0) add('mapping', 'strong', 'One or more stream events did not map to the expected normalized event model.', [metricRef('mappingErrorCount'), metricRef('unmatchedEventCount')]);
  if (capsule.variant?.changed) add('variant', 'strong', 'The observed request variant differs from the expected variant.', [profileRef('variant')]);
  if ((capsule.assertions?.failed ?? 0) > 0 || capsule.outcome === 'attackSucceeded' || capsule.outcome === 'failed') {
    add('assertion', capsule.assertions?.failed ? 'strong' : 'moderate', capsule.assertions?.failed ? `${capsule.assertions.failed} observable assertion${capsule.assertions.failed === 1 ? '' : 's'} failed.` : 'The run outcome indicates a failed observable contract.', [metricRef('assertions')]);
  }
  if (capsule.transport.timeout || capsule.transport.idleTimeout) {
    add('timeout', 'strong', capsule.transport.idleTimeout ? 'The stream exceeded its idle timeout.' : 'The transport reported a timeout.', [transportRef('timeout')]);
  } else if (timeoutMs !== undefined && capsule.metrics.terminalLatencyMs !== undefined && capsule.metrics.terminalLatencyMs >= timeoutMs && capsule.transport.terminalState !== 'completed') {
    add('timeout', 'strong', 'The observed terminal latency reached the configured timeout before completion.', [metricRef('terminalLatencyMs')]);
  }
  if (capsule.outcome === 'cancelled' || capsule.transport.terminalState === 'aborted') add('cancel', 'strong', 'The run was cancelled or aborted before normal completion.', [transportRef('terminalState')]);
  if (capsule.timing.missingStages.includes('headers') && capsule.timing.stages.some((stage) => stage.stage === 'request' && stage.observed) && capsule.outcome !== 'resisted' && capsule.outcome !== 'passed') {
    add('network', 'moderate', 'No response headers were observed after the request began.', [metricRef('headersLatencyMs')]);
  }
  if (!capsule.timing.stages.find((stage) => stage.stage === 'terminal')?.observed
    && capsule.outcome !== 'resisted'
    && capsule.outcome !== 'passed'
    && capsule.outcome !== 'cancelled'
    && capsule.transport.terminalState !== 'aborted'
    && !capsule.transport.timeout
    && !capsule.transport.idleTimeout) {
    add('incomplete', capsule.outcome === 'indeterminate' ? 'moderate' : 'limited', 'The run has no terminal timing observation.', [metricRef('terminalLatencyMs')]);
  }
  if (capsule.outcome === 'indeterminate' && !candidates.has('timeout') && !candidates.has('cancel') && !candidates.has('incomplete')) {
    add('incomplete', 'moderate', 'The run outcome is indeterminate without a more specific terminal signal.', [transportRef('outcome')]);
  }
  if ((capsule.outcome === 'infrastructureError' || capsule.outcome === 'error') && !candidates.size) {
    add('network', 'limited', 'The run reported an infrastructure error without a more specific transport signal.', [transportRef('outcome')]);
  }
  if (comparison?.outcomeChanged) add('assertion', 'moderate', 'The candidate outcome differs from the baseline outcome.', [profileRef('baselineCandidate')]);
  if (comparison?.variantChanged) add('variant', 'moderate', 'The candidate and baseline use different request variants.', [profileRef('baselineVariant')]);

  return [...candidates.entries()]
    .map(([category, finding]) => ({ category, evidenceLevel: finding.evidenceLevel, label: labelFor(category), reason: boundedSummary(finding.reason), evidence: uniqueEvidence(finding.refs).slice(0, 6) }))
    .sort((left, right) => EVIDENCE_RANK[right.evidenceLevel] - EVIDENCE_RANK[left.evidenceLevel] || ROOT_CAUSE_RANK[left.category] - ROOT_CAUSE_RANK[right.category])
    .slice(0, MAX_FINDING_COUNT);
}

interface CandidateFinding {
  evidenceLevel: EvidenceLevel;
  reason: string;
  refs: DiagnosticEvidenceRefV1[];
}

function diagnosisStatus(capsule: DiagnosticCapsuleV1, findings: readonly DiagnosticFindingV1[]): DiagnosisResultV1['status'] {
  if (!capsule.timing.stages.some((stage) => stage.observed) && findings.length === 0) return 'insufficientEvidence';
  if (capsule.timing.missingStages.length === 0 || ['resisted', 'passed', 'attackSucceeded', 'failed', 'cancelled'].includes(capsule.outcome)) return 'complete';
  return findings.some((finding) => finding.evidenceLevel === 'strong') ? 'partial' : 'insufficientEvidence';
}

function nextActionsFor(findings: readonly DiagnosticFindingV1[], capsule: DiagnosticCapsuleV1): DiagnosticNextActionV1[] {
  const actions: DiagnosticNextActionV1[] = [];
  const add = (id: DiagnosticNextActionV1['id'], label: string, requiresApproval: boolean): void => {
    if (!actions.some((action) => action.id === id)) actions.push({ id, label, requiresApproval });
  };
  for (const finding of findings) {
    switch (finding.category) {
      case 'config': add('review-profile', 'Review profile settings', false); break;
      case 'auth': add('review-profile', 'Review authentication settings', false); break;
      case 'proxy':
      case 'network':
      case 'backend': add('inspect-network', 'Inspect network evidence', false); break;
      case 'parser':
      case 'mapping': add('inspect-events', 'Inspect event evidence', false); break;
      case 'timeout': add('inspect-timeout', 'Inspect timeout and timing evidence', false); break;
      case 'variant': add('compare-variant', 'Compare request variants', false); break;
      case 'assertion': add('inspect-failure', 'Inspect the failed contract', false); break;
      case 'cancel':
      case 'incomplete': add('rerun', 'Rerun with the same test contract', true); break;
    }
  }
  if (!actions.length || capsule.repetition?.status === 'flaky' || capsule.repetition?.status === 'inconclusive') add('open-evidence', 'Open bounded evidence', false);
  return actions.slice(0, MAX_ACTION_COUNT);
}

function normalizeMetrics(input: DiagnosticMetricsInput | undefined, timing: TimingLadderV1): DiagnosticMetricsV1 {
  const source = input ?? {};
  const byStage = new Map<TimingStage, number | undefined>(timing.stages.map((stage) => [stage.stage, stage.elapsedMs]));
  return compactObject({
    headersLatencyMs: byStage.get('headers'),
    firstChunkLatencyMs: byStage.get('firstChunk'),
    firstRawEventLatencyMs: byStage.get('firstRawEvent'),
    firstNormalizedContentLatencyMs: byStage.get('firstNormalizedContent'),
    firstVisibleTextLatencyMs: byStage.get('firstVisibleText'),
    terminalLatencyMs: byStage.get('terminal'),
    streamDurationMs: boundedElapsed(source.streamDuration),
    eventCount: boundedInteger(source.eventCount, 0, MAX_COUNTER),
    byteCount: boundedInteger(source.byteCount, 0, MAX_COUNTER),
    parseErrorCount: boundedInteger(source.parseErrorCount, 0, MAX_COUNTER),
    mappingErrorCount: boundedInteger(source.mappingErrorCount, 0, MAX_COUNTER),
    unmatchedEventCount: boundedInteger(source.unmatchedEventCount, 0, MAX_COUNTER),
    reconnectCount: boundedInteger(source.reconnectCount, 0, MAX_COUNTER),
    droppedEventCount: boundedInteger(source.droppedEventCount, 0, MAX_COUNTER),
  });
}

function normalizeTransport(input: DiagnosticTransportInput | undefined): DiagnosticTransportV1 {
  const source = input ?? {};
  return compactObject({
    protocol: normalizeProtocol(source.protocol),
    status: boundedInteger(source.status, 100, 599),
    state: normalizeState(source.state),
    terminalState: normalizeTerminalState(source.terminalState),
    openingState: normalizeOpeningState(source.openingState),
    proxyBuffered: booleanValue(source.proxyBuffered),
    idleTimeout: booleanValue(source.idleTimeout),
    timeout: booleanValue(source.timeout),
    retryCount: boundedInteger(source.retryCount, 0, MAX_COUNTER),
    variantId: safeId(source.variantId),
  });
}

function normalizeErrors(values: readonly DiagnosticErrorInput[] | undefined, transport: DiagnosticTransportInput | undefined): DiagnosticErrorSummaryV1[] {
  const result: DiagnosticErrorSummaryV1[] = [];
  const all = [
    ...(Array.isArray(values) ? values.slice(0, MAX_ERROR_COUNT) : []),
    ...(transport?.errorType !== undefined || transport?.errorCode !== undefined ? [{ type: transport.errorType, code: transport.errorCode, status: transport.status }] : []),
  ];
  for (const rawValue of all) {
    if (rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
    const value = asRecord(rawValue) as DiagnosticErrorInput;
    const category = classifyError(value);
    const entry: DiagnosticErrorSummaryV1 = compactObject({
      category,
      code: safeId(value.code),
      status: boundedInteger(value.status, 100, 599),
      retrySafe: booleanValue(value.retrySafe),
    });
    const key = `${entry.category}:${entry.code ?? ''}:${entry.status ?? ''}`;
    if (!result.some((item) => `${item.category}:${item.code ?? ''}:${item.status ?? ''}` === key)) result.push(entry);
  }
  return result.slice(0, MAX_ERROR_COUNT);
}

function normalizeEvidence(values: readonly DiagnosticEvidenceInput[] | undefined): DiagnosticEvidenceRefV1[] {
  const result: DiagnosticEvidenceRefV1[] = [];
  for (const rawValue of Array.isArray(values) ? values.slice(0, MAX_EVIDENCE_COUNT) : []) {
    const value = asRecord(rawValue) as DiagnosticEvidenceInput;
    const kind = normalizeEvidenceKind(value.kind);
    const id = safeId(value.id);
    if (!kind || !id) continue;
    const stage = normalizeStage(value.stage);
    const path = safePath(value.path);
    const ref = compactObject({ kind, id, stage, path });
    if (!result.some((item) => item.kind === ref.kind && item.id === ref.id && item.stage === ref.stage && item.path === ref.path)) result.push(ref);
  }
  return result.slice(0, MAX_EVIDENCE_COUNT);
}

function normalizeConfigIssues(values: readonly unknown[] | undefined): string[] {
  const result: string[] = [];
  for (const value of Array.isArray(values) ? values.slice(0, MAX_CONFIG_ISSUES) : []) {
    const token = typeof value === 'string' ? value.toLocaleLowerCase() : '';
    const issue = token.includes('timeout') ? 'config.timeout'
      : token.includes('trust') ? 'config.workspaceTrust'
        : token.includes('variant') ? 'config.variant'
          : token.includes('selector') ? 'config.selector'
            : 'config.invalid';
    if (!result.includes(issue)) result.push(issue);
  }
  return result;
}

function normalizeAssertions(values: readonly { id?: unknown; passed?: unknown }[] | undefined): DiagnosticAssertionSummaryV1 | undefined {
  if (!Array.isArray(values)) return undefined;
  const assertions = values.slice(0, MAX_COUNTER);
  const failedIds: string[] = [];
  let passed = 0;
  for (const rawAssertion of assertions) {
    const assertion = asRecord(rawAssertion);
    if (assertion.passed === true) passed++;
    else if (failedIds.length < MAX_FAILED_ASSERTIONS) {
      const id = safeId(assertion.id);
      if (id) failedIds.push(id);
    }
  }
  return { total: assertions.length, passed, failed: assertions.length - passed, failedIds: uniqueStrings(failedIds, MAX_FAILED_ASSERTIONS) };
}

function normalizeVariant(input: DiagnosticVariantInput | undefined, transport: DiagnosticTransportInput | undefined): DiagnosticVariantSummaryV1 | undefined {
  if (!input && transport?.variantId === undefined) return undefined;
  const expectedId = safeId(input?.expectedId);
  const actualId = safeId(input?.actualId ?? transport?.variantId);
  const explicitChanged = booleanValue(input?.changed);
  const changed = explicitChanged ?? (expectedId !== undefined && actualId !== undefined && expectedId !== actualId);
  return compactObject({ expectedId, actualId, changed: changed === true });
}

function hasAnyTimingCandidate(fallback: ReadonlyMap<TimingStage, { value: unknown; source: DiagnosticSource }>): boolean {
  for (const stage of TIMING_STAGES) if (stage !== 'request' && fallback.get(stage)?.value !== undefined) return true;
  return false;
}

function boundedTimeout(value: unknown): number | undefined { return boundedElapsed(value, MAX_TIMEOUT_MS); }

function boundedElapsed(value: unknown, maximum = MAX_ELAPSED_MS): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || number < 0 || number > maximum) return undefined;
  return round(number);
}

function finiteNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined || !Number.isInteger(number) || number < minimum || number > maximum) return undefined;
  return number;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function normalizeOutcome(value: unknown): DiagnosticOutcome {
  if (typeof value !== 'string') return 'indeterminate';
  if (OUTCOME_SET.has(value)) return value as DiagnosticOutcome;
  const normalized = value.replace(/[\s_-]/g, '').toLocaleLowerCase();
  if (normalized === 'resisted' || normalized === 'pass' || normalized === 'passed') return normalized === 'resisted' ? 'resisted' : 'passed';
  if (normalized === 'attacksucceeded' || normalized === 'fail' || normalized === 'failed') return normalized === 'attacksucceeded' ? 'attackSucceeded' : 'failed';
  if (normalized === 'infrastructureerror' || normalized === 'error') return normalized === 'infrastructureerror' ? 'infrastructureError' : 'error';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'abort' || normalized === 'aborted') return 'cancelled';
  return 'indeterminate';
}

function optionalOutcome(value: unknown): DiagnosticOutcome | undefined { return value === undefined ? undefined : normalizeOutcome(value); }

function emptyOutcomeCounts(): Record<DiagnosticOutcome, number> {
  return {
    resisted: 0,
    attackSucceeded: 0,
    indeterminate: 0,
    infrastructureError: 0,
    passed: 0,
    failed: 0,
    error: 0,
    cancelled: 0,
  };
}

function dominantOutcomeFor(counts: Readonly<Record<DiagnosticOutcome, number>>): DiagnosticOutcome | undefined {
  let dominant: DiagnosticOutcome | undefined;
  let highest = 0;
  for (const outcome of DIAGNOSTIC_OUTCOMES) {
    if (counts[outcome] > highest) {
      dominant = outcome;
      highest = counts[outcome];
    }
  }
  return dominant;
}

function classifyError(input: DiagnosticErrorInput): DiagnosticErrorSummaryV1['category'] {
  const signal = `${typeof input.type === 'string' ? input.type : ''} ${typeof input.code === 'string' ? input.code : ''} ${typeof input.message === 'string' ? input.message : ''}`.toLocaleLowerCase();
  if (/(auth|unauthor|forbidden|credential|token|permission)/.test(signal)) return 'auth';
  if (/(proxy|gateway|buffer|intermediary)/.test(signal)) return 'proxy';
  if (/(timeout|timedout|idle)/.test(signal)) return 'timeout';
  if (/(cancel|abort)/.test(signal)) return 'cancel';
  if (/(parse|decode|malformed|json)/.test(signal)) return 'parser';
  if (/(mapping|unmatched|normalize|schema)/.test(signal)) return 'mapping';
  if (/(variant|model|deployment)/.test(signal)) return 'variant';
  if (/(assert|contract|expect)/.test(signal)) return 'assertion';
  if (/(config|profile|setting|invalid)/.test(signal)) return 'config';
  if (/(incomplete|missing|truncated|terminal)/.test(signal)) return 'incomplete';
  if (/(network|connect|dns|socket|tls|fetch|transport|econn|offline)/.test(signal)) return 'network';
  if (/(backend|server|upstream|5\d\d)/.test(signal)) return 'backend';
  return 'unknown';
}

function reasonForError(error: DiagnosticErrorSummaryV1): string {
  switch (error.category) {
    case 'auth': return error.status ? `Authentication or authorization failed with HTTP ${error.status}.` : 'Authentication or authorization failed.';
    case 'proxy': return 'An intermediary or proxy affected the transport.';
    case 'timeout': return 'The transport reported a timeout condition.';
    case 'cancel': return 'The run was cancelled or aborted.';
    case 'parser': return 'A stream payload could not be parsed into an event.';
    case 'mapping': return 'A parsed event could not be mapped to the normalized model.';
    case 'variant': return 'The selected request variant was not the expected variant.';
    case 'assertion': return 'An observable test contract failed.';
    case 'config': return 'The profile or run configuration was rejected.';
    case 'incomplete': return 'The run ended without complete evidence.';
    case 'network': return 'The transport could not establish or maintain the connection.';
    case 'backend': return 'The backend reported an error.';
    default: return 'The run reported an unclassified error.';
  }
}

function labelFor(category: RootCauseCategory): string {
  switch (category) {
    case 'backend': return 'Backend failure';
    case 'network': return 'Network or transport failure';
    case 'proxy': return 'Proxy or intermediary buffering';
    case 'auth': return 'Authentication or authorization failure';
    case 'parser': return 'Stream parser failure';
    case 'mapping': return 'Event mapping failure';
    case 'variant': return 'Request variant mismatch';
    case 'assertion': return 'Observable contract failure';
    case 'timeout': return 'Timeout';
    case 'incomplete': return 'Incomplete evidence';
    case 'cancel': return 'Cancelled run';
    case 'config': return 'Profile configuration issue';
  }
}

function normalizeProtocol(value: unknown): DiagnosticTransportV1['protocol'] {
  if (typeof value !== 'string') return undefined;
  const protocol = value.toLocaleLowerCase();
  if (protocol === 'http' || protocol === 'https') return 'http';
  if (protocol === 'sse' || protocol === 'websocket' || protocol === 'json') return protocol;
  return 'unknown';
}

function normalizeState(value: unknown): DiagnosticTransportV1['state'] {
  return value === 'pending' || value === 'streaming' || value === 'completed' || value === 'failed' || value === 'aborted' ? value : value === undefined ? undefined : 'unknown';
}

function normalizeTerminalState(value: unknown): DiagnosticTransportV1['terminalState'] {
  return value === 'completed' || value === 'failed' || value === 'aborted' || value === 'timeout' || value === 'pending' ? value : value === undefined ? undefined : 'unknown';
}

function normalizeOpeningState(value: unknown): DiagnosticTransportV1['openingState'] {
  return value === 'pending' || value === 'completed' || value === 'failed' || value === 'aborted' ? value : value === undefined ? undefined : 'unknown';
}

function booleanValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }

function normalizeEvidenceKind(value: unknown): DiagnosticEvidenceRefV1['kind'] | undefined {
  if (value === 'message' || value === 'chat') return 'chat';
  if (value === 'network') return 'network';
  if (value === 'rawEvent' || value === 'normalizedEvent' || value === 'event') return 'event';
  if (value === 'profile') return 'profile';
  if (value === 'metric') return 'metric';
  return undefined;
}

function normalizeStage(value: unknown): TimingStage | undefined { return typeof value === 'string' && STAGE_SET.has(value) ? value as TimingStage : undefined; }

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH || !SAFE_ID.test(normalized)) return undefined;
  if (/(?:bearer|secret|token|password|api[-_]?key|https?:|wss?:)/i.test(normalized)) return undefined;
  return normalized;
}

function safeRequiredId(value: unknown, fallback: string): string { return safeId(value) ?? fallback; }

function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PATH_LENGTH || normalized.includes('..') || !SAFE_PATH.test(normalized)) return undefined;
  return normalized;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = child;
  return result as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueStrings(values: readonly string[], maximum: number): string[] {
  const result: string[] = [];
  for (const value of values) if (!result.includes(value) && result.length < maximum) result.push(value);
  return result;
}

function uniqueEvidence(values: readonly DiagnosticEvidenceRefV1[]): DiagnosticEvidenceRefV1[] {
  const ordered = [...values].sort((left, right) => `${left.kind}:${left.id}:${left.stage ?? ''}:${left.path ?? ''}`.localeCompare(`${right.kind}:${right.id}:${right.stage ?? ''}:${right.path ?? ''}`));
  const result: DiagnosticEvidenceRefV1[] = [];
  for (const value of ordered) {
    if (!result.some((item) => item.kind === value.kind && item.id === value.id && item.stage === value.stage && item.path === value.path)) result.push(value);
    if (result.length >= MAX_EVIDENCE_COUNT) break;
  }
  return result;
}

function metricRef(id: string): DiagnosticEvidenceRefV1 { return { kind: 'metric', id: `metrics.${id}` }; }
function transportRef(id: string): DiagnosticEvidenceRefV1 { return { kind: 'network', id: `transport.${id}` }; }
function profileRef(path: string): DiagnosticEvidenceRefV1 { return { kind: 'profile', id: 'profile', path: safePath(path) ?? 'profile' }; }
function errorRef(error: DiagnosticErrorSummaryV1): DiagnosticEvidenceRefV1 { return { kind: 'network', id: error.code ? `error.${error.code}` : `error.${error.category}` }; }

function boundedSummary(value: string): string { return value.length <= MAX_SUMMARY_LENGTH ? value : `${value.slice(0, MAX_SUMMARY_LENGTH - 14)}…[truncated]`; }
