import { describe, expect, it } from 'vitest';
import type { ControlDefinition } from '../src/shared/types';
import { controlOptionIndex, isControlOptionValue, isControlValue } from '../src/shared/controlValue';

describe('select control values', () => {
  const definition: ControlDefinition = { id: 'user', type: 'select', label: 'User', options: [
    { label: 'Legacy', value: 'old-user' },
    { label: 'User A', value: { customerId: 'C001', regionCode: 'R001' } },
  ] };

  it('keeps string values and matches object fields regardless of key order', () => {
    expect(isControlValue(definition, 'old-user')).toBe(true);
    expect(controlOptionIndex(definition, { regionCode: 'R001', customerId: 'C001' })).toBe(1);
    expect(isControlValue(definition, { regionCode: 'R001', customerId: 'C001' })).toBe(true);
    expect(isControlValue(definition, { customerId: 'C001', regionCode: 'wrong' })).toBe(false);
    expect(isControlValue(definition, { customerId: 'C001', regionCode: 'R001', extra: 'x' })).toBe(false);
  });

  it('rejects nested, non-string, and unsafe object fields', () => {
    expect(isControlOptionValue({ customerId: { nested: 'C001' } })).toBe(false);
    expect(isControlOptionValue({ customerId: 1 })).toBe(false);
    expect(isControlOptionValue({ constructor: 'value' })).toBe(false);
    expect(isControlOptionValue({})).toBe(false);
  });
});
