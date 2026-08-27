import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const workspaceSource = readFileSync(resolve(root, 'src/webview/SettingsWorkspace.tsx'), 'utf8');
const workspaceStyles = readFileSync(resolve(root, 'src/webview/settingsWorkspace.css'), 'utf8');

describe('Profile Configuration surface', () => {
  it('uses a non-main root and names profile configuration explicitly', () => {
    expect(workspaceSource).not.toMatch(/<main\b/);
    expect(workspaceSource).toContain('<div className="settings-workspace">');
    expect(workspaceSource).toContain("t('Profile Configuration')");
    expect(workspaceSource).toContain("t('Profile configuration toolbar')");
    expect(workspaceSource).not.toContain("t('Settings')");
    expect(workspaceSource).not.toContain('settings-breadcrumb');
    expect(workspaceStyles).not.toContain('settings-breadcrumb');
  });

  it('exposes section and card descriptions as readable content', () => {
    expect(workspaceSource).toContain('settings-section-description');
    expect(workspaceSource).toContain('settings-card-description');
    expect(workspaceSource).not.toContain('settings-help');
    expect(workspaceSource).not.toContain('title={description}');
    expect(workspaceStyles).not.toContain('.settings-help');
  });

  it('keeps JSONC patching and security/error guidance intact', () => {
    expect(workspaceSource).toContain("type: 'profile.patch'");
    expect(workspaceSource).toContain('A request URL is required.');
    expect(workspaceSource).toContain('Never place credentials in a profile.');
    expect(workspaceSource).toContain("<ProductIcon name={snapshot?.trusted === false ? 'warning' : 'check'}");
  });
});
