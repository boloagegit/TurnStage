import { describe, expect, it, vi } from 'vitest';
import type { RequestDefinition } from '../src/shared/types';

vi.mock('vscode', () => ({}));

import { RequestBuilder, interactionContext } from '../src/extension/request/requestBuilder';

describe('RequestBuilder', () => {
  it('preserves bounded reconnect and redirect policy for the host transport', async () => {
    const request = await new RequestBuilder(async () => undefined).build({
      method: 'POST', url: 'https://example.test/stream',
      reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, retryOnStatuses: [429, 503] },
      redirectPolicy: 'same-origin', maxRedirects: 3,
    }, {});
    expect(request).toMatchObject({ reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, retryOnStatuses: [429, 503] }, redirectPolicy: 'same-origin', maxRedirects: 3 });
  });
  it('selects the first matching variant and resolves typed body values', async () => {
    const builder = new RequestBuilder(async (name) => name === 'apiKey' ? 'top-secret' : undefined);
    const definition: RequestDefinition = {
      method: 'POST',
      url: 'https://api.example.test/${env.version}',
      headers: {
        Authorization: 'Bearer ${secret.apiKey}',
        'Content-Type': 'application/json',
      },
      body: { ignored: true },
      variants: [
        {
          id: 'continuation',
          when: { path: 'conversation.id', operator: 'exists' },
          headers: { 'X-Variant': 'continuation' },
          body: { message: { $value: 'input.text' }, conversationId: { $value: 'conversation.id' }, token: { $value: 'secret.value' } },
        },
        {
          id: 'first-turn',
          when: { path: 'conversation.id', operator: 'notExists' },
          body: { message: { $value: 'input.text' }, count: { $value: 'input.count' } },
        },
      ],
      timeoutMs: 2000,
      idleTimeoutMs: 300,
    };

    const first = await builder.build(definition, {
      input: { text: 'hello', count: 2 },
      conversation: { id: undefined },
      env: { version: 'v1' },
    });
    expect(first).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/v1',
      headers: {
        Authorization: 'Bearer top-secret',
        'Content-Type': 'application/json',
      },
      timeoutMs: 2000,
      idleTimeoutMs: 300,
      redacted: { variantId: 'first-turn', url: 'https://api.example.test/v1' },
    });
    expect(first.body).toBe('{"message":"hello","count":2}');
    expect(first.redacted.body).toEqual({ message: 'hello', count: 2 });

    const continuation = await builder.build(definition, {
      input: { text: 'next', count: 3 },
      conversation: { id: 'conv-9' },
      env: { version: 'v1' },
      secret: { value: 'body-secret' },
    });
    expect(continuation.redacted.variantId).toBe('continuation');
    expect(continuation.headers['X-Variant']).toBe('continuation');
    expect(continuation.body).toBe('{"message":"next","conversationId":"conv-9","token":"body-secret"}');
    expect(continuation.redacted.headers.Authorization).toBe('Bearer ••••••••');
    expect(continuation.redacted.body).toEqual({ message: 'next', conversationId: 'conv-9', token: '••••••••' });
  });

  it('supports variant predicates and reports an unmatched variant set', async () => {
    const builder = new RequestBuilder(async () => undefined);
    const definition: RequestDefinition = {
      method: 'GET',
      url: 'https://example.test',
      variants: [{ id: 'contains', when: { path: 'input.text', operator: 'contains', value: 'needle' } }],
    };

    await expect(builder.build(definition, { input: { text: 'has needle' } })).resolves.toMatchObject({ redacted: { variantId: 'contains' } });
    await expect(builder.build(definition, { input: { text: 'haystack' } })).rejects.toMatchObject({
      type: 'RequestBuildError',
      message: 'No request variant matched the current interaction.',
    });
  });

  it('supports bounded regex variants and rejects unsafe patterns without executing them', async () => {
    const builder = new RequestBuilder(async () => undefined);
    await expect(builder.build({ method: 'GET', url: 'https://example.test', variants: [{ id: 'regex', when: { path: 'input.text', operator: 'regex', value: '^hello\\s+world$' } }] }, { input: { text: 'hello world' } })).resolves.toMatchObject({ redacted: { variantId: 'regex' } });
    await expect(builder.build({ method: 'GET', url: 'https://example.test', variants: [{ id: 'unsafe', when: { path: 'input.text', operator: 'regex', value: '(a+)+$' } }] }, { input: { text: 'aaaa' } })).rejects.toMatchObject({ type: 'RequestBuildError' });
  });

  it('rejects invalid and unsupported request URLs', async () => {
    const builder = new RequestBuilder(async () => undefined);

    await expect(builder.build({ method: 'GET', url: 'not a url' }, {})).rejects.toMatchObject({
      type: 'RequestBuildError',
      message: 'Invalid request URL: not a url',
    });
    await expect(builder.build({ method: 'GET', url: 'file:///tmp/test' }, {})).rejects.toMatchObject({
      type: 'RequestBuildError',
      message: 'Unsupported request scheme: file:',
    });
  });

  it('scrubs resolved SecretStorage values from URLs, custom headers, bodies, and build errors', async () => {
    const secret = 'environment-only-value';
    const builder = new RequestBuilder(async (name) => name === 'apiToken' ? secret : undefined);
    const request = await builder.build({
      method: 'POST',
      url: 'https://example.test/${secret.apiToken}',
      headers: { 'X-Custom': '${secret.apiToken}' },
      body: { arbitrary: '${secret.apiToken}' },
    }, {});

    expect(request.url).toContain(encodeURIComponent(secret));
    expect(request.headers['X-Custom']).toBe(secret);
    expect(request.body).toContain(secret);
    expect(request.secretValues).toEqual([secret]);
    expect(JSON.stringify(request.redacted)).not.toContain(secret);
    expect(request.redacted).toEqual({
      method: 'POST',
      url: 'https://example.test/••••••••',
      headers: { 'X-Custom': '••••••••' },
      body: { arbitrary: '••••••••' },
    });

    await expect(builder.build({ method: 'GET', url: 'not-a-url/${secret.apiToken}' }, {})).rejects.toMatchObject({
      message: 'Invalid request URL: not-a-url/••••••••',
    });
  });

  it('encodes URL secret placeholders so values cannot inject query parameters or fragments', async () => {
    const secret = 'tenant&admin=true#fragment/%';
    const builder = new RequestBuilder(async (name) => name === 'queryToken' ? secret : undefined);
    const request = await builder.build({ method: 'GET', url: 'https://example.test/chat?token=${secret.queryToken}&api-version=2026-08-01' }, {});
    expect(request.url).toBe(`https://example.test/chat?token=${encodeURIComponent(secret)}&api-version=2026-08-01`);
    expect(new URL(request.url).searchParams.get('token')).toBe(secret);
    expect(new URL(request.url).searchParams.get('admin')).toBeNull();
    expect(new URL(request.url).hash).toBe('');
    expect(JSON.stringify(request.redacted)).not.toContain(encodeURIComponent(secret));
    expect(request.redacted.url).toBe('https://example.test/chat?token=••••••••&api-version=2026-08-01');
  });
});

describe('interactionContext', () => {
  it('keeps the interaction discriminant and optional metadata intact', () => {
    expect(interactionContext({ kind: 'responseAction', sourceMessageId: 'msg-1', actionId: 'retry' })).toEqual({
      kind: 'responseAction',
      sourceMessageId: 'msg-1',
      actionId: 'retry',
    });
  });
});
