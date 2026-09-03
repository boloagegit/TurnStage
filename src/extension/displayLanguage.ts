/** Values persisted by the application-wide TurnStage editor setting. */
export type DisplayLanguagePreference = 'auto' | 'zh-tw' | 'ja' | 'ko' | 'en';

/** Effective locale sent to the Webview after applying the user preference. */
export type DisplayLocale = 'en' | 'zh-TW' | 'ja' | 'ko';

const localePattern = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

/**
 * Resolve the editor language without trusting arbitrary locale strings.
 *
 * The lower-case values are persisted by the manifest; the resolver returns
 * canonical BCP-47-like values for the Webview.
 */
export function resolveDisplayLanguage(preference: unknown, vscodeLanguage: string): DisplayLocale {
  const normalizedPreference = typeof preference === 'string' ? preference.toLowerCase() : 'auto';
  if (normalizedPreference === 'en') return 'en';
  if (normalizedPreference === 'zh-tw') return 'zh-TW';
  if (normalizedPreference === 'ja') return 'ja';
  if (normalizedPreference === 'ko') return 'ko';
  return normalizeLocale(vscodeLanguage);
}

/**
 * Keep locale input bounded before it reaches HTML, Intl, or document.lang.
 * This helper preserves the validated spelling for callers that need it;
 * `normalizeLocale` applies TurnStage's supported-locale mapping.
 */
export function safeLocale(locale: string): string {
  return typeof locale === 'string' && localePattern.test(locale) ? locale.replace(/_/g, '-') : 'en';
}

/** Map VS Code locale variants onto the finite locales shipped by TurnStage. */
export function normalizeLocale(locale: unknown): DisplayLocale {
  const safe = safeLocale(typeof locale === 'string' ? locale : '');
  if (safe === 'en') return 'en';
  const parts = safe.toLowerCase().split('-');
  const language = parts[0] ?? '';
  const script = parts.find((part) => part.length === 4);
  const region = parts.slice(1).find((part) => part.length === 2 || /^\d{3}$/.test(part));
  if (language === 'zh') {
    if (script === 'hant' || ['hk', 'mo', 'tw'].includes(region ?? '')) return 'zh-TW';
    if (script === 'hans' || ['cn', 'sg'].includes(region ?? '')) return 'en';
    // A bare `zh` has no script or region. Traditional Chinese remains the
    // stable default Chinese experience for TurnStage.
    return 'zh-TW';
  }
  if (language === 'ja') return 'ja';
  if (language === 'ko') return 'ko';
  if (language === 'en') return 'en';
  return 'en';
}

export function textDirection(locale: string): 'ltr' | 'rtl' {
  const language = locale.toLowerCase().split('-')[0] ?? '';
  return ['ar', 'fa', 'he', 'ps', 'ur'].includes(language) ? 'rtl' : 'ltr';
}
