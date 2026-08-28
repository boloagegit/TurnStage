import { describe, expect, it } from 'vitest';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { ProfileCodec } from '../src/extension/config/profileCodec';
import { ProfileValidator } from '../src/extension/config/profileValidator';

function validProfile(): TurnStageProfile {
  return {
    version: 1,
    id: 'demo',
    name: 'Demo',
    environment: 'local',
    conversation: {
      send: {
        method: 'POST',
        url: 'https://example.test/chat',
        variants: [{ id: 'default', body: { text: { $value: 'input.text' } } }],
      },
    },
    stream: {
      transport: 'sse',
      mappingMode: 'firstMatch',
      mappings: [{ id: 'text', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }],
    },
  };
}

describe('ProfileCodec', () => {
  it('parses JSONC comments and trailing commas while retaining a syntax tree', () => {
    const parsed = new ProfileCodec().parse(`
      {
        // profile metadata
        "version": 1,
        "id": "demo",
        "name": "Demo",
      }
    `);

    expect(parsed.errors).toEqual([]);
    expect(parsed.profile).toMatchObject({ version: 1, id: 'demo', name: 'Demo' });
    expect(parsed.tree?.type).toBe('object');
  });

  it('returns no profile and parse errors for malformed JSONC', () => {
    const parsed = new ProfileCodec().parse('{ "version": 1, "id": }');

    expect(parsed.profile).toBeUndefined();
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.tree).toBeDefined();
  });
});

describe('ProfileValidator', () => {
  it('accepts a complete profile when its environment is available', () => {
    const environments: TurnStageEnvironment[] = [{ version: 1, id: 'local', name: 'Local', variables: {} }];

    expect(new ProfileValidator().validate(validProfile(), undefined, environments)).toEqual([]);
  });

  it('reports missing structure, duplicate ids, unsafe regexes, and policy violations', () => {
    const profile = validProfile();
    profile.version = 2;
    profile.id = ' ';
    profile.name = '';
    profile.environment = 'missing';
    profile.description = 'sk-abcdefghijklmnop';
    profile.controls = [
      { id: 'mode', type: 'text', label: 'Mode' },
      { id: 'mode', type: 'text', label: 'Duplicate mode' },
    ];
    profile.conversation.send.variants = [];
    profile.conversation.stop = { strategy: 'abortThenRequest' };
    profile.security = { allowedUriSchemes: ['ftp'] };
    profile.stream.mappingMode = 'firstMatch';
    profile.stream.mappings = [
      { id: 'unconditional', match: {}, emit: { type: 'content.text.delta', text: { path: '$.text' } } },
      { id: 'unconditional', match: { path: '$.text', operator: 'regex', value: '(a+)+$' }, emit: { type: 'content.text.delta' } },
    ];

    const issues = new ProfileValidator().validate(profile, undefined, [{ version: 1, id: 'local', name: 'Local', variables: {} }]);
    const messages = issues.map((issue) => issue.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Unsupported config version: 2.',
      'Profile id is required.',
      'Profile name is required.',
      'At least one request variant is required.',
      'Environment "missing" was not found.',
      'Duplicate control id: mode.',
      'Duplicate mapping id: unconditional.',
      'abortThenRequest requires a stop request.',
      'URI scheme "ftp" is not supported.',
      'The profile may contain a secret value. Move secrets to SecretStorage.',
    ]));
    expect(messages.some((message) => message.includes('Potentially unsafe nested quantifier.'))).toBe(true);
    expect(messages.some((message) => message.includes('unreachable after an unconditional first-match rule.'))).toBe(true);
    expect(issues.some((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('validates required emit fields and malformed regex patterns', () => {
    const profile = validProfile();
    profile.conversation.send.variants = [{ id: 'bad-request-regex', when: { path: 'input.text', operator: 'regex', value: '[' } }];
    profile.stream.mappings = [
      { id: 'started', match: {}, emit: { type: 'conversation.started' } },
      { id: 'bad-regex', match: { path: '$.text', operator: 'regex', value: '[' }, emit: { type: 'content.text.delta' } },
    ];

    const messages = new ProfileValidator().validate(profile).map((issue) => issue.message);

    expect(messages).toContain('conversation.started requires emit.conversationId.');
    expect(messages).toContain('content.text.delta requires emit.text.');
    expect(messages).toContain('bad-regex: Invalid regular expression.');
    expect(messages).toContain('bad-request-regex: Invalid regular expression.');
  });

  it('reports an unparsed profile as a configuration error', () => {
    const parsed = new ProfileCodec().parse('{');
    const issues = new ProfileValidator().validate(parsed.profile, parsed.tree);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', message: 'Profile could not be parsed.' });
  });

  it('validates UI layout values and limits message toolbars to implemented actions', () => {
    const profile = validProfile();
    profile.ui = {
      layout: { preset: 'wide' as 'compact', inspectorPosition: 'left' as 'right', inspectorWidth: 120.5 },
      streaming: { effect: 'typewriter' as 'caret', speedMs: 399, intensityPercent: 100.5 },
      messageActions: ['request.send'],
      messageActionVisibility: 'hover' as 'always',
    };

    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Unknown UI layout preset: wide.',
      'Unknown Inspector position: left.',
      'Inspector width must be an integer from 240 to 960.',
      'Unknown Assistant streaming effect: typewriter.',
      'Assistant streaming speed must be an integer from 400 to 4000 milliseconds.',
      'Assistant streaming intensity must be an integer from 10 to 100 percent.',
      'Unknown action id: request.send.',
      'Unknown message action visibility: hover.',
    ]));
  });

  it('validates configurable message metric definitions', () => {
    const profile = validProfile();
    profile.stream.mappings = [
      { id: 'missing', match: { event: 'a' }, emit: { type: 'message.metric.updated', metric: {} } },
      { id: 'invalid', match: { event: 'b' }, emit: { type: 'message.metric.updated', metric: { id: 'latency', value: { path: '$.latency' }, aggregation: 'average', format: 'clock' } } },
    ];

    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Message metrics require id and value fields.',
      'Unknown message metric aggregation: average.',
      'Unknown message metric format: clock.',
    ]));
  });

  it('diagnoses invalid template, starter action, and duplicate declared action ids', () => {
    const profile = validProfile();
    profile.controls = [{ id: 'actor', type: 'text', label: 'Actor' }];
    profile.conversation.send.variants = [{ id: 'default', body: { actor: { $value: 'controls.missing' }, other: '${unknown.value}', env: '${env.missing}' } }];
    profile.opening = { mode: 'static', starters: [{ id: 'bad', label: 'Bad', prompt: '', behavior: 'action', actionId: 'unknown.action' }] };
    profile.stream.mappings.push(
      { id: 'action-1', match: { event: 'action-1' }, emit: { type: 'action.upsert', action: { id: 'same-action', label: 'One', actionId: 'message.retry' } } },
      { id: 'action-2', match: { event: 'action-2' }, emit: { type: 'action.upsert', action: { id: 'same-action', label: 'Two', actionId: 'message.retry' } } },
    );

    const messages = new ProfileValidator().validate(profile, undefined, [{ version: 1, id: 'local', name: 'Local', variables: { baseUrl: 'https://example.test' } }]).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Template path "controls.missing" references an unknown control.',
      'Template path "unknown.value" uses an unknown context root.',
      'Template path "env.missing" references an unknown environment variable.',
      'Unknown starter action id: unknown.action.',
      'Duplicate action id: same-action.',
    ]));
  });

  it('enforces critical runtime shape, identifier, request, and retention constraints', () => {
    const profile = validProfile();
    profile.id = '../Unsafe ID';
    profile.conversation.send.method = 'CONNECT' as 'POST';
    profile.conversation.send.timeoutMs = 0;
    profile.conversation.send.idleTimeoutMs = 900_001;
    profile.stream.transport = 'websocket' as 'sse';
    profile.history = { localRuns: { maxRuns: 101 } };

    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Profile id must use lowercase letters, numbers, and hyphens.',
      'Unsupported HTTP method: CONNECT.',
      'timeoutMs must be an integer from 1 to 900000.',
      'idleTimeoutMs must be an integer from 1 to 900000.',
      'Unsupported stream transport: websocket.',
      'Local run retention must be an integer from 1 to 100.',
    ]));
  });

  it('returns structural diagnostics instead of throwing on wrong JSON value types', () => {
    const profile = { version: 1, id: 42, name: [], controls: {}, conversation: null, stream: { mappings: {} } } as unknown as TurnStageProfile;
    expect(() => new ProfileValidator().validate(profile)).not.toThrow();
    expect(new ProfileValidator().validate(profile).map((entry) => entry.message)).toEqual(expect.arrayContaining([
      'Profile id must be a string.',
      'Profile name must be a string.',
      'Conversation send request is required.',
      'Stream mappings must be an array.',
      'Controls must be an array.',
    ]));
  });
});
