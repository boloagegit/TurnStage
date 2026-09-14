export function requestedProfileId(search: string): string | undefined {
  const value = new URLSearchParams(search).get('profile');
  return value?.trim() || undefined;
}

export function profileUrl(href: string, id: string): string {
  const url = new URL(href);
  url.searchParams.set('profile', id);
  return `${url.pathname}${url.search}${url.hash}`;
}
