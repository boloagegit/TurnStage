import type { TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';

export const WEB_PROFILE_BUNDLE_FORMAT = 'turnstage-web-profile-bundle';
export const WEB_PROFILE_BUNDLE_VERSION = 1;

const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;

export interface WebProfileBundle {
  format: typeof WEB_PROFILE_BUNDLE_FORMAT;
  version: typeof WEB_PROFILE_BUNDLE_VERSION;
  exportedAt: string;
  profile: TurnStageProfile;
  environment: TurnStageEnvironment;
}

export function encodeWebProfileBundle(profile: TurnStageProfile, environment: TurnStageEnvironment, exportedAt = new Date()): string {
  const bundle: WebProfileBundle = {
    format: WEB_PROFILE_BUNDLE_FORMAT,
    version: WEB_PROFILE_BUNDLE_VERSION,
    exportedAt: exportedAt.toISOString(),
    profile: { ...profile, environment: environment.id },
    environment,
  };
  const source = JSON.stringify(bundle, null, 2);
  assertSize(source, MAX_BUNDLE_BYTES, 'The exported Profile bundle exceeds 1 MiB.');
  return source;
}

export function decodeWebProfileBundle(source: string): WebProfileBundle | undefined {
  assertSize(source, MAX_BUNDLE_BYTES, 'The selected Profile bundle exceeds 1 MiB.');
  let value: unknown;
  try { value = JSON.parse(source); } catch { return undefined; }
  if (!isRecord(value) || value.format !== WEB_PROFILE_BUNDLE_FORMAT) return undefined;
  if (value.version !== WEB_PROFILE_BUNDLE_VERSION) throw new Error(`Unsupported TurnStage Web Profile bundle version: ${String(value.version)}.`);
  if (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) throw new Error('The selected Profile bundle has an invalid export timestamp.');
  if (!isRecord(value.profile) || !isRecord(value.environment)) throw new Error('The selected Profile bundle must contain a Profile and Environment.');
  assertSize(JSON.stringify(value.profile), MAX_ENTRY_BYTES, 'The bundled Profile exceeds 512 KiB.');
  assertSize(JSON.stringify(value.environment), MAX_ENTRY_BYTES, 'The bundled Environment exceeds 512 KiB.');
  return value as unknown as WebProfileBundle;
}

function assertSize(value: string, limit: number, message: string): void {
  if (new TextEncoder().encode(value).byteLength > limit) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
