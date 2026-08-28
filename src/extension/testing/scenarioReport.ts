import type { ScenarioRunResult } from '../../shared/types';

export const SCENARIO_REPORT_FORMAT = 'turnstage-contract-report' as const;
export const SCENARIO_REPORT_VERSION = 1 as const;

export interface ScenarioExecutionRecord {
  profileId: string;
  profileName: string;
  scenarioId: string;
  scenarioName: string;
  result?: ScenarioRunResult;
  status: 'passed' | 'failed' | 'error' | 'skipped';
}

export interface ScenarioReport {
  format: typeof SCENARIO_REPORT_FORMAT;
  version: typeof SCENARIO_REPORT_VERSION;
  generatedAt: string;
  summary: { total: number; passed: number; failed: number; errors: number; skipped: number; durationMs: number };
  scenarios: Array<{
    profileId: string;
    scenarioId: string;
    status: ScenarioExecutionRecord['status'];
    durationMs: number;
    faults?: Record<string, number>;
    correlations: Array<{ networkKind: string; traceId?: string; spanId?: string; requestId?: string }>;
    comparison?: { baselineDurationMs: number; candidateDurationMs: number; differenceCount: number; differencePaths: string[] };
    checks: Array<{ id: string; kind: string; passed: boolean; location: string }>;
    steps: Array<{ id: string; durationMs: number; passed: boolean; checks: Array<{ id: string; kind: string; passed: boolean; location: string }> }>;
  }>;
}

export function createScenarioReport(records: readonly ScenarioExecutionRecord[], generatedAt = new Date().toISOString()): ScenarioReport {
  const scenarios = records.map((record) => ({
    profileId: record.profileId,
    scenarioId: record.scenarioId,
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
    if (record.status === 'failed') outcome = `<failure message="Conversation contract failed">${escapeXml(failures.join('\n'))}</failure>`;
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
    return `<tr><td><code>${escapeHtml(scenario.profileId)}</code></td><td><code>${escapeHtml(scenario.scenarioId)}</code></td><td><span class="status status-${scenario.status}">${escapeHtml(scenario.status)}</span></td><td>${scenario.durationMs} ms</td><td>${escapeHtml(failed)}</td><td>${escapeHtml(faults)}</td><td>${escapeHtml(correlations)}</td></tr>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>TurnStage Evidence</title><style>${htmlStyles()}</style></head><body><main><header><div><p class="eyebrow">TurnStage evidence</p><h1>Conversation contract report</h1><p>Generated ${escapeHtml(report.generatedAt)}</p></div><div class="summary" aria-label="Result summary"><strong>${report.summary.passed}/${report.summary.total}</strong><span>passed</span></div></header><section class="stats"><article><strong>${report.summary.passed}</strong><span>Passed</span></article><article><strong>${report.summary.failed}</strong><span>Failed</span></article><article><strong>${report.summary.errors}</strong><span>Errors</span></article><article><strong>${report.summary.skipped}</strong><span>Skipped</span></article><article><strong>${report.summary.durationMs} ms</strong><span>Duration</span></article></section><section><h2>Scenarios</h2><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Scenario</th><th>Status</th><th>Duration</th><th>Failed checks</th><th>Fault Lab</th><th>Correlation</th></tr></thead><tbody>${rows}</tbody></table></div></section><footer>Sanitized summary only. Raw events, request bodies, response bodies, message content, headers, and secrets are excluded.</footer></main></body></html>\n`;
}

function summaryCheck(check: ScenarioRunResult['checks'][number]): { id: string; kind: string; passed: boolean; location: string } {
  return { id: check.id, kind: check.kind, passed: check.passed, location: check.location.kind };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function escapeHtml(value: string): string { return escapeXml(value); }

function boundedFaults(value: object): Record<string, number> {
  const allowed = new Set(['delayBeforeRequestMs', 'delayPerChunkMs', 'httpStatus', 'disconnectAfterEvents', 'corruptEventAt']);
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => allowed.has(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])).slice(0, 5));
}

function htmlStyles(): string {
  return `:root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#24292f}body{margin:0;background:#f6f8fa}main{max-width:1200px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}h1{margin:4px 0 8px;font-size:28px}h2{font-size:18px}.eyebrow{margin:0;color:#57606a;text-transform:uppercase;letter-spacing:.08em;font-size:12px}.summary{display:grid;justify-items:end}.summary strong{font-size:28px}.summary span,.stats span,footer{color:#57606a}.stats{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:1px;margin:24px 0;background:#d0d7de;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}.stats article{display:grid;gap:4px;padding:16px;background:#fff}.table-wrap{overflow:auto;border:1px solid #d0d7de;border-radius:6px;background:#fff}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #d8dee4}th{background:#f6f8fa}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.status{font-weight:600}.status-passed{color:#1a7f37}.status-failed,.status-error{color:#cf222e}.status-skipped{color:#6e7781}footer{margin-top:24px;font-size:12px}@media(max-width:720px){main{padding:16px}.stats{grid-template-columns:repeat(2,1fr)}header{display:block}.summary{justify-items:start;margin-top:16px}}@media(prefers-color-scheme:dark){:root{background:#0d1117;color:#e6edf3}body{background:#010409}.eyebrow,.summary span,.stats span,footer{color:#8b949e}.stats,.table-wrap{border-color:#30363d;background:#30363d}.stats article,.table-wrap{background:#0d1117}th{background:#161b22}th,td{border-color:#30363d}.status-passed{color:#3fb950}.status-failed,.status-error{color:#f85149}.status-skipped{color:#8b949e}}`;
}
