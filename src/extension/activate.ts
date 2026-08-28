import * as vscode from 'vscode';
import { ProfileCodec } from './config/profileCodec';
import { EnvironmentRepository, ProfileRepository, type ProfileDestination, type ProfileScope } from './config/profileRepository';
import { ProfileValidator } from './config/profileValidator';
import { ProfileMigrator } from './config/profileMigration';
import { ProfileDuplicateDiagnostics } from './config/profileDuplicateDiagnostics';
import { TurnStageEditorProvider } from './editors/turnstageEditorProvider';
import { SecretService } from './security/security';
import { isWorkspaceSection, type WorkspaceSection } from '../shared/protocol';
import {
  ProfileScopeTreeItem,
  ProfileTreeItem,
  ProfileTreeProvider,
} from './views/profileTreeProvider';
import { configureL10n } from './l10n';
import type { DisplayLanguagePreference } from './displayLanguage';
import { confirmRestartSession } from './confirmRestartSession';

let activeEditor: TurnStageEditorProvider | undefined;
export const TURNSTAGE_WALKTHROUGH_ID = 'turnstage.turnstage#gettingStarted';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureL10n((message, values) => vscode.l10n.t(message, values ?? {}));
  const output = vscode.window.createOutputChannel(vscode.l10n.t('TurnStage')); const diagnostics = vscode.languages.createDiagnosticCollection('turnstage'); const repository = new ProfileRepository(context.globalStorageUri); const environments = new EnvironmentRepository(context.globalStorageUri); const duplicateDiagnostics = new ProfileDuplicateDiagnostics(repository, diagnostics); const tree = new ProfileTreeProvider(repository, (entries) => duplicateDiagnostics.refresh(entries)); const editor = new TurnStageEditorProvider(context, diagnostics, output, environments); activeEditor = editor; const secrets = new SecretService(context);
  const demoProvider = vscode.workspace.registerTextDocumentContentProvider('turnstage-demo', { provideTextDocumentContent: async (uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', uri.path.split('/').pop()!))) });
  context.subscriptions.push(output, diagnostics, tree, duplicateDiagnostics, demoProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('turnstage.profiles', tree), vscode.window.registerCustomEditorProvider('turnstage.profileEditor', editor, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: false }));

  const command = (id: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`turnstage.${id}`, handler));
  const refreshProfileState = async () => { tree.refresh(); await duplicateDiagnostics.refresh(); };
  command('refreshProfiles', refreshProfileState);
  command('initializeWorkspace', async () => { if (!requireWorkspaceTrust()) return; await initializeWorkspace(context); await refreshProfileState(); });
  command('initializeUser', async () => { if (!requireWorkspaceTrust()) return; await initializeUser(context, repository, environments); await refreshProfileState(); });
  command('createProfile', async (scopeItem?: ProfileScopeTreeItem) => { if (!requireWorkspaceTrust()) return; const destination = await pickProfileDestination(scopeItem?.scope); if (!destination) return; const uri = await createEmptyProfile(repository, destination); if (uri) { await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); } });
  command('importProfile', async (scopeItem?: ProfileScopeTreeItem) => {
    if (!requireWorkspaceTrust()) return;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Import Profile'), filters: { [vscode.l10n.t('TurnStage Profiles')]: ['jsonc', 'json'] } });
    if (!selected?.[0]) return;
    const destination = await pickProfileDestination(scopeItem?.scope); if (!destination) return;
    try { const uri = await repository.import(selected[0], destination); await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); void showNotification('information', vscode.l10n.t('Imported {path}.', { path: displayProfilePath(uri, repository) })); }
    catch (error) { void showNotification('error', vscode.l10n.t('Could not import profile: {error}', { error: error instanceof Error ? error.message : String(error) })); }
  });
  command('duplicateProfile', async (item?: ProfileTreeItem | vscode.Uri) => {
    if (!requireWorkspaceTrust()) return;
    const source = asUri(item); if (!source) return;
    if (!await repository.isDiscoveredProfile(source)) { void showNotification('error', vscode.l10n.t('TurnStage can only duplicate a discovered profile.')); return; }
    try { const uri = await repository.duplicate(source); await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); void showNotification('information', vscode.l10n.t('Created {path}.', { path: displayProfilePath(uri, repository) })); }
    catch (error) { void showNotification('error', vscode.l10n.t('Could not duplicate profile: {error}', { error: error instanceof Error ? error.message : String(error) })); }
  });
  command('deleteProfile', async (item?: ProfileTreeItem | vscode.Uri) => {
    if (!requireWorkspaceTrust()) return;
    const uri = asUri(item); if (!uri) return;
    if (!await repository.isDiscoveredProfile(uri)) { void showNotification('error', vscode.l10n.t('TurnStage refused to delete a file that is not a discovered profile.')); return; }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0) { void showNotification('error', vscode.l10n.t('TurnStage can only delete a single profile file.')); return; }
    const deleteProfileLabel = vscode.l10n.t('Delete Profile');
    const confirmation = await vscode.window.showWarningMessage(vscode.l10n.t('Delete TurnStage profile "{path}"?', { path: vscode.workspace.asRelativePath(uri) }), { modal: true, detail: vscode.l10n.t('Only this exact file will be moved to Trash:\n{uri}', { uri: uri.toString() }) }, deleteProfileLabel);
    if (confirmation !== deleteProfileLabel) return;
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
    await refreshProfileState();
  });
  command('openProfile', async (item?: ProfileTreeItem | vscode.Uri) => openProfile(editor, asUri(item)));
  command('openGuide', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', TURNSTAGE_WALKTHROUGH_ID, false));
  command('changeDisplayLanguage', async () => {
    const configuration = vscode.workspace.getConfiguration('turnstage');
    const current = configuration.get<DisplayLanguagePreference>('displayLanguage', 'auto');
    const choices: Array<vscode.QuickPickItem & { value: DisplayLanguagePreference }> = [
      { label: vscode.l10n.t('Auto (Follow VS Code)'), description: vscode.env.language, value: 'auto', picked: current === 'auto' },
      { label: '繁體中文', description: 'zh-tw', value: 'zh-tw', picked: current === 'zh-tw' },
      { label: 'English', description: 'en', value: 'en', picked: current === 'en' },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: vscode.l10n.t('Change TurnStage Display Language'),
      placeHolder: vscode.l10n.t('Choose the language used in TurnStage profile editors'),
    });
    if (selected) await configuration.update('displayLanguage', selected.value, vscode.ConfigurationTarget.Global);
  });
  command('openProfileSection', async (value?: ProfileTreeItem | vscode.Uri, section?: unknown) => {
    const uri = asUri(value);
    const sectionId = isProfileSectionId(section) ? section : undefined;
    if (!uri || !sectionId) return;
    await openProfileSection(editor, uri, sectionId);
  });
  command('configureProfile', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? activeCustomEditorUri(); if (!uri) { void showNotification('error', vscode.l10n.t('Open a profile in the TurnStage editor first.')); return; } await openProfileSection(editor, uri, 'general'); });
  command('runProfile', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? vscode.Uri.parse('turnstage-demo:/basic-sse-chat.turnstage.jsonc'); const controller = await openAndWaitForController(editor, uri); if (!controller) { void showNotification('error', vscode.l10n.t('The TurnStage profile editor did not become ready in time.')); return; } if (!canStartNetwork(controller.profile.opening?.mode)) return; await controller.startSession(); });
  command('startSession', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? activeCustomEditorUri(); if (!uri) { void showNotification('error', vscode.l10n.t('Open a profile in the TurnStage editor first.')); return; } const controller = await openAndWaitForController(editor, uri); if (!controller) { void showNotification('error', vscode.l10n.t('The TurnStage profile editor did not become ready in time.')); return; } if (!canStartNetwork(controller.profile.opening?.mode)) return; await controller.startSession(); });
  command('abortRequest', async (item?: ProfileTreeItem | vscode.Uri) => editor.getController(asUri(item))?.abort());
  command('newConversation', async (item?: ProfileTreeItem | vscode.Uri) => { const controller = editor.getController(asUri(item) ?? activeCustomEditorUri()); if (!controller || !canStartNetwork(controller.profile.opening?.mode) || !await confirmRestartSession()) return; await controller.newConversation(); });
  command('clearConversation', (item?: ProfileTreeItem | vscode.Uri) => editor.getController(asUri(item))?.clearConversation());
  command('openAsText', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? activeCustomEditorUri(); if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default'); });
  command('validateProfile', async (item?: ProfileTreeItem | vscode.Uri) => { await validateUri(asUri(item), diagnostics); await duplicateDiagnostics.refresh(); });
  command('selectEnvironment', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item); if (!uri) return; await selectEnvironment(uri, environments); });
  command('openEnvironment', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item); if (!uri) return; const entries = await environments.discover(uri); const picked = await vscode.window.showQuickPick(entries.map((entry) => ({ label: entry.environment.name, description: entry.environment.id, detail: entry.scope === 'workspace' ? vscode.l10n.t('Workspace') : vscode.l10n.t('User'), entry })), { title: vscode.l10n.t('Open TurnStage Environment') }); if (picked) await vscode.commands.executeCommand('vscode.openWith', picked.entry.uri, 'default'); });
  command('setSecret', async () => { if (!requireWorkspaceTrust()) return; const name = await vscode.window.showInputBox({ title: vscode.l10n.t('TurnStage: Set Secret'), prompt: vscode.l10n.t('Secret name (values are stored in VS Code SecretStorage)'), ignoreFocusOut: true }); if (!name) return; const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Set {name}', { name }), password: true, prompt: vscode.l10n.t('Secret value'), ignoreFocusOut: true }); if (value !== undefined) { await secrets.set(name, value); void showNotification('information', vscode.l10n.t('TurnStage secret "{name}" was stored.', { name })); } });
  command('removeSecret', async () => { if (!requireWorkspaceTrust()) return; const name = await vscode.window.showQuickPick(secrets.names(), { title: vscode.l10n.t('TurnStage: Remove Secret') }); const removeLabel = vscode.l10n.t('Remove'); if (name && await vscode.window.showWarningMessage(vscode.l10n.t('Remove TurnStage secret "{name}"?', { name }), { modal: true }, removeLabel) === removeLabel) await secrets.remove(name); });
  command('listSecretNames', () => { if (!requireWorkspaceTrust()) return; return vscode.window.showQuickPick(secrets.names(), { title: vscode.l10n.t('TurnStage Secret Names'), placeHolder: vscode.l10n.t('Secret values are never displayed') }); });
  command('replayRun', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? activeCustomEditorUri(); if (!uri) { void showNotification('error', vscode.l10n.t('Open a profile in the TurnStage editor first.')); return; } const controller = await openAndWaitForController(editor, uri); if (!controller) { void showNotification('error', vscode.l10n.t('The TurnStage profile editor did not become ready in time.')); return; } const result = await editor.replayRun(uri); if (result === 'started') return; await editor.showSection(uri, 'test'); if (result === 'active') void showNotification('information', vscode.l10n.t('Finish or stop the current request before replaying another run.')); else if (result === 'unavailable') void showNotification('information', vscode.l10n.t('This run cannot be replayed because raw events were not recorded.')); else void showNotification('information', vscode.l10n.t('No recorded runs are available. Open Test to run a profile first.')); });
  command('importRun', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item) ?? activeCustomEditorUri(); if (!uri) { void showNotification('error', vscode.l10n.t('Open a profile in the TurnStage editor first.')); return; } const controller = await openAndWaitForController(editor, uri); if (!controller) { void showNotification('error', vscode.l10n.t('The TurnStage profile editor did not become ready in time.')); return; } try { const imported = await editor.importRun(uri); if (!imported) return; const message = imported.duplicate ? vscode.l10n.t('Run imported as a copy from {path}.', { path: displayExportUri(imported.uri) }) : vscode.l10n.t('Run imported from {path}.', { path: displayExportUri(imported.uri) }); void showNotification('information', message); } catch (error) { void showNotification('error', vscode.l10n.t('Could not import run: {error}', { error: error instanceof Error ? error.message : String(error) })); } });
  command('exportRun', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item) ?? activeCustomEditorUri(); if (!uri) { void showNotification('error', vscode.l10n.t('Open a profile in the TurnStage editor first.')); return; } const controller = await openAndWaitForController(editor, uri); if (!controller) { void showNotification('error', vscode.l10n.t('The TurnStage profile editor did not become ready in time.')); return; } const exported = await editor.exportRun(uri); if (exported) { void showNotification('information', vscode.l10n.t('Run exported to {path}.', { path: displayExportUri(exported) })); return; } await editor.showSection(uri, 'test'); void showNotification('information', vscode.l10n.t('No recorded runs are available. Open Test to run a profile first.')); });
  command('openOutput', () => output.show(true));
  command('migrateProfile', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item); if (!uri) return; const document = await vscode.workspace.openTextDocument(uri); const result = new ProfileMigrator().migrate(document.getText()); if (!result.changed) { void showNotification('information', vscode.l10n.t('This TurnStage profile is already current.')); return; } const migrateLabel = vscode.l10n.t('Migrate'); const confirmation = await vscode.window.showInformationMessage(vscode.l10n.t('Migrate profile from version {from} to {to}? A backup will be created.', { from: result.fromVersion, to: result.toVersion }), { modal: true, detail: result.notes.join('\n') }, migrateLabel); if (confirmation !== migrateLabel) return; const backup = uri.with({ path: `${uri.path}.v${result.fromVersion}.backup` }); await vscode.workspace.fs.writeFile(backup, new TextEncoder().encode(document.getText())); const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), result.text); await vscode.workspace.applyEdit(edit); await vscode.commands.executeCommand('vscode.diff', backup, uri, vscode.l10n.t('TurnStage Migration')); });
  output.appendLine(vscode.l10n.t('TurnStage activated in {host}.', { host: vscode.env.remoteName ?? vscode.l10n.t('Local Extension Host') }));
}

export async function deactivate(): Promise<void> {
  const editor = activeEditor;
  activeEditor = undefined;
  await editor?.drainPending();
}

function requireWorkspaceTrust(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void showNotification('error', vscode.l10n.t('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
  return false;
}

function canStartNetwork(openingMode: string | undefined): boolean {
  if (openingMode !== 'request' || vscode.workspace.isTrusted) return true;
  return requireWorkspaceTrust();
}

function asUri(value?: ProfileTreeItem | vscode.Uri): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  return value?.entry.uri;
}

function activeCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === 'turnstage.profileEditor' ? input.uri : undefined;
}

function isProfileSectionId(value: unknown): value is WorkspaceSection {
  return isWorkspaceSection(value);
}

async function openProfileSection(editor: TurnStageEditorProvider, uri: vscode.Uri, section: WorkspaceSection): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
  await editor.showSection(uri, section);
}

async function openAndWaitForController(editor: TurnStageEditorProvider, uri: vscode.Uri): Promise<import('./runtime/sessionController').SessionController | undefined> {
  await openProfileSection(editor, uri, 'test');
  return editor.waitForController(uri);
}

async function openProfile(editor: TurnStageEditorProvider, uri?: vscode.Uri): Promise<void> { if (!uri) { const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [vscode.l10n.t('TurnStage Profiles')]: ['jsonc'] } }); uri = selected?.[0]; } if (uri) await openProfileSection(editor, uri, 'test'); }

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { void showNotification('error', vscode.l10n.t('Open a workspace folder before importing a TurnStage profile.')); return undefined; }
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Select the workspace folder for the imported profile') });
}

async function pickProfileDestination(preferredScope?: ProfileScope): Promise<ProfileDestination | undefined> {
  if (preferredScope === 'user' || !vscode.workspace.workspaceFolders?.length) return 'user';
  if (preferredScope === 'workspace') return pickWorkspaceFolder();
  const choice = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('User Profiles'), description: vscode.l10n.t('Available in every workspace on this Extension Host.'), scope: 'user' as const },
    { label: vscode.l10n.t('Workspace Profiles'), description: vscode.l10n.t('Stored in .vscode/turnstage for this project.'), scope: 'workspace' as const },
  ], { title: vscode.l10n.t('Choose Profile Location') });
  return choice?.scope === 'user' ? 'user' : choice?.scope === 'workspace' ? pickWorkspaceFolder() : undefined;
}

async function initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) { void showNotification('error', vscode.l10n.t('Open a workspace folder before initializing TurnStage.')); return; }
  const choice = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Basic SSE Chat'), files: ['basic-sse-chat.turnstage.jsonc'] },
    { label: vscode.l10n.t('Agent Flow'), files: ['agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Enterprise Chat Contract'), files: ['enterprise-chat.turnstage.jsonc'] },
    { label: vscode.l10n.t('Both Starter Profiles'), files: ['basic-sse-chat.turnstage.jsonc', 'agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Empty Profile'), files: ['empty.turnstage.jsonc'] },
    { label: vscode.l10n.t('Profiles + Local Mock Server Example'), files: ['basic-sse-chat.turnstage.jsonc', 'agent-flow.turnstage.jsonc', 'enterprise-chat.turnstage.jsonc'], includeFixtures: true },
  ], { title: vscode.l10n.t('Initialize TurnStage'), placeHolder: vscode.l10n.t('Choose starter content') }); if (!choice) return;
  const root = vscode.Uri.joinPath(folder.uri, '.vscode', 'turnstage'); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'profiles')); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'environments'));
  for (const file of choice.files) { if (file === 'empty.turnstage.jsonc') { await writeSafe(vscode.Uri.joinPath(root, 'profiles', file), new TextEncoder().encode(emptyProfile('empty')), true); continue; } const source = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', file); await writeSafe(vscode.Uri.joinPath(root, 'profiles', file), await vscode.workspace.fs.readFile(source)); }
  const environment = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', 'local.environment.jsonc'); await writeSafe(vscode.Uri.joinPath(root, 'environments', 'local.environment.jsonc'), await vscode.workspace.fs.readFile(environment));
  if (choice.includeFixtures) { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'fixtures')); for (const file of ['basic-sse-chat.jsonl', 'agent-flow.jsonl', 'enterprise-chat.jsonl']) await writeSafe(vscode.Uri.joinPath(root, 'fixtures', file), await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'fixtures', file))); }
  void showNotification('information', vscode.l10n.t('TurnStage workspace initialized. No existing file was overwritten without confirmation.'));
}

async function initializeUser(context: vscode.ExtensionContext, repository: ProfileRepository, environments: EnvironmentRepository): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Basic SSE Chat'), files: ['basic-sse-chat.turnstage.jsonc'] },
    { label: vscode.l10n.t('Agent Flow'), files: ['agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Enterprise Chat Contract'), files: ['enterprise-chat.turnstage.jsonc'] },
    { label: vscode.l10n.t('Both Starter Profiles'), files: ['basic-sse-chat.turnstage.jsonc', 'agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Empty Profile'), files: ['empty.turnstage.jsonc'] },
  ], { title: vscode.l10n.t('Initialize User Profiles'), placeHolder: vscode.l10n.t('Choose starter content') });
  if (!choice) return;
  const profileDirectory = repository.profileDirectory('user');
  const environmentDirectory = environments.userEnvironmentDirectory();
  if (!environmentDirectory) throw new Error(vscode.l10n.t('User environment storage is unavailable.'));
  await vscode.workspace.fs.createDirectory(profileDirectory);
  await vscode.workspace.fs.createDirectory(environmentDirectory);
  for (const file of choice.files) {
    if (file === 'empty.turnstage.jsonc') {
      await writeSafe(vscode.Uri.joinPath(profileDirectory, file), new TextEncoder().encode(emptyProfile('empty')), true);
      continue;
    }
    const source = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', file);
    await writeSafe(vscode.Uri.joinPath(profileDirectory, file), await vscode.workspace.fs.readFile(source));
  }
  const environment = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', 'local.environment.jsonc');
  await writeSafe(vscode.Uri.joinPath(environmentDirectory, 'local.environment.jsonc'), await vscode.workspace.fs.readFile(environment));
  void showNotification('information', vscode.l10n.t('TurnStage user profiles initialized. Existing files were not overwritten without confirmation.'));
}

async function writeSafe(target: vscode.Uri, bytes: Uint8Array, silentNew = false): Promise<void> {
  try { await vscode.workspace.fs.stat(target); const skipLabel = vscode.l10n.t('Skip'); const copyLabel = vscode.l10n.t('Create Copy'); const replaceLabel = vscode.l10n.t('Replace'); const action = await vscode.window.showQuickPick([skipLabel, copyLabel, replaceLabel], { title: vscode.l10n.t('{path} already exists', { path: vscode.workspace.asRelativePath(target) }) }); if (!action || action === skipLabel) return; if (action === copyLabel) target = await duplicateUri(target); else if (await vscode.window.showWarningMessage(vscode.l10n.t('Replace {path}?', { path: vscode.workspace.asRelativePath(target) }), { modal: true }, replaceLabel) !== replaceLabel) return; } catch { /* target is new */ }
  await vscode.workspace.fs.writeFile(target, bytes); if (!silentNew) return;
}
async function duplicateUri(uri: vscode.Uri): Promise<vscode.Uri> { const match = uri.path.match(/^(.*?)(\.[^.]+\.[^.]+)$/) ?? uri.path.match(/^(.*?)(\.[^.]+)$/); const base = match?.[1] ?? uri.path; const suffix = match?.[2] ?? ''; for (let index = 2; index < 1000; index++) { const candidate = uri.with({ path: `${base}-${index}${suffix}` }); try { await vscode.workspace.fs.stat(candidate); } catch { return candidate; } } throw new Error(vscode.l10n.t('Could not create a duplicate-safe filename.')); }
async function createEmptyProfile(repository: ProfileRepository, destination: ProfileDestination): Promise<vscode.Uri | undefined> { const id = await vscode.window.showInputBox({ title: vscode.l10n.t('Create TurnStage Profile'), prompt: vscode.l10n.t('Profile id'), value: 'sample-profile', validateInput: (value) => /^[a-z0-9][a-z0-9-]*$/.test(value) ? undefined : vscode.l10n.t('Use lowercase letters, numbers, and hyphens.') }); if (!id) return; const directory = repository.profileDirectory(destination); await vscode.workspace.fs.createDirectory(directory); const uri = await duplicateIfExists(vscode.Uri.joinPath(directory, `${id}.turnstage.jsonc`)); await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(emptyProfile(id))); return uri; }
function displayExportUri(uri: vscode.Uri): string { return uri.scheme === 'file' ? uri.fsPath : uri.toString(true); }
async function duplicateIfExists(uri: vscode.Uri): Promise<vscode.Uri> { try { await vscode.workspace.fs.stat(uri); return duplicateUri(uri); } catch { return uri; } }
function emptyProfile(id: string): string { return JSON.stringify({ version: 1, id, name: id.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' '), environment: 'local', opening: { mode: 'static', message: vscode.l10n.t('Hello, I am a test assistant. What would you like to test?'), starters: [] }, conversation: { send: { method: 'POST', url: '${env.baseUrl}/basic/chat/stream', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, variants: [{ id: 'first-turn', when: { path: 'conversation.id', operator: 'notExists' }, body: { message: { $value: 'input.text' } } }, { id: 'continuation', when: { path: 'conversation.id', operator: 'exists' }, body: { message: { $value: 'input.text' }, conversationId: { $value: 'conversation.id' } } }] } }, stream: { transport: 'sse', dataFormat: 'json', mappingMode: 'firstMatch', unexpectedEndPolicy: 'fail', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] } }, null, 2); }

async function validateUri(uri: vscode.Uri | undefined, collection: vscode.DiagnosticCollection): Promise<void> { if (!uri) return; const document = await vscode.workspace.openTextDocument(uri); const codec = new ProfileCodec(); const parsed = codec.parse(document.getText()); const issues = new ProfileValidator().validate(parsed.profile, parsed.tree); collection.set(uri, issues.map((item) => new vscode.Diagnostic(new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.message, item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning))); void showNotification('information', issues.length === 0 ? vscode.l10n.t('TurnStage profile is valid.') : issues.length === 1 ? vscode.l10n.t('TurnStage found {count} issue.', { count: issues.length }) : vscode.l10n.t('TurnStage found {count} issues.', { count: issues.length })); }
async function selectEnvironment(uri: vscode.Uri, repository: EnvironmentRepository): Promise<void> { const document = await vscode.workspace.openTextDocument(uri); const entries = await repository.discover(uri); const picked = await vscode.window.showQuickPick(entries.map((item) => ({ label: item.environment.name, description: item.environment.id, detail: item.scope === 'workspace' ? vscode.l10n.t('Workspace') : vscode.l10n.t('User') })), { title: vscode.l10n.t('Select TurnStage Environment') }); if (!picked?.description) return; const edits = (await import('jsonc-parser')).modify(document.getText(), ['environment'], picked.description, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); const workspaceEdit = new vscode.WorkspaceEdit(); for (const item of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(uri, new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.content); await vscode.workspace.applyEdit(workspaceEdit); }

function displayProfilePath(uri: vscode.Uri, repository: ProfileRepository): string {
  const directory = repository.userProfileDirectory();
  if (directory && uri.toString().startsWith(`${directory.toString().replace(/\/$/, '')}/`)) return `${vscode.l10n.t('User')} / ${uri.path.slice(uri.path.lastIndexOf('/') + 1)}`;
  return vscode.workspace.asRelativePath(uri);
}

type NotificationKind = 'information' | 'error';

async function showNotification(kind: NotificationKind, message: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('turnstage');
  if (configuration.get<boolean>('notifications.enabled', true) === false) return;
  const doNotShowAgain = vscode.l10n.t('Do not show again');
  const action = kind === 'error'
    ? await vscode.window.showErrorMessage(message, doNotShowAgain)
    : await vscode.window.showInformationMessage(message, doNotShowAgain);
  if (action === doNotShowAgain) {
    try { await configuration.update('notifications.enabled', false, vscode.ConfigurationTarget.Global); } catch { /* notification preferences are best effort */ }
  }
}
