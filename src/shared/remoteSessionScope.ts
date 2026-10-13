import type { TurnStageProfile } from './types';

export type RemoteSessionScope = NonNullable<NonNullable<NonNullable<TurnStageProfile['history']>['remoteSessions']>['scope']>[number];

/** Without an explicit scope, remote conversation lists are kept apart by Profile, actor, and environment. */
export const DEFAULT_REMOTE_SESSION_SCOPE: readonly RemoteSessionScope[] = ['profile', 'actor', 'environment'];

/** The scope that decides which remote conversation list is used; the Profile always separates lists. */
export function remoteSessionScope(remoteSessions: NonNullable<TurnStageProfile['history']>['remoteSessions']): RemoteSessionScope[] {
  return [...(remoteSessions?.scope ?? DEFAULT_REMOTE_SESSION_SCOPE)];
}
