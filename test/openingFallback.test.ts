import { describe, expect, it } from 'vitest';
import type { OpeningDefinition } from '../src/shared/types';
import { selectOpeningFallback } from '../src/extension/opening/fallbackResolver';

const opening: OpeningDefinition = {
  mode: 'request',
  fallbacks: [
    { match: { path: 'response.status', operator: 'equals', value: 401 }, message: 'Sign in fallback' },
    { match: { path: '$.code', operator: 'equals', value: 'OPENING_NOT_FOUND' }, message: 'Missing opening fallback' },
    { match: { path: 'response.missingMessage', operator: 'equals', value: true }, message: 'Missing message fallback' },
    { match: { path: 'error.type', operator: 'oneOf', value: ['NetworkError', 'TimeoutError'] }, message: 'Network fallback' },
    { message: 'Default fallback' },
  ],
};

describe('opening fallback selection', () => {
  it('matches status, body fields, missing messages, and error types in declaration order', () => {
    expect(selectOpeningFallback(opening, {}, { status: 401 })?.message).toBe('Sign in fallback');
    expect(selectOpeningFallback(opening, { code: 'OPENING_NOT_FOUND' }, { status: 404 })?.message).toBe('Missing opening fallback');
    expect(selectOpeningFallback(opening, {}, { status: 200, missingMessage: true })?.message).toBe('Missing message fallback');
    expect(selectOpeningFallback(opening, undefined, { errorType: 'TimeoutError' })?.message).toBe('Network fallback');
    expect(selectOpeningFallback(opening, {}, { status: 500 })?.message).toBe('Default fallback');
  });
});
