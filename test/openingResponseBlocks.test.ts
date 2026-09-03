import { describe, expect, it } from 'vitest';
import {
  isSafeOpeningResponsePath,
  MAX_OPENING_BLOCK_ITEMS,
  MAX_OPENING_RESPONSE_BLOCKS,
  normalizeOpeningResponseBlocks,
} from '../src/extension/opening/responseBlockNormalizer';
import type { OpeningResponseBlockDefinition } from '../src/shared/types';

describe('opening response blocks', () => {
  it('normalizes provider-specific choices and quota into canonical blocks', () => {
    const definitions: OpeningResponseBlockDefinition[] = [
      { id: 'suggestions', label: 'Suggestions', kind: 'choices', path: '$.optionsInfo', itemLabelPath: '$.option', itemPromptPath: '$.option', behavior: 'fill' },
      { id: 'quota', label: 'Usage', kind: 'meter', path: '$.quota', valuePath: '$.used', maxPath: '$.limit', resetAtPath: '$.resetAt', unit: 'requests' },
    ];
    expect(normalizeOpeningResponseBlocks({
      optionsInfo: [{ option: 'First question' }, { option: 'Second question' }],
      quota: { used: 48, limit: 100, resetAt: '2026-09-04T00:00:00Z' },
    }, definitions)).toEqual([
      { id: 'suggestions', label: 'Suggestions', kind: 'choices', items: [
        { id: 'suggestions-1', label: 'First question', prompt: 'First question', behavior: 'fill' },
        { id: 'suggestions-2', label: 'Second question', prompt: 'Second question', behavior: 'fill' },
      ], empty: false },
      { id: 'quota', label: 'Usage', kind: 'meter', value: 48, max: 100, resetAt: '2026-09-04T00:00:00Z', unit: 'requests', empty: false },
    ]);
  });

  it('supports fields, status, and redacted bounded JSON without executable presentation data', () => {
    const definitions: OpeningResponseBlockDefinition[] = [
      { id: 'account', kind: 'fields', path: '$.account', fields: [
        { id: 'plan', label: 'Plan', path: '$.plan' },
        { id: 'renewal', label: 'Renewal', path: '$.renewal', format: 'datetime' },
        { id: 'access', label: 'Access', path: '$.accessToken' },
      ] },
      { id: 'health', kind: 'status', path: '$.health', valuePath: '$.message', tone: 'success' },
      { id: 'details', kind: 'json', path: '$.details', defaultCollapsed: false },
    ];
    const blocks = normalizeOpeningResponseBlocks({ account: { plan: 'Free', renewal: 1_788_480_000_000, accessToken: 'do-not-display' }, health: { message: 'Available' }, details: { model: 'test', tokenCount: 42, accessToken: 'do-not-display' } }, definitions);
    expect(blocks).toEqual([
      { id: 'account', kind: 'fields', items: [
        { id: 'plan', label: 'Plan', value: 'Free', format: 'text' },
        { id: 'renewal', label: 'Renewal', value: '2026-09-04T00:00:00.000Z', format: 'datetime' },
        { id: 'access', label: 'Access', value: '••••••••', format: 'text' },
      ], empty: false },
      { id: 'health', kind: 'status', value: 'Available', tone: 'success', empty: false },
      { id: 'details', kind: 'json', value: { model: 'test', tokenCount: 42, accessToken: '••••••••' }, defaultCollapsed: false, empty: false },
    ]);
  });

  it('hides missing blocks unless an explicit empty state is configured', () => {
    const definitions: OpeningResponseBlockDefinition[] = [
      { id: 'hidden', kind: 'status', path: '$.missing' },
      { id: 'visible', label: 'Optional data', kind: 'fields', path: '$.missing', emptyPolicy: 'show', fields: [] },
    ];
    expect(normalizeOpeningResponseBlocks({}, definitions)).toEqual([
      { id: 'visible', label: 'Optional data', kind: 'fields', items: [], empty: true },
    ]);
  });

  it('fails closed for negative meter values and redacts sensitive choice paths', () => {
    expect(normalizeOpeningResponseBlocks({ quota: { used: -1, limit: 100 }, options: [{ accessToken: 'do-not-send' }] }, [
      { id: 'quota', kind: 'meter', path: '$.quota', valuePath: '$.used', maxPath: '$.limit' },
      { id: 'choices', kind: 'choices', path: '$.options', itemLabelPath: '$.accessToken', itemPromptPath: '$.accessToken' },
    ])).toEqual([]);
  });

  it('bounds block and choice counts and ignores duplicate or unsafe definitions', () => {
    const choices = Array.from({ length: MAX_OPENING_BLOCK_ITEMS + 10 }, (_, index) => `Choice ${index + 1}`);
    const definitions: OpeningResponseBlockDefinition[] = Array.from({ length: MAX_OPENING_RESPONSE_BLOCKS + 5 }, (_, index) => ({ id: `block-${index + 1}`, kind: 'choices', path: '$.choices' }));
    definitions.splice(1, 0, { id: 'block-1', kind: 'json', path: '$.__proto__' });
    const blocks = normalizeOpeningResponseBlocks({ choices }, definitions);
    expect(blocks).toHaveLength(MAX_OPENING_RESPONSE_BLOCKS);
    expect(blocks[0]).toMatchObject({ id: 'block-1', kind: 'choices' });
    expect(blocks[0]?.kind === 'choices' && blocks[0].items).toHaveLength(MAX_OPENING_BLOCK_ITEMS);
    expect(isSafeOpeningResponsePath('$.quota.used')).toBe(true);
    expect(isSafeOpeningResponsePath('$.constructor.prototype')).toBe(false);
  });

  it('projects hostile JSON keys without mutating object prototypes', () => {
    const payload = JSON.parse('{"details":{"__proto__":{"polluted":true},"constructor":"hidden","tokenCount":42}}') as unknown;
    const [block] = normalizeOpeningResponseBlocks(payload, [{ id: 'details', kind: 'json', path: '$.details' }]);
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.stringify(block)).toContain('"__proto__":{"polluted":true}');
    expect(JSON.stringify(block)).toContain('"constructor":"hidden"');
    expect(JSON.stringify(block)).toContain('"tokenCount":42');
  });
});
