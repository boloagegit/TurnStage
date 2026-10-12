import { buildOpenAICompatibleProfileDraft } from '../../src/extension/connection/profileDraft';
import { parseCurlCommand } from '../../src/extension/connection/curlParser';
import type { TurnStageProfile } from '../../src/shared/types';

export interface CurlProfileImport {
  profile: TurnStageProfile;
  /** Values recovered from the pasted command for the draft's secret references; kept in memory only. */
  secrets: Map<string, string>;
  warnings: readonly string[];
}

/**
 * Turn a pasted cURL command into a sanitized Profile. The command is parsed
 * without a shell and never executed; credential values are replaced by
 * `${secret.*}` references in the Profile and returned separately so the
 * caller can keep them in the tab's memory-only secret store.
 */
export function profileFromCurl(command: string, options: { id?: string; environment?: string } = {}): CurlProfileImport {
  const parsed = parseCurlCommand(command);
  const draft = buildOpenAICompatibleProfileDraft(parsed, { ...(options.id ? { id: options.id } : {}), ...(options.environment ? { profileEnvironment: options.environment } : {}) });
  const secrets = new Map<string, string>();
  const draftHeaders = draft.profile.conversation.send.headers ?? {};
  for (const [name, template] of Object.entries(draftHeaders)) {
    const value = Object.entries(parsed.headers).find(([candidate]) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())?.[1];
    if (typeof template !== 'string' || value === undefined) continue;
    const match = /^(.*)\$\{secret\.([A-Za-z0-9_-]{1,128})\}(.*)$/su.exec(template);
    if (!match) continue;
    const [, prefix = '', reference = '', suffix = ''] = match;
    if (value.length < prefix.length + suffix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) continue;
    const secret = value.slice(prefix.length, value.length - suffix.length);
    if (secret) secrets.set(reference, secret);
  }
  return { profile: draft.profile, secrets, warnings: draft.warnings };
}
