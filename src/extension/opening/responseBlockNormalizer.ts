import type {
  OpeningFieldItem,
  OpeningInfoBlock,
  OpeningResponseBlockDefinition,
  OpeningValueFormat,
} from '../../shared/types';
import { getPath } from '../request/templateResolver';

export const MAX_OPENING_RESPONSE_BLOCKS = 8;
export const MAX_OPENING_BLOCK_ITEMS = 20;
export const MAX_OPENING_BLOCK_TEXT = 512;
export const MAX_OPENING_JSON_NODES = 200;
export const MAX_OPENING_JSON_DEPTH = 6;

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const BLOCKED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const REDACTED = '••••••••';

export function isSafeOpeningResponsePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 1 || path.length > 256) return false;
  const normalized = path.replace(/^\$\.?/u, '');
  return !normalized || normalized.split('.').every((segment) => SAFE_SEGMENT.test(segment) && !BLOCKED_SEGMENTS.has(segment));
}

/**
 * Projects provider-specific opening payloads into bounded, presentation-only
 * blocks. Invalid definitions or missing data cannot widen Webview authority.
 */
export function normalizeOpeningResponseBlocks(data: unknown, definitions: readonly OpeningResponseBlockDefinition[] | undefined): OpeningInfoBlock[] {
  if (!Array.isArray(definitions)) return [];
  const blocks: OpeningInfoBlock[] = [];
  const usedIds = new Set<string>();
  for (const definition of definitions) {
    if (blocks.length >= MAX_OPENING_RESPONSE_BLOCKS) break;
    if (!definition || !VALID_ID.test(definition.id) || usedIds.has(definition.id) || !isSafeOpeningResponsePath(definition.path)) continue;
    const block = normalizeBlock(data, definition);
    if (!block || (block.empty && definition.emptyPolicy !== 'show')) continue;
    blocks.push(block);
    usedIds.add(definition.id);
  }
  return blocks;
}

function normalizeBlock(data: unknown, definition: OpeningResponseBlockDefinition): OpeningInfoBlock | undefined {
  const source = getPath(data, definition.path);
  const base = { id: definition.id, ...(boundedText(definition.label) ? { label: boundedText(definition.label) } : {}) };
  switch (definition.kind) {
    case 'choices': {
      const items = Array.isArray(source) ? source.slice(0, MAX_OPENING_BLOCK_ITEMS).flatMap((item, index) => {
        const label = pathText(item, definition.itemLabelPath) ?? scalarText(item);
        const prompt = pathText(item, definition.itemPromptPath) ?? label;
        return label && prompt ? [{ id: `${definition.id}-${index + 1}`, label, prompt, behavior: definition.behavior ?? 'send' as const }] : [];
      }) : [];
      return { ...base, kind: 'choices', items, empty: items.length === 0 };
    }
    case 'fields': {
      const items = Array.isArray(definition.fields) ? definition.fields.slice(0, MAX_OPENING_BLOCK_ITEMS).flatMap((field): OpeningFieldItem[] => {
        if (!field || !VALID_ID.test(field.id) || !boundedText(field.label) || !isSafeOpeningResponsePath(field.path)) return [];
        const value = isSensitivePath(field.path) ? REDACTED : formatFieldValue(getPath(source, field.path), field.format ?? 'text');
        return value === undefined ? [] : [{ id: field.id, label: boundedText(field.label)!, value, format: field.format ?? 'text' }];
      }) : [];
      return { ...base, kind: 'fields', items, empty: items.length === 0 };
    }
    case 'meter': {
      if (!isSafeOpeningResponsePath(definition.valuePath) || !isSafeOpeningResponsePath(definition.maxPath) || (definition.resetAtPath !== undefined && !isSafeOpeningResponsePath(definition.resetAtPath))) return;
      const value = finiteNumber(getPath(source, definition.valuePath));
      const max = finiteNumber(getPath(source, definition.maxPath));
      const resetAt = definition.resetAtPath ? scalarText(getPath(source, definition.resetAtPath)) : undefined;
      const valid = value !== undefined && value >= 0 && max !== undefined && max > 0;
      return { ...base, kind: 'meter', ...(valid ? { value, max } : {}), ...(resetAt ? { resetAt } : {}), ...(boundedText(definition.unit, 32) ? { unit: boundedText(definition.unit, 32) } : {}), empty: !valid };
    }
    case 'status': {
      if (definition.valuePath !== undefined && !isSafeOpeningResponsePath(definition.valuePath)) return;
      const value = scalarText(definition.valuePath ? getPath(source, definition.valuePath) : source);
      return { ...base, kind: 'status', ...(value ? { value } : {}), tone: definition.tone ?? 'neutral', empty: !value };
    }
    case 'json': {
      const value = boundedJson(source);
      return { ...base, kind: 'json', ...(value !== undefined ? { value } : {}), defaultCollapsed: definition.defaultCollapsed ?? true, empty: value === undefined };
    }
  }
}

function pathText(root: unknown, path: string | undefined): string | undefined {
  if (!path || !isSafeOpeningResponsePath(path)) return;
  if (isSensitivePath(path)) return;
  return scalarText(getPath(root, path));
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return boundedText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return;
}

function boundedText(value: unknown, maximum = MAX_OPENING_BLOCK_TEXT): string | undefined {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return;
}

function formatFieldValue(value: unknown, format: OpeningValueFormat): string | undefined {
  if (format === 'number' || format === 'percent') {
    const number = finiteNumber(value);
    return number === undefined ? undefined : String(number);
  }
  if (format === 'datetime') {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return scalarText(value);
}

function boundedJson(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return;
  const state = { nodes: 0 };
  return projectJson(value, 0, state);
}

function projectJson(value: unknown, depth: number, state: { nodes: number }): unknown {
  if (state.nodes >= MAX_OPENING_JSON_NODES || depth > MAX_OPENING_JSON_DEPTH) return '[truncated]';
  state.nodes += 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return value.slice(0, MAX_OPENING_BLOCK_TEXT);
  if (Array.isArray(value)) return value.slice(0, MAX_OPENING_BLOCK_ITEMS).map((item) => projectJson(item, depth + 1, state));
  if (!value || typeof value !== 'object') return String(value).slice(0, MAX_OPENING_BLOCK_TEXT);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, MAX_OPENING_BLOCK_ITEMS).map(([key, child]) => {
    const safeKey = key.slice(0, 128);
    return [safeKey, isSensitiveKey(key) ? REDACTED : projectJson(child, depth + 1, state)];
  }));
}

function isSensitivePath(path: string): boolean {
  return isSensitiveKey(path.replace(/^\$\.?/u, '').split('.').at(-1) ?? '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').replace(/_/gu, '-').toLocaleLowerCase('en-US');
  return ['authorization', 'cookie', 'set-cookie', 'secret', 'password', 'api-key', 'x-api-key', 'token', 'credential', 'credentials'].includes(normalized)
    || /(?:^|-)(?:secret|password|credential|access-token|refresh-token|id-token|auth-token|bearer-token)$/u.test(normalized);
}
