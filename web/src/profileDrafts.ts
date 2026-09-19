export interface ProfileDraft {
  version: 1;
  profileId: string;
  baseFingerprint: string;
  draft: string;
  updatedAt: number;
}

const KEY = 'turnstage.web.profileDrafts.v1';

export function loadProfileDraft(profileId: string): ProfileDraft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return normalize(value[profileId]);
  } catch { return undefined; }
}

export function saveProfileDraft(profileId: string, base: string, draft: string): void {
  const values = all();
  values[profileId] = { version: 1, profileId, baseFingerprint: sourceFingerprint(base), draft, updatedAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(values));
}

export function deleteProfileDraft(profileId: string): void {
  const values = all();
  delete values[profileId];
  localStorage.setItem(KEY, JSON.stringify(values));
}

export function sourceFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function all(): Record<string, ProfileDraft> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).flatMap(([id, draft]) => { const normalized = normalize(draft); return normalized ? [[id, normalized]] : []; }));
  } catch { return {}; }
}

function normalize(value: unknown): ProfileDraft | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.profileId !== 'string' || typeof item.baseFingerprint !== 'string' || typeof item.draft !== 'string' || typeof item.updatedAt !== 'number') return;
  return item as unknown as ProfileDraft;
}

