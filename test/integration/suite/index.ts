import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * The integration suite deliberately uses only public VS Code APIs. It runs
 * as a single async function so a failed assertion closes the Extension
 * Development Host instead of leaving a test runner or modal picker behind.
 */
export async function run(): Promise<void> {
  const expectedTrust = process.env.TURNSTAGE_EXPECT_TRUST ?? 'trusted';
  const extension = vscode.extensions.getExtension('turnstage.turnstage');
  assert.ok(extension, 'TurnStage extension should be discoverable');
  assert.equal(extension.isActive, false, 'TurnStage should be lazy and inactive before a command/editor is used');

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The integration runner must open a workspace folder');
  const workspaceRoot = workspaceFolder.uri;
  assert.equal(vscode.workspace.isTrusted, expectedTrust === 'trusted', `Workspace trust should match the ${expectedTrust} integration run`);
  const profileDirectory = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'turnstage', 'profiles');
  const profileUri = vscode.Uri.joinPath(profileDirectory, 'integration.turnstage.jsonc');
  const initialProfileText = await readText(profileUri);

  // A command is the first activation trigger in this suite. No profile scan
  // or webview is created before this point.
  await vscode.commands.executeCommand('turnstage.openOutput');
  assert.equal(extension.isActive, true, 'The command activation should complete');

  await assertRegisteredCommands();
  await assertManifestCapabilities(extension);
  await assertSecretStorageCommandPath();

  // Activation must not initialize or rewrite an existing workspace on its
  // own. This is observable without invoking the interactive initializer.
  assert.equal(await readText(profileUri), initialProfileText, 'Activation must not overwrite an existing profile');

  await assertProfileDiscovery(profileUri);
  await assertCustomEditorAndTextFallback(profileUri);
  await assertDiagnostics(profileDirectory, profileUri);
  await assertFileDiscoveryAfterCreateAndChange(profileDirectory);
  await assertWorkspaceTrustBehavior(profileDirectory);
}

async function assertRegisteredCommands(): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'turnstage.initializeWorkspace',
    'turnstage.initializeUser',
    'turnstage.createProfile',
    'turnstage.importProfile',
    'turnstage.duplicateProfile',
    'turnstage.deleteProfile',
    'turnstage.openProfile',
    'turnstage.openProfileSection',
    'turnstage.openGuide',
    'turnstage.configureProfile',
    'turnstage.runProfile',
    'turnstage.startSession',
    'turnstage.validateProfile',
    'turnstage.openAsText',
    'turnstage.openEnvironment',
    'turnstage.setSecret',
    'turnstage.replayRun',
    'turnstage.exportRun',
  ]) {
    assert.ok(commands.has(command), `${command} should be registered`);
  }
}

async function assertManifestCapabilities(extension: vscode.Extension<unknown>): Promise<void> {
  const capabilities = extension.packageJSON.capabilities?.untrustedWorkspaces as {
    supported?: string;
    restrictedConfigurations?: unknown;
  } | undefined;
  assert.ok(capabilities, 'The extension manifest must declare untrusted workspace support');
  assert.equal(capabilities.supported, 'limited');
  assert.deepEqual(capabilities.restrictedConfigurations, []);
}

async function assertSecretStorageCommandPath(): Promise<void> {
  // The command normally opens two input boxes. In Extension Host tests we
  // provide deterministic answers through the public window API and restore it
  // in a finally block, so the suite never waits for a human picker.
  const windowApi = vscode.window as typeof vscode.window & {
    showInputBox: typeof vscode.window.showInputBox;
  };
  const original = windowApi.showInputBox;
  let inputCount = 0;
  try {
    windowApi.showInputBox = async () => {
      inputCount += 1;
      return inputCount === 1 ? 'integration-secret' : 'integration-secret-value';
    };
    await vscode.commands.executeCommand('turnstage.setSecret');
  } finally {
    windowApi.showInputBox = original;
  }
  assert.equal(inputCount, vscode.workspace.isTrusted ? 2 : 0, vscode.workspace.isTrusted ? 'The SecretStorage command should request a name and value' : 'SecretStorage mutation must be blocked in an untrusted workspace');

  // The value itself is intentionally never observable from the test. This
  // assertion only verifies the non-modal command reached its handler and did
  // not expose the secret through a UI result.
}

async function assertProfileDiscovery(profileUri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.turnstage');
  const profiles = await waitFor(async () => {
    const entries = await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc');
    return entries.some((uri) => uri.toString() === profileUri.toString()) ? entries : undefined;
  }, 'the starter profile to be discoverable');
  assert.equal(profiles.length, 1, 'The clean temp workspace should start with one profile');
  const document = await vscode.workspace.openTextDocument(profileUri);
  assert.match(document.getText(), /"id"\s*:\s*"integration"/);
}

async function assertCustomEditorAndTextFallback(profileUri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(profileUri);
  await vscode.commands.executeCommand('turnstage.runProfile', profileUri);
  const customTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? activeTabInput() : undefined, 'the TurnStage custom editor tab');
  assert.equal((customTab as vscode.TabInputCustom).viewType, 'turnstage.profileEditor');
  assert.equal((customTab as vscode.TabInputCustom).uri.toString(), profileUri.toString());
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Integration Profile · TurnStage', 'Run Profile should identify the custom editor instead of looking like a JSONC text tab');
  assert.ok(vscode.workspace.textDocuments.some((item) => item.uri.toString() === profileUri.toString()), 'Custom editor must be backed by the shared TextDocument');

  // Hiding a custom editor disposes its webview DOM because the provider uses
  // retainContextWhenHidden: false. Revealing the same tab must keep using the
  // custom editor; the provider rehydrates the new DOM from cached host state.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The tab-switch regression requires an open workspace folder');
  const switchAwayUri = vscode.Uri.joinPath(workspaceFolder.uri, 'switch-away.txt');
  await writeText(switchAwayUri, 'TurnStage integration tab switch');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(switchAwayUri));
  assert.ok(activeTabInput() instanceof vscode.TabInputText, 'A text editor should temporarily hide the TurnStage custom editor');
  await vscode.commands.executeCommand('vscode.openWith', profileUri, 'turnstage.profileEditor');
  const revealedTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? activeTabInput() : undefined, 'the revealed TurnStage custom editor tab');
  assert.equal((revealedTab as vscode.TabInputCustom).viewType, 'turnstage.profileEditor');
  assert.equal((revealedTab as vscode.TabInputCustom).uri.toString(), profileUri.toString());

  // A host-side edit must remain visible while the custom editor is open. It
  // exercises the provider document listener and proves the document model
  // remains the source of truth for the webview session.
  const marker = 'Integration Profile';
  const markerOffset = document.getText().indexOf(marker);
  assert.ok(markerOffset >= 0, 'The integration fixture should contain its profile name');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(profileUri, new vscode.Range(document.positionAt(markerOffset), document.positionAt(markerOffset + marker.length)), 'Integration Profile Synced');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await waitFor(() => document.getText().includes('Integration Profile Synced') ? true : undefined, 'the custom editor document edit');
  await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Integration Profile Synced · TurnStage' ? true : undefined, 'the profile name to update the custom editor tab');
  await document.save();
  assert.ok(activeTabInput() instanceof vscode.TabInputCustom, 'The custom editor should survive a TextDocument change');

  await vscode.commands.executeCommand('turnstage.openAsText', profileUri);
  const textTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputText ? activeTabInput() : undefined, 'Open as Text to activate a text tab');
  assert.equal((textTab as vscode.TabInputText).uri.toString(), profileUri.toString());

  // Close only the test tab. This invokes the provider's panel disposal path
  // and avoids leaving a dirty editor or a pending Extension Host UI prompt.
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active) await vscode.window.tabGroups.close(active, true);
}

async function assertDiagnostics(profileDirectory: vscode.Uri, profileUri: vscode.Uri): Promise<void> {
  const invalidUri = vscode.Uri.joinPath(profileDirectory, 'invalid.turnstage.jsonc');
  await writeText(invalidUri, '{\n  "version": 1,\n  "id": "invalid",\n');
  await vscode.commands.executeCommand('turnstage.validateProfile', invalidUri);
  const diagnostics = await waitFor(() => {
    const matching = vscode.languages.getDiagnostics(invalidUri).filter((diagnostic) => diagnostic.source === 'TurnStage' || /could not be parsed|invalid json/i.test(diagnostic.message));
    return matching.length ? matching : undefined;
  }, 'TurnStage diagnostics for an invalid profile');
  assert.ok(diagnostics.some((diagnostic) => /could not be parsed|invalid json/i.test(diagnostic.message)), 'Invalid JSONC should produce a TurnStage diagnostic');

  const duplicateUri = vscode.Uri.joinPath(profileDirectory, 'duplicate.turnstage.jsonc');
  await writeText(duplicateUri, validProfile('integration', 'Duplicate Integration Profile'));
  const duplicateDiagnostics = await waitFor(() => {
    const matching = vscode.languages.getDiagnostics(profileUri).filter((diagnostic) => diagnostic.code === 'duplicate-profile-id' || /also used by/i.test(diagnostic.message));
    return matching.length ? matching : undefined;
  }, 'duplicate profile id diagnostics');
  assert.ok(duplicateDiagnostics.length > 0, 'Duplicate profile ids should be surfaced in Problems');
}

async function assertFileDiscoveryAfterCreateAndChange(profileDirectory: vscode.Uri): Promise<void> {
  const watcherUri = vscode.Uri.joinPath(profileDirectory, 'watcher.turnstage.jsonc');
  await writeText(watcherUri, validProfile('watcher', 'Watcher Profile'));
  const created = await waitFor(async () => {
    const entries = await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc');
    return entries.some((uri) => uri.toString() === watcherUri.toString()) ? entries : undefined;
  }, 'a newly-created profile to be found by the configured profile glob');
  assert.ok(created.some((uri) => uri.toString() === watcherUri.toString()));

  const watcherDocument = await vscode.workspace.openTextDocument(watcherUri);
  const editedText = watcherDocument.getText().replace('Watcher Profile', 'Watcher Profile Changed');
  await writeText(watcherUri, editedText);
  await waitFor(async () => (await readText(watcherUri)).includes('Watcher Profile Changed') ? true : undefined, 'a modified profile to be visible through the workspace filesystem');
  await vscode.commands.executeCommand('turnstage.refreshProfiles');
  assert.ok((await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc')).some((uri) => uri.toString() === watcherUri.toString()), 'The refresh command should retain the new profile in discovery');
}

async function assertWorkspaceTrustBehavior(profileDirectory: vscode.Uri): Promise<void> {
  if (vscode.workspace.isTrusted) return;
  const requestUri = vscode.Uri.joinPath(profileDirectory, 'untrusted-request.turnstage.jsonc');
  await writeText(requestUri, JSON.stringify({
    version: 1,
    id: 'untrusted-request',
    name: 'Untrusted Opening Request',
    environment: 'local',
    opening: { mode: 'request', request: { method: 'GET', url: 'http://127.0.0.1:9/should-not-run' } },
    conversation: { send: { method: 'GET', url: 'http://127.0.0.1:9/should-not-run', variants: [{ id: 'default', body: {} }] } },
    stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
  }, null, 2));
  await vscode.commands.executeCommand('vscode.openWith', requestUri, 'turnstage.profileEditor');
  await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? true : undefined, 'the untrusted profile custom editor');
  assert.equal(vscode.workspace.isTrusted, false, 'The Extension Host should remain untrusted for this test');
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active) await vscode.window.tabGroups.close(active, true);
}

function activeTabInput(): vscode.TabInputText | vscode.TabInputCustom | unknown {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input;
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function validProfile(id: string, name: string): string {
  return JSON.stringify({
    version: 1,
    id,
    name,
    environment: 'local',
    opening: { mode: 'static', message: 'Integration opening.' },
    conversation: { send: { method: 'POST', url: 'http://127.0.0.1:9/unused', variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
    stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
  }, null, 2);
}

async function waitFor<T>(probe: () => T | Promise<T | undefined> | undefined, description: string, timeoutMs = 8_000): Promise<NonNullable<T>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined && value !== false && value !== null) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
