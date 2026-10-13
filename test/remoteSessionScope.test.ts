import { describe, expect, it } from 'vitest';
import { remoteSessionScope } from '../src/shared/remoteSessionScope';

describe('remote session scope', () => {
  it('defaults to Profile, actor, and environment like the runtime key', () => {
    expect(remoteSessionScope(undefined)).toEqual(['profile', 'actor', 'environment']);
    expect(remoteSessionScope({ mode: 'referenceOnly' })).toEqual(['profile', 'actor', 'environment']);
    expect(remoteSessionScope({ mode: 'referenceOnly', scope: ['profile'] })).toEqual(['profile']);
  });

  it('returns a copy that callers can change', () => {
    const scope = remoteSessionScope(undefined);
    scope.pop();
    expect(remoteSessionScope(undefined)).toHaveLength(3);
  });
});
