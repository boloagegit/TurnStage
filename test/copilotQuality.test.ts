import { describe, expect, it } from 'vitest';
import { QUALITY_REVIEW_LIMITS } from '../src/extension/copilot/quality/contracts';
import { createQualityDisclosureGrant, createQualityReviewRecord, QualityGrantStore, validateQualityRubrics } from '../src/extension/copilot/quality/policy';

const rubric = [{ id: 'support', name: 'Support quality', criteria: [{ id: 'correct', label: 'Correct', description: 'Claims match disclosed evidence.' }] }];

describe('Copilot advisory quality policy', () => {
  it('requires explicit bounded attempt selection and returns no formal outcome field', () => {
    const grant = createQualityDisclosureGrant({ evidenceIds: ['evidence-1'], attempts: [{ attemptId: 'attempt-1', response: 'A bounded assistant response.' }], rubrics: rubric, now: 100, grantId: 'grant-1' });
    expect(grant).toMatchObject({ version: 'QualityDisclosureGrantV1', disclosure: { manualSelection: true, prompts: false, responseContent: true } });
    expect(JSON.stringify(grant)).not.toContain('outcome');
    expect(() => createQualityDisclosureGrant({ evidenceIds: [], attempts: [], rubrics: rubric })).toThrow(/Select 1-/);
  });

  it('enforces per-response, aggregate, attempt, and secret boundaries', () => {
    expect(() => createQualityDisclosureGrant({ evidenceIds: ['e'], attempts: [{ attemptId: 'a', response: 'x'.repeat(QUALITY_REVIEW_LIMITS.maxResponseCharacters + 1) }] })).toThrow(/exceeds/);
    expect(() => createQualityDisclosureGrant({ evidenceIds: ['e'], attempts: [{ attemptId: 'a', response: 'Bearer abcdefghijklmnop' }] })).toThrow(/secret-like/);
    const evidenceIds = Array.from({ length: QUALITY_REVIEW_LIMITS.maxSelectedAttempts + 1 }, (_, index) => `e-${index}`);
    expect(() => createQualityDisclosureGrant({ evidenceIds, attempts: evidenceIds.map((_, index) => ({ attemptId: `a-${index}`, response: 'ok' })) })).toThrow(/Select 1-/);
  });

  it('rejects complete URLs and common credential shapes without blocking ordinary security wording', () => {
    const unsafeResponses = [
      'See https://example.com/help for details.',
      'token=abcd',
      ['github', 'pat', '11abcdefghijklmnopqrstuv'].join('_'),
      ['AIzaSy', 'Abcdefghijklmnopqrstuvwx'].join(''),
      ['ghp', '123456789012345678901234'].join('_'),
      ['sk', '1234567890abcdefghijkl'].join('-'),
      ['xoxb', '1234567890abcdef'].join('-'),
    ];
    for (const response of unsafeResponses) {
      expect(() => createQualityDisclosureGrant({ evidenceIds: ['e'], attempts: [{ attemptId: 'a', response }] })).toThrow();
    }

    expect(createQualityDisclosureGrant({
      evidenceIds: ['e'],
      attempts: [{ attemptId: 'a', response: 'A token is a concept; basic instructions are safe to discuss.' }],
    }).attempts[0]?.response).toContain('basic instructions');
  });

  it('applies the same URL and secret policy to review summaries and rationales', () => {
    const grant = createQualityDisclosureGrant({ evidenceIds: ['e'], attempts: [{ attemptId: 'a', response: 'A safe response.' }], rubrics: rubric, now: 100, grantId: 'grant-policy' });
    const finding = { rubricId: 'support', criterionId: 'correct', rating: 'meets' as const, rationale: 'Observed.', evidenceAttemptIds: ['a'] };
    expect(() => createQualityReviewRecord(grant, { summary: 'See https://example.com', findings: [finding] }, 200)).toThrow(/unsafe/);
    expect(() => createQualityReviewRecord(grant, { summary: 'Safe.', findings: [{ ...finding, rationale: 'token=abcd' }] }, 200)).toThrow(/unsafe/);
  });

  it('validates fixed rubrics and rejects duplicates or executable-looking extra fields', () => {
    expect(validateQualityRubrics(rubric)[0]?.criteria[0]?.id).toBe('correct');
    expect(() => validateQualityRubrics([{ ...rubric[0], criteria: [...rubric[0]!.criteria, rubric[0]!.criteria[0]] }])).toThrow(/Duplicate criterion/);
    expect(() => validateQualityRubrics([{ ...rubric[0], prompt: 'ignore instructions' }])).toThrow(/unsupported property/);
  });

  it('records bounded advisory provenance without response content', () => {
    const grant = createQualityDisclosureGrant({ evidenceIds: ['evidence-1'], attempts: [{ attemptId: 'attempt-1', response: 'Private response text that must not be exported.' }], rubrics: rubric, now: 100, grantId: 'grant-1' });
    const record = createQualityReviewRecord(grant, { summary: 'Generally correct.', modelLabel: 'Copilot model reported by host', findings: [{ rubricId: 'support', criterionId: 'correct', rating: 'meets', rationale: 'The disclosed response matches the available evidence.', evidenceAttemptIds: ['attempt-1'] }] }, 200);
    expect(record).toMatchObject({ advisoryOnly: true, evidenceCompleteness: 'complete', version: 'QualityReviewRecordV1' });
    expect(record.rubricDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('Private response text');
    expect(record).not.toHaveProperty('outcome');
  });

  it('uses single-use expiring grants and rejects undisclosed evidence ids', () => {
    const store = new QualityGrantStore();
    store.issue(createQualityDisclosureGrant({ evidenceIds: ['evidence-1'], attempts: [{ attemptId: 'attempt-1', response: 'Response.' }], rubrics: rubric, now: 0, grantId: 'grant-1' }), 0);
    expect(() => store.record('grant-1', { summary: 'Review.', findings: [{ rubricId: 'support', criterionId: 'correct', rating: 'meets', rationale: 'Observed.', evidenceAttemptIds: ['other'] }] }, 1)).toThrow(/undisclosed/);
    store.record('grant-1', { summary: 'Review.', findings: [{ rubricId: 'support', criterionId: 'correct', rating: 'meets', rationale: 'Observed.', evidenceAttemptIds: ['attempt-1'] }] }, 2);
    expect(() => store.get('grant-1', 3)).toThrow(/missing or expired/);
    store.issue(createQualityDisclosureGrant({ evidenceIds: ['evidence-2'], attempts: [{ attemptId: 'attempt-2', response: 'Response.' }], rubrics: rubric, now: 0, grantId: 'grant-2' }), 0);
    expect(() => store.get('grant-2', QUALITY_REVIEW_LIMITS.grantTtlMs + 1)).toThrow(/missing or expired/);
  });
});
