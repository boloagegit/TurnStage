import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dateTimeAttribute, formatDateTime, formatNumber, setLocale, t } from '../src/webview/i18n';

const root = resolve(import.meta.dirname, '..');

afterEach(() => setLocale('en'));

describe('localization catalogs', () => {
  it('keeps package manifest keys in parity', () => {
    const english = json('package.nls.json');
    const traditionalChinese = json('package.nls.zh-tw.json');
    expect(Object.keys(traditionalChinese).sort()).toEqual(Object.keys(english).sort());
  });

  it('keeps Extension Host bundle keys in parity', () => {
    const english = json('l10n/bundle.l10n.json');
    const traditionalChinese = json('l10n/bundle.l10n.zh-tw.json');
    expect(Object.keys(traditionalChinese).sort()).toEqual(Object.keys(english).sort());
  });

  it('covers Extension Host localization literals in both bundles', () => {
    const hostSources = sourceFiles(resolve(root, 'src/extension')).map((path) => readFileSync(path, 'utf8')).join('\n');
    const english = json('l10n/bundle.l10n.json');
    const traditionalChinese = json('l10n/bundle.l10n.zh-tw.json');
    const messages = new Set<string>();
    const literalCall = /(?:vscode\.l10n\.t|localize)\(\s*(['"])([\s\S]*?)\1/g;
    for (const match of hostSources.matchAll(literalCall)) messages.add((match[2] ?? '').replace(/\\n/g, '\n'));
    expect([...messages].filter((message) => !(message in english) || !(message in traditionalChinese)).sort()).toEqual([]);
  });

  it('covers every literal Webview message with Traditional Chinese', () => {
    const webviewSources = [
      'src/webview/main.tsx',
      'src/webview/MobileChatPreview.tsx',
      'src/webview/SettingsWorkspace.tsx',
      'src/webview/configEditors.tsx'
    ].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');
    const catalogSource = readFileSync(resolve(root, 'src/webview/i18n.ts'), 'utf8');
    const usedMessages = new Set([...webviewSources.matchAll(/\bt\(\s*(['"])(.*?)\1/g)].map((match) => match[2]));
    const translatedMessages = new Set([...catalogSource.matchAll(/^\s*(['"])(.*?)\1:\s*(['"])/gm)].map((match) => match[2]));

    expect([...usedMessages].filter((message) => !translatedMessages.has(message)).sort()).toEqual([]);
  });

  it('translates Webview copy, interpolation, and locale-aware numbers', () => {
    setLocale('zh-tw');
    expect(t('Restricted mode.')).toBe('受限模式。');
    expect(t('Run exported to {path}', { path: '/tmp/run.json' })).toBe('執行記錄已匯出至 /tmp/run.json');
    expect(formatNumber(12_345)).toBe('12,345');
  });

  it('falls back to the source message for unsupported locales', () => {
    setLocale('fr');
    expect(t('Restricted mode.')).toBe('Restricted mode.');
  });

  it('formats corrupt persisted dates without throwing or emitting invalid time attributes', () => {
    expect(() => formatDateTime('not-a-date')).not.toThrow();
    expect(formatDateTime('not-a-date')).toBe('Unknown date');
    expect(formatDateTime(Number.NaN)).toBe('Unknown date');
    expect(dateTimeAttribute('not-a-date')).toBeUndefined();
    expect(dateTimeAttribute(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});

function json(path: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, string>;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}
