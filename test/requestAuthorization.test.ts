import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedRequest, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';

const mock = vi.hoisted(() => ({
  workspace: { isTrusted: true },
  window: { showWarningMessage: vi.fn() },
  l10n: { t: (message: string) => message },
}));

vi.mock('vscode', () => mock);

import { RequestAuthorizationService, assessRequestAuthorization, isLoopbackHost, requestAuthorizationFingerprint } from '../src/extension/security/requestAuthorization';

const profileUri = { toString: () => 'file:///workspace/demo.turnstage.jsonc' } as never;
const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {}, secretReferences: { token: 'company-token' } };
const profile: TurnStageProfile = {
  version: 1,
  id: 'demo',
  name: 'Demo',
  environment: 'local',
  opening: { mode: 'request', request: { method: 'GET', url: '${env.baseUrl}/opening', headers: { Authorization: 'Bearer ${secret.token}' } } },
  conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat', headers: { Authorization: 'Bearer ${secret.token}' } } },
  stream: { transport: 'sse', mappings: [] },
};

function request(url: string, options: { secret?: boolean; invalidTls?: boolean } = {}): PreparedRequest {
  return {
    method: 'POST',
    url,
    headers: options.secret ? { Authorization: 'Bearer actual-secret' } : {},
    ...(options.invalidTls ? { tls: { allowInvalidCertificates: true } } : {}),
    ...(options.secret ? { secretValues: ['actual-secret'] } : {}),
    redacted: {
      method: 'POST',
      url,
      headers: options.secret ? { Authorization: 'Bearer ••••••••' } : {},
      ...(options.invalidTls ? { tls: { allowInvalidCertificates: true } } : {}),
    },
  };
}

beforeEach(() => {
  mock.workspace.isTrusted = true;
  mock.window.showWarningMessage.mockReset();
});

describe('request authorization assessment', () => {
  it('keeps localhost and loopback Profile openings frictionless', () => {
    expect(assessRequestAuthorization(request('http://localhost:3000/opening'), 'opening', false).required).toBe(false);
    expect(assessRequestAuthorization(request('http://127.9.8.7/opening'), 'opening', false).required).toBe(false);
    expect(assessRequestAuthorization(request('http://[::1]/opening'), 'opening', false).required).toBe(false);
  });

  it('requires consent for external automatic openings', () => {
    const result = assessRequestAuthorization(request('https://api.example.test/opening'), 'opening', false);
    expect(result).toMatchObject({ required: true, automaticOpening: true, destination: 'https://api.example.test/opening' });
  });

  it('requires consent for cleartext secrets but not ordinary explicit HTTPS sends', () => {
    expect(assessRequestAuthorization(request('http://api.example.test/chat', { secret: true }), 'conversation', true).cleartextSecrets).toBe(true);
    expect(assessRequestAuthorization(request('https://api.example.test/chat', { secret: true }), 'conversation', true).required).toBe(false);
    expect(assessRequestAuthorization(request('http://api.example.test/chat'), 'conversation', false).required).toBe(false);
  });

  it('always requires consent when certificate verification is disabled', () => {
    expect(assessRequestAuthorization(request('https://localhost/chat', { invalidTls: true }), 'conversation', false).required).toBe(true);
  });

  it('recognizes only valid loopback hosts', () => {
    expect(isLoopbackHost('localhost.')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.example.test')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.999.0.1')).toBe(false);
  });
});

describe('remembered request authorization', () => {
  function context() {
    const values = new Map<string, unknown>();
    return {
      workspaceState: {
        get: (key: string) => values.get(key),
        update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      },
    } as never;
  }

  it('remembers a Profile grant and asks again after the destination changes', async () => {
    const service = new RequestAuthorizationService(context());
    mock.window.showWarningMessage.mockResolvedValue('Allow this Profile');
    const first = request('https://api.example.test/opening', { secret: true });
    await expect(service.authorize(profileUri, profile, environment, first, 'opening', true)).resolves.toBe(true);
    await expect(service.authorize(profileUri, profile, environment, first, 'opening', true)).resolves.toBe(true);
    await expect(service.authorize(profileUri, profile, environment, request('https://other.example.test/opening', { secret: true }), 'opening', true)).resolves.toBe(true);
    expect(mock.window.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('does not persist allow-once or a cancelled prompt', async () => {
    const service = new RequestAuthorizationService(context());
    mock.window.showWarningMessage.mockResolvedValueOnce('Allow once').mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const candidate = request('https://api.example.test/opening');
    await expect(service.authorize(profileUri, profile, environment, candidate, 'opening', false)).resolves.toBe(true);
    await expect(service.authorize(profileUri, profile, environment, candidate, 'opening', false)).resolves.toBe(false);
    await expect(service.authorize(profileUri, profile, environment, candidate, 'opening', false)).resolves.toBe(false);
    expect(mock.window.showWarningMessage).toHaveBeenCalledTimes(3);
  });

  it('fails closed in Restricted Mode without showing a prompt', async () => {
    mock.workspace.isTrusted = false;
    const service = new RequestAuthorizationService(context());
    await expect(service.authorize(profileUri, profile, environment, request('https://api.example.test/opening'), 'opening', false)).resolves.toBe(false);
    expect(mock.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('authorization fingerprint', () => {
  it('is stable for the same request and changes with relevant Profile security inputs', () => {
    const candidate = request('https://api.example.test/opening', { secret: true });
    const assessment = assessRequestAuthorization(candidate, 'opening', true);
    const original = requestAuthorizationFingerprint(profileUri, profile, environment, candidate, 'opening', assessment);
    expect(requestAuthorizationFingerprint(profileUri, structuredClone(profile), structuredClone(environment), candidate, 'opening', assessment)).toBe(original);
    expect(requestAuthorizationFingerprint(profileUri, profile, { ...environment, secretReferences: { token: 'rotated-token' } }, candidate, 'opening', assessment)).not.toBe(original);
    expect(requestAuthorizationFingerprint(profileUri, profile, environment, request('https://api.example.test/other-opening', { secret: true }), 'opening', assessment)).not.toBe(original);
    expect(requestAuthorizationFingerprint(profileUri, profile, environment, request('https://other.example.test/opening', { secret: true }), 'opening', assessment)).not.toBe(original);
  });
});
