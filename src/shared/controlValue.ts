import type { ControlDefinition } from './types';

export function isControlOptionValue(value: unknown): value is string | Record<string, string> {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 32 && entries.every(([key, item]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && key !== 'constructor' && key !== 'prototype' && typeof item === 'string');
}

export function controlOptionIndex(definition: ControlDefinition, value: unknown): number {
  if (!definition.options || !isControlOptionValue(value)) return -1;
  return definition.options.findIndex((option) => {
    if (!isControlOptionValue(option.value) || typeof option.value !== typeof value) return false;
    if (typeof value === 'string') return option.value === value;
    const candidate = option.value as Record<string, string>;
    const keys = Object.keys(value);
    return keys.length === Object.keys(candidate).length && keys.every((key) => candidate[key] === value[key]);
  });
}

export function isControlValue(definition: ControlDefinition, value: unknown): boolean {
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (definition.type === 'text') return typeof value === 'string';
  return definition.options?.length ? controlOptionIndex(definition, value) >= 0 : typeof value === 'string';
}

export function controlSecretValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!isControlOptionValue(value)) return [];
  return Object.values(value).filter((item) => item.length > 0);
}
