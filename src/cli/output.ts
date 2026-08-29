import type { CliExecutionResult, CliOutputFormat, CliResultRecord } from './contracts';
import { aggregateExitCode, classifyCliOutcome, type CliExitAggregation } from './exitCodes';

export const CLI_OUTPUT_FORMAT = 'turnstage-cli-result' as const;
export const CLI_OUTPUT_VERSION = 1 as const;

export interface CliOutputRecord {
  id: string;
  outcome: string;
  class: 'pass' | 'assertion' | 'indeterminate' | 'infrastructure';
  durationMs?: number;
  failureId?: string;
}

export interface CliOutputDocument {
  format: typeof CLI_OUTPUT_FORMAT;
  version: typeof CLI_OUTPUT_VERSION;
  exitCode: number;
  runId?: string;
  summary: CliExitAggregation['counts'];
  records: CliOutputRecord[];
  nextCursor?: string;
  manifestDigest?: string;
  verification?: { valid: boolean; manifestValid?: boolean; errors: string[] };
}

export function createCliOutputDocument(result: CliExecutionResult, aggregation = aggregateExitCode(result.records ?? [])): CliOutputDocument {
  const records = (result.records ?? []).map((record, index) => toOutputRecord(record, index));
  return {
    format: CLI_OUTPUT_FORMAT,
    version: CLI_OUTPUT_VERSION,
    exitCode: aggregation.exitCode,
    ...(safeIdentifier(result.runId) ? { runId: safeIdentifier(result.runId) } : {}),
    summary: aggregation.counts,
    records,
    ...(safeCursor(result.nextCursor) ? { nextCursor: safeCursor(result.nextCursor) } : {}),
    ...(isDigest(result.manifestDigest) ? { manifestDigest: result.manifestDigest } : {}),
    ...(result.verification ? {
      verification: {
        valid: result.verification.valid,
        ...(result.verification.manifestValid !== undefined ? { manifestValid: result.verification.manifestValid } : {}),
        errors: (result.verification.errors ?? []).map((error) => safeText(error)).filter(Boolean).slice(0, 100),
      },
    } : {}),
  };
}

export function renderCliOutput(result: CliExecutionResult, format: CliOutputFormat, aggregation = aggregateExitCode(result.records ?? [])): string {
  const document = createCliOutputDocument(result, aggregation);
  if (format === 'junit') return renderJUnit(document);
  if (format === 'html') return renderHtml(document);
  if (format === 'evidence') return `${JSON.stringify({ ...document, provenance: result.provenance }, null, 2)}\n`;
  return `${JSON.stringify(document, null, 2)}\n`;
}

export const formatCliOutput = renderCliOutput;

function toOutputRecord(record: CliResultRecord, index: number): CliOutputRecord {
  const classification = classifyCliOutcome(record);
  const rawOutcome = record.outcome ?? record.status ?? classification.label;
  return {
    id: safeIdentifier(record.id) ?? `case-${index + 1}`,
    outcome: safeText(rawOutcome) || classification.label,
    class: classification.class,
    ...(safeDuration(record.durationMs) !== undefined ? { durationMs: safeDuration(record.durationMs) } : {}),
    ...(safeIdentifier(record.failureId) ? { failureId: safeIdentifier(record.failureId) } : {}),
  };
}

function renderJUnit(document: CliOutputDocument): string {
  const failures = document.records.filter((record) => record.class === 'assertion').length;
  const errors = document.records.filter((record) => record.class === 'indeterminate' || record.class === 'infrastructure').length;
  const duration = document.records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0);
  const cases = document.records.map((record) => {
    const name = escapeXml(record.id);
    const seconds = ((record.durationMs ?? 0) / 1_000).toFixed(3);
    if (record.class === 'assertion') return `  <testcase name="${name}" time="${seconds}"><failure message="${escapeXml(record.outcome)}">${escapeXml(record.failureId ?? '')}</failure></testcase>`;
    if (record.class === 'indeterminate' || record.class === 'infrastructure') return `  <testcase name="${name}" time="${seconds}"><error message="${escapeXml(record.outcome)}">${escapeXml(record.failureId ?? '')}</error></testcase>`;
    return `  <testcase name="${name}" time="${seconds}" />`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="TurnStage headless contracts" tests="${document.records.length}" failures="${failures}" errors="${errors}" skipped="0" time="${(duration / 1_000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function renderHtml(document: CliOutputDocument): string {
  const rows = document.records.map((record) => `<tr><td><code>${escapeHtml(record.id)}</code></td><td>${escapeHtml(record.outcome)}</td><td>${escapeHtml(record.class)}</td><td>${record.durationMs ?? '—'} ms</td></tr>`).join('\n');
  const counts = Object.entries(document.summary).map(([key, value]) => `<li><strong>${escapeHtml(String(value))}</strong> ${escapeHtml(key)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TurnStage CLI result</title><style>body{font:14px system-ui,sans-serif;margin:2rem;color:#24292f;background:#f6f8fa}main{max-width:960px;margin:auto;background:#fff;padding:1.5rem;border:1px solid #d0d7de;border-radius:8px}ul{display:flex;gap:1.25rem;flex-wrap:wrap;padding:0;list-style:none}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #d8dee4}code{font-family:ui-monospace,monospace}</style></head><body><main><h1>TurnStage headless result</h1><p>Exit code <strong>${document.exitCode}</strong>${document.runId ? ` · run ${escapeHtml(document.runId)}` : ''}</p><ul>${counts}</ul><table><thead><tr><th>Case</th><th>Outcome</th><th>Class</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>\n`;
}

function safeIdentifier(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !hasControlCharacters(value) ? value : undefined; }
function safeCursor(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !hasControlCharacters(value) ? value : undefined; }
function safeText(value: unknown): string { return typeof value === 'string' ? stripControlCharacters(value).slice(0, 512) : ''; }
function safeDuration(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value * 1_000) / 1_000 : undefined; }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function escapeHtml(value: string): string { return escapeXml(value); }
function hasControlCharacters(value: string): boolean { return stripControlCharacters(value) !== value; }
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127) result += character;
  }
  return result;
}
