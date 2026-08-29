export const QUALITY_REVIEW_LIMITS = {
  maxRubrics: 20,
  maxCriteriaPerRubric: 20,
  maxSelectedAttempts: 10,
  maxResponseCharacters: 8_000,
  maxTotalCharacters: 32_000,
  maxFindingCharacters: 1_000,
  maxSummaryCharacters: 2_000,
  grantTtlMs: 10 * 60_000,
  maxActiveGrants: 20,
} as const;

export type QualityRating = 'meets' | 'partiallyMeets' | 'doesNotMeet' | 'notEnoughEvidence';

export interface QualityRubricCriterion {
  id: string;
  label: string;
  description: string;
}

export interface QualityRubricDefinition {
  id: string;
  name: string;
  description?: string;
  criteria: QualityRubricCriterion[];
}

export interface QualityDisclosureAttempt {
  attemptId: string;
  response: string;
}

export interface QualityDisclosureGrantV1 {
  version: 'QualityDisclosureGrantV1';
  grantId: string;
  evidenceIds: string[];
  attempts: QualityDisclosureAttempt[];
  rubrics: QualityRubricDefinition[];
  disclosedCharacters: number;
  createdAt: number;
  expiresAt: number;
  disclosure: {
    manualSelection: true;
    responseContent: true;
    prompts: false;
    rawPayloads: false;
    headers: false;
    fullUrls: false;
    secrets: false;
  };
}

export interface QualityReviewFinding {
  rubricId: string;
  criterionId: string;
  rating: QualityRating;
  rationale: string;
  evidenceAttemptIds: string[];
}

export interface QualityReviewSubmission {
  summary: string;
  findings: QualityReviewFinding[];
  /** Descriptive metadata reported by Copilot, not an authenticated model identity. */
  modelLabel?: string;
}

export interface QualityReviewRecordV1 {
  version: 'QualityReviewRecordV1';
  advisoryOnly: true;
  grantId: string;
  evidenceIds: string[];
  attemptIds: string[];
  createdAt: number;
  modelLabel?: string;
  rubricDigest: string;
  disclosureDigest: string;
  evidenceCompleteness: 'complete' | 'partial';
  summary: string;
  findings: QualityReviewFinding[];
  disclosure: QualityDisclosureGrantV1['disclosure'] & { disclosedCharacters: number };
}

export const DEFAULT_QUALITY_RUBRIC: QualityRubricDefinition = {
  id: 'turnstage-response-quality',
  name: 'Response quality',
  description: 'A bounded advisory review. It never changes the formal TurnStage test outcome.',
  criteria: [
    { id: 'relevance', label: 'Relevance', description: 'The response directly addresses the visible user request.' },
    { id: 'clarity', label: 'Clarity', description: 'The response is understandable, structured, and avoids unnecessary ambiguity.' },
    { id: 'completeness', label: 'Completeness', description: 'The response covers the important parts supported by the disclosed evidence.' },
    { id: 'grounding', label: 'Grounding', description: 'Claims stay within the disclosed evidence and clearly signal uncertainty.' },
  ],
};
