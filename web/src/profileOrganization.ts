export interface ProfileFolder { id: string; name: string; parentId?: string }
export interface ProfileOrganization {
  folders: ProfileFolder[];
  assignments: Record<string, string>;
  collapsed: string[];
}

const KEY = 'turnstage.web.profileOrganization.v1';
const empty = (): ProfileOrganization => ({ folders: [], assignments: {}, collapsed: [] });

export function normalizeProfileOrganization(value: unknown): ProfileOrganization {
  if (!value || typeof value !== 'object') return empty();
  const source = value as Record<string, unknown>;
  const seen = new Set<string>();
  const folders = (Array.isArray(source.folders) ? source.folders : []).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const folder = entry as Record<string, unknown>;
    if (typeof folder.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(folder.id) || seen.has(folder.id) || typeof folder.name !== 'string') return [];
    const name = folder.name.trim().slice(0, 60);
    if (!name) return [];
    seen.add(folder.id);
    return [{ id: folder.id, name, ...(typeof folder.parentId === 'string' ? { parentId: folder.parentId } : {}) }];
  }).slice(0, 100);
  const valid = new Set(folders.map((folder) => folder.id));
  for (const folder of folders) {
    const ancestors = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (!valid.has(parentId) || ancestors.has(parentId) || ancestors.size > 8) { delete folder.parentId; break; }
      ancestors.add(parentId);
      parentId = folders.find((candidate) => candidate.id === parentId)?.parentId;
    }
  }
  const assignments: Record<string, string> = {};
  if (source.assignments && typeof source.assignments === 'object' && !Array.isArray(source.assignments)) {
    for (const [profileId, folderId] of Object.entries(source.assignments)) {
      if (profileId.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(profileId) && typeof folderId === 'string' && valid.has(folderId)) assignments[profileId] = folderId;
    }
  }
  const collapsed = Array.isArray(source.collapsed)
    ? source.collapsed.filter((id): id is string => typeof id === 'string' && (id === 'official' || id === 'local' || id.startsWith('server:') && id.length <= 500 || (id.startsWith('folder:') && valid.has(id.slice(7)))))
    : [];
  return { folders, assignments, collapsed: [...new Set(collapsed)] };
}

export function loadProfileOrganization(): ProfileOrganization {
  try { return normalizeProfileOrganization(JSON.parse(localStorage.getItem(KEY) ?? 'null')); }
  catch { return empty(); }
}

export function saveProfileOrganization(value: ProfileOrganization): void {
  localStorage.setItem(KEY, JSON.stringify(normalizeProfileOrganization(value)));
}
