import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const editorSource = readFileSync(resolve(root, 'src/extension/editors/turnstageEditorProvider.ts'), 'utf8');
const activateSource = readFileSync(resolve(root, 'src/extension/activate.ts'), 'utf8');

describe('Extension host editor lifecycle', () => {
  it('debounces profile document changes and cancels pending work on disposal', () => {
    expect(editorSource).toContain('const DOCUMENT_CHANGE_DEBOUNCE_MS = 150;');
    expect(editorSource).toContain('loadTimer = setTimeout');
    expect(editorSource).toContain('clearTimeout(loadTimer)');
    expect(editorSource).toContain('if (loadTimer) clearTimeout(loadTimer);');
  });

  it('does not claim unsupported multiple custom editors for one document', () => {
    expect(activateSource).toContain('supportsMultipleEditorsPerDocument: false');
  });

  it('rehydrates a recreated webview from cached profile and session state', () => {
    expect(activateSource).toContain('retainContextWhenHidden: false');
    expect(editorSource).toContain('let profileSnapshot:');
    expect(editorSource).toContain('let validationSnapshot:');
    expect(editorSource).toContain('const rehydrate = async () =>');
    expect(editorSource).toContain('if (documentVersion !== document.version || !profileSnapshot || !validationSnapshot) { await load(); return; }');
    expect(editorSource).toContain('const sessionSnapshot = currentSessionSnapshot();');
    expect(editorSource).toContain("message.type === 'webview.ready'");
    expect(editorSource).toContain('await rehydrate();');
  });

  it('waits for an editor controller before executing start, replay, or export', () => {
    expect(activateSource).toContain('openAndWaitForController(editor, uri)');
    expect(editorSource).toContain('async waitForController(uri: vscode.Uri, timeoutMs = 5000)');
    expect(editorSource).toContain('if (current && this.controllers.get(documentKey) === current) this.controllers.delete(documentKey);');
  });

  it('offers a localized snooze action and persists it globally', () => {
    expect(activateSource).toContain("vscode.l10n.t('Do not show again')");
    expect(activateSource).toContain("configuration.update('notifications.enabled', false, vscode.ConfigurationTarget.Global)");
  });

  it('renders exported virtual-workspace URIs without assuming a local fsPath', () => {
    expect(activateSource).toContain('displayExportUri(exported)');
    expect(activateSource).toContain("uri.scheme === 'file' ? uri.fsPath : uri.toString(true)");
    expect(activateSource).not.toContain('path: exported.fsPath');
  });

  it('drains active editor finalization before extension deactivation completes', () => {
    expect(activateSource).toContain('export async function deactivate(): Promise<void>');
    expect(activateSource).toContain('await editor?.drainPending()');
    expect(editorSource).toContain('controller.disposeAndWait()');
    expect(editorSource).toContain('async drainPending(): Promise<void>');
  });

  it('opens the native VS Code walkthrough from the usage-guide command', () => {
    expect(activateSource).toContain("export const TURNSTAGE_WALKTHROUGH_ID = 'turnstage.turnstage#gettingStarted';");
    expect(activateSource).toContain("command('openGuide', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', TURNSTAGE_WALKTHROUGH_ID, false))");
  });

  it('updates open profile editors when the display-language preference changes', () => {
    expect(editorSource).toContain("event.affectsConfiguration('turnstage.displayLanguage')");
    expect(editorSource).toContain('void postHostReady()');
    expect(editorSource).toContain('configurationListener.dispose()');
  });
});
