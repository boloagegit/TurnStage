import { describe, expect, it } from 'vitest';
import { normalizeLocale, resolveDisplayLanguage, safeLocale, textDirection } from '../src/extension/displayLanguage';

describe('TurnStage display language', () => {
  it('follows the VS Code display language in auto mode', () => {
    expect(resolveDisplayLanguage('auto', 'zh-tw')).toBe('zh-TW');
    expect(resolveDisplayLanguage('auto', 'fr')).toBe('en');
  });

  it('uses an explicit supported editor language', () => {
    expect(resolveDisplayLanguage('zh-tw', 'en')).toBe('zh-TW');
    expect(resolveDisplayLanguage('ja', 'en')).toBe('ja');
    expect(resolveDisplayLanguage('ko', 'en')).toBe('ko');
    expect(resolveDisplayLanguage('en', 'zh-tw')).toBe('en');
  });

  it('normalizes Chinese script and region variants', () => {
    for (const locale of ['zh-Hant', 'zh-HK', 'zh-MO', 'zh-Hant-TW']) expect(normalizeLocale(locale)).toBe('zh-TW');
    for (const locale of ['zh-Hans', 'zh-SG', 'zh-CN', 'zh-Hans-CN']) expect(normalizeLocale(locale)).toBe('en');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('ko-KR')).toBe('ko');
  });

  it('treats unknown preferences as auto and sanitizes invalid locales', () => {
    expect(resolveDisplayLanguage('unsupported', 'zh-tw')).toBe('zh-TW');
    expect(resolveDisplayLanguage(undefined, '<script>')).toBe('en');
    expect(safeLocale('zh-Hant-TW')).toBe('zh-Hant-TW');
  });

  it('keeps direction derived from the effective locale', () => {
    expect(textDirection('zh-tw')).toBe('ltr');
    expect(textDirection('ar')).toBe('rtl');
  });
});
