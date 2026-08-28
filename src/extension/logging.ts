import * as vscode from 'vscode';

export type TurnStageLogLevel = 'error' | 'warn' | 'info' | 'debug';

const priority: Record<TurnStageLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function logAt(output: Pick<vscode.OutputChannel, 'appendLine'>, level: TurnStageLogLevel, message: string): void {
  const configured = vscode.workspace.getConfiguration('turnstage').get<TurnStageLogLevel>('logLevel', 'info');
  if (priority[level] <= priority[configured]) output.appendLine(`[${level}] ${message}`);
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
