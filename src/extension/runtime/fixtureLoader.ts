import * as vscode from 'vscode';
import type { RawStreamEvent } from '../../shared/types';
import { localize } from '../l10n';

export const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
export const MAX_FIXTURE_EVENTS = 10_000;
export const MAX_FIXTURE_EVENT_BYTES = 1024 * 1024;

export async function loadFixture(uri: vscode.Uri, startedAt = Date.now()): Promise<RawStreamEvent[]> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_FIXTURE_BYTES) throw new Error(localize('Fixture files cannot exceed 5 MB.'));
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_FIXTURE_BYTES) throw new Error(localize('Fixture files cannot exceed 5 MB.'));
  return parseFixture(new TextDecoder().decode(bytes), startedAt);
}

export function parseFixture(text: string, startedAt = Date.now()): RawStreamEvent[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_FIXTURE_EVENTS) throw new Error(localize('Fixture files cannot contain more than {count} events.', { count: MAX_FIXTURE_EVENTS }));
  return lines.map((line, index) => {
    if (Buffer.byteLength(line) > MAX_FIXTURE_EVENT_BYTES) throw new Error(localize('A fixture event exceeded the maximum allowed size.'));
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(localize('Fixture line {line} is not valid JSON.', { line: index + 1 })); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(localize('Fixture line {line} must be a JSON object.', { line: index + 1 }));
    const item = value as Record<string, unknown>;
    if (typeof item.event !== 'string' || item.event.length === 0 || item.event.length > 1024) throw new Error(localize('Fixture line {line} has an invalid event name.', { line: index + 1 }));
    const delayMs = typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) && item.delayMs >= 0
      ? Math.min(item.delayMs, 24 * 60 * 60 * 1000)
      : 0;
    return {
      sequence: index + 1,
      receivedAt: startedAt + delayMs,
      elapsedMs: delayMs,
      protocol: 'fixture' as const,
      sse: { event: item.event },
      raw: JSON.stringify(item.data),
      data: item.data,
    };
  });
}
