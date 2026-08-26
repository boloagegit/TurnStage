import * as vscode from 'vscode';
import { modify } from 'jsonc-parser';
import type { HostPayload, WebviewMessage, WorkspaceSection } from '../../shared/protocol';
import { isWebviewMessage, PROTOCOL_VERSION } from '../../shared/protocol';
import type { FormDefinition, RawStreamEvent, TurnStageEnvironment } from '../../shared/types';
import { EnvironmentRepository } from '../config/profileRepository';
import { ProfileCodec } from '../config/profileCodec';
import { ProfileValidator } from '../config/profileValidator';
import { LocalRunRepository } from '../history/localRunRepository';
import { SecretService, UriPolicy } from '../security/security';
import { SessionController } from '../runtime/sessionController';
import { MappingEngine } from '../mapping/mappingEngine';
import { localize } from '../l10n';

export class TurnStageEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();
  private readonly environments = new EnvironmentRepository();
  private readonly runs: LocalRunRepository;
  private readonly secrets: SecretService;
  private readonly uriPolicy = new UriPolicy();
  private readonly controllers = new Map<string, SessionController>();
  private readonly sectionPosters = new Map<string, Set<(section: WorkspaceSection) => Thenable<boolean>>>();
  private readonly pendingSections = new Map<string, WorkspaceSection>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly diagnostics: vscode.DiagnosticCollection, private readonly output: vscode.OutputChannel) { this.runs = new LocalRunRepository(context); this.secrets = new SecretService(context); }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const instanceId = crypto.randomUUID(); panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] }; panel.webview.html = this.html(panel.webview, instanceId);
    let controller: SessionController | undefined; let documentVersion = -1; let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const post = (message: HostPayload, requestId: string = crypto.randomUUID()) => panel.webview.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId });
    const documentKey = document.uri.toString();
    const postSection = (section: WorkspaceSection) => post({ type: 'workspace.section', section });
    const posters = this.sectionPosters.get(documentKey) ?? new Set<(section: WorkspaceSection) => Thenable<boolean>>();
    posters.add(postSection);
    this.sectionPosters.set(documentKey, posters);
    const sendSession = (immediate = false) => { if (!controller) return; if (sendTimer) clearTimeout(sendTimer); const publish = () => { sendTimer = undefined; void post({ type: 'session.snapshot', snapshot: controller!.snapshot, runs: controller!.getRuns(), requestPreview: controller!.requestPreview }); }; if (immediate) publish(); else sendTimer = setTimeout(publish, vscode.workspace.getConfiguration('turnstage').get('streamBatchIntervalMs', 32)); };
    const load = async () => {
      if (documentVersion === document.version && controller) return;
      documentVersion = document.version; const parsed = this.codec.parse(document.getText()); const envEntries = await this.environments.discover(document.uri); const issues = this.validator.validate(parsed.profile, parsed.tree, envEntries.map((item) => item.environment)); this.publishDiagnostics(document, issues);
      await post({ type: 'profile.snapshot', profile: parsed.profile, parseError: parsed.errors.length ? localize('Invalid JSONC') : undefined, version: document.version, environments: envEntries.map((item) => item.environment.id) });
      await post({ type: 'profile.validation', diagnostics: issues });
      if (!parsed.profile || issues.some((item) => item.severity === 'error')) return;
      if (!controller || controller.profile !== parsed.profile) {
        controller?.dispose(); const environment = envEntries.find((item) => item.environment.id === parsed.profile!.environment)?.environment ?? builtInEnvironment();
        controller = new SessionController(parsed.profile, document.uri, environment, this.context, this.secrets, this.runs, sendSession, this.output); this.controllers.set(document.uri.toString(), controller); await controller.loadRuns();
        if (document.uri.scheme === 'turnstage-demo') {
          const fixtureUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'fixtures', `${parsed.profile.id}.jsonl`);
          try { const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(fixtureUri)).trim().split(/\r?\n/); const startedAt = Date.now(); controller.addBuiltInFixture(lines.map((line, index) => { const item = JSON.parse(line) as { event: string; data: unknown; delayMs?: number }; return { sequence: index + 1, receivedAt: startedAt + (item.delayMs ?? 0), elapsedMs: item.delayMs ?? 0, protocol: 'fixture' as const, sse: { event: item.event }, raw: JSON.stringify(item.data), data: item.data }; })); } catch (error) { this.output.appendLine(`[fixture] ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (parsed.profile.opening?.mode === 'static') await controller.startSession(); else sendSession();
      }
    };
    const documentListener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document.uri.toString() === document.uri.toString()) void load(); });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => { if (controller) controller.snapshot.trusted = true; void post({ type: 'workspaceTrust.changed', trusted: true }); sendSession(); });
    const messageListener = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (!isWebviewMessage(raw, instanceId)) return; const message = raw as WebviewMessage;
      try {
        if (message.type === 'webview.ready') { await post({ type: 'host.ready', trusted: vscode.workspace.isTrusted, remoteName: vscode.env.remoteName, locale: vscode.env.language, direction: textDirection(vscode.env.language) }, message.requestId); await postSection(this.pendingSections.get(documentKey) ?? 'test'); await load(); return; }
        if (message.type === 'profile.openAsText') { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return; }
        if (message.type === 'profile.validate') { documentVersion = -1; await load(); return; }
        if (message.type === 'profile.patch') { await this.patchDocument(document, message.path, message.value); return; }
        if (message.type === 'output.open') { this.output.show(true); return; }
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
          case 'action.invoke': await this.invokeAction(message.actionId, message.sourceMessageId, controller); break;
          case 'form.submit': { const form = this.findForm(controller, message.formId); if (form) await controller.send(form.submit.messageTemplate, { kind: 'formSubmit', formId: message.formId, formValues: message.values, sourceMessageId: message.sourceMessageId }); break; }
          case 'run.replay.play': await controller.replay(message.runId, message.speed); break;
          case 'run.replay.pause': controller.pauseReplay(); break;
          case 'run.replay.resume': await controller.resumeReplay(); break;
          case 'run.replay.stop': await controller.stopReplay(); break;
          case 'run.replay.step': await controller.stepReplay(); break;
          case 'run.replay.speed': controller.setReplaySpeed(message.speed); break;
          case 'run.export': { const run = controller.getRuns().find((item) => item.id === message.runId); if (run) { const uri = await this.runs.export(run); if (uri) await post({ type: 'run.exported', path: uri.toString() }, message.requestId); } break; }
          case 'form.cancel': break;
        }
      } catch (error) { this.output.appendLine(`[editor] ${error instanceof Error ? error.stack ?? error.message : String(error)}`); await post({ type: 'request.error', error: { type: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }, message.requestId); }
    });
    panel.onDidDispose(() => { if (sendTimer) clearTimeout(sendTimer); controller?.dispose(); this.controllers.delete(document.uri.toString()); posters.delete(postSection); if (!posters.size) this.sectionPosters.delete(documentKey); documentListener.dispose(); trustListener.dispose(); messageListener.dispose(); });
  }

  getController(uri?: vscode.Uri): SessionController | undefined { return uri ? this.controllers.get(uri.toString()) : [...this.controllers.values()].at(-1); }
  async showSection(uri: vscode.Uri, section: WorkspaceSection): Promise<void> {
    const key = uri.toString();
    this.pendingSections.set(key, section);
    await Promise.all([...(this.sectionPosters.get(key) ?? [])].map((postSection) => postSection(section)));
  }
  private async patchDocument(document: vscode.TextDocument, path: Array<string | number>, value: unknown): Promise<void> {
    if (!isAllowedPatchPath(path)) return;
    const edits = modify(document.getText(), path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); const workspaceEdit = new vscode.WorkspaceEdit(); for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.content); await vscode.workspace.applyEdit(workspaceEdit);
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
    const allowed = controller.profile.security?.allowedCommands ?? [];
    if (action?.actionId.startsWith('vscodeCommand.invoke:')) { if (!vscode.workspace.isTrusted) throw new Error(localize('Profile commands are disabled in untrusted workspaces.')); const command = action.actionId.slice('vscodeCommand.invoke:'.length); if (!allowed.includes(command)) throw new Error(localize('Command {command} is not allowlisted.', { command })); await vscode.commands.executeCommand(command); return; }
    if (action?.actionId === 'message.retry') await controller.retry();
  }
  private findForm(controller: SessionController, id: string): FormDefinition | undefined { for (const message of controller.snapshot.messages) for (const part of message.parts) if (part.type === 'form' && (part.form as FormDefinition | undefined)?.id === id) return part.form as FormDefinition; return; }
  private html(webview: vscode.Webview, instanceId: string): string { const nonce = crypto.randomUUID().replace(/-/g, ''); const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')); const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')); const locale = safeLocale(vscode.env.language); const direction = textDirection(locale); return `<!doctype html><html lang="${locale}" dir="${direction}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"><title>TurnStage</title></head><body><div id="root" data-instance-id="${instanceId}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`; }
}

function safeLocale(locale: string): string {
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale) ? locale : 'en';
}

function textDirection(locale: string): 'ltr' | 'rtl' {
  const language = locale.toLowerCase().split('-')[0] ?? '';
  return ['ar', 'fa', 'he', 'ps', 'ur'].includes(language) ? 'rtl' : 'ltr';
}

function isAllowedPatchPath(path: unknown): path is Array<string | number> {
  if (!Array.isArray(path) || !path.length || !path.every((part) => (typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part) && part >= 0)) && part !== '__proto__' && part !== 'prototype' && part !== 'constructor')) return false;
  const key = path.join('.');
  if (key === 'name' || key === 'description' || key === 'opening.mode' || key === 'opening.message' || key === 'opening.trigger' || key === 'conversation.send.method' || key === 'conversation.send.url' || key === 'conversation.send.variants' || key === 'conversation.stop.strategy' || key === 'conversation.stop.request' || key === 'conversation.stop.requiredContext' || key === 'stream.mappingMode' || key === 'stream.unexpectedEndPolicy' || key === 'stream.mappings') return true;
  if (/^conversation\.send\.variants\.\d+\.(id|body)$/.test(key)) return true;
  if (/^conversation\.send\.variants\.\d+\.when\.(path|operator|value)$/.test(key)) return true;
  if (/^conversation\.stop\.(preservePartialContent|appendSystemNotice)$/.test(key)) return true;
  if (/^conversation\.stop\.request\.(method|url|headers|body)$/.test(key)) return true;
  if (/^errorPolicy\.(preservePartialContent|showErrorPart|keepConversationId|allowContinuation|releaseAllLocks)$/.test(key)) return true;
  if (/^history\.localRuns\.(enabled|maxRuns|recordRawEvents|recordNormalizedEvents|recordChatSnapshot)$/.test(key)) return true;
  if (/^stream\.mappings\.\d+\.(id|continue|emit)$/.test(key)) return true;
  if (/^stream\.mappings\.\d+\.match\.(event|path|operator|value)$/.test(key)) return true;
  if (/^ui\.layout\.(preset|inspectorPosition|inspectorWidth)$/.test(key)) return true;
  if (/^ui\.composer\.(placeholder|multiline|enterBehavior|shiftEnterBehavior|showStopWhileStreaming)$/.test(key)) return true;
  if (/^ui\.components\.[a-zA-Z0-9_-]+\.(visible|label|collapsible|defaultCollapsed)$/.test(key)) return true;
  return /^ui\.locks\.whileTurnActive\.(disable|allow)$/.test(key);
}

function builtInEnvironment(): TurnStageEnvironment { return { version: 1, id: 'local', name: 'Local Mock Server', variables: { baseUrl: 'http://127.0.0.1:8787' }, secretReferences: { apiToken: 'local-api-token' } }; }
