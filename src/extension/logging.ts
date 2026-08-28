import * as vscode from 'vscode';

export type TurnStageLogLevel = 'error' | 'warn' | 'info' | 'debug';

const priority: Record<TurnStageLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function logAt(output: Pick<vscode.OutputChannel, 'appendLine'>, level: TurnStageLogLevel, message: string): void {
  const configured = vscode.workspace.getConfiguration('turnstage').get<TurnStageLogLevel>('logLevel', 'info');
  if (priority[level] <= priority[configured]) output.appendLine(`[${level}] ${message}`);
}
