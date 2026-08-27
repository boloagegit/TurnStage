const MAX_PROFILE_TITLE_LENGTH = 80;

export function profileEditorTitle(name: string | undefined, resourceTitle: string): string {
  const normalized = name?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return resourceTitle;
  const displayName = normalized.length > MAX_PROFILE_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_PROFILE_TITLE_LENGTH - 1).trimEnd()}…`
    : normalized;
  return `${displayName} · TurnStage`;
}
