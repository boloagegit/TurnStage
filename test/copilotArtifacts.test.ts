import { describe, expect, it } from 'vitest';
import {
  COPILOT_ARTIFACT_LIMITS,
  CopilotArtifactError,
  InMemoryCopilotArtifactRepository,
} from '../src/extension/copilot/artifacts';
import type { ProfilePatchDraftV1 } from '../src/extension/copilot/remediation';
import { stableStringify } from '../src/extension/testing/provenance';

const DIGEST = 'a'.repeat(64);

function diagnosis(overrides: Record<string, unknown> = {}) {
  return {
    version: 'DiagnosisResultV1',
    sanitized: true,
    runId: 'run-1',
    status: 'partial',
    evidenceLevel: 'moderate',
    summary: 'Headers were delayed at https://private.example.test/chat; Bearer very-secret-value.',
    findings: [{
      category: 'timeout',
      evidenceLevel: 'strong',
      label: 'Opening timeout',
      reason: 'The request exceeded the configured timeout.',
      evidence: [{ kind: 'network', id: 'network-1' }],
    }],
    nextActions: [{ id: 'inspect-network', label: 'Inspect network', requiresApproval: false }],
    capsule: {
      version: 'DiagnosticCapsuleV1',
      sanitized: true,
      runId: 'run-1',
      outcome: 'indeterminate',
      timing: {
        stages: [
          { stage: 'request', observed: true, elapsedMs: 0 },
          { stage: 'headers', observed: true, elapsedMs: 950 },
        ],
        missingStages: ['firstChunk', 'firstRawEvent', 'firstNormalizedContent', 'firstVisibleText', 'terminal'],
        orderingValid: true,
        anomalies: [],
      },
      metrics: { headersLatencyMs: 950, eventCount: 0 },
      transport: { protocol: 'sse', status: 504, terminalState: 'timeout', timeout: true, variantId: 'model-a' },
      errors: [{ category: 'timeout', code: 'opening-timeout', message: 'Bearer very-secret-value' }],
      evidence: [
        { kind: 'network', id: 'https://private.example.test/headers' },
        { kind: 'event', id: 'event-1', stage: 'headers', path: 'https://private.example.test/events' },
      ],
      configIssues: ['config.invalid'],
      assertions: { total: 1, passed: 0, failed: 1, failedIds: ['assertion-1'] },
    },
    prompt: 'Never persist this prompt.',
    response: 'Never persist this complete assistant response.',
    ...overrides,
  };
}

function profilePatchDraft() {
  return {
    format: 'turnstage-profile-patch-draft',
    version: 1,
    profileDigest: DIGEST,
    sourceDigest: 'b'.repeat(64),
    updatedProfileDigest: 'c'.repeat(64),
    sourceLength: 200,
    updatedSourceLength: 205,
    summary: 'Increase timeout after observing https://private.example.test and token=secret-value.',
    changes: [{
      path: ['conversation', 'send', 'timeoutMs'],
      pathLabel: 'conversation.send.timeoutMs',
      operation: 'set',
      category: 'request-timing',
      before: { kind: 'number', value: 20_000 },
      after: { kind: 'number', value: 45_000 },
      reason: 'Observed delayed headers.',
    }, {
      path: ['stream', 'mappingMode'],
      pathLabel: 'stream.mappingMode',
      operation: 'set',
      category: 'stream-parser',
      before: { kind: 'string', value: 'the old profile edit content' },
      after: { kind: 'string', value: 'the new profile edit content' },
      reason: 'Align parser mapping.',
    }],
    edits: [{ offset: 1, length: 3, content: 'https://private.example.test/secret profile edit content' }],
    inverseEdits: [{ offset: 1, length: 5, content: 'old profile edit content' }],
    safety: { allowlisted: true, networkSettingsChanged: false, secretSettingsChanged: false, requiresConfirmation: true, contentRedacted: true },
  };
}

function qualityReview() {
  return {
    version: 'QualityReviewRecordV1',
    advisoryOnly: true,
    grantId: 'grant-1',
    evidenceIds: ['evidence-1'],
    attemptIds: ['attempt-1'],
    createdAt: 123,
    modelLabel: 'Copilot model',
    rubricDigest: DIGEST,
    disclosureDigest: 'b'.repeat(64),
    evidenceCompleteness: 'complete',
    summary: 'The complete assistant response was: Private assistant response with https://private.example.test.',
    findings: [{
      rubricId: 'support',
      criterionId: 'correct',
      rating: 'meets',
      rationale: 'This rationale must not become a transcript.',
      evidenceAttemptIds: ['attempt-1'],
    }],
    disclosure: {
      manualSelection: true,
      responseContent: true,
      prompts: false,
      rawPayloads: false,
      headers: false,
      fullUrls: false,
      secrets: false,
      disclosedCharacters: 37,
    },
    attempts: [{ attemptId: 'attempt-1', response: 'Private assistant response with https://private.example.test.' }],
    prompt: 'Never persist this prompt.',
    body: 'Never persist this request body.',
  };
}

describe('Copilot artifact repository', () => {
  it('stores deterministic diagnosis metadata and excludes payloads, URLs, and secrets', () => {
    const repository = new InMemoryCopilotArtifactRepository();
    const input = diagnosis();
    repository.recordDiagnosis(input, { secretValues: ['very-secret-value'], recordedAt: 10 });
    input.summary = 'mutated after recording';

    const snapshot = repository.snapshot();
    const stored = snapshot.diagnoses[0];
    expect(stored?.summary).toContain('[URL_REDACTED]');
    expect(stored?.summary).toContain('[SECRET_REDACTED]');
    expect(stored?.timing.stages.map((stage) => stage.stage)).toEqual(['request', 'headers', 'firstChunk', 'firstRawEvent', 'firstNormalizedContent', 'firstVisibleText', 'terminal']);
    expect(stored?.metrics).toEqual({ headersLatencyMs: 950, eventCount: 0 });
    expect(stored?.evidence).toEqual([{ kind: 'network' }, { kind: 'event', id: 'event-1', stage: 'headers' }]);
    expect(JSON.stringify(snapshot)).not.toContain('private.example.test');
    expect(JSON.stringify(snapshot)).not.toContain('very-secret-value');
    expect(JSON.stringify(snapshot)).not.toContain('Never persist');
    expect(stored?.summary).not.toContain('mutated after recording');
  });

  it('records patch audit metadata only and never stores profile edit contents', () => {
    const repository = new InMemoryCopilotArtifactRepository();
    const draft = profilePatchDraft() as unknown as ProfilePatchDraftV1;
    const artifact = repository.recordProfilePatch({ draft, status: 'applied', profileId: 'profile-1', recordedAt: 20, secretValues: ['secret-value'] });
    expect(artifact.profileId).toBe('profile-1');
    expect(artifact.editCount).toBe(1);
    expect(artifact.inverseEditCount).toBe(1);
    expect(artifact.changes[0]?.after).toEqual({ kind: 'number', value: 45_000 });
    expect(artifact.changes[1]?.after).toEqual({ kind: 'string' });
    expect(JSON.stringify(artifact)).not.toContain('profile edit content');
    expect(JSON.stringify(artifact)).not.toContain('private.example.test');
    expect(artifact.requiresConfirmation).toBe(true);
    expect(artifact.contentRedacted).toBe(true);
  });

  it('records quality review ratings and summaries without assistant attempts or rationale', () => {
    const repository = new InMemoryCopilotArtifactRepository();
    const artifact = repository.recordQualityReview(qualityReview(), { profileId: 'profile-1', runId: 'run-1', disclosedResponses: ['Private assistant response with https://private.example.test.'] });
    expect(artifact).toMatchObject({ kind: 'qualityReview', profileId: 'profile-1', runId: 'run-1', advisoryOnly: true, evidenceCompleteness: 'complete' });
    expect(artifact.findings).toEqual([{ rubricId: 'support', criterionId: 'correct', rating: 'meets', evidenceAttemptIds: ['attempt-1'] }]);
    expect(artifact.summary).toContain('[SECRET_REDACTED]');
    expect(JSON.stringify(artifact)).not.toContain('Private assistant response');
    expect(JSON.stringify(artifact)).not.toContain('Never persist');
    expect(JSON.stringify(artifact)).not.toContain('private.example.test');
    expect(JSON.stringify(artifact)).not.toContain('rationale');
  });

  it('bounds each artifact stream, returns frozen defensive snapshots, and sorts deterministically', () => {
    const repository = new InMemoryCopilotArtifactRepository();
    for (let index = 0; index < COPILOT_ARTIFACT_LIMITS.maxDiagnoses + 5; index += 1) {
      repository.recordDiagnosis(diagnosis({ runId: `run-${String(index).padStart(3, '0')}`, summary: `run ${index}` }));
    }
    const first = repository.snapshot();
    const second = repository.snapshot();
    expect(first.diagnoses).toHaveLength(COPILOT_ARTIFACT_LIMITS.maxDiagnoses);
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.diagnoses)).toBe(true);
    expect(Object.isFrozen(first.diagnoses[0])).toBe(true);
    expect(() => (first.diagnoses as unknown as DiagnosisArtifactLike[]).push(first.diagnoses[0]!)).toThrow();
    expect(repository.snapshot().diagnoses).toHaveLength(COPILOT_ARTIFACT_LIMITS.maxDiagnoses);
  });

  it('fails closed on unsanitized or unsafe source records', () => {
    const repository = new InMemoryCopilotArtifactRepository();
    expect(() => repository.recordDiagnosis({ runId: 'run-1', capsule: {} })).toThrow(CopilotArtifactError);
    const unsafeDraft = { ...profilePatchDraft(), safety: { requiresConfirmation: false, contentRedacted: false } } as unknown as ProfilePatchDraftV1;
    expect(() => repository.recordProfilePatch({ draft: unsafeDraft, profileId: 'profile-1', status: 'drafted' })).toThrow(CopilotArtifactError);
    expect(() => repository.recordQualityReview({ ...qualityReview(), disclosure: { ...qualityReview().disclosure, fullUrls: true } }, { profileId: 'profile-1' })).toThrow(CopilotArtifactError);

    const googleKey = `AIza${'A'.repeat(32)}`;
    const unsafeIdentifier = diagnosis({
      capsule: { ...diagnosis().capsule, evidence: [{ kind: 'event', id: googleKey }] },
    });
    const artifact = repository.recordDiagnosis(unsafeIdentifier);
    expect(JSON.stringify(artifact)).not.toContain(googleKey);
    expect(artifact.evidence).toEqual([{ kind: 'event' }]);
  });
});

type DiagnosisArtifactLike = { artifactId: string };
