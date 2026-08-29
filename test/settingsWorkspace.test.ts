import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const workspaceSource = readFileSync(resolve(root, 'src/webview/SettingsWorkspace.tsx'), 'utf8');
const workspaceStyles = readFileSync(resolve(root, 'src/webview/settingsWorkspace.css'), 'utf8');

describe('Profile Configuration surface', () => {
  it('uses a non-main root and names profile configuration explicitly', () => {
    expect(workspaceSource).not.toMatch(/<main\b/);
    expect(workspaceSource).toContain("settings-workspace--embedded");
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

  it('provides local navigation for a full editor and a compact picker when embedded', () => {
    for (const section of ['general', 'opening-flow', 'request', 'stream-mapping', 'chat-ui', 'scenario-tests', 'history-errors', 'security']) {
      expect(workspaceSource).toContain(`id: '${section}'`);
    }
    expect(workspaceSource).toContain('onSectionChange: (section: SettingsSectionId) => void');
    expect(workspaceSource).toContain('settings-section-nav');
    expect(workspaceSource).toContain('!embedded && <nav');
    expect(workspaceSource).toContain('settings-section-picker');
    expect(workspaceSource).toContain('event.target.value as SettingsSectionId');
    expect(workspaceSource).toContain('SETTINGS_SECTIONS.map');
    expect(workspaceSource).toContain('onSectionChange(item.id)');
    expect(workspaceSource).toContain("aria-current={active.id === item.id ? 'page' : undefined}");
    expect(workspaceStyles).toContain('.settings-content-layout');
    expect(workspaceStyles).toContain('.settings-section-nav button.is-active');
    expect(workspaceStyles).toContain('var(--vscode-dropdown-background');
    expect(workspaceStyles).toContain('var(--vscode-dropdown-listBackground');
    expect(workspaceStyles).toContain('grid-template-columns: 1fr');
  });

  it('provides a bounded scenario builder through one supported JSONC patch path', () => {
    expect(workspaceSource).toContain("active.id === 'scenario-tests'");
    expect(workspaceSource).toContain("patch(['tests', 'scenarios'], next)");
    expect(workspaceSource).toContain('Conversation contracts');
    expect(workspaceSource).toContain('Built-in state invariants still run.');
    expect(workspaceSource).toContain('disabled={!canDelete}');
    expect(workspaceStyles).toContain('.scenario-editor');
    expect(workspaceStyles).toContain('.assertion-row');
  });

  it('configures sanitized reports, baseline comparison, ignore rules, and every supported performance metric', () => {
    expect(workspaceSource).toContain("patch(['tests', 'reporting']");
    expect(workspaceSource).toContain('Run baseline and candidate');
    expect(workspaceSource).toContain('Ignore dynamic paths');
    expect(workspaceSource).toContain('performanceMetricOptions.map');
    for (const metric of ['scenario.durationMs', 'metrics.headersLatency', 'metrics.firstChunkLatency', 'metrics.firstEventLatency', 'metrics.ttft', 'metrics.streamDuration', 'metrics.totalDuration', 'metrics.averageEventGap', 'metrics.maxEventGap']) expect(workspaceSource).toContain(metric);
    expect(workspaceStyles).toContain('.scenario-budget__row');
    expect(workspaceStyles).toContain('var(--vscode-editorWidget-border)');
  });

  it('keeps JSONC patching and security/error guidance intact', () => {
    expect(workspaceSource).toContain("type: 'profile.patch'");
    expect(workspaceSource).toContain('A request URL is required.');
    expect(workspaceSource).toContain('Never place credentials in a profile.');
    expect(workspaceSource).toContain("<ProductIcon name={snapshot?.trusted === false ? 'warning' : 'check'}");
  });

  it('exposes bounded reconnect and redirect controls in the native settings surface', () => {
    expect(workspaceSource).toContain('settings-reconnect-attempts');
    expect(workspaceSource).toContain("['conversation', 'send', 'reconnect', 'retryOnStatuses']");
    expect(workspaceSource).toContain('settings-redirect-policy');
    expect(workspaceSource).toContain("['conversation', 'send', 'maxRedirects']");
    expect(workspaceSource).toContain('Retries only before the first stream event.');
  });
});
