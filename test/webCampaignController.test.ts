import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { HostPayload } from '../src/shared/protocol';
import type { TurnStageEnvironment, TurnStageProfile } from '../src/shared/types';
import { WebCampaignController } from '../web/src/webCampaignController';
import { WebTestController } from '../web/src/webTestController';

describe('WebCampaignController', () => {
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
});
