import { describe, expect, it } from 'vitest';
import { profileFromCurl } from '../web/src/curlImport';
import { ProfileValidator } from '../src/extension/config/profileValidator';

describe('Web cURL import', () => {
  it('creates a sanitized Profile and keeps the credential only in memory', () => {
    const result = profileFromCurl(`curl https://api.example.test/v1/chat/completions \\
  -H 'Authorization: Bearer sk-live-123' \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'`, { id: 'from-curl', environment: 'local' });
    const text = JSON.stringify(result.profile);
    expect(text).not.toContain('sk-live-123');
    expect(result.profile.id).toBe('from-curl');
    expect(result.profile.environment).toBe('local');
    const authorization = Object.entries(result.profile.conversation.send.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const reference = /\$\{secret\.([^}]+)\}/u.exec(String(authorization))?.[1];
    expect(reference).toBeTruthy();
    expect(result.secrets.get(reference!)).toBe('sk-live-123');
    expect(new ProfileValidator().validate(result.profile).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('rejects text that is not a cURL command', () => {
    expect(() => profileFromCurl('rm -rf /', { id: 'x' })).toThrow();
  });
});
