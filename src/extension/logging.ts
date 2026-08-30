import * as vscode from 'vscode';

export type TurnStageLogLevel = 'error' | 'warn' | 'info' | 'debug';
export type TurnStageLogMessage = string | (() => string);

type TurnStageLogSink = Pick<vscode.OutputChannel, 'appendLine'> & Partial<Pick<vscode.LogOutputChannel, TurnStageLogLevel>>;

const priority: Record<TurnStageLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL: TurnStageLogLevel = 'info';
const MAX_LOG_LINE_LENGTH = 2_048;

let configuredLevel: TurnStageLogLevel | undefined;
let operationSequence = 0;

/** Cache the configured level so disabled debug calls stay out of hot SSE paths. */
export function configureTurnStageLogging(): vscode.Disposable {
  refreshConfiguredLevel();
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('turnstage.logLevel')) refreshConfiguredLevel();
  });
}

export function isLogLevelEnabled(level: TurnStageLogLevel): boolean {
  return priority[level] <= priority[currentLevel()];
}

/** A message factory is evaluated only when its level is enabled. */
export function logAt(output: TurnStageLogSink, level: TurnStageLogLevel, message: TurnStageLogMessage): void {
  if (!isLogLevelEnabled(level)) return;
  const line = diagnosticValue(typeof message === 'function' ? message() : message, MAX_LOG_LINE_LENGTH);
  const native = output[level];
  if (typeof native === 'function') native.call(output, line);
  else output.appendLine(`[${level}] ${line}`);
}

export interface TurnStageLogOperation {
  readonly id: string;
  progress(fields?: Readonly<Record<string, unknown>>): void;
  complete(fields?: Readonly<Record<string, unknown>>): void;
  cancel(fields?: Readonly<Record<string, unknown>>): void;
  fail(fields?: Readonly<Record<string, unknown>>): void;
}

/** A bounded start/progress/end timeline shared by long-running features. */
export function startLogOperation(
  output: TurnStageLogSink,
  category: string,
  action: string,
  fields: Readonly<Record<string, unknown>> = {},
): TurnStageLogOperation {
  const id = `${safeToken(category, 'op')}-${++operationSequence}`;
  const startedAt = Date.now();
  let finished = false;
  logAt(output, 'info', () => operationLine(id, action, 'started', fields));
  const finish = (state: 'completed' | 'cancelled' | 'failed', level: TurnStageLogLevel, details: Readonly<Record<string, unknown>> = {}): void => {
    if (finished) return;
    finished = true;
    logAt(output, level, () => operationLine(id, action, state, { ...details, durationMs: Date.now() - startedAt }));
  };
  return {
    id,
    progress: (details = {}) => { if (!finished) logAt(output, 'info', () => operationLine(id, action, 'progress', details)); },
    complete: (details = {}) => finish('completed', 'info', details),
    cancel: (details = {}) => finish('cancelled', 'warn', details),
    fail: (details = {}) => finish('failed', 'error', details),
  };
}

/**
 * Keep request diagnostics useful without copying credentials or query values
 * into the Output Channel. Callers must redact known secrets before passing a
 * URL because a profile may intentionally place a secret in its path.
 */
export function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/** Prevent server-controlled metadata from creating extra Output lines. */
export function diagnosticValue(value: unknown, maxLength = 160): string {
  const withoutControls = [...String(value ?? '')]
    .map((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 ? ' ' : character; })
    .join('');
  const normalized = withoutControls
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function currentLevel(): TurnStageLogLevel {
  if (configuredLevel === undefined) refreshConfiguredLevel();
  return configuredLevel ?? DEFAULT_LEVEL;
}

function refreshConfiguredLevel(): void {
  const value = vscode.workspace.getConfiguration('turnstage').get<TurnStageLogLevel>('logLevel', DEFAULT_LEVEL);
  configuredLevel = Object.prototype.hasOwnProperty.call(priority, value) ? value : DEFAULT_LEVEL;
}

function operationLine(id: string, action: string, state: string, fields: Readonly<Record<string, unknown>>): string {
  const values = Object.entries(fields).flatMap(([key, value]) => value === undefined ? [] : [`${safeToken(key, 'field')}=${formatField(value)}`]);
  return `[${id}] ${safeToken(action, 'operation')} state=${state}${values.length ? ` ${values.join(' ')}` : ''}`;
}

function formatField(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return diagnosticValue(value.join(','), 256);
  return JSON.stringify(diagnosticValue(value, 256));
}

function safeToken(value: string, fallback: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return token || fallback;
}

/** Test-only reset for deterministic module-level cache checks. */
export function resetLoggingForTests(): void {
  configuredLevel = undefined;
  operationSequence = 0;
}
