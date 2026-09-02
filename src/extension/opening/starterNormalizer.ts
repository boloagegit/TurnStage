import type { Starter } from '../../shared/types';

export const MAX_OPENING_STARTERS = 100;

const VALID_BEHAVIORS = new Set<Starter['behavior']>(['send', 'fill', 'action']);

/**
 * Keeps remote opening payloads from leaking malformed or blank starter
 * buttons into the Webview. String choices are a common API shorthand and
 * are treated as sendable prompts, never as host actions.
 */
export function normalizeOpeningStarters(value: unknown): Starter[] {
  if (!Array.isArray(value)) return [];

  const output: Starter[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < value.length && output.length < MAX_OPENING_STARTERS; index += 1) {
    const starter = normalizeStarter(value[index], index);
    if (!starter) continue;
    starter.id = uniqueId(starter.id, usedIds);
    usedIds.add(starter.id);
    output.push(starter);
  }
  return output;
}

function normalizeStarter(value: unknown, index: number): Starter | undefined {
  if (typeof value === 'string') {
    const text = nonEmptyText(value);
    if (!text) return undefined;
    return { id: `starter-${index + 1}`, label: text, prompt: text, behavior: 'send' };
  }
  if (!isRecord(value)) return undefined;

  const label = firstText(value.label, value.title, value.text, value.prompt, value.value);
  const prompt = firstText(value.prompt, value.value, value.text, value.label, value.title);
  if (!label && !prompt) return undefined;

  const actionId = nonEmptyText(value.actionId);
  const requestedBehavior = typeof value.behavior === 'string' && VALID_BEHAVIORS.has(value.behavior as Starter['behavior'])
    ? value.behavior as Starter['behavior']
    : 'send';
  const behavior = requestedBehavior === 'action' && !actionId ? 'send' : requestedBehavior;

  return {
    id: firstText(value.id, value.value) ?? `starter-${index + 1}`,
    label: label ?? prompt!,
    prompt: prompt ?? label!,
    behavior,
    ...(behavior === 'action' && actionId ? { actionId } : {}),
  };
}

function uniqueId(candidate: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(candidate)) return candidate;
  let suffix = 2;
  while (usedIds.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = nonEmptyText(value);
    if (text) return text;
  }
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
