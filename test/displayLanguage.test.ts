import { describe, expect, it } from 'vitest';
import { resolveDisplayLanguage, safeLocale, textDirection } from '../src/extension/displayLanguage';

describe('TurnStage display language', () => {
  it('follows the VS Code display language in auto mode', () => {
    expect(resolveDisplayLanguage('auto', 'zh-tw')).toBe('zh-tw');
    expect(resolveDisplayLanguage('auto', 'fr')).toBe('fr');
  });

  it('uses an explicit supported editor language', () => {
    expect(resolveDisplayLanguage('zh-tw', 'en')).toBe('zh-tw');
    expect(resolveDisplayLanguage('en', 'zh-tw')).toBe('en');
  });

  it('treats unknown preferences as auto and sanitizes invalid locales', () => {
    expect(resolveDisplayLanguage('unsupported', 'zh-tw')).toBe('zh-tw');
    expect(resolveDisplayLanguage(undefined, '<script>')).toBe('en');
    expect(safeLocale('zh-Hant-TW')).toBe('zh-Hant-TW');
  });

  it('keeps direction derived from the effective locale', () => {
    expect(textDirection('zh-tw')).toBe('ltr');
    expect(textDirection('ar')).toBe('rtl');
  });
});
