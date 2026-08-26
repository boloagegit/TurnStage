export class TurnStageError extends Error {
  constructor(public readonly type: string, message: string, public readonly details: Record<string, unknown> = {}) { super(message); this.name = type; }
}
export const errors = {
  config: (message: string) => new TurnStageError('ConfigValidationError', message),
  missingSecret: (name: string) => new TurnStageError('MissingSecretError', localize('Secret "{name}" is not configured.', { name })),
  request: (message: string) => new TurnStageError('RequestBuildError', message),
  trust: () => new TurnStageError('WorkspaceTrustError', localize('This workspace is not trusted. Network requests are disabled.')),
  abort: () => new TurnStageError('UserAbortError', localize('The request was stopped.')),
  unexpectedEnd: () => new TurnStageError('UnexpectedStreamEndError', localize('The stream ended without a done or error event.')),
};
import { localize } from './l10n';
