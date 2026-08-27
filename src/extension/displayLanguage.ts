export type DisplayLanguagePreference = 'auto' | 'zh-tw' | 'en';

export function resolveDisplayLanguage(preference: unknown, vscodeLanguage: string): string {
  const normalizedPreference = typeof preference === 'string' ? preference.toLowerCase() : 'auto';
  if (normalizedPreference === 'zh-tw' || normalizedPreference === 'en') return normalizedPreference;
  return safeLocale(vscodeLanguage);
}

export function safeLocale(locale: string): string {
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale) ? locale : 'en';
}

export function textDirection(locale: string): 'ltr' | 'rtl' {
  const language = locale.toLowerCase().split('-')[0] ?? '';
  return ['ar', 'fa', 'he', 'ps', 'ur'].includes(language) ? 'rtl' : 'ltr';
}
