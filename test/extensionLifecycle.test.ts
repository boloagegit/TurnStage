import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const editorSource = readFileSync(resolve(root, 'src/extension/editors/turnstageEditorProvider.ts'), 'utf8');
const activateSource = readFileSync(resolve(root, 'src/extension/activate.ts'), 'utf8');
const scenarioTestSource = readFileSync(resolve(root, 'src/extension/testing/scenarioTestController.ts'), 'utf8');
const scenarioReportSource = readFileSync(resolve(root, 'src/extension/testing/scenarioReport.ts'), 'utf8');
const duplicateDiagnosticsSource = readFileSync(resolve(root, 'src/extension/config/profileDuplicateDiagnostics.ts'), 'utf8');

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
    expect(editorSource).toContain('await postFullSession();');
    expect(editorSource).toContain('sessionDeltaTracker.checkpoint(payload);');
    expect(editorSource).toContain("message.type === 'webview.ready'");
    expect(editorSource).toContain('await rehydrate();');
    expect(editorSource).toContain('const pendingSection = this.pendingSections.get(documentKey);');
    expect(editorSource).not.toContain("this.pendingSections.get(documentKey) ?? 'test'");
  });

  it('drops late Webview messages after the panel is disposed', () => {
    expect(editorSource).toContain('if (disposed) return false;');
    expect(editorSource).toContain('if (disposed || isDisposedWebviewError(error)) return false;');
    expect(editorSource).toContain("error.message.includes('Webview is disposed')");
  });

  it('waits for an editor controller before executing start, replay, import, or export', () => {
    expect(activateSource).toContain('openAndWaitForController(editor, uri)');
    expect(editorSource).toContain('async waitForController(uri: vscode.Uri, timeoutMs = 5000)');
    expect(editorSource).toContain('if (current && this.controllers.get(documentKey) === current) this.controllers.delete(documentKey);');
    expect(activateSource).toContain("command('importRun'");
    expect(editorSource).toContain('async importRun(uri: vscode.Uri)');
  });

  it('routes Open and Run back to Test when the profile editor is already showing configuration', () => {
    expect(activateSource).toContain("command('openProfile', async (item?: ProfileTreeItem | vscode.Uri) => openProfile(editor, asUri(item)))");
    expect(activateSource).toContain("await openProfileSection(editor, uri, 'test');");
    expect(activateSource).toContain("if (uri) await openProfileSection(editor, uri, 'test');");
    expect(editorSource).toContain('this.pendingSections.set(key, section);');
  });

  it('offers bounded native navigation and Host-owned artifact actions', () => {
    expect(activateSource).toContain("command('goTo'");
    expect(editorSource).toContain('async showDestination(uri: vscode.Uri, destination: WorkspaceDestination)');
    expect(editorSource).toContain('while (artifacts.size > 16)');
    expect(editorSource).toContain("message.type === 'artifact.action'");
    expect(editorSource).toContain("vscode.env.clipboard.writeText(artifact.path)");
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
    expect(editorSource).toContain('...this.pendingLinkedCaseWrites');
  });

  it('opens the native VS Code walkthrough from the usage-guide command', () => {
    expect(activateSource).toContain("export const TURNSTAGE_WALKTHROUGH_ID = 'turnstage.turnstage#gettingStarted';");
    expect(activateSource).toContain("command('openGuide', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', TURNSTAGE_WALKTHROUGH_ID, false))");
  });

  it('updates open profile editors when the display-language preference changes', () => {
    expect(editorSource).toContain("event.affectsConfiguration('turnstage.displayLanguage')");
    expect(editorSource).toContain("observeBackground(postHostReady(), 'display-language')");
    expect(editorSource).toContain('configurationListener.dispose()');
  });

  it('contains rejected background refresh and Webview operations', () => {
    expect(editorSource).toContain('const observeBackground =');
    expect(editorSource).toContain("observeBackground(postTestOperation(");
    expect(scenarioTestSource).toContain("this.refresh().catch((error) => logAt(this.output, 'error'");
    expect(duplicateDiagnosticsSource).toContain("this.refresh().catch((error) => logAt(this.output, 'error'");
    expect(activateSource).toContain("editor.publishTestResults(uri, results).catch((error) => logAt(output, 'error'");
    expect(activateSource).toContain("[notification] failed type=");
  });

  it('requires confirmation before a command restarts the current session', () => {
    expect(activateSource).toContain("!await confirmRestartSession()");
    expect(editorSource).toContain("case 'conversation.new': if (await confirmRestartSession())");
  });

  it('registers a native Test Explorer controller and a bounded failure-evidence command', () => {
    expect(scenarioTestSource).toContain("vscode.tests.createTestController('turnstage.contracts'");
    expect(scenarioTestSource).toContain('createRunProfile');
    expect(scenarioTestSource).toContain("markdown.isTrusted = { enabledCommands: ['turnstage.openTestEvidence'] }");
    expect(scenarioTestSource).toContain('message.contextValue = `${MESSAGE_EVIDENCE_PREFIX}${contextId}`');
    expect(scenarioTestSource).toContain('messageEvidenceByContext.get(contextId)');
    expect(scenarioTestSource).toContain('getMessageEvidence(argument: unknown)');
    expect(activateSource).toContain("command('openTestEvidence'");
    expect(activateSource).toContain('scenarioTests.getMessageEvidence(argument)');
    expect(activateSource).toContain('isScenarioEvidenceLocation(value?.location)');
    expect(editorSource).toContain("type: 'inspector.focus'");
  });

  it('keeps CI report projection separate from runtime evidence', () => {
    expect(activateSource).toContain("command('runContractTests', () => scenarioTests.runAll())");
    expect(scenarioTestSource).toContain("async runAll(): Promise<'completed' | 'cancelled'>");
    expect(activateSource).toContain("command('exportTestReport'");
    expect(scenarioTestSource).toContain('ScenarioReportService');
    expect(scenarioReportSource).toContain("format: SCENARIO_REPORT_FORMAT");
    expect(scenarioReportSource).not.toContain('rawEvents');
    expect(scenarioReportSource).not.toContain('requestPreview');
    expect(scenarioReportSource).not.toContain('actualOutput');
  });

  it('exports a sanitized evidence bundle and opens its offline HTML entry point', () => {
    expect(activateSource).toContain("command('exportEvidenceBundle'");
    expect(activateSource).toContain('scenarioTests.exportEvidenceBundle()');
    expect(activateSource).toContain("vscode.Uri.joinPath(uri, 'index.html')");
    expect(activateSource).toContain('await vscode.env.openExternal(index)');
  });
});
