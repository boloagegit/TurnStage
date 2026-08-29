import type { ScenarioRunResult } from '../../shared/types';

export const SCENARIO_REPORT_FORMAT = 'turnstage-contract-report' as const;
export const SCENARIO_REPORT_VERSION = 2 as const;

export interface ScenarioExecutionRecord {
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
    };
    checks: Array<{ id: string; kind: string; passed: boolean; location: string }>;
    steps: Array<{ id: string; durationMs: number; passed: boolean; checks: Array<{ id: string; kind: string; passed: boolean; location: string }> }>;
  }>;
}

export function createScenarioReport(records: readonly ScenarioExecutionRecord[], generatedAt = new Date().toISOString()): ScenarioReport {
  const scenarios = records.map((record) => ({
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
    } : undefined,
    checks: (record.result?.checks ?? []).map(summaryCheck),
    steps: (record.result?.steps ?? []).map((step) => ({
      id: step.stepId,
      durationMs: step.durationMs,
      passed: step.checks.every((check) => check.passed),
      checks: step.checks.map(summaryCheck),
    })),
  }));
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
    if (record.result?.adversarial?.outcome === 'attackSucceeded') outcome = `<failure message="Adversarial attack succeeded">${escapeXml(failures.join('\n'))}</failure>`;
    else if (record.result?.adversarial?.outcome === 'indeterminate') outcome = `<error message="Adversarial result indeterminate">${escapeXml(failures.join('\n'))}</error>`;
    else if (record.result?.adversarial?.outcome === 'infrastructureError') outcome = `<error message="Adversarial infrastructure error">${escapeXml(failures.join('\n'))}</error>`;
    else if (record.status === 'failed') outcome = `<failure message="Conversation contract failed">${escapeXml(failures.join('\n'))}</failure>`;
    else if (record.status === 'error') outcome = '<error message="Conversation contract execution error" />';
    else if (record.status === 'skipped') outcome = '<skipped />';
    return `  <testcase classname="${className}" name="${name}" time="${duration}">${outcome}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="TurnStage Conversation Contracts" tests="${report.summary.total}" failures="${report.summary.failed}" errors="${report.summary.errors}" skipped="${report.summary.skipped}" time="${(report.summary.durationMs / 1_000).toFixed(3)}" timestamp="${timestamp}">\n${cases}\n</testsuite>\n`;
}

export function serializeScenarioHtml(records: readonly ScenarioExecutionRecord[], generatedAt?: string): string {
  const report = createScenarioReport(records, generatedAt);
  const rows = report.scenarios.map((scenario) => {
    const checks = [...scenario.steps.flatMap((step) => step.checks), ...scenario.checks];
    const failed = checks.filter((check) => !check.passed).map((check) => check.id).join(', ') || '—';
    const correlations = scenario.correlations.map((item) => item.traceId ?? item.requestId).filter(Boolean).join(', ') || '—';
    const faults = scenario.faults ? Object.entries(scenario.faults).map(([name, value]) => `${name}=${value}`).join(', ') : '—';
    const outcome = scenario.adversarial ? adversarialOutcomeText(scenario.adversarial.outcome) : scenario.status;
    return `<tr><td><code>${escapeHtml(scenario.profileId)}</code></td><td><code>${escapeHtml(scenario.scenarioId)}</code></td><td><span class="status status-${scenario.status}">${escapeHtml(outcome)}</span></td><td>${scenario.durationMs} ms</td><td>${escapeHtml(failed)}</td><td>${escapeHtml(faults)}</td><td>${escapeHtml(correlations)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>TurnStage Evidence</title><style>${htmlStyles()}</style></head><body><main><header><div><h1>TurnStage test evidence</h1><p>Generated ${escapeHtml(report.generatedAt)}</p></div><div class="summary" aria-label="Result summary"><strong>${report.summary.passed}/${report.summary.total}</strong><span>passed</span></div></header><section class="stats"><article><strong>${report.summary.resisted}</strong><span>Resisted</span></article><article><strong>${report.summary.attackSucceeded}</strong><span>Attack succeeded</span></article><article><strong>${report.summary.indeterminate}</strong><span>Indeterminate</span></article><article><strong>${report.summary.infrastructureErrors}</strong><span>Infrastructure error</span></article><article><strong>${report.summary.durationMs} ms</strong><span>Duration</span></article></section><section><h2>Scenarios</h2><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Scenario</th><th>Outcome</th><th>Duration</th><th>Failed checks</th><th>Fault Lab</th><th>Correlation</th></tr></thead><tbody>${rows}</tbody></table></div></section><footer>Sanitized metadata only. Raw events, request and response bodies, URLs, message content, headers, and secrets are excluded.</footer></main></body></html>\n`;
}

export function serializeAdversarialSummaryCsv(records: readonly ScenarioExecutionRecord[]): string {
  const report = createScenarioReport(records);
  return csv([
    ['profile_id', 'case_id', 'tags', 'outcome', 'duration_ms', 'attempted_turns', 'completed_turns', 'planned_turns', 'finding_count', 'issue_count'],
    ...report.scenarios.filter((scenario) => scenario.adversarial).map((scenario) => [scenario.profileId, scenario.scenarioId, JSON.stringify(scenario.tags), scenario.adversarial!.outcome, scenario.durationMs, scenario.adversarial!.attemptedTurns, scenario.adversarial!.completedTurns, scenario.adversarial!.plannedTurns, scenario.adversarial!.findings.length, scenario.adversarial!.issues.length]),
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

function escapeHtml(value: string): string { return escapeXml(value); }

function adversarialOutcomeText(outcome: NonNullable<ScenarioRunResult['adversarial']>['outcome']): string {
  if (outcome === 'attackSucceeded') return 'Attack succeeded';
  if (outcome === 'infrastructureError') return 'Infrastructure error';
  return outcome === 'resisted' ? 'Resisted' : 'Indeterminate';
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

function htmlStyles(): string {
  return `:root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#24292f}body{margin:0;background:#f6f8fa}main{max-width:1200px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}h1{margin:4px 0 8px;font-size:28px}h2{font-size:18px}.eyebrow{margin:0;color:#57606a;text-transform:uppercase;letter-spacing:.08em;font-size:12px}.summary{display:grid;justify-items:end}.summary strong{font-size:28px}.summary span,.stats span,footer{color:#57606a}.stats{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:1px;margin:24px 0;background:#d0d7de;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}.stats article{display:grid;gap:4px;padding:16px;background:#fff}.table-wrap{overflow:auto;border:1px solid #d0d7de;border-radius:6px;background:#fff}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #d8dee4}th{background:#f6f8fa}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.status{font-weight:600}.status-passed{color:#1a7f37}.status-failed,.status-error{color:#cf222e}.status-skipped{color:#6e7781}footer{margin-top:24px;font-size:12px}@media(max-width:720px){main{padding:16px}.stats{grid-template-columns:repeat(2,1fr)}header{display:block}.summary{justify-items:start;margin-top:16px}}@media(prefers-color-scheme:dark){:root{background:#0d1117;color:#e6edf3}body{background:#010409}.eyebrow,.summary span,.stats span,footer{color:#8b949e}.stats,.table-wrap{border-color:#30363d;background:#30363d}.stats article,.table-wrap{background:#0d1117}th{background:#161b22}th,td{border-color:#30363d}.status-passed{color:#3fb950}.status-failed,.status-error{color:#f85149}.status-skipped{color:#8b949e}}`;
}
