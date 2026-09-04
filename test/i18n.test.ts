import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dateTimeAttribute, formatDateTime, formatNumber, normalizeLocale, setLocale, t } from '../src/webview/i18n';

const root = resolve(import.meta.dirname, '..');

afterEach(() => setLocale('en'));

describe('localization catalogs', () => {
  it('keeps package manifest keys in parity', () => {
    const english = json('package.nls.json');
    for (const locale of ['zh-tw', 'ja', 'ko']) {
      expect(Object.keys(json(`package.nls.${locale}.json`)).sort(), locale).toEqual(Object.keys(english).sort());
    }
  });

  it('keeps Extension Host bundle keys in parity', () => {
    const english = json('l10n/bundle.l10n.json');
    for (const locale of ['zh-tw', 'ja', 'ko']) {
      expect(Object.keys(json(`l10n/bundle.l10n.${locale}.json`)).sort(), locale).toEqual(Object.keys(english).sort());
    }
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

  it('normalizes and translates the supported CJK Webview locales', () => {
    expect(normalizeLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeLocale('zh-Hans-SG')).toBe('en');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('ko-KR')).toBe('ko');

    setLocale('ja-JP');
    expect(t('Run scenario {name}', { name: 'smoke' })).toBe('シナリオ「smoke」を実行');
    setLocale('ko-KR');
    expect(t('Run scenario {name}', { name: 'smoke' })).toBe('시나리오 “smoke” 실행');
  });

  it('does not fall back to English across the automated testing workspace', () => {
    const messages = [
      'Functional, regression, comparison, and performance automation.',
      'Run deterministic conversation contracts and inspect bounded evidence without mixing them with adversarial outcomes.',
      'Deterministic contract, comparison, and performance outcomes from this Extension Host session.',
      'Review test result',
      'Test result navigation',
      'Previous test result',
      'Next test result',
      'Selected test result actions',
      'Selected test result summary',
      'Run selected scenario again',
      'Select test result {name}',
      'Actions',
      'Duration',
      'Showing {start}–{end} of {total}',
      'Page {current} of {total}',
      'Linked suites',
      'Inline',
      'Keep small cases inline or link a JSONC/CSV suite. Full prompts load only when you edit a case.',
      'Test campaigns',
      'Create a bounded, repeatable selection of existing cases. Campaign history stores metadata only; raw prompts and evidence remain session-scoped.',
      'Add campaign',
      'Repetitions per adversarial case',
      'Conversation contracts run once; adversarial cases use this sample size.',
      'Concurrent cases',
      'Cases may run in parallel. Turns and repeated attempts within one case remain sequential.',
      'Case IDs',
      'Leave empty to select by suite or tags.',
      'Suite IDs',
      'Optional exact suite IDs.',
      'Selector tags',
      'All tags must match unless tag mode is changed in JSONC.',
      'Coverage tags',
      'Missing required tags are reported before and after execution.',
      '{completed}/{planned} cases complete',
      'Concurrency {limit} / 8',
      '{percent}% coverage',
      '{count} regression',
      'Preview plan',
      'Cancel run',
      'Resume',
      'Accept as baseline',
      'Export results JSONL',
      'Summarize with Copilot',
      'Delete campaign',
      'Attack succeeded',
      'Resisted',
    ];
    for (const supportedLocale of ['zh-TW', 'ja-JP', 'ko-KR']) {
      setLocale(supportedLocale);
      for (const message of messages) expect(t(message), `${supportedLocale}: ${message}`).not.toBe(message);
    }
  });

  it('keeps Webview locale placeholders intact', () => {
    for (const path of ['src/webview/i18n.ja.ts', 'src/webview/i18n.ko.ts']) {
      for (const [message, translation] of sourceCatalog(path)) {
        expect(placeholders(translation), `${path}: ${message}`).toEqual(placeholders(message));
      }
    }
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

function sourceCatalog(path: string): Map<string, string> {
  const source = readFileSync(resolve(root, path), 'utf8');
  return new Map([...source.matchAll(/^\s*(['"])(.*?)\1:\s*(['"])(.*?)\3,?$/gm)].map((match) => [match[2] ?? '', match[4] ?? '']));
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}
