import { describe, expect, it } from 'vitest';
import type { ScenarioAssertionDefinition, TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { ProfileCodec } from '../src/extension/config/profileCodec';
import { ProfileValidator, validateAdversarialScenariosAgainstProfile } from '../src/extension/config/profileValidator';

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

  it('accepts an explicit TLS bypass boolean and rejects malformed TLS configuration', () => {
    const profile = validProfile();
    profile.conversation.send.tls = { allowInvalidCertificates: true };
    expect(new ProfileValidator().validate(profile)).toEqual([]);
    (profile.conversation.send as unknown as { tls: unknown }).tls = { allowInvalidCertificates: 'yes' };
    expect(new ProfileValidator().validate(profile).map((item) => item.message)).toContain('TLS configuration must use a boolean allowInvalidCertificates value.');
  });

  it('rejects allowlisted commands that can replace or restart the VS Code window', () => {
    const profile = validProfile();
    profile.security = { allowedCommands: ['workbench.action.files.openFile', 'workbench.action.reloadWindow'] };

    expect(new ProfileValidator().validate(profile).map((item) => item.message)).toContain(
      'Command workbench.action.reloadWindow is blocked because it can reload, restart, or close VS Code.',
    );
  });

  it('accepts a valid declarative scenario with step and profile assertions', () => {
    const profile = validProfile();
    profile.controls = [
      { id: 'actor', type: 'text', label: 'Actor', persist: 'none' },
      { id: 'mode', type: 'select', label: 'Mode', persist: 'none', options: [{ label: 'Normal', value: 'normal' }] },
    ];
    profile.tests = {
      scenarios: [{
        id: 'basic-contract',
        name: 'Basic contract',
        description: 'Checks a normal conversation.',
        controls: { actor: 'actor-a', mode: 'normal' },
        steps: [{
          id: 'first-turn',
          name: 'First turn',
          input: 'Hello',
          assertions: [
            { id: 'completed', path: 'turn.state', operator: 'equals', value: 'completed' },
            { id: 'has-reply', path: 'assistant.text', operator: 'exists' },
          ],
        }],
        assertions: [{ id: 'no-mapping-errors', path: 'metrics.mappingErrorCount', operator: 'equals', value: 0 }],
      }],
    };

    expect(new ProfileValidator().validate(profile)).toEqual([]);
  });

  it('accepts bounded multi-turn adversarial cases and safe linked suite paths', () => {
    const profile = validProfile();
    profile.stream.mappings.push({ id: 'tool', match: { event: 'tool' }, emit: { type: 'tool.started', toolCallId: { path: '$.id' }, name: { path: '$.name' } } });
    profile.tests = {
      adversarialSuites: ['.vscode/turnstage/tests/security.adversarial.jsonc', '.vscode/turnstage/tests/security.adversarial.csv'],
      scenarios: [{
        id: 'known-attack', name: 'Known attack',
        sourceBinding: { sourceGlobs: ['src/chat/**'], riskTags: ['prompt-boundary'] },
        steps: [{ id: 'probe', input: 'First probe' }, { id: 'follow-up', input: 'Follow up', additionalForbid: { events: ['tool.started'] } }],
        adversarial: { mode: 'multiTurn', maxTurns: 2, timeoutMs: 60_000, stopOnAttackSucceeded: true, forbid: { content: ['protected-marker'], urls: true, tools: true, events: ['tool.started'] } },
      }],
    };
    expect(new ProfileValidator().validate(profile)).toEqual([]);
  });

  it('rejects unsafe source bindings instead of selecting by traversal-like paths', () => {
    const profile = validProfile();
    profile.tests = { scenarios: [{ id: 'bound', name: 'Bound', sourceBinding: { sourceGlobs: ['../outside/**'] }, steps: [{ id: 'turn', input: 'hello' }] }] };
    expect(new ProfileValidator().validate(profile).map((issue) => issue.message)).toContainEqual(expect.stringContaining('Invalid source binding'));
  });

  it('validates external suite cases against Profile-owned observable mappings', () => {
    const issues = validateAdversarialScenariosAgainstProfile(validProfile(), [{
      id: 'tool-attack', name: 'Tool attack', steps: [{ id: 'probe', input: 'Use a tool' }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, forbid: { tools: true } },
    }]);

    expect(issues).toContainEqual(expect.objectContaining({
      scenarioId: 'tool-attack',
      message: 'This Profile has no mapping that can expose tool interactions.',
    }));
  });

  it('rejects unsafe suites, empty prohibitions, truncated multi-turn cases, and contract-only features', () => {
    const profile = validProfile();
    profile.tests = {
      adversarialSuites: ['../outside.adversarial.jsonc', '../outside.adversarial.jsonc'],
      scenarios: [{
        id: 'invalid-attack', name: 'Invalid attack', comparison: { baseline: {}, candidate: {} },
        steps: [{ id: 'one', input: 'one', assertions: [{ path: 'turn.state', operator: 'exists' }] }, { id: 'two', input: 'two' }],
        adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 500, forbid: {} },
      }],
    };
    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Adversarial suite path must be a safe workspace-relative .adversarial.jsonc, .adversarial.json, or .csv path.',
      'Adversarial suite paths must be unique.',
      'A single-turn adversarial case must contain exactly one step.',
      'Adversarial steps exceed maxTurns and will not be truncated.',
      'Adversarial timeoutMs must be an integer from 1000 to 300000.',
      'An adversarial case requires at least one prohibited effect.',
      'Adversarial cases cannot use conversation-contract assertions in the first version.',
      'Adversarial cases cannot combine with comparison, performance, or Fault Lab in the first version.',
    ]));
  });

  it('accepts baseline comparison, performance budgets, ignore paths, and CI reporting', () => {
    const profile = validProfile();
    profile.controls = [{ id: 'mode', type: 'text', label: 'Mode', persist: 'none' }];
    profile.tests = {
      reporting: { formats: ['json', 'junit'], outputDirectory: '.turnstage/reports' },
      scenarios: [{
        id: 'candidate-contract', name: 'Candidate contract', steps: [{ id: 'turn', input: 'Hello' }],
        comparison: {
          baseline: { label: 'Baseline', environment: 'local', controls: { mode: 'baseline' } },
          candidate: { label: 'Candidate', environment: 'local', controls: { mode: 'candidate' } },
          ignorePaths: ['session.title', 'messages[*].parts[0].text'],
        },
        performance: {
          thresholds: { 'scenario.durationMs': 5_000, 'metrics.ttft': 1_000 },
          regression: { 'metrics.ttft': { maxIncreaseMs: 100, maxIncreasePercent: 20 } },
        },
      }],
    };

    expect(new ProfileValidator().validate(profile, undefined, [{ version: 1, id: 'local', name: 'Local', variables: {} }])).toEqual([]);
  });

  it('rejects unsafe or malformed Phase 2 comparison and report settings', () => {
    const profile = validProfile();
    profile.controls = [{ id: 'token', type: 'text', label: 'Token', persist: 'secret' }];
    profile.tests = {
      reporting: { formats: ['json', 'json'], outputDirectory: '../outside' },
      scenarios: [{
        id: 'invalid-phase-two', name: 'Invalid Phase 2', steps: [{ id: 'turn', input: 'Hello' }],
        comparison: {
          baseline: { environment: 'missing', controls: { token: 'secret' } },
          candidate: {},
          ignorePaths: ['request.headers.authorization', 'session.title', 'session.title'],
        },
        performance: {
          thresholds: { 'metrics.ttft': -1, 'unknown.metric': 10 } as never,
          regression: { 'scenario.durationMs': {} },
        },
      }],
    };

    const messages = new ProfileValidator().validate(profile, undefined, [{ version: 1, id: 'local', name: 'Local', variables: {} }]).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Test report formats must be unique.',
      'Test report outputDirectory must be a safe workspace-relative directory.',
      'Environment "missing" was not found.',
      'Scenario controls cannot set secret control: token.',
      'Unsupported comparison path: request.headers.authorization.',
      'Comparison ignore paths must be unique.',
      'Performance thresholds must be finite numbers from 0 to 900000 milliseconds.',
      'Unsupported performance metric: unknown.metric.',
      'Performance regression limit requires maxIncreaseMs or maxIncreasePercent.',
    ]));
  });

  it('accepts bounded advisory quality rubrics and rejects unsafe duplicates', () => {
    const valid = validProfile();
    valid.tests = { scenarios: [] };
    valid.tests!.qualityRubrics = [{ id: 'support', name: 'Support quality', criteria: [{ id: 'correct', label: 'Correct', description: 'Claims match the disclosed response evidence.' }] }];
    expect(new ProfileValidator().validate(valid, undefined, [{ version: 1, id: 'local', name: 'Local', variables: {} }]).map((entry) => entry.message)).not.toEqual(expect.arrayContaining([expect.stringContaining('quality rubrics')]));

    valid.tests!.qualityRubrics = [{ id: 'support', name: 'Support quality', criteria: [
      { id: 'correct', label: 'Correct', description: 'First.' },
      { id: 'correct', label: 'Duplicate', description: 'Second.' },
    ] }];
    expect(new ProfileValidator().validate(valid, undefined, [{ version: 1, id: 'local', name: 'Local', variables: {} }]).map((entry) => entry.message)).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate criterion id')]));
  });

  it('requires comparison before applying regression limits', () => {
    const profile = validProfile();
    profile.tests = { scenarios: [{ id: 'no-baseline', name: 'No baseline', steps: [{ id: 'turn', input: 'Hello' }], performance: { regression: { 'scenario.durationMs': { maxIncreasePercent: 10 } } } }] };

    expect(new ProfileValidator().validate(profile).map((entry) => entry.message)).toContain('Performance regression rules require a baseline comparison.');
  });

  it('accepts bounded Fault Lab, visual baseline, and HTML reporting settings', () => {
    const profile = validProfile();
    profile.tests = {
      reporting: { formats: ['json', 'junit', 'html'], outputDirectory: '.turnstage/reports' },
      visual: { baselineDirectory: '.turnstage/baselines', maxDifferencePercent: 0.1, channelTolerance: 16 },
      scenarios: [{ id: 'fault-check', name: 'Fault check', steps: [{ id: 'turn', input: 'Hello' }], faults: { delayBeforeRequestMs: 20, delayPerChunkMs: 5, httpStatus: 503, disconnectAfterEvents: 3, corruptEventAt: 2 } }],
    };
    expect(new ProfileValidator().validate(profile)).toEqual([]);
  });

  it('rejects unbounded or unknown Fault Lab and visual settings', () => {
    const profile = validProfile();
    profile.tests = {
      visual: { baselineDirectory: '../outside', maxDifferencePercent: 101, channelTolerance: 256 },
      scenarios: [{ id: 'fault-check', name: 'Fault check', steps: [{ id: 'turn', input: 'Hello' }], faults: { delayBeforeRequestMs: 30_001, httpStatus: 200, disconnectAfterEvents: 0, arbitrary: 1 } as never }],
    };
    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Visual baselineDirectory must be a safe workspace-relative directory.',
      'Visual maximum difference must be a finite percentage from 0 to 100.',
      'Visual channel tolerance must be an integer from 0 to 255.',
      'delayBeforeRequestMs must be an integer from 0 to 30000.',
      'Fault Lab HTTP status must be an integer from 400 to 599.',
      'disconnectAfterEvents must be an integer from 1 to 10000.',
      'Unsupported Fault Lab setting: arbitrary.',
    ]));
  });

  it('reports duplicate scenario and step ids', () => {
    const profile = validProfile();
    profile.tests = {
      scenarios: [
        { id: 'duplicate', name: 'First', steps: [{ id: 'same-step', input: 'one' }, { id: 'same-step', input: 'duplicate step' }] },
        { id: 'duplicate', name: 'Second', steps: [{ id: 'other-step', input: 'two' }] },
      ],
    };

    const messages = new ProfileValidator().validate(profile).map((issue) => issue.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Duplicate scenario id: duplicate.',
      'Duplicate scenario step id: same-step.',
    ]));
  });

  it('reports empty input and rejects unknown or secret scenario controls', () => {
    const profile = validProfile();
    profile.controls = [
      { id: 'actor', type: 'text', label: 'Actor', persist: 'none' },
      { id: 'token', type: 'text', label: 'Token', persist: 'secret' },
    ];
    profile.tests = {
      scenarios: [{
        id: 'controls',
        name: 'Controls',
        controls: { actor: 'actor-a', missing: 'value', token: 'secret-value' },
        steps: [{ id: 'empty', input: '   ' }],
      }],
    };

    const messages = new ProfileValidator().validate(profile).map((issue) => issue.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Scenario references unknown control: missing.',
      'Scenario controls cannot set secret control: token.',
      'Scenario step input is required.',
    ]));
  });

  it('reports invalid assertion paths, operators, regexes, numeric values, and arrays', () => {
    const profile = validProfile();
    const invalidOperator = 'not-supported' as ScenarioAssertionDefinition['operator'];
    profile.tests = {
      scenarios: [{
        id: 'invalid-assertions',
        name: 'Invalid assertions',
        steps: [{
          id: 'step',
          input: 'Check this',
          assertions: [
            { path: 'filesystem.password', operator: 'equals', value: 'secret' },
            { path: 'turn.state', operator: invalidOperator, value: 'completed' },
            { path: 'assistant.text', operator: 'regex', value: '(a+)+$' },
            { path: 'metrics.totalDuration', operator: 'lessThan', value: 'fast' },
            { path: 'events.normalized[*].type', operator: 'sequenceContains', value: 'not-an-array' },
          ],
        }],
      }],
    };

    const messages = new ProfileValidator().validate(profile).map((issue) => issue.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Unsupported assertion path: filesystem.password.',
      'Unsupported assertion operator: not-supported.',
      'Assertion regex must be valid, safe, and no longer than 256 characters.',
      'Assertion operator lessThan requires a finite number.',
      'Assertion operator sequenceContains requires an array value.',
    ]));
  });

  it('returns diagnostics instead of throwing for primitive scenarios and steps', () => {
    const primitiveScenario = validProfile();
    (primitiveScenario as unknown as { tests: { scenarios: unknown[] } }).tests = { scenarios: [null, 42, 'scenario'] };
    expect(() => new ProfileValidator().validate(primitiveScenario)).not.toThrow();

    const primitiveStep = validProfile();
    (primitiveStep as unknown as { tests: { scenarios: unknown[] } }).tests = { scenarios: [{ id: 'primitive-step', name: 'Primitive step', steps: [null, 42, 'step'] }] };
    expect(() => new ProfileValidator().validate(primitiveStep)).not.toThrow();
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
      streaming: { reveal: 'typewriter' as 'adaptive', indicator: 'pulse' as 'caret', effect: 'typewriter' as 'caret', pace: 'rushed' as 'fast', maxVisualLagMs: 99.5, speedMs: 399, intensityPercent: 100.5 },
      messageActions: ['request.send'],
      messageActionVisibility: 'hover' as 'always',
      messageTags: [
        { id: 'duplicate', label: '', source: 'network' as 'message', path: '__proto__.value', operator: 'regex' as 'exists' },
        { id: 'duplicate', label: 'Again', source: 'message', path: 'status', operator: 'equals' },
      ],
    };

    const messages = new ProfileValidator().validate(profile).map((entry) => entry.message);

    expect(messages).toEqual(expect.arrayContaining([
      'Unknown UI layout preset: wide.',
      'Unknown Inspector position: left.',
      'Inspector width must be an integer from 240 to 960.',
      'Unknown Assistant streaming effect: typewriter.',
      'Unknown Assistant streaming indicator: pulse.',
      'Unknown Assistant content reveal mode: typewriter.',
      'Unknown Assistant content reveal pace: rushed.',
      'Assistant maximum visual lag must be an integer from 100 to 2000 milliseconds.',
      'Assistant streaming speed must be an integer from 400 to 4000 milliseconds.',
      'Assistant streaming intensity must be an integer from 10 to 100 percent.',
      'Unknown action id: request.send.',
      'Unknown message action visibility: hover.',
      'Message tag labels must contain 1 to 48 characters.',
      'Unknown message tag source: network.',
      'Message tag paths must be safe bounded dot paths.',
      'Unknown message tag operator: regex.',
      'Message tag ids must be unique, bounded identifiers.',
      'This message tag operator requires a primitive value.',
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

  it('accepts bounded opening response blocks and rejects unsafe or ambiguous definitions', () => {
    const valid = validProfile();
    valid.opening = { mode: 'request', response: { messagePath: '$.content', blocks: [
      { id: 'suggestions', kind: 'choices', path: '$.optionsInfo', itemLabelPath: '$.option', itemPromptPath: '$.option' },
      { id: 'quota', kind: 'meter', path: '$.quota', valuePath: '$.used', maxPath: '$.limit' },
    ] } };
    expect(new ProfileValidator().validate(valid)).toEqual([]);

    const duplicatedLegacyPath = validProfile();
    duplicatedLegacyPath.opening = { mode: 'request', response: { startersPath: '$.optionsInfo', blocks: [
      { id: 'suggestions', kind: 'choices', path: '$.optionsInfo' },
    ] } };
    expect(new ProfileValidator().validate(duplicatedLegacyPath)).toContainEqual(expect.objectContaining({
      severity: 'warning',
      message: 'Opening choices block duplicates the legacy starter path and may render the same options twice.',
    }));

    const invalid = validProfile();
    invalid.opening = { mode: 'request', response: { blocks: [
      { id: 'duplicate', kind: 'fields', path: '$.account', fields: [{ id: 'same', label: '', path: '$.__proto__' }, { id: 'same', label: 'Plan', path: '$.plan' }] },
      { id: 'duplicate', kind: 'meter', path: '$.quota', valuePath: '$.constructor', maxPath: '' },
    ] } };
    const messages = new ProfileValidator().validate(invalid).map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Opening field label must contain 1 to 80 characters.',
      'Opening field path must be a safe dotted path.',
      'Duplicate opening field id: same.',
      'Opening meter path must be a safe dotted path.',
      'Duplicate opening block id: duplicate.',
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
