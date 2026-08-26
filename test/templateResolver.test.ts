import { describe, expect, it } from 'vitest';
import { getPath, resolveTemplate } from '../src/extension/request/templateResolver';

describe('getPath', () => {
  it('supports root paths with or without the JSONPath-style prefix', () => {
    const context = { conversation: { id: 'conv-1' }, value: 7 };

    expect(getPath(context, '$.conversation.id')).toBe('conv-1');
    expect(getPath(context, 'conversation.id')).toBe('conv-1');
    expect(getPath(context, '$')).toBe(context);
    expect(getPath(context, '')).toBe(context);
    expect(getPath(context, 'conversation.missing')).toBeUndefined();
  });
});

describe('resolveTemplate', () => {
  it('preserves typed values instead of stringifying them', async () => {
    const context = { input: { count: 3, enabled: true }, nested: { value: null } };

    await expect(resolveTemplate({
      count: { $value: 'input.count' },
      enabled: { $value: 'input.enabled' },
      missingWithDefault: { $value: 'input.missing', $transforms: [{ name: 'default', value: 'fallback' }] },
      nested: [{ $value: 'nested.value' }, 'literal'],
    }, context)).resolves.toEqual({
      count: 3,
      enabled: true,
      missingWithDefault: 'fallback',
      nested: [null, 'literal'],
    });
  });

  it('applies scalar, collection, and object transform forms in order', async () => {
    const context = { raw: '  MiXeD  ', values: ['one', 'two'], object: { a: 1 } };

    await expect(resolveTemplate({ $value: 'raw', $transforms: ['trim', 'lowercase', 'uppercase'] }, context)).resolves.toBe('MIXED');
    await expect(resolveTemplate({ $value: 'raw', $transforms: ['trim', 'number'] }, context)).resolves.toBeNaN();
    await expect(resolveTemplate({ $value: 'raw', $transforms: ['trim', 'boolean'] }, context)).resolves.toBe(false);
    await expect(resolveTemplate({ $value: 'values', $transforms: [{ name: 'join', value: ' | ' }] }, context)).resolves.toBe('one | two');
    await expect(resolveTemplate({ $value: 'object', $transforms: ['json'] }, context)).resolves.toBe('{"a":1}');
  });

  it('resolves repeated interpolations and awaits secret values', async () => {
    const requested: string[] = [];
    const context = { env: { host: 'example.test' }, input: { id: 42 } };
    const provider = async (name: string): Promise<string | undefined> => {
      requested.push(name);
      return name === 'apiKey' ? 'secret-value' : undefined;
    };

    await expect(resolveTemplate(
      'https://${env.host}/items/${input.id}?key=${secret.apiKey}',
      context,
      provider,
    )).resolves.toBe('https://example.test/items/42?key=secret-value');
    expect(requested).toEqual(['apiKey']);
  });

  it('rejects missing interpolation paths, missing secrets, and unknown transforms', async () => {
    const context = { input: { value: 'x' } };

    await expect(resolveTemplate('${input.missing}', context)).rejects.toMatchObject({ type: 'RequestBuildError' });
    await expect(resolveTemplate('${secret.nope}', context, async () => undefined)).rejects.toMatchObject({
      type: 'MissingSecretError',
      message: 'Secret "nope" is not configured.',
    });
    await expect(resolveTemplate({ $value: 'input.value', $transforms: ['explode'] }, context)).rejects.toMatchObject({
      type: 'RequestBuildError',
      message: 'Unsupported transform: explode.',
    });
  });
});
