import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { redactDeep, redactHeaders } from '../src/extension/security/security';

describe('redactHeaders', () => {
  it('redacts sensitive headers case-insensitively while preserving auth schemes', () => {
    const headers = {
      Authorization: 'Bearer abc123',
      COOKIE: 'session=abc',
      'X-API-Key': 'key-123',
      Accept: 'application/json',
    };

    expect(redactHeaders(headers)).toEqual({
      Authorization: 'Bearer ••••••••',
      COOKIE: '••••••••',
      'X-API-Key': '••••••••',
      Accept: 'application/json',
    });
    expect(headers.Authorization).toBe('Bearer abc123');
  });
});

describe('redactDeep', () => {
  it('redacts sensitive key names recursively without changing unrelated values', () => {
    const value = {
      token: 'root-token',
      nested: {
        clientSecret: 'secret',
        passwordHash: 'hash',
        safe: 'visible',
        list: [{ access_token: 'token-2', value: 4 }],
      },
      array: ['plain', { authorization: 'header-value' }],
    };

    expect(redactDeep(value)).toEqual({
      token: '••••••••',
      nested: {
        clientSecret: '••••••••',
        passwordHash: '••••••••',
        safe: 'visible',
        list: [{ access_token: '••••••••', value: 4 }],
      },
      array: ['plain', { authorization: '••••••••' }],
    });
    expect(value.nested.safe).toBe('visible');
  });

  it('passes through primitive and null values', () => {
    expect(redactDeep(undefined)).toBeUndefined();
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep('text')).toBe('text');
  });
});
