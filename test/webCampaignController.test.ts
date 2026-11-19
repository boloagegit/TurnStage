import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostPayload } from '../src/shared/protocol';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { WebCampaignController } from '../web/src/webCampaignController';
import { WebTestController } from '../web/src/webTestController';

afterEach(() => vi.unstubAllGlobals());

describe('WebCampaignController', () => {
  it.each([[undefined, undefined, 1], [4, undefined, 4], [1, 3, 3]] as const)('previews and enforces Profile %s, override %s as %i workers', async (profileLimit, override, expected) => {
    const profile: TurnStageProfile = {
      version: 1, id: `campaign-limits-${crypto.randomUUID()}`, name: 'Campaign limits',
      conversation: { send: { method: 'POST', url: 'https://example.test/stream' } },
      stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
      tests: {
        scenarios: Array.from({ length: 4 }, (_, i) => ({ id: `case-${i}`, name: `Case ${i}`, steps: [{ id: 'turn', input: 'mock input' }] })),
        ...(profileLimit === undefined ? {} : { runPolicy: { maxConcurrency: profileLimit } }),
        campaigns: [{ id: 'smoke', name: 'Smoke', ...(override === undefined ? {} : { runPolicy: { maxConcurrency: override } }) }],
      },
    };
    const definition = structuredClone(profile.tests!.campaigns![0]);
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const messages: HostPayload[] = [];
    const post = (payload: HostPayload) => messages.push(payload);
    const tests = new WebTestController(() => profile, () => environment, new Map(), post);
    const campaigns = new WebCampaignController(() => profile, tests, post);
    const releases: Array<() => void> = [];
    const fetch = vi.fn(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);

    await campaigns.preview('smoke');
    expect(messages.at(-1)).toMatchObject({ type: 'campaign.preview', maxConcurrency: expected, selectedCases: 4 });
    const running = campaigns.run('smoke');
    for (let dispatched = 0; dispatched < 4; dispatched += expected) {
      await vi.waitFor(() => expect(releases).toHaveLength(Math.min(expected, 4 - dispatched)));
      if (dispatched === 0) {
        expect(messages).toContainEqual(expect.objectContaining({ type: 'campaign.dashboard', dashboard: expect.objectContaining({
          campaigns: [expect.objectContaining({ activeCaseCount: expected, latest: expect.objectContaining({ status: 'running', plan: expect.objectContaining({ maxConcurrency: expected }) }) })],
        }) }));
        profile.tests!.runPolicy = { maxConcurrency: 8 };
      }
      for (const release of releases.splice(0)) release();
    }
    await running;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(profile.tests!.campaigns![0]).toEqual(definition);
    const latest = messages.filter((message) => message.type === 'campaign.dashboard').at(-1);
    expect(latest?.dashboard.campaigns[0]?.latest).toMatchObject({ status: 'completed', plan: { maxConcurrency: expected } });
  });

  it('previews profile campaigns from browser-native scenarios', async () => {
    const id = `campaign-profile-${crypto.randomUUID()}`;
    const profile: TurnStageProfile = { version: 1, id, name: 'Campaign Web', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [{ id: 'contract-case', name: 'Contract case', tags: ['smoke'], steps: [{ id: 'turn', input: 'hello' }] }], campaigns: [{ id: 'smoke', name: 'Smoke', selectors: { tags: ['smoke'] } }] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const posted: HostPayload[] = [];
    const post = (payload: HostPayload) => posted.push(payload);
    const tests = new WebTestController(() => profile, () => environment, new Map(), post);
    const campaigns = new WebCampaignController(() => profile, tests, post);

    await campaigns.preview('smoke');
    await campaigns.postDashboard();

    expect(posted).toContainEqual(expect.objectContaining({ type: 'campaign.preview', campaignId: 'smoke', selectedCases: 1, plannedAttempts: 1 }));
    expect(posted).toContainEqual({ type: 'campaign.dashboard', dashboard: { profileId: id, campaigns: [{ definition: profile.tests!.campaigns![0] }] } });
  });

  it('never includes captured drafts in a saved execution scope', async () => {
    const id = `campaign-draft-${crypto.randomUUID()}`;
    const profile: TurnStageProfile = { version: 1, id, name: 'Draft scope', conversation: { send: { method: 'POST', url: 'https://example.test' } }, stream: { transport: 'sse', mappings: [] }, tests: { scenarios: [
      { id: 'ready', name: 'Ready', tags: ['smoke'], steps: [{ id: 'turn', input: 'ready' }] },
      { id: 'draft', name: 'Draft', tags: ['smoke', 'needs-review'], steps: [{ id: 'turn', input: 'draft' }] },
    ], campaigns: [{ id: 'smoke', name: 'Smoke', selectors: { tags: ['smoke'] } }] } };
    const environment: TurnStageEnvironment = { version: 1, id: 'local', name: 'Local', variables: {} };
    const posted: HostPayload[] = [];
    const post = (payload: HostPayload) => posted.push(payload);
    const tests = new WebTestController(() => profile, () => environment, new Map(), post);
    const campaigns = new WebCampaignController(() => profile, tests, post);

    await campaigns.preview('smoke');
    expect(posted).toContainEqual(expect.objectContaining({ type: 'campaign.preview', selectedCases: 1 }));
  });
});
