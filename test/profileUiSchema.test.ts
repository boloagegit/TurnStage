import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiDefinition } from '../src/shared/types';

type SchemaNode = {
  $ref?: string;
  type?: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  uniqueItems?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
};

type ProfileSchema = SchemaNode & {
  properties: Record<string, SchemaNode>;
  $defs?: Record<string, SchemaNode>;
};

const root = resolve(import.meta.dirname, '..');
const schema = JSON.parse(readFileSync(resolve(root, 'resources/schemas/turnstage-profile.schema.json'), 'utf8')) as ProfileSchema;

function propertySchema(node: SchemaNode, name: string): SchemaNode {
  const property = node.properties?.[name];
  if (!property) throw new Error(`Missing schema property: ${name}`);
  return property;
}

const uiSchema = propertySchema(schema, 'ui');
const metricsSchema = propertySchema(schema, 'metrics');

function resolveSchema(node: SchemaNode): SchemaNode {
  if (!node.$ref) return node;
  const prefix = '#/$defs/';
  if (!node.$ref.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${node.$ref}`);
  const resolved = schema.$defs?.[node.$ref.slice(prefix.length)];
  if (!resolved) throw new Error(`Missing schema definition: ${node.$ref}`);
  return resolved;
}

function matchesSchema(value: unknown, node: SchemaNode): boolean {
  const resolved = resolveSchema(node);
  if (resolved.enum && !resolved.enum.some((candidate) => candidate === value)) return false;

  if (!resolved.type) return true;
  if (resolved.type === 'array') {
    return Array.isArray(value)
      && (resolved.maxItems === undefined || value.length <= resolved.maxItems)
      && (!resolved.uniqueItems || new Set(value.map((item) => JSON.stringify(item))).size === value.length)
      && (!resolved.items || value.every((item) => matchesSchema(item, resolved.items as SchemaNode)));
  }
  if (resolved.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const properties = resolved.properties ?? {};
    return Object.entries(object).every(([key, item]) => {
      const propertySchema = properties[key];
      if (propertySchema) return matchesSchema(item, propertySchema);
      if (resolved.additionalProperties === false) return false;
      if (resolved.additionalProperties && typeof resolved.additionalProperties === 'object') return matchesSchema(item, resolved.additionalProperties);
      return true;
    });
  }
  if (resolved.type === 'string') return typeof value === 'string'
    && (resolved.minLength === undefined || value.length >= resolved.minLength)
    && (resolved.maxLength === undefined || value.length <= resolved.maxLength)
    && (resolved.pattern === undefined || new RegExp(resolved.pattern, 'u').test(value));
  if (resolved.type === 'number' || resolved.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (resolved.type === 'integer' && !Number.isInteger(value)) return false;
    if (resolved.minimum !== undefined && value < resolved.minimum) return false;
    if (resolved.maximum !== undefined && value > resolved.maximum) return false;
    return true;
  }
  return typeof value === 'boolean';
}

const validUi: UiDefinition = {
  layout: { preset: 'split-inspector', inspectorPosition: 'right', inspectorWidth: 360 },
  composer: { placeholder: 'Enter a test message...', multiline: true, enterBehavior: 'send', shiftEnterBehavior: 'newline', showStopWhileStreaming: true },
  streaming: { reveal: 'adaptive', indicator: 'dots', pace: 'balanced', maxVisualLagMs: 600, speedMs: 1200, intensityPercent: 80 },
  locks: { whileTurnActive: { disable: ['composer', 'actor'], allow: ['stop', 'message.copy'] } },
  components: {
    progress: { visible: true, label: 'Progress', collapsible: true, defaultCollapsed: false, icon: 'activity' },
    'custom-panel': { visible: false, label: 'Custom panel', customSetting: { compact: true } },
  },
  messageActions: ['message.copy', 'message.retry'],
  messageActionVisibility: 'always',
  messageTags: [{ id: 'tool', label: 'Tool call', source: 'normalizedEvent', path: 'type', operator: 'startsWith', value: 'tool.', tone: 'warning' }],
};

describe('profile UI schema', () => {
  it('declares every UiDefinition field and keeps extension points scoped', () => {
    expect(uiSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(uiSchema.properties ?? {})).toEqual(['layout', 'composer', 'streaming', 'locks', 'components', 'messageActions', 'messageActionVisibility', 'messageTags']);

    const layout = propertySchema(uiSchema, 'layout');
    expect(layout).toMatchObject({ type: 'object', additionalProperties: false });
    expect(propertySchema(layout, 'preset').enum).toEqual(['chat-only', 'split-inspector', 'chat-with-metrics', 'compact']);
    expect(propertySchema(layout, 'inspectorPosition').enum).toEqual(['right', 'bottom']);
    expect(propertySchema(layout, 'inspectorWidth')).toEqual({ type: 'integer', minimum: 240, maximum: 960 });

    const composer = propertySchema(uiSchema, 'composer');
    expect(composer).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(composer.properties ?? {})).toEqual(['placeholder', 'multiline', 'enterBehavior', 'shiftEnterBehavior', 'showStopWhileStreaming']);
    expect(propertySchema(composer, 'enterBehavior').enum).toEqual(['send', 'newline']);
    expect(propertySchema(composer, 'shiftEnterBehavior').enum).toEqual(['send', 'newline']);

    const streaming = propertySchema(uiSchema, 'streaming');
    expect(streaming).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(streaming.properties ?? {})).toEqual(['reveal', 'indicator', 'effect', 'pace', 'maxVisualLagMs', 'speedMs', 'intensityPercent']);
    expect(propertySchema(streaming, 'reveal').enum).toEqual(['instant', 'event', 'adaptive']);
    expect(propertySchema(streaming, 'indicator').enum).toEqual(['none', 'caret', 'dots', 'shimmer']);
    expect(propertySchema(streaming, 'effect').enum).toEqual(['none', 'caret', 'dots', 'shimmer']);
    expect(propertySchema(streaming, 'pace').enum).toEqual(['calm', 'balanced', 'fast']);
    expect(propertySchema(streaming, 'maxVisualLagMs')).toEqual({ type: 'integer', minimum: 100, maximum: 2000 });
    expect(propertySchema(streaming, 'speedMs')).toEqual({ type: 'integer', minimum: 400, maximum: 4000 });
    expect(propertySchema(streaming, 'intensityPercent')).toEqual({ type: 'integer', minimum: 10, maximum: 100 });

    const locks = propertySchema(uiSchema, 'locks');
    expect(locks).toMatchObject({ type: 'object', additionalProperties: false });
    const whileTurnActive = propertySchema(locks, 'whileTurnActive');
    expect(whileTurnActive).toMatchObject({ type: 'object', additionalProperties: false });
    expect(propertySchema(whileTurnActive, 'disable')).toEqual({ type: 'array', items: { type: 'string' } });
    expect(propertySchema(whileTurnActive, 'allow')).toEqual({ type: 'array', items: { type: 'string' } });

    const components = propertySchema(uiSchema, 'components');
    expect(components.type).toBe('object');
    const component = components.additionalProperties;
    if (!component || typeof component === 'boolean') throw new Error('Components must allow typed additional properties.');
    expect(component).toMatchObject({ type: 'object', additionalProperties: true });
    expect(Object.keys(component.properties ?? {})).toEqual(['visible', 'label', 'collapsible', 'defaultCollapsed']);
    expect(propertySchema(uiSchema, 'messageActions')).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { enum: ['message.copy', 'message.retry', 'message.editAndResend', 'message.inspectRaw'] },
    });
    expect(propertySchema(uiSchema, 'messageActionVisibility').enum).toEqual(['always', 'interaction']);
  });

  it('keeps run and per-message metric filters typed and closed', () => {
    expect(metricsSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(metricsSchema.properties ?? {})).toEqual(['enabled', 'messageEnabled']);
    expect(propertySchema(metricsSchema, 'enabled')).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
    });
    expect(propertySchema(metricsSchema, 'messageEnabled')).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
    });
    expect(matchesSchema({ enabled: ['ttft'], messageEnabled: ['e2e'] }, metricsSchema)).toBe(true);
    expect(matchesSchema({ enabled: ['ttft'], messageEnabled: ['e2e'], typo: true }, metricsSchema)).toBe(false);
    expect(matchesSchema({ messageEnabled: ['e2e', 'e2e'] }, metricsSchema)).toBe(false);
  });

  it('accepts a complete UiDefinition, including arbitrary component names and extension fields', () => {
    expect(matchesSchema(validUi, uiSchema)).toBe(true);
  });

  it.each([
    ['a misspelled ui section', { ...validUi, composre: { placeholder: 'typo' } }],
    ['an unsupported layout preset', { ...validUi, layout: { preset: 'wide' } }],
    ['a misspelled lock field', { ...validUi, locks: { whileTurnActive: { disablee: ['composer'] } } }],
    ['a wrong composer type', { ...validUi, composer: { multiline: 'yes' } }],
    ['an unsupported streaming effect', { ...validUi, streaming: { effect: 'typewriter' } }],
    ['an unsupported streaming indicator', { ...validUi, streaming: { indicator: 'pulse' } }],
    ['an unsupported content reveal mode', { ...validUi, streaming: { reveal: 'typewriter' } }],
    ['an unsupported content reveal pace', { ...validUi, streaming: { pace: 'rushed' } }],
    ['a visual lag below the supported range', { ...validUi, streaming: { maxVisualLagMs: 50 } }],
    ['a streaming speed below the supported range', { ...validUi, streaming: { speedMs: 100 } }],
    ['a fractional streaming intensity', { ...validUi, streaming: { intensityPercent: 50.5 } }],
    ['a wrong component metadata type', { ...validUi, components: { panel: { visible: 'yes' } } }],
    ['a non-string message action', { ...validUi, messageActions: ['message.copy', 42] }],
    ['an unsupported message action', { ...validUi, messageActions: ['request.send'] }],
    ['duplicate message actions', { ...validUi, messageActions: ['message.copy', 'message.copy'] }],
    ['an unsupported message action visibility', { ...validUi, messageActionVisibility: 'hover' }],
    ['an unsupported message tag source', { ...validUi, messageTags: [{ id: 'tag', label: 'Tag', source: 'network', path: 'type', operator: 'exists' }] }],
    ['an unsafe message tag path', { ...validUi, messageTags: [{ id: 'tag', label: 'Tag', source: 'message', path: '__proto__.value', operator: 'exists' }] }],
    ['an Inspector width below the supported range', { ...validUi, layout: { inspectorWidth: 120 } }],
    ['a fractional Inspector width', { ...validUi, layout: { inspectorWidth: 360.5 } }],
  ])('rejects %s', (_description, value) => {
    expect(matchesSchema(value, uiSchema)).toBe(false);
  });
});
