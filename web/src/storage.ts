import type { CatalogReference } from './catalog';

export interface StoredProfile {
  id: string;
  name: string;
  raw: string;
  builtIn?: boolean;
  official?: CatalogReference;
  basedOn?: CatalogReference;
  updatedAt: number;
}

export interface StoredEnvironment {
  id: string;
  name: string;
  raw: string;
  builtIn?: boolean;
  official?: CatalogReference;
  basedOn?: CatalogReference;
  updatedAt: number;
}

export type WebThemePreference = 'system' | 'dark' | 'light';

export interface WebPreferences {
  version: 1;
  activeProfileId?: string;
  locale?: string;
  activeEnvironmentId?: string;
  theme?: WebThemePreference;
}

const PROFILES_KEY = 'turnstage.web.profiles.v1';
const PREFERENCES_KEY = 'turnstage.web.preferences.v1';
const ENVIRONMENTS_KEY = 'turnstage.web.environments.v1';

export function loadProfiles(): StoredProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.flatMap((item) => normalizeStoredProfile(item)) : [];
  } catch { return []; }
}

export function saveProfiles(profiles: readonly StoredProfile[]): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles.flatMap((item) => normalizeStoredProfile(item))));
}

export function loadEnvironments(): StoredEnvironment[] {
  try {
    const value = JSON.parse(localStorage.getItem(ENVIRONMENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.flatMap((item) => normalizeStoredEnvironment(item)) : [];
  } catch { return []; }
}

export function saveEnvironments(environments: readonly StoredEnvironment[]): void {
  localStorage.setItem(ENVIRONMENTS_KEY, JSON.stringify(environments.flatMap((item) => normalizeStoredEnvironment(item))));
}

export function loadPreferences(): WebPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<WebPreferences>;
    return { version: 1, ...(typeof value.activeProfileId === 'string' ? { activeProfileId: value.activeProfileId } : {}), ...(typeof value.activeEnvironmentId === 'string' ? { activeEnvironmentId: value.activeEnvironmentId } : {}), ...(typeof value.locale === 'string' ? { locale: value.locale } : {}), ...(value.theme === 'system' || value.theme === 'dark' || value.theme === 'light' ? { theme: value.theme } : {}) };
  } catch { return { version: 1 }; }
}

export function savePreferences(value: WebPreferences): void {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value));
}

function normalizeStoredProfile(value: unknown): StoredProfile[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.raw !== 'string' || typeof item.updatedAt !== 'number') return [];
  return [{ id: item.id, name: item.name, raw: item.raw, updatedAt: item.updatedAt, ...(isCatalogReference(item.basedOn) ? { basedOn: item.basedOn } : {}) }];
}

function normalizeStoredEnvironment(value: unknown): StoredEnvironment[] {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.raw !== 'string' || typeof item.updatedAt !== 'number') return [];
  return [{ id: item.id, name: item.name, raw: item.raw, updatedAt: item.updatedAt, ...(isCatalogReference(item.basedOn) ? { basedOn: item.basedOn } : {}) }];
}

function isCatalogReference(value: unknown): value is CatalogReference {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.catalogId === 'string' && typeof item.catalogRevision === 'string' && typeof item.entryId === 'string';
}
