import * as vscode from 'vscode';
import { ProfileCodec } from './config/profileCodec';
import { ProfileRepository } from './config/profileRepository';
import { ProfileValidator } from './config/profileValidator';
import { ProfileMigrator } from './config/profileMigration';
import { ProfileDuplicateDiagnostics } from './config/profileDuplicateDiagnostics';
import { TurnStageEditorProvider } from './editors/turnstageEditorProvider';
import { SecretService } from './security/security';
import { isWorkspaceSection, type WorkspaceSection } from '../shared/protocol';
import {
  ProfileSectionTreeItem,
  ProfileTreeItem,
  ProfileTreeProvider,
} from './views/profileTreeProvider';
import { configureL10n } from './l10n';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureL10n((message, values) => vscode.l10n.t(message, values ?? {}));
  const output = vscode.window.createOutputChannel(vscode.l10n.t('TurnStage')); const diagnostics = vscode.languages.createDiagnosticCollection('turnstage'); const repository = new ProfileRepository(); const duplicateDiagnostics = new ProfileDuplicateDiagnostics(repository, diagnostics); const tree = new ProfileTreeProvider(repository, (entries) => duplicateDiagnostics.refresh(entries)); const editor = new TurnStageEditorProvider(context, diagnostics, output); const secrets = new SecretService(context);
  const demoProvider = vscode.workspace.registerTextDocumentContentProvider('turnstage-demo', { provideTextDocumentContent: async (uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', uri.path.split('/').pop()!))) });
  context.subscriptions.push(output, diagnostics, tree, duplicateDiagnostics, demoProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('turnstage.profiles', tree), vscode.window.registerCustomEditorProvider('turnstage.profileEditor', editor, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true }));

  const command = (id: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`turnstage.${id}`, handler));
  const refreshProfileState = async () => { tree.refresh(); await duplicateDiagnostics.refresh(); };
  command('refreshProfiles', refreshProfileState);
  command('initializeWorkspace', async () => { if (!requireWorkspaceTrust()) return; await initializeWorkspace(context); await refreshProfileState(); });
  command('createProfile', async () => { if (!requireWorkspaceTrust()) return; const uri = await createEmptyProfile(); if (uri) { await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); } });
  command('importProfile', async () => {
    if (!requireWorkspaceTrust()) return;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Import Profile'), filters: { [vscode.l10n.t('TurnStage Profiles')]: ['jsonc', 'json'] } });
    if (!selected?.[0]) return;
    const folder = await pickWorkspaceFolder(); if (!folder) return;
    try { const uri = await repository.import(selected[0], folder); await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); void vscode.window.showInformationMessage(vscode.l10n.t('Imported {path}.', { path: vscode.workspace.asRelativePath(uri) })); }
    catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('Could not import profile: {error}', { error: error instanceof Error ? error.message : String(error) })); }
  });
  command('duplicateProfile', async (item?: ProfileTreeItem | vscode.Uri) => {
    if (!requireWorkspaceTrust()) return;
    const source = asUri(item); if (!source) return;
    if (!await repository.isDiscoveredProfile(source)) { void vscode.window.showErrorMessage(vscode.l10n.t('TurnStage can only duplicate a discovered profile.')); return; }
    try { const uri = await repository.duplicate(source); await refreshProfileState(); await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); void vscode.window.showInformationMessage(vscode.l10n.t('Created {path}.', { path: vscode.workspace.asRelativePath(uri) })); }
    catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('Could not duplicate profile: {error}', { error: error instanceof Error ? error.message : String(error) })); }
  });
  command('deleteProfile', async (item?: ProfileTreeItem | vscode.Uri) => {
    if (!requireWorkspaceTrust()) return;
    const uri = asUri(item); if (!uri) return;
    if (!await repository.isDiscoveredProfile(uri)) { void vscode.window.showErrorMessage(vscode.l10n.t('TurnStage refused to delete a file that is not a discovered profile.')); return; }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0) { void vscode.window.showErrorMessage(vscode.l10n.t('TurnStage can only delete a single profile file.')); return; }
    const deleteProfileLabel = vscode.l10n.t('Delete Profile');
    const confirmation = await vscode.window.showWarningMessage(vscode.l10n.t('Delete TurnStage profile "{path}"?', { path: vscode.workspace.asRelativePath(uri) }), { modal: true, detail: vscode.l10n.t('Only this exact file will be moved to Trash:\n{uri}', { uri: uri.toString() }) }, deleteProfileLabel);
    if (confirmation !== deleteProfileLabel) return;
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
    await refreshProfileState();
  });
  command('openProfile', async (item?: ProfileTreeItem | vscode.Uri) => openProfile(asUri(item)));
  command('openProfileSection', async (value?: ProfileTreeItem | ProfileSectionTreeItem | vscode.Uri, section?: unknown) => {
    const uri = asUri(value);
    const sectionId = isProfileSectionId(section) ? section : value instanceof ProfileSectionTreeItem ? value.section.id : undefined;
    if (!uri || !sectionId) return;
    await openProfileSection(editor, uri, sectionId);
  });
  command('runProfile', async (item?: ProfileTreeItem | vscode.Uri) => { let uri = asUri(item); if (!uri) uri = vscode.Uri.parse('turnstage-demo:/basic-sse-chat.turnstage.jsonc'); await openProfile(uri); setTimeout(() => void vscode.commands.executeCommand('turnstage.startSession', uri), 250); });
  command('startSession', async (item?: ProfileTreeItem | vscode.Uri) => { const controller = editor.getController(asUri(item) ?? vscode.window.activeTextEditor?.document.uri); if (!controller || !canStartNetwork(controller.profile.opening?.mode)) return; await controller.startSession(); });
  command('abortRequest', async (item?: ProfileTreeItem | vscode.Uri) => editor.getController(asUri(item))?.abort());
  command('newConversation', async (item?: ProfileTreeItem | vscode.Uri) => { const controller = editor.getController(asUri(item)); if (!controller || !canStartNetwork(controller.profile.opening?.mode)) return; await controller.newConversation(); });
  command('clearConversation', (item?: ProfileTreeItem | vscode.Uri) => editor.getController(asUri(item))?.clearConversation());
  command('openAsText', async (item?: ProfileTreeItem | vscode.Uri) => { const uri = asUri(item) ?? activeCustomEditorUri(); if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default'); });
  command('validateProfile', async (item?: ProfileTreeItem | vscode.Uri) => { await validateUri(asUri(item), diagnostics); await duplicateDiagnostics.refresh(); });
  command('selectEnvironment', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item); if (!uri) return; await selectEnvironment(uri); });
  command('setSecret', async () => { if (!requireWorkspaceTrust()) return; const name = await vscode.window.showInputBox({ title: vscode.l10n.t('TurnStage: Set Secret'), prompt: vscode.l10n.t('Secret name (values are stored in VS Code SecretStorage)'), ignoreFocusOut: true }); if (!name) return; const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Set {name}', { name }), password: true, prompt: vscode.l10n.t('Secret value'), ignoreFocusOut: true }); if (value !== undefined) { await secrets.set(name, value); void vscode.window.showInformationMessage(vscode.l10n.t('TurnStage secret "{name}" was stored.', { name })); } });
  command('removeSecret', async () => { if (!requireWorkspaceTrust()) return; const name = await vscode.window.showQuickPick(secrets.names(), { title: vscode.l10n.t('TurnStage: Remove Secret') }); const removeLabel = vscode.l10n.t('Remove'); if (name && await vscode.window.showWarningMessage(vscode.l10n.t('Remove TurnStage secret "{name}"?', { name }), { modal: true }, removeLabel) === removeLabel) await secrets.remove(name); });
  command('listSecretNames', () => { if (!requireWorkspaceTrust()) return; return vscode.window.showQuickPick(secrets.names(), { title: vscode.l10n.t('TurnStage Secret Names'), placeHolder: vscode.l10n.t('Secret values are never displayed') }); });
  command('replayRun', async () => vscode.window.showInformationMessage(vscode.l10n.t('Open a profile’s Test section and use Debug → Runs to select a recorded run.')));
  command('exportRun', async () => vscode.window.showInformationMessage(vscode.l10n.t('Open a profile’s Test section and export a run from Debug → Runs.')));
  command('openOutput', () => output.show(true));
  command('migrateProfile', async (item?: ProfileTreeItem | vscode.Uri) => { if (!requireWorkspaceTrust()) return; const uri = asUri(item); if (!uri) return; const document = await vscode.workspace.openTextDocument(uri); const result = new ProfileMigrator().migrate(document.getText()); if (!result.changed) { void vscode.window.showInformationMessage(vscode.l10n.t('This TurnStage profile is already current.')); return; } const migrateLabel = vscode.l10n.t('Migrate'); const confirmation = await vscode.window.showInformationMessage(vscode.l10n.t('Migrate profile from version {from} to {to}? A backup will be created.', { from: result.fromVersion, to: result.toVersion }), { modal: true, detail: result.notes.join('\n') }, migrateLabel); if (confirmation !== migrateLabel) return; const backup = uri.with({ path: `${uri.path}.v${result.fromVersion}.backup` }); await vscode.workspace.fs.writeFile(backup, new TextEncoder().encode(document.getText())); const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), result.text); await vscode.workspace.applyEdit(edit); await vscode.commands.executeCommand('vscode.diff', backup, uri, vscode.l10n.t('TurnStage Migration')); });
  output.appendLine(vscode.l10n.t('TurnStage activated in {host}.', { host: vscode.env.remoteName ?? vscode.l10n.t('Local Extension Host') }));
}

export function deactivate(): void {}

function requireWorkspaceTrust(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showErrorMessage(vscode.l10n.t('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
  return false;
}

function canStartNetwork(openingMode: string | undefined): boolean {
  if (openingMode !== 'request' || vscode.workspace.isTrusted) return true;
  return requireWorkspaceTrust();
}

function asUri(value?: ProfileTreeItem | ProfileSectionTreeItem | vscode.Uri): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value instanceof ProfileSectionTreeItem) return value.profileUri;
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

async function openProfile(uri?: vscode.Uri): Promise<void> { if (!uri) { const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [vscode.l10n.t('TurnStage Profiles')]: ['jsonc'] } }); uri = selected?.[0]; } if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor'); }

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { void vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder before importing a TurnStage profile.')); return undefined; }
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Select the workspace folder for the imported profile') });
}

async function initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) { void vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder before initializing TurnStage.')); return; }
  const choice = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Basic SSE Chat'), files: ['basic-sse-chat.turnstage.jsonc'] },
    { label: vscode.l10n.t('Agent Flow'), files: ['agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Both Starter Profiles'), files: ['basic-sse-chat.turnstage.jsonc', 'agent-flow.turnstage.jsonc'] },
    { label: vscode.l10n.t('Empty Profile'), files: ['empty.turnstage.jsonc'] },
    { label: vscode.l10n.t('Profiles + Local Mock Server Example'), files: ['basic-sse-chat.turnstage.jsonc', 'agent-flow.turnstage.jsonc'], includeFixtures: true },
  ], { title: vscode.l10n.t('Initialize TurnStage'), placeHolder: vscode.l10n.t('Choose starter content') }); if (!choice) return;
  const root = vscode.Uri.joinPath(folder.uri, '.vscode', 'turnstage'); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'profiles')); await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'environments'));
  for (const file of choice.files) { if (file === 'empty.turnstage.jsonc') { await writeSafe(vscode.Uri.joinPath(root, 'profiles', file), new TextEncoder().encode(emptyProfile('empty')), true); continue; } const source = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', file); await writeSafe(vscode.Uri.joinPath(root, 'profiles', file), await vscode.workspace.fs.readFile(source)); }
  const environment = vscode.Uri.joinPath(context.extensionUri, 'resources', 'templates', 'local.environment.jsonc'); await writeSafe(vscode.Uri.joinPath(root, 'environments', 'local.environment.jsonc'), await vscode.workspace.fs.readFile(environment));
  if (choice.includeFixtures) { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'fixtures')); for (const file of ['basic-sse-chat.jsonl', 'agent-flow.jsonl']) await writeSafe(vscode.Uri.joinPath(root, 'fixtures', file), await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'fixtures', file))); }
  void vscode.window.showInformationMessage(vscode.l10n.t('TurnStage workspace initialized. No existing file was overwritten without confirmation.'));
}

async function writeSafe(target: vscode.Uri, bytes: Uint8Array, silentNew = false): Promise<void> {
  try { await vscode.workspace.fs.stat(target); const skipLabel = vscode.l10n.t('Skip'); const copyLabel = vscode.l10n.t('Create Copy'); const replaceLabel = vscode.l10n.t('Replace'); const action = await vscode.window.showQuickPick([skipLabel, copyLabel, replaceLabel], { title: vscode.l10n.t('{path} already exists', { path: vscode.workspace.asRelativePath(target) }) }); if (!action || action === skipLabel) return; if (action === copyLabel) target = await duplicateUri(target); else if (await vscode.window.showWarningMessage(vscode.l10n.t('Replace {path}?', { path: vscode.workspace.asRelativePath(target) }), { modal: true }, replaceLabel) !== replaceLabel) return; } catch { /* target is new */ }
  await vscode.workspace.fs.writeFile(target, bytes); if (!silentNew) return;
}
async function duplicateUri(uri: vscode.Uri): Promise<vscode.Uri> { const match = uri.path.match(/^(.*?)(\.[^.]+\.[^.]+)$/) ?? uri.path.match(/^(.*?)(\.[^.]+)$/); const base = match?.[1] ?? uri.path; const suffix = match?.[2] ?? ''; for (let index = 2; index < 1000; index++) { const candidate = uri.with({ path: `${base}-${index}${suffix}` }); try { await vscode.workspace.fs.stat(candidate); } catch { return candidate; } } throw new Error(vscode.l10n.t('Could not create a duplicate-safe filename.')); }
async function createEmptyProfile(): Promise<vscode.Uri | undefined> { const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) return; const id = await vscode.window.showInputBox({ title: vscode.l10n.t('Create TurnStage Profile'), prompt: vscode.l10n.t('Profile id'), value: 'sample-profile', validateInput: (value) => /^[a-z0-9][a-z0-9-]*$/.test(value) ? undefined : vscode.l10n.t('Use lowercase letters, numbers, and hyphens.') }); if (!id) return; const directory = vscode.Uri.joinPath(folder.uri, '.vscode', 'turnstage', 'profiles'); await vscode.workspace.fs.createDirectory(directory); const uri = await duplicateIfExists(vscode.Uri.joinPath(directory, `${id}.turnstage.jsonc`)); await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(emptyProfile(id))); return uri; }
async function duplicateIfExists(uri: vscode.Uri): Promise<vscode.Uri> { try { await vscode.workspace.fs.stat(uri); return duplicateUri(uri); } catch { return uri; } }
function emptyProfile(id: string): string { return JSON.stringify({ version: 1, id, name: id.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' '), environment: 'local', opening: { mode: 'static', message: vscode.l10n.t('Hello, I am a test assistant. What would you like to test?'), starters: [] }, conversation: { send: { method: 'POST', url: '${env.baseUrl}/basic/chat/stream', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, variants: [{ id: 'first-turn', when: { path: 'conversation.id', operator: 'notExists' }, body: { message: { $value: 'input.text' } } }, { id: 'continuation', when: { path: 'conversation.id', operator: 'exists' }, body: { message: { $value: 'input.text' }, conversationId: { $value: 'conversation.id' } } }] } }, stream: { transport: 'sse', dataFormat: 'json', mappingMode: 'firstMatch', unexpectedEndPolicy: 'fail', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] } }, null, 2); }

async function validateUri(uri: vscode.Uri | undefined, collection: vscode.DiagnosticCollection): Promise<void> { if (!uri) return; const document = await vscode.workspace.openTextDocument(uri); const codec = new ProfileCodec(); const parsed = codec.parse(document.getText()); const issues = new ProfileValidator().validate(parsed.profile, parsed.tree); collection.set(uri, issues.map((item) => new vscode.Diagnostic(new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.message, item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning))); void vscode.window.showInformationMessage(issues.length === 0 ? vscode.l10n.t('TurnStage profile is valid.') : issues.length === 1 ? vscode.l10n.t('TurnStage found {count} issue.', { count: issues.length }) : vscode.l10n.t('TurnStage found {count} issues.', { count: issues.length })); }
async function selectEnvironment(uri: vscode.Uri): Promise<void> { const document = await vscode.workspace.openTextDocument(uri); const envUris = await vscode.workspace.findFiles('**/.vscode/turnstage/environments/*.environment.jsonc', '**/{node_modules,.git}/**', 100); const codec = new ProfileCodec(); const entries = await Promise.all(envUris.map(async (envUri) => ({ uri: envUri, profile: codec.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(envUri))).profile }))); const picked = await vscode.window.showQuickPick(entries.filter((item) => item.profile).map((item) => ({ label: item.profile!.name, description: item.profile!.id })), { title: vscode.l10n.t('Select TurnStage Environment') }); if (!picked?.description) return; const edits = (await import('jsonc-parser')).modify(document.getText(), ['environment'], picked.description, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); const workspaceEdit = new vscode.WorkspaceEdit(); for (const item of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(uri, new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)), item.content); await vscode.workspace.applyEdit(workspaceEdit); }
