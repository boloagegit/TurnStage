import * as vscode from 'vscode';
import { modify } from 'jsonc-parser';
import type { HostPayload, WebviewMessage, WorkspaceSection } from '../../shared/protocol';
import { isWebviewMessage, PROTOCOL_VERSION } from '../../shared/protocol';
import type { RawStreamEvent, TurnStageEnvironment } from '../../shared/types';
import { EnvironmentRepository } from '../config/profileRepository';
import { ProfileCodec } from '../config/profileCodec';
import { ProfileValidator } from '../config/profileValidator';
import { LocalRunRepository, type LocalRunImportResult } from '../history/localRunRepository';
import { SecretService, UriPolicy } from '../security/security';
import { isActive, SessionController } from '../runtime/sessionController';
import { MappingEngine } from '../mapping/mappingEngine';
import { localize } from '../l10n';
import { validateFormSubmission } from './formSubmission';
import { resolveDisplayLanguage, textDirection } from '../displayLanguage';
import { profileEditorTitle } from './profileEditorTitle';
import { EventBatcher } from '../runtime/eventBatcher';
import { logAt } from '../logging';
import { decodeChatScreenshot, normalizeScreenshotFileName } from './chatScreenshot';

const DOCUMENT_CHANGE_DEBOUNCE_MS = 150;

export class TurnStageEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();
  private readonly runs: LocalRunRepository;
  private readonly secrets: SecretService;
  private readonly uriPolicy = new UriPolicy();
  private readonly controllers = new Map<string, SessionController>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly sectionPosters = new Map<string, Set<(section: WorkspaceSection) => Thenable<boolean>>>();
  private readonly pendingSections = new Map<string, WorkspaceSection>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly diagnostics: vscode.DiagnosticCollection, private readonly output: vscode.OutputChannel, private readonly environments = new EnvironmentRepository(context.globalStorageUri)) { this.runs = new LocalRunRepository(context); this.secrets = new SecretService(context); }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const resourceTitle = panel.title;
    // Set the semantic title before the first asynchronous operation. Older VS
    // Code releases can paint the backing JSONC filename as soon as the custom
    // editor resolves, so waiting for environment discovery causes a visible
    // and test-observable title race.
    panel.title = profileEditorTitle(this.codec.parse(document.getText()).profile?.name, resourceTitle);
    const instanceId = crypto.randomUUID(); panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] }; panel.webview.html = this.html(panel.webview, instanceId);
    let controller: SessionController | undefined; let documentVersion = -1; let loadTimer: ReturnType<typeof setTimeout> | undefined; let disposed = false;
    let profileSnapshot: Extract<HostPayload, { type: 'profile.snapshot' }> | undefined;
    let validationSnapshot: Extract<HostPayload, { type: 'profile.validation' }> | undefined;
    const post = (message: HostPayload, requestId: string = crypto.randomUUID()) => panel.webview.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId });
    const documentKey = document.uri.toString();
    const postSection = (section: WorkspaceSection) => post({ type: 'workspace.section', section });
    const posters = this.sectionPosters.get(documentKey) ?? new Set<(section: WorkspaceSection) => Thenable<boolean>>();
    posters.add(postSection);
    this.sectionPosters.set(documentKey, posters);
    const disposeController = () => {
      const current = controller;
      controller = undefined;
      if (current) this.trackDisposal(current.disposeAndWait());
      if (current && this.controllers.get(documentKey) === current) this.controllers.delete(documentKey);
    };
    const currentSessionSnapshot = (): Extract<HostPayload, { type: 'session.snapshot' }> | undefined => controller ? { type: 'session.snapshot', snapshot: controller.snapshot, runs: controller.getRunSummaries(), requestPreview: controller.requestPreview } : undefined;
    const sessionBatcher = new EventBatcher<void>(() => {
      if (disposed) return;
      const snapshot = currentSessionSnapshot();
      if (snapshot) void post(snapshot);
    }, vscode.workspace.getConfiguration('turnstage').get('streamBatchIntervalMs', 32), 50);
    const syncTurnActiveContext = () => {
      if (panel.active) void vscode.commands.executeCommand('setContext', 'turnstage.turnActive', Boolean(controller && isActive(controller.snapshot.turnState)));
    };
    const sendSession = (immediate = false) => { if (controller) sessionBatcher.add(undefined, immediate); syncTurnActiveContext(); };
    const load = async () => {
      if (disposed || (documentVersion === document.version && controller)) return;
      const version = document.version;
      documentVersion = version; const parsed = this.codec.parse(document.getText()); const envEntries = await this.environments.discover(document.uri); if (disposed || document.version !== version) return; const issues = this.validator.validate(parsed.profile, parsed.tree, envEntries.map((item) => item.environment)); this.publishDiagnostics(document, issues);
      panel.title = profileEditorTitle(parsed.profile?.name, resourceTitle);
      profileSnapshot = { type: 'profile.snapshot', profile: parsed.profile, parseError: parsed.errors.length ? localize('Invalid JSONC') : undefined, version: document.version, environments: envEntries.map((item) => item.environment.id) };
      validationSnapshot = { type: 'profile.validation', diagnostics: issues };
      logAt(this.output, 'debug', `[profile] loaded ${parsed.profile?.id ?? document.uri.toString()} at document version ${version}`);
      await post(profileSnapshot);
      await post(validationSnapshot);
      if (disposed || document.version !== version) return;
      if (!parsed.profile || issues.some((item) => item.severity === 'error')) { disposeController(); return; }
      if (!controller || controller.profile !== parsed.profile) {
        disposeController(); const environment = envEntries.find((item) => item.environment.id === parsed.profile!.environment)?.environment ?? builtInEnvironment();
        const nextController = new SessionController(parsed.profile, document.uri, environment, this.context, this.secrets, this.runs, sendSession, this.output); await nextController.loadRuns();
        if (disposed || document.version !== version) { nextController.dispose(); return; }
        controller = nextController;
        syncTurnActiveContext();
        if (document.uri.scheme === 'turnstage-demo' || parsed.profile.stream.transport === 'fixture') {
          const folder = vscode.workspace.getWorkspaceFolder(document.uri);
          const fixtureUri = document.uri.scheme === 'turnstage-demo'
            ? vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'fixtures', `${parsed.profile.id}.jsonl`)
            : folder ? vscode.Uri.joinPath(folder.uri, '.vscode', 'turnstage', 'fixtures', `${parsed.profile.id}.jsonl`) : undefined;
          if (!fixtureUri) logAt(this.output, 'warn', `[fixture] profile ${parsed.profile.id} is not inside a workspace folder`);
          else try { const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(fixtureUri)).trim().split(/\r?\n/); const startedAt = Date.now(); controller.addBuiltInFixture(lines.map((line, index) => { const item = JSON.parse(line) as { event: string; data: unknown; delayMs?: number }; return { sequence: index + 1, receivedAt: startedAt + (item.delayMs ?? 0), elapsedMs: item.delayMs ?? 0, protocol: 'fixture' as const, sse: { event: item.event }, raw: JSON.stringify(item.data), data: item.data }; })); } catch (error) { logAt(this.output, 'error', `[fixture] ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (parsed.profile.opening?.mode === 'static') await controller.startSession(); else sendSession();
        if (disposed || document.version !== version) { disposeController(); return; }
        this.controllers.set(document.uri.toString(), controller);
      }
    };
    const rehydrate = async () => {
      if (disposed) return;
      if (documentVersion !== document.version || !profileSnapshot || !validationSnapshot) { await load(); return; }
      await post(profileSnapshot);
      await post(validationSnapshot);
      const sessionSnapshot = currentSessionSnapshot();
      if (sessionSnapshot) await post(sessionSnapshot);
    };
    const scheduleLoad = () => { if (loadTimer) clearTimeout(loadTimer); loadTimer = setTimeout(() => { loadTimer = undefined; void load().catch((error) => logAt(this.output, 'error', `[editor] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)); }, DOCUMENT_CHANGE_DEBOUNCE_MS); };
    const documentListener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document.uri.toString() === document.uri.toString()) scheduleLoad(); });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => { if (controller) controller.snapshot.trusted = true; void post({ type: 'workspaceTrust.changed', trusted: true }); sendSession(); });
    const postHostReady = (requestId?: string) => {
      const locale = configuredLocale();
      return post({ type: 'host.ready', trusted: vscode.workspace.isTrusted, remoteName: vscode.env.remoteName, locale, direction: textDirection(locale) }, requestId);
    };
    const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('turnstage.displayLanguage')) void postHostReady();
    });
    const viewStateListener = panel.onDidChangeViewState(syncTurnActiveContext);
    const messageListener = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (!isWebviewMessage(raw, instanceId)) return; const message = raw as WebviewMessage;
      try {
        if (message.type === 'webview.ready') { await postHostReady(message.requestId); await postSection(this.pendingSections.get(documentKey) ?? 'test'); await rehydrate(); return; }
        if (message.type === 'profile.openAsText') { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return; }
        if (message.type === 'profile.validate') {
          documentVersion = -1;
          await load();
          await post({ type: 'profile.validated', valid: validationSnapshot?.diagnostics.length === 0 }, message.requestId);
          return;
        }
        if (message.type === 'profile.patch') { await this.patchDocument(document, message.path, message.value); return; }
        if (message.type === 'output.open') { this.output.show(true); return; }
        if (message.type === 'chat.screenshot.save') {
          const uri = await this.saveChatScreenshot(message.dataUrl, message.suggestedName, document.uri);
          if (uri) await post({ type: 'chat.screenshot.saved', path: uri.toString() }, message.requestId);
          return;
        }
        if (!controller) return;
        switch (message.type) {
          case 'mapping.test': {
            const sample = message.event;
            const rawEvent: RawStreamEvent = {
              sequence: 1,
              receivedAt: Date.now(),
              elapsedMs: 0,
              protocol: sample.protocol,
              sse: sample.eventName ? { event: sample.eventName } : undefined,
              raw: sample.raw,
              data: sample.data
            };
            const result = new MappingEngine(controller.profile.stream).map(rawEvent);
            await post({ type: 'mapping.test.result', result: { ruleIds: result.ruleIds, normalized: result.events, errors: result.errors } }, message.requestId);
            break;
          }
          case 'control.set': await controller.setControl(message.controlId, message.value); break;
          case 'session.start': await controller.startSession(); break;
          case 'opening.retry': await controller.retryOpening(); break;
          case 'opening.useFallback': controller.useConfiguredOpeningFallback(); break;
          case 'request.send': await controller.send(message.text, message.interaction); break;
          case 'request.abort': await controller.abort(); break;
          case 'conversation.new': await controller.newConversation(); break;
          case 'conversation.clear': controller.clearConversation(); break;
          case 'history.remote.apply': controller.applyRemoteSession(message.conversationId); break;
          case 'citation.open': { const citation = controller.snapshot.messages.flatMap((item) => item.citations).find((item) => item.id === message.citationId); if (citation) await this.uriPolicy.open(citation, controller.profile, controller.profileUri); break; }
          case 'uri.open': await this.uriPolicy.open({ id: `markdown-link-${message.requestId}`, kind: 'url', uri: message.uri }, controller.profile, controller.profileUri); break;
          case 'action.invoke': await this.invokeAction(message.actionId, message.sourceMessageId, controller); break;
          case 'form.submit': {
            const submission = validateFormSubmission(controller.snapshot.messages, message.formId, message.sourceMessageId, message.values);
            const previousTurnState = controller.snapshot.turnState;
            const sending = controller.send(submission.form.submit.messageTemplate, { kind: 'formSubmit', formId: message.formId, formValues: submission.values, sourceMessageId: message.sourceMessageId });
            if (controller.snapshot.turnState !== previousTurnState) await post({ type: 'form.accepted', formId: message.formId, sourceMessageId: message.sourceMessageId }, message.requestId);
            await sending;
            break;
          }
          case 'run.replay.play': {
            const result = controller.replay(message.runId, message.speed);
            if (result === 'active') throw new Error(localize('Finish or stop the current request before replaying another run.'));
            if (result === 'unavailable') throw new Error(localize('This run cannot be replayed because raw events were not recorded.'));
            if (result === 'notFound') throw new Error(localize('The selected run is no longer available.'));
            break;
          }
          case 'run.replay.pause': controller.pauseReplay(); break;
          case 'run.replay.resume': await controller.resumeReplay(); break;
          case 'run.replay.stop': await controller.stopReplay(); break;
          case 'run.replay.step': await controller.stepReplay(); break;
          case 'run.replay.speed': controller.setReplaySpeed(message.speed); break;
          case 'run.import': {
            if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
            const imported = await controller.importRun();
            if (imported) await post({ type: 'run.imported', path: imported.uri.toString(), runId: imported.run.id, duplicate: imported.duplicate }, message.requestId);
            break;
          }
          case 'run.export': { if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.')); const run = controller.getRuns().find((item) => item.id === message.runId); if (run) { const uri = await this.runs.export(run); if (uri) await post({ type: 'run.exported', path: uri.toString() }, message.requestId); } break; }
          case 'form.cancel': break;
        }
      } catch (error) { logAt(this.output, 'error', `[editor] ${error instanceof Error ? error.stack ?? error.message : String(error)}`); await post({ type: 'request.error', error: { type: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }, message.requestId); }
    });
    panel.onDidDispose(() => { disposed = true; sessionBatcher.dispose(); if (loadTimer) clearTimeout(loadTimer); disposeController(); posters.delete(postSection); if (!posters.size) { this.sectionPosters.delete(documentKey); this.pendingSections.delete(documentKey); } documentListener.dispose(); trustListener.dispose(); configurationListener.dispose(); viewStateListener.dispose(); messageListener.dispose(); });
  }

  getController(uri?: vscode.Uri): SessionController | undefined { return uri ? this.controllers.get(uri.toString()) : [...this.controllers.values()].at(-1); }
  async drainPending(): Promise<void> {
    await Promise.allSettled([...this.pendingDisposals, ...[...this.controllers.values()].map((controller) => controller.disposeAndWait())]);
  }
  async waitForController(uri: vscode.Uri, timeoutMs = 5000): Promise<SessionController | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const controller = this.getController(uri);
      if (controller) return controller;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return this.getController(uri);
  }
  async replayRun(uri: vscode.Uri, runId?: string): Promise<'started' | 'active' | 'notFound' | 'unavailable'> {
    const controller = await this.waitForController(uri);
    const run = controller?.getRuns().find((item) => item.id === runId) ?? controller?.getRuns()[0];
    if (!controller || !run) return 'notFound';
    return controller.replay(run.id);
  }
  async importRun(uri: vscode.Uri): Promise<LocalRunImportResult | undefined> {
    const controller = await this.waitForController(uri);
    return controller?.importRun();
  }
  async exportRun(uri: vscode.Uri, runId?: string): Promise<vscode.Uri | undefined> {
    const controller = await this.waitForController(uri);
    const run = controller?.getRuns().find((item) => item.id === runId) ?? controller?.getRuns()[0];
    return run ? this.runs.export(run) : undefined;
  }
  async showSection(uri: vscode.Uri, section: WorkspaceSection): Promise<void> {
    const key = uri.toString();
    this.pendingSections.set(key, section);
    await Promise.all([...(this.sectionPosters.get(key) ?? [])].map((postSection) => postSection(section)));
  }
  private async patchDocument(document: vscode.TextDocument, path: Array<string | number>, value: unknown): Promise<void> {
    if (!isAllowedPatchPath(path)) throw new Error(localize('This profile setting cannot be edited from the configuration surface.'));
    const edits = modify(document.getText(), path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); const workspaceEdit = new vscode.WorkspaceEdit(); for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.content); await vscode.workspace.applyEdit(workspaceEdit);
  }
  private async saveChatScreenshot(dataUrl: string, suggestedName: string, profileUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    let bytes: Uint8Array;
    try { bytes = decodeChatScreenshot(dataUrl); }
    catch { throw new Error(localize('Unable to save the chat screenshot.')); }
    const fileName = normalizeScreenshotFileName(suggestedName);
    const folder = vscode.workspace.getWorkspaceFolder(profileUri) ?? vscode.workspace.workspaceFolders?.[0];
    const uri = await vscode.window.showSaveDialog({
      title: localize('Save chat screenshot'),
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined,
      filters: { [localize('PNG image')]: ['png'] },
      saveLabel: localize('Save screenshot')
    });
    if (!uri) return undefined;
    await vscode.workspace.fs.writeFile(uri, bytes);
    void vscode.window.showInformationMessage(localize('Chat screenshot saved.'));
    return uri;
  }
  private trackDisposal(promise: Promise<void>): void {
    this.pendingDisposals.add(promise);
    void promise.finally(() => this.pendingDisposals.delete(promise));
  }
  private publishDiagnostics(document: vscode.TextDocument, issues: ReturnType<ProfileValidator['validate']>): void { this.diagnostics.set(document.uri, issues.map((issue) => { const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(issue.offset), document.positionAt(issue.offset + issue.length)), issue.message, issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning); diagnostic.source = 'TurnStage'; return diagnostic; })); }
  private async invokeAction(actionId: string, sourceMessageId: string | undefined, controller: SessionController): Promise<void> {
    const message = sourceMessageId ? controller.snapshot.messages.find((item) => item.id === sourceMessageId) : undefined;
    if (actionId === 'message.copy' && message) { await vscode.env.clipboard.writeText(message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('')); return; }
    if (actionId === 'message.retry') { await controller.retry(); return; }
    if (actionId === 'request.abort') { await controller.abort(); return; }
    if (actionId === 'conversation.new') { await controller.newConversation(); return; }
    if (actionId === 'conversation.clear') { controller.clearConversation(); return; }
    const action = message?.actions.find((item) => item.id === actionId || item.actionId === actionId);
    if (!action) throw new Error(localize('The selected response action is no longer available.'));
    if (action.confirm) {
      const confirmLabel = localize('Continue');
      const confirmed = await vscode.window.showWarningMessage(action.confirm.title, { modal: true, detail: action.confirm.message }, confirmLabel);
      if (confirmed !== confirmLabel) return;
    }
    const payload = action.payload ?? {};
    const payloadText = [payload.text, payload.prompt, payload.message].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (action.actionId === 'request.send' || action.actionId === 'request.resend' || action.actionId === 'followup.send') {
      const lastUserText = [...controller.snapshot.messages].reverse().find((item) => item.role === 'user')?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text ?? '').join('');
      const text = payloadText ?? lastUserText;
      if (!text) throw new Error(localize('This action does not provide a message to send.'));
      await controller.send(text, { kind: 'responseAction', actionId: action.id, actionKey: typeof payload.interactionKey === 'string' ? payload.interactionKey : action.actionId, sourceMessageId });
      return;
    }
    if (action.actionId === 'request.abort') { await controller.abort(); return; }
    if (action.actionId === 'conversation.new') { await controller.newConversation(); return; }
    if (action.actionId === 'conversation.clear') { controller.clearConversation(); return; }
    if (action.actionId === 'citation.open') {
      const citationId = typeof payload.citationId === 'string' ? payload.citationId : undefined;
      const citation = message?.citations.find((item) => item.id === citationId);
      if (!citation) throw new Error(localize('The selected citation is no longer available.'));
      await this.uriPolicy.open(citation, controller.profile, controller.profileUri);
      return;
    }
    if (action.actionId === 'uri.open') {
      const citation = typeof payload.uri === 'string'
        ? { id: `action-${action.id}`, kind: 'url' as const, uri: payload.uri }
        : typeof payload.path === 'string' ? { id: `action-${action.id}`, kind: 'file' as const, path: payload.path } : undefined;
      if (!citation) throw new Error(localize('This action does not provide a URI or workspace file path.'));
      await this.uriPolicy.open(citation, controller.profile, controller.profileUri);
      return;
    }
    if (action.actionId === 'run.export') {
      const requestedRunId = typeof payload.runId === 'string' ? payload.runId : undefined;
      const run = controller.getRuns().find((item) => item.id === requestedRunId) ?? controller.getRuns()[0];
      if (!run) throw new Error(localize('There is no recorded run to export.'));
      await this.runs.export(run);
      return;
    }
    const allowed = controller.profile.security?.allowedCommands ?? [];
    if (action?.actionId.startsWith('vscodeCommand.invoke:')) { if (!vscode.workspace.isTrusted) throw new Error(localize('Profile commands are disabled in untrusted workspaces.')); const command = action.actionId.slice('vscodeCommand.invoke:'.length); if (!allowed.includes(command)) throw new Error(localize('Command {command} is not allowlisted.', { command })); await vscode.commands.executeCommand(command); return; }
    if (action.actionId === 'message.retry') { await controller.retry(); return; }
    if (['input.fill', 'event.inspect', 'form.open', 'form.submit', 'form.cancel'].includes(action.actionId)) return;
    throw new Error(localize('This response action is not supported: {action}.', { action: action.actionId }));
  }
  private html(webview: vscode.Webview, instanceId: string): string { const nonce = crypto.randomUUID().replace(/-/g, ''); const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')); const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')); const locale = configuredLocale(); const direction = textDirection(locale); return `<!doctype html><html lang="${locale}" dir="${direction}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"><title>TurnStage</title></head><body><div id="root" data-instance-id="${instanceId}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`; }
}

function configuredLocale(): string {
  return resolveDisplayLanguage(vscode.workspace.getConfiguration('turnstage').get('displayLanguage', 'auto'), vscode.env.language);
}

export function isAllowedPatchPath(path: unknown): path is Array<string | number> {
  if (!Array.isArray(path) || !path.length || !path.every((part) => (typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part) && part >= 0)) && part !== '__proto__' && part !== 'prototype' && part !== 'constructor')) return false;
  const key = path.join('.');
  if (key === 'name' || key === 'description' || key === 'environment' || key === 'opening.mode' || key === 'opening.message' || key === 'opening.trigger' || key === 'opening.starters' || key === 'opening.request' || key === 'opening.response' || key === 'opening.fallbacks' || key === 'opening.failurePolicy' || key === 'conversation.send.method' || key === 'conversation.send.url' || key === 'conversation.send.variants' || key === 'conversation.send.timeoutMs' || key === 'conversation.send.idleTimeoutMs' || key === 'conversation.send.headers' || key === 'conversation.send.body' || key === 'conversation.stop.strategy' || key === 'conversation.stop.request' || key === 'conversation.stop.requiredContext' || key === 'stream.transport' || key === 'stream.dataFormat' || key === 'stream.doneValue' || key === 'stream.mappingMode' || key === 'stream.unexpectedEndPolicy' || key === 'stream.mappings' || key === 'history.remoteSessions' || key === 'metrics.enabled' || key === 'metrics.messageEnabled' || key === 'security.allowedUriSchemes' || key === 'security.allowedDomains' || key === 'security.allowedCommands' || key === 'ui.messageActions' || key === 'ui.messageActionVisibility') return true;
  if (/^conversation\.send\.variants\.\d+\.(id|body|headers)$/.test(key)) return true;
  if (/^conversation\.send\.variants\.\d+\.when\.(path|operator|value)$/.test(key)) return true;
  if (/^conversation\.send\.reconnect\.(maxAttempts|baseDelayMs|maxDelayMs|retryOnStatuses)$/.test(key)) return true;
  if (/^conversation\.send\.(redirectPolicy|maxRedirects)$/.test(key)) return true;
  if (/^conversation\.stop\.(preservePartialContent|appendSystemNotice)$/.test(key)) return true;
  if (/^conversation\.stop\.request\.(method|url|headers|body)$/.test(key)) return true;
  if (/^errorPolicy\.(preservePartialContent|showErrorPart|keepConversationId|allowContinuation|releaseAllLocks)$/.test(key)) return true;
  if (/^history\.localRuns\.(enabled|maxRuns|recordRawEvents|recordNormalizedEvents|recordChatSnapshot)$/.test(key)) return true;
  if (/^stream\.mappings\.\d+\.(id|continue|emit)$/.test(key)) return true;
  if (/^stream\.mappings\.\d+\.match\.(event|path|operator|value)$/.test(key)) return true;
  if (/^ui\.layout\.(preset|inspectorPosition|inspectorWidth)$/.test(key)) return true;
  if (/^ui\.composer\.(placeholder|multiline|enterBehavior|shiftEnterBehavior|showStopWhileStreaming)$/.test(key)) return true;
  if (/^ui\.streaming\.(effect|speedMs|intensityPercent)$/.test(key)) return true;
  if (/^ui\.components\.[a-zA-Z0-9_-]+\.(visible|label|collapsible|defaultCollapsed)$/.test(key)) return true;
  return /^ui\.locks\.whileTurnActive\.(disable|allow)$/.test(key);
}

function builtInEnvironment(): TurnStageEnvironment { return { version: 1, id: 'local', name: 'Local Mock Server', variables: { baseUrl: 'http://127.0.0.1:8787' }, secretReferences: { apiToken: 'local-api-token' } }; }
