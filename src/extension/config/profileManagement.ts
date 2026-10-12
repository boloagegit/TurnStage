export interface ProfileIdentity<T = unknown> {
  item: T;
  id?: string;
}

export interface DuplicateProfileGroup<T = unknown> {
  id: string;
  items: T[];
}

export function duplicateProfileGroups<T>(entries: Array<ProfileIdentity<T>>): Array<DuplicateProfileGroup<T>> {
  const byId = new Map<string, T[]>();
  for (const entry of entries) {
    const id = entry.id;
    if (!id?.trim()) continue;
    const items = byId.get(id) ?? [];
    items.push(entry.item);
    byId.set(id, items);
  }
  return [...byId.entries()].filter(([, items]) => items.length > 1).map(([id, items]) => ({ id, items }));
}

export function importedProfileFileName(sourceName: string): string {
  if (sourceName.toLowerCase().endsWith('.turnstage.jsonc')) return `${sourceName.slice(0, -'.turnstage.jsonc'.length)}.turnstage.jsonc`;
  const stem = sourceName.replace(/\.(?:jsonc|json)$/i, '');
  return `${stem || 'imported'}.turnstage.jsonc`;
}

export function copyFileName(fileName: string, copyNumber = 1): string {
  const suffix = copyNumber === 1 ? '-copy' : `-copy-${copyNumber}`;
  const match = /^(.*?)(\.turnstage\.jsonc)$/i.exec(fileName) ?? /^(.*?)(\.[^.]*)$/.exec(fileName);
  return `${match?.[1] ?? fileName}${suffix}${match?.[2] ?? ''}`;
}

export function copyProfileId(id: string, copyNumber = 1): string {
  return `${id}-copy${copyNumber === 1 ? '' : `-${copyNumber}`}`;
}

export function duplicateProfileText(text: string, id: string, name: string): string {
  const formattingOptions = { insertSpaces: true, tabSize: 2 };
  let result = applyJsonEdits(text, modify(text, ['id'], id, { formattingOptions }));
  result = applyJsonEdits(result, modify(result, ['name'], name, { formattingOptions }));
  return result;
}

function applyJsonEdits(text: string, edits: Array<{ offset: number; length: number; content: string }>): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) result = result.slice(0, edit.offset) + edit.content + result.slice(edit.offset + edit.length);
  return result;
}
import { modify } from 'jsonc-parser';

export const DEFAULT_PROFILE_GLOB = '.vscode/turnstage/profiles/*.turnstage.jsonc';

/**
 * Workspace-relative folder where new Profiles are written for a discovery glob: the path segments before the
 * first wildcard. Globs that are absolute or leave the workspace fall back to the default folder.
 */
export function profileGlobDirectory(glob: string): string[] {
  const normalized = glob.trim().replace(/\\/g, '/');
  const fallback = DEFAULT_PROFILE_GLOB.split('/').slice(0, -1);
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return fallback;
  const directory: string[] = [];
  for (const segment of normalized.split('/').slice(0, -1)) {
    if (/[*?[\]{}!]/.test(segment)) break;
    if (segment === '..') return fallback;
    if (segment && segment !== '.') directory.push(segment);
  }
  return directory;
}
