import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  workspace: { isTrusted: true },
  l10n: { t: (message: string) => message },
}));

vi.mock('vscode', () => vscodeMock);

import { ScenarioCopilotRuntime } from '../src/extension/copilot/scenarioRuntime';
import { InMemoryCopilotArtifactRepository } from '../src/extension/copilot/artifacts';

const token = { isCancellationRequested: false } as never;

function controller(overrides: Record<string, unknown> = {}) {
  return {
    previewSelection: vi.fn(async () => ({
      selectedCount: 1,
      plannedAttempts: 1,
      plannedTurns: 1,
      maximumRequests: 1,
      maximumDurationMs: 1_000,
      maximumRepetitions: 1,
      environments: ['local'],
      warnings: [],
    })),
    getIntegrityMaterial: vi.fn(async () => ({ profile: { id: 'profile' }, cases: [{ id: 'case' }] })),
    runSelection: vi.fn(async () => ({ summaries: [], results: [] })),
    getEvidence: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('ScenarioCopilotRuntime safety boundaries', () => {
  beforeEach(() => { vscodeMock.workspace.isTrusted = true; });

  it('fails closed when Workspace Trust changes while a network run is active', async () => {
    const tests = controller({
      runSelection: vi.fn(async () => {
        vscodeMock.workspace.isTrusted = false;
        return { summaries: [], results: [] };
      }),
    });
    const runtime = new ScenarioCopilotRuntime(tests as never);

    await expect(runtime.runTests({ selectors: ['case'] }, token)).rejects.toMatchObject({ code: 'WORKSPACE_UNTRUSTED' });
  });

  it('rejects an aggregate Copilot run above the attempt budget before integrity or network work', async () => {
    const tests = controller({
      previewSelection: vi.fn(async () => ({
        selectedCount: 100,
        plannedAttempts: 501,
        plannedTurns: 501,
        maximumRequests: 501,
        maximumDurationMs: 1_000,
        maximumRepetitions: 6,
        environments: ['local'],
        warnings: [],
      })),
    });
    const runtime = new ScenarioCopilotRuntime(tests as never);

    await expect(runtime.runTests({ selectors: ['case'] }, token)).rejects.toMatchObject({ code: 'RUN_BUDGET_EXCEEDED' });
    expect(tests.getIntegrityMaterial).not.toHaveBeenCalled();
    expect(tests.runSelection).not.toHaveBeenCalled();
  });

  it('rechecks the final prepared execution snapshot before network work', async () => {
    const tests = controller({
      runSelection: vi.fn(async (_selection: unknown, _token: unknown, scope: { validateIntegrity?: (material: unknown) => void }) => {
        scope.validateIntegrity?.({ profile: { id: 'changed-profile' }, cases: [{ id: 'case' }] });
        return { summaries: [], results: [] };
      }),
    });
    const runtime = new ScenarioCopilotRuntime(tests as never);

    await expect(runtime.runTests({ selectors: ['case'] }, token)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  it('allows only one Copilot-triggered network run at a time', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const tests = controller({
      runSelection: vi.fn(async () => {
        entered();
        await hold;
        return { summaries: [], results: [] };
      }),
    });
    const runtime = new ScenarioCopilotRuntime(tests as never);
    const first = runtime.runTests({ selectors: ['case'] }, token);
    await started;

    await expect(runtime.runTests({ selectors: ['case'] }, token)).rejects.toMatchObject({ code: 'RUNTIME_FAILED' });
    release();
    await expect(first).resolves.toMatchObject({ completedCases: 0 });
  });

  it('binds an advisory quality artifact to the stored run and profile', async () => {
    const evidence = {
      evidence: {
        profileId: 'profile-a',
        scenarioId: 'case-a',
        snapshot: { messages: [{ id: 'assistant-1', role: 'assistant', status: 'completed', parts: [{ text: 'A safe bounded response.' }] }] },
      },
      location: { kind: 'message', messageId: 'assistant-1' },
    };
    const tests = controller({
      runSelection: vi.fn(async () => ({
        summaries: [{ profileId: 'profile-a', scenarioId: 'case-a', scenarioName: 'Case A', outcome: 'resisted', evidenceId: 'evidence-a', sampleComplete: true }],
        results: [],
      })),
      getEvidence: vi.fn((id: string) => id === 'evidence-a' ? evidence : undefined),
    });
    const artifacts = new InMemoryCopilotArtifactRepository();
    const runtime = new ScenarioCopilotRuntime(tests as never, undefined, undefined, artifacts);

    const run = await runtime.runTests({ selectors: ['case'] }, token);
    const disclosed = await runtime.reviewResponseQuality({ action: 'disclose', evidenceIds: ['evidence-a'] }, token);
    if (disclosed.action !== 'disclose') throw new Error('Expected a disclosure grant.');
    const recorded = await runtime.reviewResponseQuality({
      action: 'record',
      grantId: disclosed.grant.grantId,
      review: {
        summary: 'The disclosed response is relevant and clear.',
        findings: disclosed.grant.rubrics.flatMap((rubric) => rubric.criteria.map((criterion) => ({
          rubricId: rubric.id,
          criterionId: criterion.id,
          rating: 'meets' as const,
          rationale: 'The selected evidence supports this criterion.',
          evidenceAttemptIds: [disclosed.grant.attempts[0]!.attemptId],
        }))),
      },
    }, token);

    expect(run.runId).toBeTruthy();
    expect(recorded.action).toBe('record');
    expect(artifacts.snapshot().qualityReviews).toMatchObject([{ profileId: 'profile-a', runId: run.runId }]);
  });
});
