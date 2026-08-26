import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnStageEnvironment } from '../src/shared/types';
import { ProfileCodec } from '../src/extension/config/profileCodec';
import { ProfileValidator } from '../src/extension/config/profileValidator';

describe('starter resources', () => {
  const codec = new ProfileCodec();
  const environment = codec.parse(readFileSync('resources/templates/local.environment.jsonc', 'utf8')).profile as unknown as TurnStageEnvironment;

  for (const id of ['basic-sse-chat', 'agent-flow']) {
    it(`${id} parses and passes semantic validation`, () => {
      const parsed = codec.parse(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8'));
      expect(parsed.errors).toEqual([]);
      expect(new ProfileValidator().validate(parsed.profile, parsed.tree, [environment])).toEqual([]);
    });

    it(`${id} fixture contains a terminal event`, () => {
      const events = readFileSync(`resources/fixtures/${id}.jsonl`, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event: string });
      expect(events.at(-1)?.event).toBe('done');
    });

    it(`${id} exposes every stream mock scenario through a profile control`, () => {
      const parsed = codec.parse(readFileSync(`resources/templates/${id}.turnstage.jsonc`, 'utf8'));
      const mode = parsed.profile?.controls?.find((control) => control.id === 'mode');
      expect(mode?.options?.map((option) => option.value)).toEqual([
        'normal', 'slow', 'chunk-split', 'malformed-json', 'unknown-event',
        'partial-error', 'http-401', 'http-500', 'idle-timeout', 'disconnect',
      ]);
      expect(JSON.stringify(parsed.profile?.conversation.send.variants)).toContain('controls.mode');
    });
  }
});
