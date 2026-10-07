// @vitest-environment jsdom

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWebAppearance, resolveWebTheme } from '../web/src/theme';
import { loadPreferences, savePreferences } from '../web/src/storage';

const repository = resolve(import.meta.dirname, '..');

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  document.body.className = '';
  vi.unstubAllGlobals();
});

describe('TurnStage Web theme compatibility', () => {
  it('scopes every VS Code-only rule to the VS Code host so Web keeps its own look', () => {
    const nativeCss = readFileSync(resolve(repository, 'src/webview/vscodeNative.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    const selectors = [...nativeCss.matchAll(/(^|\})\s*([^{}@]+)\{/gu)].map((match) => match[2]!.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(10);
    const topLevelParts = (selector: string) => { const parts: string[] = []; let depth = 0; let current = ''; for (const character of selector) { if (character === '(') depth += 1; if (character === ')') depth -= 1; if (character === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += character; } parts.push(current.trim()); return parts; };
    expect(selectors.flatMap(topLevelParts).filter((part) => !part.startsWith("html[data-host='vscode']"))).toEqual([]);
    expect(readFileSync(resolve(repository, 'web/index.html'), 'utf8')).toContain('data-host="web"');
    expect(readFileSync(resolve(repository, 'src/extension/editors/turnstageEditorProvider.ts'), 'utf8')).toContain('data-host="vscode"');
  });

  it('keeps narrow editor layout rules out of shared Web styles', () => {
    const sharedCss = readFileSync(resolve(repository, 'src/webview/refresh.css'), 'utf8');
    const nativeCss = readFileSync(resolve(repository, 'src/webview/vscodeNative.css'), 'utf8');
    expect(sharedCss).not.toContain("data-narrow-view");
    expect(nativeCss).toContain("html[data-host='vscode'] .test-workspace[data-narrow-view='chat']");
  });

  it('defines every VS Code token consumed by the shared Webview CSS', () => {
    const sharedCss = readdirSync(resolve(repository, 'src/webview'))
      // vscodeNative.css only applies under <html data-host="vscode">, where VS Code supplies every token.
      .filter((name) => name.endsWith('.css') && name !== 'vscodeNative.css')
      .map((name) => readFileSync(resolve(repository, 'src/webview', name), 'utf8'))
      .join('\n');
    const compatibilityCss = readFileSync(resolve(repository, 'web/src/vscode-token-compat.css'), 'utf8');
    const consumed = new Set([...sharedCss.matchAll(/var\((--vscode-[A-Za-z0-9-]+)/gu)].map((match) => match[1]!));
    const defined = new Set([...compatibilityCss.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/gu)].map((match) => match[1]!));

    expect([...consumed].filter((token) => !defined.has(token)).sort()).toEqual([]);
    expect(consumed.size).toBeGreaterThan(100);

    const lightStart = compatibilityCss.indexOf(":root[data-theme='light']");
    const darkSemantic = new Set([...compatibilityCss.slice(0, lightStart).matchAll(/(--ts-[A-Za-z0-9-]+)\s*:/gu)].map((match) => match[1]!));
    const lightSemantic = new Set([...compatibilityCss.slice(lightStart).matchAll(/(--ts-[A-Za-z0-9-]+)\s*:/gu)].map((match) => match[1]!));
    expect([...darkSemantic].filter((token) => !lightSemantic.has(token)).sort()).toEqual([]);
  });

  it('keeps the browser Profile library on the shared flat workbench language', () => {
    const shellCss = readFileSync(resolve(repository, 'web/src/web.css'), 'utf8');
    const profileRoot = shellCss.match(/#profile-root\s*\{([^}]+)\}/u)?.[1] ?? '';
    const activeProfile = shellCss.match(/\.profile-item\.active\s*\{([^}]+)\}/u)?.[1] ?? '';

    expect(profileRoot).toContain('background: var(--vscode-sideBar-background)');
    expect(profileRoot).not.toContain('gradient');
    expect(profileRoot).not.toContain('box-shadow');
    expect(activeProfile).toContain('background: var(--vscode-list-inactiveSelectionBackground)');
    expect(activeProfile).not.toContain('gradient');
    expect(activeProfile).not.toContain('box-shadow');
    expect(shellCss).not.toMatch(/\.profile-item\.active[^}]*border-inline-(?:start|end)/u);
    expect(shellCss).toContain('max-height: 52vh');
    expect(shellCss).toContain('overflow-y: auto');
  });

  it('resolves explicit and system themes and applies VS Code body classes', () => {
    expect(resolveWebTheme('system', true)).toBe('light');
    expect(resolveWebTheme('system', false)).toBe('dark');
    expect(resolveWebTheme('dark', true)).toBe('dark');

    expect(applyWebAppearance('light', document, { matches: false })).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.body.classList.contains('vscode-light')).toBe(true);
    expect(document.body.classList.contains('vscode-dark')).toBe(false);

    applyWebAppearance('dark', document, { matches: true });
    expect(document.body.classList.contains('vscode-dark')).toBe(true);
    expect(document.body.classList.contains('vscode-light')).toBe(false);
  });

  it('persists only supported browser theme preferences', () => {
    savePreferences({ version: 1, theme: 'light' });
    expect(loadPreferences().theme).toBe('light');
    localStorage.setItem('turnstage.web.preferences.v1', JSON.stringify({ version: 1, theme: 'unsupported' }));
    expect(loadPreferences().theme).toBeUndefined();
  });
});
