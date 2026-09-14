import type { EvidenceTimelineSummary, ScenarioRunResult } from '../../shared/types';
import { renderTestReportHtml, type TestReportKind } from '../../shared/testReportHtml';
import { buildEvidenceTimeline, clusterFailures, type FailureClusterV1 } from './evidenceTimeline';
import { createReliabilitySummary, type ReliabilitySummaryV1 } from './reliabilityStatistics';

export const SCENARIO_REPORT_FORMAT = 'turnstage-contract-report' as const;
export const SCENARIO_REPORT_VERSION = 2 as const;

export interface ScenarioExecutionRecord {
  kind?: TestReportKind;
  reportOutcome?: NonNullable<ScenarioRunResult['adversarial']>['outcome'];
  profileId: string;
  profileName: string;
  scenarioId: string;
  scenarioName: string;
  scenarioTags?: string[];
  result?: ScenarioRunResult;
  status: 'passed' | 'failed' | 'error' | 'skipped';
}

export interface ScenarioReport {
  format: typeof SCENARIO_REPORT_FORMAT;
  version: typeof SCENARIO_REPORT_VERSION;
  generatedAt: string;
  summary: { total: number; passed: number; failed: number; errors: number; skipped: number; durationMs: number; resisted: number; attackSucceeded: number; indeterminate: number; infrastructureErrors: number };
  failureClusters: FailureClusterV1[];
  scenarios: Array<{
    profileId: string;
    scenarioId: string;
    tags: string[];
    status: ScenarioExecutionRecord['status'];
    durationMs: number;
    faults?: Record<string, number>;
    correlations: Array<{ networkKind: string; traceId?: string; spanId?: string; requestId?: string }>;
    comparison?: { baselineDurationMs: number; candidateDurationMs: number; differenceCount: number; differencePaths: string[] };
    adversarial?: {
      outcome: NonNullable<ScenarioRunResult['adversarial']>['outcome'];
      attemptedTurns: number;
      completedTurns: number;
      plannedTurns: number;
      maxTurns: number;
      timeoutMs: number;
      findings: Array<{ id: string; category: string; turnId: string; turnIndex: number; ruleId?: string; locations: string[] }>;
      issues: Array<{ id: string; kind: string; turnId?: string; turnIndex?: number; location: string }>;
      repetitions?: {
        requestedAttempts: number;
        completedAttempts: number;
        skippedAttempts: number;
        sampleComplete: boolean;
        outcome: string;
        stability: string;
        counts: Record<string, number>;
      };
      reliability?: Pick<ReliabilitySummaryV1, 'requestedAttempts' | 'completedAttempts' | 'evaluableAttempts' | 'sampleComplete' | 'resistanceRate' | 'attackRate' | 'resistance' | 'ttft' | 'duration' | 'verdict' | 'verdictReasons'>;
      timeline: EvidenceTimelineSummary;
    };
    checks: Array<{ id: string; kind: string; passed: boolean; location: string }>;
    steps: Array<{ id: string; durationMs: number; passed: boolean; checks: Array<{ id: string; kind: string; passed: boolean; location: string }> }>;
  }>;
}

export function createScenarioReport(records: readonly ScenarioExecutionRecord[], generatedAt = new Date().toISOString()): ScenarioReport {
  const scenarios = records.map((record) => {
    const repetitions = record.result?.repetitions;
    const reliability = repetitions ? createReliabilitySummary({
      requestedAttempts: repetitions.requestedAttempts,
      completedAttempts: repetitions.completedAttempts,
      sampleComplete: repetitions.sampleComplete,
      attempts: repetitions.attempts.map((attempt) => ({ outcome: attempt.outcome, durationMs: attempt.durationMs, ttftMs: attempt.ttftMs })),
    }) : undefined;
    return ({
    profileId: record.profileId,
    scenarioId: record.scenarioId,
    tags: (record.scenarioTags ?? []).slice(0, 20).map((tag) => tag.slice(0, 64)),
    status: record.status,
    durationMs: record.result?.durationMs ?? 0,
    faults: record.result?.evidence.faults ? boundedFaults(record.result.evidence.faults) : undefined,
    correlations: (record.result?.evidence.networkEntries ?? []).flatMap((entry) => entry.correlation ? [{
      networkKind: entry.kind,
      ...(entry.correlation.traceId ? { traceId: entry.correlation.traceId } : {}),
      ...(entry.correlation.spanId ? { spanId: entry.correlation.spanId } : {}),
      ...(entry.correlation.requestId ? { requestId: entry.correlation.requestId.slice(0, 256) } : {}),
    }] : []).slice(0, 50),
    comparison: record.result?.comparison ? {
      baselineDurationMs: record.result.comparison.baselineDurationMs,
      candidateDurationMs: record.result.comparison.candidateDurationMs,
      differenceCount: record.result.comparison.differenceCount,
      differencePaths: record.result.comparison.differencePaths.slice(0, 100).map((path) => path.slice(0, 512)),
    } : undefined,
    adversarial: record.result?.adversarial ? {
      outcome: record.result.adversarial.outcome,
      attemptedTurns: record.result.adversarial.attemptedTurns,
      completedTurns: record.result.adversarial.completedTurns,
      plannedTurns: record.result.adversarial.plannedTurns,
      maxTurns: record.result.adversarial.maxTurns,
      timeoutMs: record.result.adversarial.timeoutMs,
      findings: record.result.adversarial.findings.slice(0, 500).map((finding) => ({ id: finding.id.slice(0, 256), category: finding.category, turnId: finding.turnId.slice(0, 256), turnIndex: finding.turnIndex, ...(finding.ruleId ? { ruleId: finding.ruleId.slice(0, 256) } : {}), locations: finding.locations.map((location) => location.kind) })),
      issues: record.result.adversarial.issues.slice(0, 500).map((issue) => ({ id: issue.id.slice(0, 256), kind: issue.kind, ...(issue.turnId ? { turnId: issue.turnId.slice(0, 256) } : {}), ...(issue.turnIndex !== undefined ? { turnIndex: issue.turnIndex } : {}), location: issue.location.kind })),
      repetitions: record.result.repetitions ? {
        requestedAttempts: record.result.repetitions.requestedAttempts,
        completedAttempts: record.result.repetitions.completedAttempts,
        skippedAttempts: record.result.repetitions.skippedAttempts,
        sampleComplete: record.result.repetitions.sampleComplete,
        outcome: record.result.repetitions.outcome,
        stability: record.result.repetitions.stability,
        counts: { ...record.result.repetitions.counts },
      } : undefined,
      ...(reliability ? { reliability: {
        requestedAttempts: reliability.requestedAttempts,
        completedAttempts: reliability.completedAttempts,
        evaluableAttempts: reliability.evaluableAttempts,
        sampleComplete: reliability.sampleComplete,
        resistanceRate: reliability.resistanceRate,
        attackRate: reliability.attackRate,
        resistance: reliability.resistance,
        ttft: reliability.ttft,
        duration: reliability.duration,
        verdict: reliability.verdict,
        verdictReasons: reliability.verdictReasons,
      } } : {}),
      timeline: buildEvidenceTimeline(record.result),
    } : undefined,
    checks: (record.result?.checks ?? []).map(summaryCheck),
    steps: (record.result?.steps ?? []).map((step) => ({
      id: step.stepId,
      durationMs: step.durationMs,
      passed: step.checks.every((check) => check.passed),
      checks: step.checks.map(summaryCheck),
    })),
  }); });
  const failureClusters = clusterFailures(records.flatMap((record) => record.result && (record.status !== 'passed' || (record.result.adversarial && record.result.adversarial.outcome !== 'resisted')) ? [{ caseId: `${record.profileId}/${record.scenarioId}`, result: record.result }] : []));
  return {
    format: SCENARIO_REPORT_FORMAT,
    version: SCENARIO_REPORT_VERSION,
    generatedAt,
    summary: {
      total: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.status === 'passed').length,
      failed: scenarios.filter((scenario) => scenario.status === 'failed').length,
      errors: scenarios.filter((scenario) => scenario.status === 'error').length,
      skipped: scenarios.filter((scenario) => scenario.status === 'skipped').length,
      durationMs: scenarios.reduce((sum, scenario) => sum + scenario.durationMs, 0),
      resisted: scenarios.filter((scenario) => scenario.adversarial?.outcome === 'resisted').length,
      attackSucceeded: scenarios.filter((scenario) => scenario.adversarial?.outcome === 'attackSucceeded').length,
      indeterminate: scenarios.filter((scenario) => scenario.adversarial?.outcome === 'indeterminate').length,
      infrastructureErrors: scenarios.filter((scenario) => scenario.adversarial?.outcome === 'infrastructureError').length,
    },
    failureClusters,
    scenarios,
  };
}

export function serializeScenarioJson(records: readonly ScenarioExecutionRecord[], generatedAt?: string): string {
  return `${JSON.stringify(createScenarioReport(records, generatedAt), null, 2)}\n`;
}

export function serializeScenarioJUnit(records: readonly ScenarioExecutionRecord[], generatedAt?: string): string {
  const report = createScenarioReport(records, generatedAt);
  const timestamp = escapeXml(report.generatedAt);
  const cases = records.map((record) => {
    const duration = ((record.result?.durationMs ?? 0) / 1_000).toFixed(3);
    const name = escapeXml(`${record.profileId} / ${record.scenarioId}`);
    const className = escapeXml(`turnstage.${record.profileId}`);
    const failures = record.result ? [...record.result.steps.flatMap((step) => step.checks), ...record.result.checks].filter((check) => !check.passed).map((check) => check.id) : [];
    let outcome = '';
    if (record.status === 'error') outcome = `<error message="${record.result?.adversarial?.outcome === 'indeterminate' ? 'Adversarial result indeterminate' : record.result?.adversarial?.outcome === 'infrastructureError' ? 'Adversarial infrastructure error' : 'Conversation contract execution error'}">${escapeXml(failures.join('\n'))}</error>`;
    else if (record.status === 'failed') outcome = `<failure message="${record.result?.adversarial?.outcome === 'attackSucceeded' ? 'Adversarial attack succeeded' : 'Conversation contract failed'}">${escapeXml(failures.join('\n'))}</failure>`;
    else if (record.status === 'skipped') outcome = '<skipped />';
    return `  <testcase classname="${className}" name="${name}" time="${duration}">${outcome}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="TurnStage Conversation Contracts" tests="${report.summary.total}" failures="${report.summary.failed}" errors="${report.summary.errors}" skipped="${report.summary.skipped}" time="${(report.summary.durationMs / 1_000).toFixed(3)}" timestamp="${timestamp}">\n${cases}\n</testsuite>\n`;
}

export function serializeScenarioHtml(records: readonly ScenarioExecutionRecord[], generatedAt?: string, kind?: TestReportKind, locale?: string): string {
  const selected = kind ? records.filter((record) => (record.kind ?? (record.result?.adversarial ? 'adversarial' : 'contract')) === kind) : [...records];
  const resolvedKind = kind ?? (selected.length > 0 && selected.every((record) => record.kind === 'adversarial' || Boolean(record.result?.adversarial)) ? 'adversarial' : 'contract');
  const report = createScenarioReport(selected, generatedAt);
  const factLabels = htmlFactLabels(locale);
  const clusterByCase = new Map(report.failureClusters.flatMap((cluster) => cluster.caseIds.map((caseId) => [caseId, cluster] as const)));
  return renderTestReportHtml({
    kind: resolvedKind,
    generatedAt: report.generatedAt,
    locale,
    cases: report.scenarios.map((scenario, index) => {
      const checks = [...scenario.steps.flatMap((step) => step.checks), ...scenario.checks];
      const cluster = clusterByCase.get(`${scenario.profileId}/${scenario.scenarioId}`);
      const facts = [
        ...(scenario.faults ? [{ label: factLabels.faults, value: Object.entries(scenario.faults).map(([name, value]) => `${name}=${value}`).join(', ') }] : []),
        ...scenario.correlations.map((item) => item.traceId ?? item.requestId).filter((value): value is string => Boolean(value)).slice(0, 8).map((value) => ({ label: factLabels.correlation, value })),
        ...(cluster ? [{ label: factLabels.cluster, value: `${cluster.fingerprint.phase} / ${cluster.fingerprint.code} (${cluster.count})` }] : []),
        ...(scenario.adversarial?.reliability?.resistanceRate === undefined ? [] : [{ label: factLabels.resistanceRate, value: `${(scenario.adversarial.reliability.resistanceRate * 100).toFixed(1)}%` }]),
        ...checks.filter((check) => !check.passed).slice(0, 12).map((check) => ({ label: factLabels.failedCheck, value: check.id })),
      ];
      return {
        id: scenario.scenarioId,
        profileId: scenario.profileId,
        outcome: resolvedKind === 'adversarial' ? scenario.adversarial?.outcome ?? selected[index]?.reportOutcome ?? 'incomplete' : scenario.status,
        durationMs: scenario.durationMs,
        ...(scenario.adversarial?.repetitions ? { completedAttempts: scenario.adversarial.repetitions.completedAttempts, requestedAttempts: scenario.adversarial.repetitions.requestedAttempts, stability: scenario.adversarial.repetitions.stability } : {}),
        passedChecks: checks.filter((check) => check.passed).length,
        failedChecks: checks.filter((check) => !check.passed).length,
        findingCount: scenario.adversarial?.findings.length,
        facts,
        timeline: scenario.adversarial?.timeline.entries.slice(0, 16).map((entry) => ({ elapsedMs: entry.elapsedMs, label: entry.label })),
      };
    }),
    failureClusters: report.failureClusters.map((cluster) => ({ label: `${cluster.fingerprint.phase} / ${cluster.fingerprint.code}`, count: cluster.count })),
  });
}

function htmlFactLabels(locale: string | undefined) {
  if (locale?.toLowerCase().startsWith('zh')) return { faults: '故障模擬', correlation: '關聯 ID', cluster: '失敗群組', resistanceRate: '防禦成功率', failedCheck: '失敗的檢查' };
  if (locale?.toLowerCase().startsWith('ja')) return { faults: '障害シミュレーション', correlation: '相関 ID', cluster: '失敗グループ', resistanceRate: '防御成功率', failedCheck: '失敗したチェック' };
  if (locale?.toLowerCase().startsWith('ko')) return { faults: '장애 시뮬레이션', correlation: '상관 ID', cluster: '실패 그룹', resistanceRate: '방어 성공률', failedCheck: '실패한 검사' };
  return { faults: 'Fault simulation', correlation: 'Correlation ID', cluster: 'Failure cluster', resistanceRate: 'Resistance rate', failedCheck: 'Failed check' };
}

export function serializeAdversarialSummaryCsv(records: readonly ScenarioExecutionRecord[]): string {
  const report = createScenarioReport(records);
  return csv([
    ['profile_id', 'case_id', 'tags', 'outcome', 'duration_ms', 'attempted_turns', 'completed_turns', 'planned_turns', 'finding_count', 'issue_count', 'requested_attempts', 'completed_attempts', 'skipped_attempts', 'sample_complete', 'stability', 'resisted_count', 'attack_succeeded_count', 'indeterminate_count', 'infrastructure_error_count'],
    ...report.scenarios.filter((scenario) => scenario.adversarial).map((scenario) => {
      const repetitions = scenario.adversarial!.repetitions;
      const counts = repetitions?.counts ?? {};
      return [scenario.profileId, scenario.scenarioId, JSON.stringify(scenario.tags), scenario.adversarial!.outcome, scenario.durationMs, scenario.adversarial!.attemptedTurns, scenario.adversarial!.completedTurns, scenario.adversarial!.plannedTurns, scenario.adversarial!.findings.length, scenario.adversarial!.issues.length, repetitions?.requestedAttempts ?? 1, repetitions?.completedAttempts ?? 1, repetitions?.skippedAttempts ?? 0, repetitions?.sampleComplete ?? true, repetitions?.stability ?? (scenario.adversarial!.outcome === 'resisted' ? 'stable-pass' : 'inconclusive'), counts.resisted ?? (scenario.adversarial!.outcome === 'resisted' ? 1 : 0), counts.attackSucceeded ?? (scenario.adversarial!.outcome === 'attackSucceeded' ? 1 : 0), counts.indeterminate ?? (scenario.adversarial!.outcome === 'indeterminate' ? 1 : 0), counts.infrastructureError ?? (scenario.adversarial!.outcome === 'infrastructureError' ? 1 : 0)];
    }),
  ]);
}

export function serializeAdversarialTurnsCsv(records: readonly ScenarioExecutionRecord[]): string {
  return csv([['profile_id', 'case_id', 'turn_id', 'turn_index', 'duration_ms', 'passed'], ...records.flatMap((record) => record.result?.adversarial ? record.result.steps.map((step, index) => [record.profileId, record.scenarioId, step.stepId, index + 1, step.durationMs, step.checks.every((check) => check.passed)]) : [])]);
}

export function serializeAdversarialFindingsCsv(records: readonly ScenarioExecutionRecord[]): string {
  return csv([['profile_id', 'case_id', 'finding_id', 'category', 'turn_id', 'turn_index', 'rule_id', 'location_kinds'], ...records.flatMap((record) => record.result?.adversarial?.findings.map((finding) => [record.profileId, record.scenarioId, finding.id, finding.category, finding.turnId, finding.turnIndex + 1, finding.ruleId ?? '', [...new Set(finding.locations.map((location) => location.kind))].join('|')]) ?? [])]);
}

export function serializeAdversarialNetworkCsv(records: readonly ScenarioExecutionRecord[]): string {
  return csv([['profile_id', 'case_id', 'network_id', 'kind', 'attempt', 'state', 'status_code', 'event_count', 'transferred_bytes'], ...records.flatMap((record) => record.result?.adversarial ? record.result.evidence.networkEntries.map((entry) => [record.profileId, record.scenarioId, entry.id, entry.kind, entry.attempt, entry.state, entry.status ?? '', entry.eventCount, entry.transferredBytes]) : [])]);
}

export function serializeAdversarialEventsCsv(records: readonly ScenarioExecutionRecord[]): string {
  return csv([['profile_id', 'case_id', 'sequence', 'type', 'raw_sequence', 'mapping_rule_id'], ...records.flatMap((record) => record.result?.adversarial ? record.result.evidence.snapshot.normalizedEvents.map((event) => [record.profileId, record.scenarioId, event.sequence, event.type, event.rawSequence ?? '', event.mappingRuleId ?? '']) : [])]);
}

function summaryCheck(check: ScenarioRunResult['checks'][number]): { id: string; kind: string; passed: boolean; location: string } {
  return { id: check.id, kind: check.kind, passed: check.passed, location: check.location.kind };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function csv(rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${rows.map((row) => row.map((value) => csvCell(String(value))).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function boundedFaults(value: object): Record<string, number> {
  const allowed = new Set(['delayBeforeRequestMs', 'delayPerChunkMs', 'httpStatus', 'disconnectAfterEvents', 'corruptEventAt']);
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => allowed.has(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])).slice(0, 5));
}
