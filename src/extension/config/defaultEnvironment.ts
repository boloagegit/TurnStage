import type { TurnStageEnvironment } from '../../shared/types';

export function builtInEnvironment(): TurnStageEnvironment {
  return {
    version: 1,
    id: 'local',
    name: 'Local Mock Server',
    variables: { baseUrl: 'http://127.0.0.1:8787' },
    secretReferences: { apiToken: 'local-api-token' },
  };
}
