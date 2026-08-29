import type { JsonObject } from '../../../shared/types';

/**
 * The profile remediation boundary is intentionally narrower than the profile
 * editor.  It is designed for evidence-backed fixes suggested by Copilot,
 * not for arbitrary configuration authoring.
 */
export const PROFILE_PATCH_DRAFT_FORMAT = 'turnstage-profile-patch-draft' as const;
export const PROFILE_PATCH_DRAFT_VERSION = 1 as const;

export const PROFILE_PATCH_LIMITS = {
  maxOperations: 64,
  maxPathSegments: 12,
  maxPathString: 256,
  maxReasonLength: 256,
  maxSummaryLength: 512,
  maxSourceCharacters: 2 * 1024 * 1024,
  maxEditCharacters: 128 * 1024,
  maxTotalEditCharacters: 512 * 1024,
  maxTopLevelKeys: 16,
  maxArrayItems: 100,
  maxStringValueLength: 256,
  maxRetryStatuses: 20,
} as const;

export type ProfilePatchPathPart = string | number;
export type ProfilePatchPath = readonly ProfilePatchPathPart[];
export type ProfilePatchOperation = 'set' | 'remove';
export type ProfilePatchCategory = 'request-timing' | 'retry-timing' | 'stream-parser' | 'mapping';

/** Input accepted by the pure planner. It is never written directly. */
export interface ProfilePatchOperationV1 {
  path: ProfilePatchPath;
  operation?: ProfilePatchOperation;
  value?: unknown;
  reason?: string;
  category?: ProfilePatchCategory;
}

export interface ProfilePatchTextEditV1 {
  /** Character offsets in the source document supplied to the planner. */
  offset: number;
  length: number;
  content: string;
}

export interface ProfilePatchValueSummaryV1 {
  kind: 'missing' | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
  /** Exact values are included only for finite numbers, booleans, null, and known-safe short strings. */
  value?: boolean | number | string | null;
  length?: number;
  keys?: number;
  digest?: string;
}

export interface ProfilePatchChangeV1 {
  path: ProfilePatchPath;
  /** Stable, human-readable path; it contains no profile payload. */
  pathLabel: string;
  operation: ProfilePatchOperation;
  category: ProfilePatchCategory;
  before: ProfilePatchValueSummaryV1;
  after: ProfilePatchValueSummaryV1;
  reason: string;
}

export interface ProfilePatchSafetyV1 {
  allowlisted: true;
  networkSettingsChanged: false;
  secretSettingsChanged: false;
  requiresConfirmation: true;
  contentRedacted: true;
}

/**
 * Serializable, reviewable remediation proposal. The text edits are local
 * JSONC edits and can be converted to VS Code WorkspaceEdit by the host.
 * This object contains no profile, request, response, or URL payload.
 */
export interface ProfilePatchDraftV1 {
  format: typeof PROFILE_PATCH_DRAFT_FORMAT;
  version: typeof PROFILE_PATCH_DRAFT_VERSION;
  profileDigest: string;
  sourceDigest: string;
  updatedProfileDigest: string;
  sourceLength: number;
  updatedSourceLength: number;
  summary: string;
  changes: readonly ProfilePatchChangeV1[];
  edits: readonly ProfilePatchTextEditV1[];
  inverseEdits: readonly ProfilePatchTextEditV1[];
  safety: ProfilePatchSafetyV1;
}

export interface ProfilePatchPlanInputV1 {
  /** Parsed profile corresponding to sourceText. */
  profile: unknown;
  /** Original JSONC text. Comments and surrounding formatting are retained. */
  sourceText: string;
  operations: readonly ProfilePatchOperationV1[];
  /** A caller-supplied lock. A mismatch fails closed before any edit is planned. */
  expectedProfileDigest?: string;
  /** Optional source-text lock for callers that captured the JSONC document separately. */
  expectedSourceDigest?: string;
  /** Optional known secret values are used only to prevent them entering summaries. */
  secretValues?: readonly unknown[];
  /** Fixed timestamp is accepted for deterministic callers but is not persisted in the draft. */
  generatedAt?: string;
}

export interface ProfilePatchDigestCheckV1 {
  expected?: string;
  actual: string;
  matches: boolean;
}

export interface ProfilePatchVerificationInputV1 {
  profile: unknown;
  sourceText: string;
  /** The source digest and profile digest captured when the draft was created. */
  draft: ProfilePatchDraftV1;
  secretValues?: readonly unknown[];
}

export interface ProfilePatchVerificationResultV1 {
  valid: boolean;
  profileDigest: ProfilePatchDigestCheckV1;
  sourceDigest: ProfilePatchDigestCheckV1;
  errors: string[];
}

export interface ProfilePatchValidationResultV1 {
  valid: boolean;
  errors: string[];
}

/** A JSON-compatible value used by the planner after strict validation. */
export type SafePatchValue = JsonObject | readonly unknown[] | string | number | boolean | null;

export class ProfilePatchError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_PROFILE'
      | 'INVALID_SOURCE'
      | 'INVALID_PATH'
      | 'INVALID_VALUE'
      | 'DIGEST_MISMATCH'
      | 'CONFLICTING_EDITS'
      | 'OVERSIZED'
      | 'NO_OP'
      | 'UNSAFE_EDIT'
      | 'INVALID_DRAFT',
    message: string,
  ) {
    super(message);
    this.name = 'ProfilePatchError';
  }
}
