import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnStageEnvironment } from '../src/shared/types';
import { ProfileCodec } from '../src/extension/config/profileCodec';
import { ProfileValidator } from '../src/extension/config/profileValidator';

describe('starter resources', () => {
  const profileIds = ['basic-sse-chat', 'agent-flow', 'enterprise-chat'];
  const codec = new ProfileCodec();
  const environmentText = readFileSync('resources/templates/local.environment.jsonc', 'utf8');
  const environment = codec.parse(environmentText).profile as unknown as TurnStageEnvironment;

  it('relies on manifest file matching instead of copy-location-dependent schema paths', () => {
    expect(environmentText).not.toContain('"$schema"');
    for (const id of profileIds) {
      expect(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8')).not.toContain('"$schema"');
    }
  });

  it('keeps the local mock-server starters credential-free', () => {
    for (const id of profileIds) expect(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8')).not.toContain('${secret.');
    expect(environment.secretReferences).toBeUndefined();
  });

  for (const id of profileIds) {
    it(`${id} parses and passes semantic validation`, () => {
      const parsed = codec.parse(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8'));
      expect(parsed.errors).toEqual([]);
      expect(new ProfileValidator().validate(parsed.profile, parsed.tree, [environment])).toEqual([]);
    });

    it(`${id} fixture contains a terminal event`, () => {
      const events = readFileSync(`resources/fixtures/${id}.jsonl`, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event: string });
      expect(events.at(-1)?.event).toBe('done');
    });

  }

  for (const id of ['basic-sse-chat', 'agent-flow']) {
    it(`${id} exposes every generic stream mock scenario through a profile control`, () => {
      const parsed = codec.parse(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8'));
      const mode = parsed.profile?.controls?.find((control) => control.id === 'mode');
      expect(mode?.options?.map((option) => option.value)).toEqual([
        'normal', 'slow', 'chunk-split', 'malformed-json', 'unknown-event',
        'partial-error', 'http-401', 'http-500', 'idle-timeout', 'disconnect',
      ]);
      expect(JSON.stringify(parsed.profile?.conversation.send.variants)).toContain('controls.mode');
    });
  }

  it('basic-sse-chat declares its built-in two-turn scenario', () => {
    const parsed = codec.parse(readFileSync('resources/templates/basic-sse-chat.turnstage.jsonc', 'utf8'));
    const scenario = parsed.profile?.tests?.scenarios.find((item) => item.id === 'basic-two-turn');

    expect(scenario).toMatchObject({ id: 'basic-two-turn', name: 'Basic two-turn contract' });
    expect(scenario?.steps.map((step) => step.id)).toEqual(['first-turn', 'continuation']);
    expect(scenario?.steps.every((step) => (step.assertions?.length ?? 0) > 0)).toBe(true);
  });

  it('agent-flow declares its built-in agent tools scenario', () => {
    const parsed = codec.parse(readFileSync('resources/templates/agent-flow.turnstage.jsonc', 'utf8'));
    const scenario = parsed.profile?.tests?.scenarios.find((item) => item.id === 'agent-tools');

    expect(scenario).toMatchObject({ id: 'agent-tools', name: 'Agent tool and citation contract' });
    expect(scenario?.steps).toHaveLength(1);
    expect(scenario?.steps[0]?.assertions?.map((assertion) => assertion.path)).toEqual([
      'turn.state',
      'events.normalized[*].type',
      'assistant.text',
    ]);
  });

  it('enterprise-chat exposes the contract-specific mock scenarios', () => {
    const parsed = codec.parse(readFileSync('resources/templates/enterprise-chat.turnstage.jsonc', 'utf8'));
    const mode = parsed.profile?.controls?.find((control) => control.id === 'mode');
    expect(mode?.options?.map((option) => option.value)).toEqual(['normal', 'contract-slow', 'contract-error', 'contract-actions', 'opening-options']);
  });
});
