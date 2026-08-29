import type { ImpactMappingOptions } from '../extension/testing/impactMapping';

export type CliCommand = 'run' | 'verify' | 'help' | 'version';
export type CliOutputFormat = 'json' | 'junit' | 'html' | 'evidence';

export interface CliSelectors {
  profiles: string[];
  suites: string[];
  cases: string[];
  tags: string[];
  changedFiles: string[];
}

export interface CliRunPolicy {
  repetitions?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxRequests?: number;
  failFast: boolean;
}

export interface CliRunOptions extends ImpactMappingOptions {
  command: 'run';
  configFiles: string[];
  selectors: CliSelectors;
  policy: CliRunPolicy;
  format: CliOutputFormat;
  outputPath?: string;
  noColor: boolean;
}

export interface CliVerifyOptions {
  command: 'verify';
  manifestPath: string;
  format: CliOutputFormat;
  outputPath?: string;
  noColor: boolean;
}

export type CliOptions = CliRunOptions | CliVerifyOptions | { command: 'help' | 'version' };

export interface CliParseResult {
  ok: boolean;
  options?: CliOptions;
  errors: string[];
  usage: string;
}

export interface CliRunRequest {
  command: 'run';
  configFiles: readonly string[];
  selectors: CliSelectors;
  policy: CliRunPolicy;
  impact: ImpactMappingOptions;
}

export interface CliVerifyRequest {
  command: 'verify';
  manifestPath: string;
}

export interface CliResultRecord {
  id: string;
  outcome?: string;
  status?: string;
  /** Optional compatibility field for runtimes that expose only passed/not-passed. */
  passed?: boolean;
  durationMs?: number;
  /** A stable failure/check identifier is safe to include; free-form details are not. */
  failureId?: string;
}

export interface CliVerificationResult {
  valid: boolean;
  manifestValid?: boolean;
  errors?: readonly string[];
}

export interface CliExecutionResult {
  runId?: string;
  records?: readonly CliResultRecord[];
  nextCursor?: string;
  manifestDigest?: string;
  verification?: CliVerificationResult;
  provenance?: unknown;
}

export interface CliExecutionRuntime {
  execute(request: CliRunRequest, signal?: AbortSignal): Promise<CliExecutionResult>;
  verify?(request: CliVerifyRequest, signal?: AbortSignal): Promise<CliExecutionResult>;
}

export interface CliIo {
  writeStdout(text: string): void | Promise<void>;
  writeStderr(text: string): void | Promise<void>;
  writeFile?(path: string, text: string): void | Promise<void>;
}

export interface CliExecutionSummary {
  exitCode: number;
  output?: string;
  errors: string[];
}
