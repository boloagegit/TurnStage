import * as vscode from 'vscode';
import { modify } from 'jsonc-parser';
import type { HostPayload, InspectorTargetTab, TestOperationAction, TestOperationSnapshot, WebviewMessage, WorkspaceSection } from '../../shared/protocol';
import { isWebviewMessage, PROTOCOL_VERSION } from '../../shared/protocol';
import type { AdversarialResultSummary, CampaignDashboardV1, ConnectionDoctorSummary, RawStreamEvent, ScenarioDefinition, ScenarioEvidenceLocation, ScenarioRunEvidence, ScenarioRunResult, SessionSnapshot, TurnStageProfile } from '../../shared/types';
import { EnvironmentRepository, MAX_PROFILE_BYTES } from '../config/profileRepository';
import { ProfileCodec } from '../config/profileCodec';
import { ProfileValidator, validateAdversarialScenariosAgainstProfile } from '../config/profileValidator';
import { LocalRunRepository, type LocalRunImportResult } from '../history/localRunRepository';
import { SecretService, UriPolicy } from '../security/security';
import { isActive, SessionController } from '../runtime/sessionController';
import { MappingEngine } from '../mapping/mappingEngine';
import { localize } from '../l10n';
import { validateFormSubmission } from './formSubmission';
import { resolveDisplayLanguage, textDirection } from '../displayLanguage';
import { profileEditorTitle } from './profileEditorTitle';
import { EventBatcher } from '../runtime/eventBatcher';
import { logAt, startLogOperation } from '../logging';
import { confirmRestartSession } from '../confirmRestartSession';
import { builtInEnvironment } from '../config/defaultEnvironment';
import { VisualRegressionService } from '../testing/visualRegression';
import { adversarialCsvTemplate, parseAdversarialCsv, serializeAdversarialCsv } from '../testing/adversarialCsv';
import { createAdversarialSuite, isSafeAdversarialSuitePath, normalizeAdversarialSuite, parseAdversarialSuite, serializeAdversarialSuite } from '../testing/adversarialSuite';
import { parseAdversarialSource } from '../testing/adversarialSource';
import { buildEvidenceTimeline } from '../testing/evidenceTimeline';
import { analyzeConnectionProbe } from '../connection/protocolProbe';
import { loadFixture } from '../runtime/fixtureLoader';
import type { ScenarioTestController } from '../testing/scenarioTestController';
import { parseAdversarialJsonl, serializeAdversarialJsonl, serializeCampaignResultsJsonl } from '../testing/adversarialJsonl';

const DOCUMENT_CHANGE_DEBOUNCE_MS = 150;

export class TurnStageEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly codec = new ProfileCodec();
  private readonly validator = new ProfileValidator();
  private readonly runs: LocalRunRepository;
  private readonly secrets: SecretService;
  private readonly uriPolicy = new UriPolicy();
  private readonly visualRegression: VisualRegressionService;
  private readonly controllers = new Map<string, SessionController>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly sectionPosters = new Map<string, Set<(section: WorkspaceSection) => Thenable<boolean>>>();
  private readonly evidencePosters = new Map<string, Set<(evidence: ScenarioRunEvidence, result: ScenarioRunResult | undefined, target: { tab: InspectorTargetTab; evidenceId: string; networkId?: string; sequence?: number; messageId?: string }) => Promise<boolean>>>();
  private readonly pendingSections = new Map<string, WorkspaceSection>();
  private readonly resultPosters = new Map<string, Set<(results: AdversarialResultSummary[]) => Thenable<boolean>>>();
  private readonly campaignPosters = new Map<string, Set<(dashboard: CampaignDashboardV1) => Thenable<boolean>>>();
  private readonly activeCampaignRuns = new Map<string, { campaignId: string; cancellation: vscode.CancellationTokenSource }>();
  private readonly pendingCampaignRuns = new Set<Promise<unknown>>();
  private readonly latestResults = new Map<string, AdversarialResultSummary[]>();
  private readonly latestTestOperations = new Map<string, TestOperationSnapshot>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly diagnostics: vscode.DiagnosticCollection, private readonly output: vscode.OutputChannel, private readonly environments = new EnvironmentRepository(context.globalStorageUri), visualRegression?: VisualRegressionService, private readonly scenarioTests?: ScenarioTestController) { this.runs = new LocalRunRepository(context, output); this.secrets = new SecretService(context); this.visualRegression = visualRegression ?? new VisualRegressionService(context); }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const resourceTitle = panel.title;
    // Set the semantic title before the first asynchronous operation. Older VS
    // Code releases can paint the backing JSONC filename as soon as the custom
    // editor resolves, so waiting for environment discovery causes a visible
    // and test-observable title race.
    const initialText = document.getText();
    panel.title = profileEditorTitle(Buffer.byteLength(initialText) <= MAX_PROFILE_BYTES ? this.codec.parse(initialText).profile?.name : undefined, resourceTitle);
    const instanceId = crypto.randomUUID(); panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] }; panel.webview.html = this.html(panel.webview, instanceId);
    let controller: SessionController | undefined; let documentVersion = -1; let loadTimer: ReturnType<typeof setTimeout> | undefined; let disposed = false; let latestConnectionResult: ConnectionDoctorSummary | undefined;
    let profileSnapshot: Extract<HostPayload, { type: 'profile.snapshot' }> | undefined;
    let validationSnapshot: Extract<HostPayload, { type: 'profile.validation' }> | undefined;
    const post = async (message: HostPayload, requestId: string = crypto.randomUUID()): Promise<boolean> => {
      if (disposed) return false;
      try {
        return await panel.webview.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId });
      } catch (error) {
        if (disposed || isDisposedWebviewError(error)) return false;
        throw error;
      }
    };
    const documentKey = document.uri.toString();
    const postSection = (section: WorkspaceSection) => post({ type: 'workspace.section', section });
    const posters = this.sectionPosters.get(documentKey) ?? new Set<(section: WorkspaceSection) => Thenable<boolean>>();
    posters.add(postSection);
    this.sectionPosters.set(documentKey, posters);
    const postResults = (results: AdversarialResultSummary[]) => post({ type: 'test.results', results });
    const resultPosters = this.resultPosters.get(documentKey) ?? new Set<typeof postResults>();
    resultPosters.add(postResults);
    this.resultPosters.set(documentKey, resultPosters);
    const postCampaigns = (dashboard: CampaignDashboardV1) => post({ type: 'campaign.dashboard', dashboard });
    const campaignPosters = this.campaignPosters.get(documentKey) ?? new Set<typeof postCampaigns>();
    campaignPosters.add(postCampaigns);
    this.campaignPosters.set(documentKey, campaignPosters);
    const postTestOperation = async (operation: TestOperationSnapshot, requestId?: string) => {
      this.latestTestOperations.set(documentKey, operation);
      await post({ type: 'test.operation', operation }, requestId);
    };
    const postEvidence = async (evidence: ScenarioRunEvidence, result: ScenarioRunResult | undefined, target: { tab: InspectorTargetTab; evidenceId: string; networkId?: string; sequence?: number; messageId?: string }): Promise<boolean> => {
      if (!controller?.applyScenarioEvidence(evidence)) return false;
      const snapshot = currentSessionSnapshot();
      if (snapshot) await post(snapshot);
      if (result) await post({ type: 'test.timeline', evidenceId: target.evidenceId, timeline: buildEvidenceTimeline(result) });
      await post({ type: 'inspector.focus', ...target });
      return true;
    };
    const evidencePosters = this.evidencePosters.get(documentKey) ?? new Set<typeof postEvidence>();
    evidencePosters.add(postEvidence);
    this.evidencePosters.set(documentKey, evidencePosters);
    const disposeController = (): Promise<void> => {
      const current = controller;
      controller = undefined;
      if (current && this.controllers.get(documentKey) === current) this.controllers.delete(documentKey);
      if (!current) return Promise.resolve();
      const disposal = current.disposeAndWait();
      this.trackDisposal(disposal);
      return disposal;
    };
    const currentSessionSnapshot = (): Extract<HostPayload, { type: 'session.snapshot' }> | undefined => controller ? { type: 'session.snapshot', snapshot: controller.snapshot, runs: controller.getRunSummaries(), requestPreview: controller.requestPreview, networkEntries: controller.getNetworkEntries() } : undefined;
    const sessionBatcher = new EventBatcher<void>(() => {
      if (disposed) return;
      const snapshot = currentSessionSnapshot();
      if (snapshot) void post(snapshot);
    }, boundedNumber(vscode.workspace.getConfiguration('turnstage').get('streamBatchIntervalMs', 32), 16, 1000, 32), Number.MAX_SAFE_INTEGER);
    const syncTurnActiveContext = () => {
      if (panel.active) void vscode.commands.executeCommand('setContext', 'turnstage.turnActive', Boolean(controller && isActive(controller.snapshot.turnState)));
    };
    const sendSession = (immediate = false) => { latestConnectionResult = undefined; if (controller) sessionBatcher.add(undefined, immediate); syncTurnActiveContext(); };
    const load = async () => {
      if (disposed || (documentVersion === document.version && controller)) return;
      const version = document.version;
      documentVersion = version;
      const text = document.getText();
      if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) {
        const message = localize('Profile files cannot exceed 5 MB.');
        await disposeController();
        profileSnapshot = { type: 'profile.snapshot', parseError: message, version: document.version, environments: [] };
        validationSnapshot = { type: 'profile.validation', diagnostics: [{ severity: 'error', message, offset: 0, length: 1 }] };
        this.publishDiagnostics(document, validationSnapshot.diagnostics);
        await post(profileSnapshot); await post(validationSnapshot);
        return;
      }
      const parsed = this.codec.parse(text); const envEntries = await this.environments.discover(document.uri); if (disposed || document.version !== version) return; const issues = this.validator.validate(parsed.profile, parsed.tree, envEntries.map((item) => item.environment)); this.publishDiagnostics(document, issues);
      panel.title = profileEditorTitle(parsed.profile?.name, resourceTitle);
      profileSnapshot = { type: 'profile.snapshot', profile: parsed.profile, parseError: parsed.errors.length ? localize('Invalid JSONC') : undefined, version: document.version, environments: envEntries.map((item) => item.environment.id) };
      validationSnapshot = { type: 'profile.validation', diagnostics: issues };
      latestConnectionResult = undefined;
      logAt(this.output, 'debug', `[profile] loaded ${parsed.profile?.id ?? document.uri.toString()} at document version ${version}`);
      await post(profileSnapshot);
      await post(validationSnapshot);
      if (disposed || document.version !== version) return;
      if (!parsed.profile || issues.some((item) => item.severity === 'error')) { await disposeController(); return; }
      if (!controller || controller.profile !== parsed.profile) {
        await disposeController(); const environment = envEntries.find((item) => item.environment.id === parsed.profile!.environment)?.environment ?? builtInEnvironment();
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
          else try { controller.addBuiltInFixture(await loadFixture(fixtureUri)); } catch (error) { logAt(this.output, 'error', `[fixture] ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (parsed.profile.opening?.mode === 'static') await controller.startSession(); else sendSession();
        if (disposed || document.version !== version) { await disposeController(); return; }
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
        if (message.type === 'webview.ready') {
          await postHostReady(message.requestId);
          const pendingSection = this.pendingSections.get(documentKey);
          if (pendingSection) {
            this.pendingSections.delete(documentKey);
            await postSection(pendingSection);
          }
          await rehydrate();
          await postResults(this.latestResults.get(documentKey) ?? []);
          const latestTestOperation = this.latestTestOperations.get(documentKey);
          if (latestTestOperation) await post({ type: 'test.operation', operation: latestTestOperation });
          if (this.scenarioTests) await post({ type: 'campaign.dashboard', dashboard: await this.scenarioTests.getCampaignDashboard(document.uri) });
          return;
        }
        if (message.type === 'profile.openAsText') { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return; }
        if (message.type === 'profile.validate') {
          documentVersion = -1;
          await load();
          await post({ type: 'profile.validated', valid: validationSnapshot?.diagnostics.length === 0 }, message.requestId);
          return;
        }
        if (message.type === 'profile.patch') { await this.patchDocument(document, message.path, message.value); return; }
        if (message.type === 'adversarial.file') {
          if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
          const operation = await this.handleAdversarialFile(document, message.action);
          await post({ type: 'adversarial.operation', action: message.action, ...operation }, message.requestId);
          return;
        }
        if (message.type === 'adversarial.openLinkedSuite') {
          const profile = this.codec.parse(document.getText()).profile;
          if (!profile) throw new Error(localize('Profile could not be parsed.'));
          if (!canOpenLinkedAdversarialSuite(profile, message.path)) throw new Error(localize('Only a safe suite linked by this Profile can be opened.'));
          const folder = vscode.workspace.getWorkspaceFolder(document.uri);
          if (!folder) throw new Error(localize('The linked suite cannot be resolved because this Profile is not inside a workspace folder.'));
          const uri = vscode.Uri.joinPath(folder.uri, ...message.path.split('/'));
          await vscode.workspace.fs.stat(uri);
          await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
          return;
        }
        if (message.type === 'test.runAll' || message.type === 'test.rerun') {
          if (!this.scenarioTests) throw new Error(localize('Test runtime is unavailable.'));
          const current = this.latestTestOperations.get(documentKey);
          if (current?.state === 'running' || current?.state === 'cancelling') throw new Error(localize('A TurnStage test run is already active.'));
          const action: TestOperationAction = message.type === 'test.runAll' ? 'runAll' : message.status === 'failed' ? 'rerunFailed' : message.status === 'unstable' ? 'rerunUnstable' : 'rerunIncomplete';
          await postTestOperation({ action, state: 'running' }, message.requestId);
          try {
            const state = message.type === 'test.runAll' ? await this.scenarioTests.runAll() : await this.scenarioTests.rerunLatest(document.uri, message.status);
            await postTestOperation({ action, state }, message.requestId);
          } catch (error) {
            await postTestOperation({ action, state: 'failed' }, message.requestId);
            throw error;
          }
          return;
        }
        if (message.type === 'test.cancel') {
          const active = this.latestTestOperations.get(documentKey);
          if (!active || active.state !== 'running' || !this.scenarioTests?.cancelActiveManualRun()) throw new Error(localize('No active TurnStage test run is available to stop.'));
          await postTestOperation({ action: active.action, state: 'cancelling' }, message.requestId);
          return;
        }
        if (message.type === 'test.timeline.open') {
          const reference = this.scenarioTests?.getEvidence(message.evidenceId);
          if (!reference?.result) throw new Error(localize('This test evidence is no longer available. Run the scenario again.'));
          await post({ type: 'test.timeline', evidenceId: message.evidenceId, timeline: buildEvidenceTimeline(reference.result) }, message.requestId);
          return;
        }
        if (message.type === 'test.evidence.open') { await vscode.commands.executeCommand('turnstage.openTestEvidence', { evidenceId: message.evidenceId, location: message.location }); return; }
        if (message.type === 'campaign.preview') {
          if (!this.scenarioTests) throw new Error('Campaign runtime is unavailable.');
          const plan = await this.scenarioTests.previewCampaign(document.uri, message.campaignId);
          await post({ type: 'campaign.preview', campaignId: message.campaignId, selectedCases: plan.batch.selectedCases, plannedAttempts: plan.batch.plannedAttempts, plannedRequests: plan.batch.plannedRequests, maximumDurationMs: plan.batch.maximumDurationMs, maxConcurrency: plan.batch.maxConcurrency, warnings: plan.batch.issues.map((item) => item.message) }, message.requestId);
          return;
        }
        if (message.type === 'campaign.run' || message.type === 'campaign.resume') {
          if (!this.scenarioTests) throw new Error('Campaign runtime is unavailable.');
          if (this.activeCampaignRuns.has(documentKey)) throw new Error('A campaign is already running for this profile.');
          const cancellation = new vscode.CancellationTokenSource();
          this.activeCampaignRuns.set(documentKey, { campaignId: message.campaignId, cancellation });
          const execution = this.scenarioTests.runCampaign(document.uri, message.campaignId, cancellation.token, message.type === 'campaign.resume' ? message.runId : undefined);
          this.pendingCampaignRuns.add(execution);
          try { await execution; }
          finally {
            this.pendingCampaignRuns.delete(execution);
            if (this.activeCampaignRuns.get(documentKey)?.cancellation === cancellation) this.activeCampaignRuns.delete(documentKey);
            cancellation.dispose();
          }
          await post({ type: 'campaign.dashboard', dashboard: await this.scenarioTests.getCampaignDashboard(document.uri) }, message.requestId);
          return;
        }
        if (message.type === 'campaign.cancel') {
          const active = this.activeCampaignRuns.get(documentKey);
          if (!active || active.campaignId !== message.campaignId) throw new Error('The selected campaign is not running.');
          active.cancellation.cancel();
          return;
        }
        if (message.type === 'campaign.acceptBaseline') {
          if (!this.scenarioTests) throw new Error('Campaign runtime is unavailable.');
          const run = await this.scenarioTests.getCampaignRun(document.uri, message.runId);
          if (!run || run.campaignId !== message.campaignId) throw new Error('Campaign run was not found.');
          if (run.diff?.regressions) {
            const acceptLabel = localize('Accept as baseline');
            const selected = await vscode.window.showWarningMessage(
              localize('This campaign has {count} regression(s). Accept it as the new baseline?', { count: run.diff.regressions }),
              { modal: true, detail: localize('The current accepted baseline will be replaced. Formal test outcomes are not changed.') },
              acceptLabel,
            );
            if (selected !== acceptLabel) return;
          }
          await this.scenarioTests.acceptCampaignBaseline(document.uri, message.campaignId, message.runId);
          await post({ type: 'campaign.dashboard', dashboard: await this.scenarioTests.getCampaignDashboard(document.uri) }, message.requestId);
          return;
        }
        if (message.type === 'campaign.exportResults') {
          if (!this.scenarioTests) throw new Error('Campaign runtime is unavailable.');
          const run = await this.scenarioTests.getCampaignRun(document.uri, message.runId);
          if (!run || run.campaignId !== message.campaignId) throw new Error('Campaign run was not found.');
          const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${run.campaignId}-${run.id}.results.jsonl`), filters: { JSONL: ['jsonl'] } });
          if (uri) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeCampaignResultsJsonl(run)));
          return;
        }
        if (message.type === 'campaign.copilotSummary') {
          if (!this.scenarioTests) throw new Error('Campaign runtime is unavailable.');
          const run = await this.scenarioTests.getCampaignRun(document.uri, message.runId);
          if (!run || run.campaignId !== message.campaignId) throw new Error('Campaign run was not found.');
          const summary = { campaign: run.campaignName, status: run.status, plan: run.plan, coverage: run.coverage, diff: run.diff ? { regressions: run.diff.regressions, improvements: run.diff.improvements, changed: run.diff.changed, entries: run.diff.entries.slice(0, 20) } : undefined, outcomes: run.cases.slice(0, 100).map((item) => ({ case: item.scenarioId, outcome: item.outcome, stability: item.stability, completedAttempts: item.completedAttempts, requestedAttempts: item.requestedAttempts })) };
          await openCopilotChat(`@turnstage /compare Review this sanitized Campaign summary. Explain deterministic regressions, instability, incomplete samples, coverage gaps, and practical next actions. Do not act as an LLM judge and do not change formal outcomes: ${boundedCopilotContext(summary)}`);
          return;
        }
        if (message.type === 'copilot.diagnose') {
          await openCopilotChat(`@turnstage /diagnose Diagnose TurnStage evidence ${JSON.stringify(message.evidenceId)} in ${message.mode} mode. Explain deterministic evidence first, distinguish facts from hypotheses, and suggest only safe profile changes.`);
          return;
        }
        if (message.type === 'copilot.qualityReview') {
          await openCopilotChat(`@turnstage /evidence Start an Advisory AI response-quality review for these explicitly selected TurnStage evidence ids: ${message.evidenceIds.map((id) => JSON.stringify(id)).join(', ')}. Show the disclosure confirmation before reading response content. This review must not change the formal test outcome.`);
          return;
        }
        if (message.type === 'copilot.profileDoctor') {
          const connectionEvidence = latestConnectionResult ? boundedCopilotContext(latestConnectionResult, 4_000) : 'unavailable';
          await openCopilotChat(`@turnstage /configure Act as Profile Doctor for TurnStage profile ${JSON.stringify(document.uri.toString())}. Combine deterministic validation with this sanitized Connection Doctor evidence: ${connectionEvidence}. Explain the observed protocol, HTTP status, mapping counts, terminal state, and bounded timing findings before proposing safe profile-only changes. Do not propose secret, proxy, VPN, or certificate changes.`);
          return;
        }
        if (message.type === 'output.open') { this.output.show(true); return; }
        if (!controller) return;
        switch (message.type) {
          case 'connection.analyze': {
            const operation = startLogOperation(this.output, 'connection', 'analyze');
            try {
              const snapshot = controller.snapshot;
              const network = controller.getLatestConnectionExchange();
              const result = analyzeConnectionProbe({
                status: network?.status,
                contentType: headerValue(network?.responseHeaders, 'content-type'),
                timing: {
                  headersLatencyMs: snapshot.metrics.headersLatency ?? network?.timing.headers,
                  firstChunkLatencyMs: snapshot.metrics.firstChunkLatency ?? network?.timing.firstChunk,
                  firstEventLatencyMs: snapshot.metrics.firstEventLatency,
                  totalLatencyMs: snapshot.metrics.totalDuration ?? network?.timing.total,
                },
                bodyPrefix: network?.responseBodyPreview,
                bodyPrefixTruncated: network?.responseBodyTruncated,
                rawEvents: snapshot.rawEvents,
                normalizedEvents: snapshot.normalizedEvents,
                mapping: {
                  configured: controller.profile.stream.mappings.length > 0,
                  mappedEventCount: snapshot.normalizedEvents.length,
                  unmatchedEventCount: snapshot.metrics.unmatchedEventCount,
                  mappingErrorCount: snapshot.metrics.mappingErrorCount,
                },
              });
              latestConnectionResult = {
                protocol: result.fingerprint.protocol,
                confidence: result.fingerprint.confidence,
                status: result.fingerprint.status,
                rawEventCount: result.fingerprint.rawEventCount,
                normalizedEventCount: result.fingerprint.normalizedEventCount,
                mappedEventCount: result.fingerprint.mappedEventCount,
                unmatchedEventCount: result.fingerprint.unmatchedEventCount,
                parseErrorCount: result.fingerprint.parseErrorCount,
                mappingErrorCount: result.fingerprint.mappingErrorCount,
                terminalEventSeen: result.fingerprint.terminalEventSeen,
                terminalMapped: result.fingerprint.terminalMapped,
                safe: result.safe,
                findings: result.findings.map((finding) => ({ id: finding.id, category: finding.category, severity: finding.severity, message: finding.message })),
              };
              operation.complete({ protocol: result.fingerprint.protocol, safe: result.safe, findings: result.findings.length });
              await post({ type: 'connection.result', result: latestConnectionResult }, message.requestId);
            } catch (error) {
              operation.fail({ reason: error instanceof Error ? error.name : 'Error' });
              throw error;
            }
            break;
          }
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
          case 'conversation.new': if (await confirmRestartSession()) await controller.newConversation(); break;
          case 'conversation.clear': controller.clearConversation(); break;
          case 'history.remote.apply': controller.applyRemoteSession(message.conversationId); break;
          case 'citation.open': { const citation = controller.snapshot.messages.flatMap((item) => item.citations).find((item) => item.id === message.citationId); if (citation) await this.uriPolicy.open(citation, controller.profile, controller.profileUri); break; }
          case 'uri.open': await this.uriPolicy.open({ id: `markdown-link-${message.requestId}`, kind: 'url', uri: message.uri }, controller.profile, controller.profileUri); break;
          case 'action.invoke': {
            try {
              await this.invokeAction(message.actionId, message.sourceMessageId, controller);
              if (message.sourceMessageId && message.actionId === 'message.copy') await post({ type: 'action.feedback', actionId: message.actionId, sourceMessageId: message.sourceMessageId, status: 'success', message: localize('Message copied.') }, message.requestId);
            } catch (error) {
              if (message.sourceMessageId) await post({ type: 'action.feedback', actionId: message.actionId, sourceMessageId: message.sourceMessageId, status: 'error', message: error instanceof Error ? error.message : String(error) }, message.requestId);
              throw error;
            }
            break;
          }
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
          case 'run.delete': {
            if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
            const summary = controller.getRunStorageSummary(message.runId);
            if (!summary.count) throw new Error(localize('The selected run is no longer available.'));
            const action = localize('Delete Run');
            const confirmed = await vscode.window.showWarningMessage(localize('Delete this recorded run?'), { modal: true, detail: localize('This permanently removes {count} local run ({size}) for the current Profile. Exported run files are not affected.', { count: String(summary.count), size: formatStorageBytes(summary.bytes) }) }, action);
            if (confirmed === action) { const result = await controller.deleteRun(message.runId); await post({ type: 'run.history.changed', ...result }, message.requestId); }
            break;
          }
          case 'run.clear': {
            if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
            const summary = controller.getRunStorageSummary();
            if (!summary.count) break;
            const action = localize('Clear Replay History');
            const confirmed = await vscode.window.showWarningMessage(localize('Clear replay history for this Profile?'), { modal: true, detail: localize('This permanently removes {count} local runs ({size}) for the current Profile. Exported run files are not affected.', { count: String(summary.count), size: formatStorageBytes(summary.bytes) }) }, action);
            if (confirmed === action) { const result = await controller.clearRuns(); await post({ type: 'run.history.changed', ...result }, message.requestId); }
            break;
          }
          case 'visual.baseline.save': {
            if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
            const result = await this.visualRegression.saveBaseline(controller.profile, document.uri, message.viewport, message.dataUrl);
            if (result) await post({ type: 'visual.result', operation: 'baseline', status: 'saved', baselinePath: vscode.workspace.asRelativePath(result.baselineUri) }, message.requestId);
            break;
          }
          case 'visual.compare': {
            if (!vscode.workspace.isTrusted) throw new Error(localize('This action requires a trusted workspace. Profile editing and fixture replay remain available.'));
            const result = await this.visualRegression.compare(controller.profile, document.uri, message.viewport, message.dataUrl);
            await post({ type: 'visual.result', operation: 'compare', status: result.status, differencePercent: result.differencePercent, baselinePath: vscode.workspace.asRelativePath(result.baselineUri), ...(result.diffUri ? { diffPath: vscode.workspace.asRelativePath(result.diffUri) } : {}) }, message.requestId);
            break;
          }
          case 'adversarial.capture': {
            const detail = await this.captureAdversarialConversation(document, controller.snapshot, controller.profile);
            if (detail) await post({ type: 'adversarial.captured', detail }, message.requestId);
            break;
          }
          case 'form.cancel': break;
        }
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Error';
        logAt(this.output, 'error', () => `[editor] action=${message.type} type=${type}`);
        await post({ type: 'request.error', error: { type, message: error instanceof Error ? error.message : String(error) } }, message.requestId);
        const openOutput = localize('Open TurnStage Output');
        void vscode.window.showErrorMessage(localize('TurnStage could not complete {action}.', { action: message.type }), openOutput).then((choice) => { if (choice === openOutput) this.output.show(true); });
      }
    });
    panel.onDidDispose(() => { disposed = true; sessionBatcher.dispose(); if (loadTimer) clearTimeout(loadTimer); this.activeCampaignRuns.get(documentKey)?.cancellation.cancel(); void disposeController(); posters.delete(postSection); if (!posters.size) { this.sectionPosters.delete(documentKey); this.pendingSections.delete(documentKey); } resultPosters.delete(postResults); if (!resultPosters.size) this.resultPosters.delete(documentKey); campaignPosters.delete(postCampaigns); if (!campaignPosters.size) this.campaignPosters.delete(documentKey); evidencePosters.delete(postEvidence); if (!evidencePosters.size) this.evidencePosters.delete(documentKey); documentListener.dispose(); trustListener.dispose(); configurationListener.dispose(); viewStateListener.dispose(); messageListener.dispose(); });
  }

  getController(uri?: vscode.Uri): SessionController | undefined { return uri ? this.controllers.get(uri.toString()) : [...this.controllers.values()].at(-1); }
  async drainPending(): Promise<void> {
    for (const active of this.activeCampaignRuns.values()) active.cancellation.cancel();
    await Promise.allSettled([...this.pendingCampaignRuns, ...this.pendingDisposals, ...[...this.controllers.values()].map((controller) => controller.disposeAndWait())]);
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
    const posters = [...(this.sectionPosters.get(key) ?? [])];
    if (!posters.length) {
      this.pendingSections.set(key, section);
      return;
    }
    const delivered = await Promise.all(posters.map((postSection) => postSection(section)));
    if (delivered.some(Boolean)) this.pendingSections.delete(key);
    else this.pendingSections.set(key, section);
  }
  async showScenarioEvidence(uri: vscode.Uri, evidence: ScenarioRunEvidence, location: ScenarioEvidenceLocation, evidenceId: string, result?: ScenarioRunResult): Promise<boolean> {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'turnstage.profileEditor', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
    await this.showSection(uri, 'test');
    if (!await this.waitForController(uri)) return false;
    const target = { ...inspectorTarget(location, evidence), evidenceId };
    const posters = [...(this.evidencePosters.get(uri.toString()) ?? [])];
    if (!posters.length) return false;
    const results = await Promise.all(posters.map((poster) => poster(evidence, result, target)));
    return results.some(Boolean);
  }
  async publishTestResults(uri: vscode.Uri, results: AdversarialResultSummary[]): Promise<void> {
    const key = uri.toString();
    this.latestResults.set(key, structuredClone(results));
    await Promise.all([...(this.resultPosters.get(key) ?? [])].map((poster) => poster(results)));
  }
  async publishCampaignDashboard(uri: vscode.Uri, dashboard: CampaignDashboardV1): Promise<void> {
    await Promise.all([...(this.campaignPosters.get(uri.toString()) ?? [])].map((poster) => poster(dashboard)));
  }
  private async patchDocument(document: vscode.TextDocument, path: Array<string | number>, value: unknown): Promise<void> {
    if (!isAllowedPatchPath(path)) throw new Error(localize('This profile setting cannot be edited from the configuration surface.'));
    const edits = modify(document.getText(), path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }); const workspaceEdit = new vscode.WorkspaceEdit(); for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), edit.content); await vscode.workspace.applyEdit(workspaceEdit);
  }
  private async handleAdversarialFile(document: vscode.TextDocument, action: Extract<WebviewMessage, { type: 'adversarial.file' }>['action']): Promise<{ status: 'completed' | 'cancelled'; detail: string; path?: string }> {
    const profile = this.codec.parse(document.getText()).profile;
    if (!profile) throw new Error(localize('Profile could not be parsed.'));
    if (action === 'csvTemplate') {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('turnstage-adversarial-template.csv'), filters: { CSV: ['csv'] } });
      if (!uri) return cancelledOperation();
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(adversarialCsvTemplate()));
      return completedOperation(localize('CSV template exported.'), uri);
    }
    if (action === 'exportCsv' || action === 'exportJsonc' || action === 'exportJsonl') {
      const scenarios = (profile.tests?.scenarios ?? []).filter((scenario) => scenario.adversarial);
      if (!scenarios.length) throw new Error(localize('This profile has no inline adversarial cases to export.'));
      const jsonc = action === 'exportJsonc';
      const jsonl = action === 'exportJsonl';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${profile.id}.adversarial.${jsonc ? 'jsonc' : jsonl ? 'jsonl' : 'csv'}`),
        filters: jsonc ? { JSONC: ['jsonc'] } : jsonl ? { JSONL: ['jsonl'] } : { CSV: ['csv'] },
      });
      if (!uri) return cancelledOperation();
      const suite = createAdversarialSuite(`${profile.id}-adversarial`, `${profile.name} adversarial tests`, scenarios);
      const contents = jsonc ? serializeAdversarialSuite(suite) : jsonl ? serializeAdversarialJsonl(suite) : serializeAdversarialCsv(scenarios);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(contents));
      return completedOperation(localize('Exported {count} adversarial cases.', { count: String(scenarios.length) }), uri);
    }
    const linking = action === 'linkSuite' || action === 'linkJsonc';
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: action === 'linkSuite' ? { [localize('Adversarial Suites')]: ['jsonc', 'json', 'csv'] } : action === 'importCsv' ? { CSV: ['csv'] } : action === 'importJsonl' ? { JSONL: ['jsonl'] } : { JSONC: ['jsonc', 'json'] },
      openLabel: linking ? localize('Link Adversarial Suite') : localize('Import Adversarial Tests'),
    });
    const uri = selected?.[0];
    if (!uri) return cancelledOperation();
    if (linking) {
      const profileFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const suiteFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!profileFolder || profileFolder.uri.toString() !== suiteFolder?.uri.toString()) throw new Error(localize('Linked suites must be inside the same workspace folder as the profile.'));
      const relative = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
      if (!isSafeAdversarialSuitePath(relative)) throw new Error(localize('Linked suites must use a safe workspace-relative *.adversarial.jsonc, *.json, or *.csv path.'));
      if (action === 'linkJsonc' && /\.csv$/iu.test(relative)) throw new Error(localize('The legacy JSONC link action cannot link CSV files.'));
      const parsed = parseAdversarialSource(relative, await readBoundedTextFile(uri));
      if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.slice(0, 20).join('\n') || localize('The selected adversarial suite is invalid.'));
      const scenarios = parsed.scenarios;
      this.assertAdversarialScenariosCompatible(profile, scenarios);
      const paths = profile.tests?.adversarialSuites ?? [];
      if (!paths.includes(relative)) await this.patchDocument(document, ['tests', 'adversarialSuites'], [...paths, relative]);
      return completedOperation(localize('Linked {count} adversarial cases.', { count: String(scenarios.length) }), uri);
    }
    const contents = await readBoundedTextFile(uri);
    let imported: ScenarioDefinition[];
    if (action === 'importCsv') {
      const parsed = parseAdversarialCsv(contents);
      if (parsed.issues.length) throw new Error(parsed.issues.slice(0, 20).map((issue) => `Row ${issue.row}${issue.column ? ` (${issue.column})` : ''}: ${issue.message}`).join('\n'));
      imported = parsed.scenarios;
    } else if (action === 'importJsonl') {
      const parsed = parseAdversarialJsonl(contents);
      if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.slice(0, 20).map((issue) => `Line ${issue.line}: ${issue.message}`).join('\n') || localize('The selected suite is not valid JSONL.'));
      imported = normalizeAdversarialSuite(parsed.suite);
    } else {
      const parsed = parseAdversarialSuite(contents);
      if (parsed.parseErrors.length || !parsed.suite || parsed.issues.length) throw new Error(parsed.issues.slice(0, 20).map((issue) => `${issue.path}: ${issue.message}`).join('\n') || localize('The selected suite is not valid JSONC.'));
      imported = normalizeAdversarialSuite(parsed.suite);
    }
    if (!imported.length) throw new Error(localize('The selected file contains no enabled adversarial cases.'));
    this.assertAdversarialScenariosCompatible(profile, imported);
    const merged = await mergeImportedScenarios(profile, imported);
    if (!merged) return cancelledOperation();
    await this.patchDocument(document, ['tests', 'scenarios'], merged);
    return completedOperation(localize('Imported {count} adversarial cases.', { count: String(imported.length) }), uri);
  }
  private async captureAdversarialConversation(document: vscode.TextDocument, snapshot: SessionSnapshot, profile: TurnStageProfile): Promise<string | undefined> {
    const userMessages = snapshot.messages.filter((message) => message.role === 'user').map((message) => message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text ?? '').join('')).filter((text) => text.trim());
    if (!userMessages.length) throw new Error(localize('There are no user messages to save as an adversarial test.'));
    if (userMessages.length > 10) throw new Error(localize('This conversation has more than 10 user turns. Start a shorter conversation before saving it as one adversarial case.'));
    const saveLabel = localize('Continue');
    const confirmed = await vscode.window.showWarningMessage(localize('Save this conversation as an adversarial test?'), { modal: true, detail: localize('The user messages will be written to the Profile JSONC. Review them for secrets or private data first.') }, saveLabel);
    if (confirmed !== saveLabel) return undefined;
    const name = await vscode.window.showInputBox({ title: localize('Adversarial Case Name'), value: localize('Captured adversarial conversation'), validateInput: (value) => value.trim() ? undefined : localize('Case name is required.') });
    if (!name?.trim()) return undefined;
    const emitted = new Set(profile.stream.mappings.map((mapping) => String(mapping.emit.type)));
    const visible = [...emitted].some((type) => ['content.text.delta', 'content.markdown.delta', 'citation.upsert', 'citation.attach', 'action.upsert', 'followup.upsert', 'form.upsert'].includes(type));
    const content = visible ? await vscode.window.showInputBox({ title: localize('Forbidden Content'), prompt: localize('Optional literal phrase that must not appear in the assistant response.') }) : undefined;
    const availableChoices: Array<{ label: string; key: 'urls' | 'ctas' | 'tools' }> = [];
    if (visible) availableChoices.push({ label: localize('Forbid URLs'), key: 'urls' });
    if ([...emitted].some((type) => ['action.upsert', 'followup.upsert', 'form.upsert'].includes(type))) availableChoices.push({ label: localize('Forbid calls to action'), key: 'ctas' });
    if ([...emitted].some((type) => type.startsWith('tool.'))) availableChoices.push({ label: localize('Forbid tool interactions'), key: 'tools' });
    if (!visible && !availableChoices.length) throw new Error(localize('This Profile has no observable mapping available for an adversarial prohibition.'));
    const choices = await vscode.window.showQuickPick(availableChoices, { title: localize('Additional Prohibited Effects'), canPickMany: true, placeHolder: localize('Choose any additional observable effects to prohibit') });
    if (!choices) return undefined;
    const forbid = {
      ...(content?.trim() ? { content: [content.trim()] } : {}),
      ...(choices.some((choice) => choice.key === 'urls') ? { urls: true } : {}),
      ...(choices.some((choice) => choice.key === 'ctas') ? { ctas: true } : {}),
      ...(choices.some((choice) => choice.key === 'tools') ? { tools: true } : {}),
    };
    if (!Object.keys(forbid).length) throw new Error(localize('Choose at least one prohibited effect before saving the case.'));
    const scenarios = profile.tests?.scenarios ?? [];
    const baseId = slugScenarioId(name) || 'captured-adversarial';
    const id = nextScenarioId(new Set(scenarios.map((scenario) => scenario.id)), baseId);
    const steps = userMessages.map((input, index) => ({ id: `turn-${index + 1}`, name: localize('Turn {number}', { number: String(index + 1) }), input }));
    const scenario: ScenarioDefinition = { id, name: name.trim(), tags: ['captured'], steps, adversarial: { mode: steps.length > 1 ? 'multiTurn' : 'singleTurn', maxTurns: steps.length, timeoutMs: 60_000, stopOnAttackSucceeded: true, forbid } };
    this.assertAdversarialScenariosCompatible(profile, [scenario]);
    await this.patchDocument(document, ['tests', 'scenarios'], [...scenarios, scenario]);
    return localize('Saved {count} user turns as adversarial case {id}.', { count: String(steps.length), id });
  }
  private assertAdversarialScenariosCompatible(profile: TurnStageProfile, scenarios: readonly ScenarioDefinition[]): void {
    const firstError = validateAdversarialScenariosAgainstProfile(profile, scenarios)[0];
    if (firstError) throw new Error(localize('Adversarial case {id} is incompatible with this Profile: {message}', { id: firstError.scenarioId, message: firstError.message }));
  }
  private trackDisposal(promise: Promise<void>): void {
    this.pendingDisposals.add(promise);
    void promise.then(
      () => this.pendingDisposals.delete(promise),
      (error) => { this.pendingDisposals.delete(promise); logAt(this.output, 'error', `[session] disposal failed type=${error instanceof Error ? error.name : 'Error'}`); },
    );
  }
  private publishDiagnostics(document: vscode.TextDocument, issues: ReturnType<ProfileValidator['validate']>): void { this.diagnostics.set(document.uri, issues.map((issue) => { const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(issue.offset), document.positionAt(issue.offset + issue.length)), issue.message, issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning); diagnostic.source = 'TurnStage'; return diagnostic; })); }
  private async invokeAction(actionId: string, sourceMessageId: string | undefined, controller: SessionController): Promise<void> {
    const message = sourceMessageId ? controller.snapshot.messages.find((item) => item.id === sourceMessageId) : undefined;
    if (actionId === 'message.copy' && message) { await vscode.env.clipboard.writeText(message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('')); return; }
    if (actionId === 'message.retry') { await controller.retry(); return; }
    if (actionId === 'request.abort') { await controller.abort(); return; }
    if (actionId === 'conversation.new') { if (await confirmRestartSession()) await controller.newConversation(); return; }
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
    if (action.actionId === 'conversation.new') { if (await confirmRestartSession()) await controller.newConversation(); return; }
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

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

async function openCopilotChat(query: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false });
}

function boundedCopilotContext(value: unknown, maxCharacters = 6_000): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= maxCharacters ? serialized : `${serialized.slice(0, maxCharacters)}…`;
}

function configuredLocale(): string {
  return resolveDisplayLanguage(vscode.workspace.getConfiguration('turnstage').get('displayLanguage', 'auto'), vscode.env.language);
}

function inspectorTarget(location: ScenarioEvidenceLocation, evidence?: ScenarioRunEvidence): { tab: InspectorTargetTab; networkId?: string; sequence?: number; messageId?: string } {
  if (location.kind === 'network') return { tab: 'Network', networkId: location.networkId };
  if (location.kind === 'normalizedEvent') return { tab: 'Normalized', sequence: location.sequence };
  if (location.kind === 'rawEvent') return { tab: 'Raw Events', sequence: location.sequence };
  if (location.kind === 'message') {
    const message = evidence?.snapshot.messages.find((item) => item.id === location.messageId);
    const rawSequences = Array.isArray(message?.metadata?.rawSequences) ? message.metadata.rawSequences.filter((item): item is number => Number.isInteger(item) && Number(item) >= 0) : [];
    return { tab: 'Raw Events', sequence: rawSequences.at(-1), messageId: location.messageId };
  }
  return { tab: 'Raw Events' };
}

export function isAllowedPatchPath(path: unknown): path is Array<string | number> {
  if (!Array.isArray(path) || !path.length || !path.every((part) => (typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part) && part >= 0)) && part !== '__proto__' && part !== 'prototype' && part !== 'constructor')) return false;
  const key = path.join('.');
  if (key === 'name' || key === 'description' || key === 'environment' || key === 'opening.mode' || key === 'opening.message' || key === 'opening.trigger' || key === 'opening.starters' || key === 'opening.request' || key === 'opening.response' || key === 'opening.fallbacks' || key === 'opening.failurePolicy' || key === 'conversation.send.method' || key === 'conversation.send.url' || key === 'conversation.send.variants' || key === 'conversation.send.timeoutMs' || key === 'conversation.send.idleTimeoutMs' || key === 'conversation.send.headers' || key === 'conversation.send.body' || key === 'conversation.stop.strategy' || key === 'conversation.stop.request' || key === 'conversation.stop.requiredContext' || key === 'stream.transport' || key === 'stream.dataFormat' || key === 'stream.doneValue' || key === 'stream.mappingMode' || key === 'stream.unexpectedEndPolicy' || key === 'stream.mappings' || key === 'history.remoteSessions' || key === 'metrics.enabled' || key === 'metrics.messageEnabled' || key === 'security.allowedUriSchemes' || key === 'security.allowedDomains' || key === 'security.allowedCommands' || key === 'ui.messageActions' || key === 'ui.messageActionVisibility' || key === 'ui.messageTags' || key === 'tests' || key === 'tests.scenarios' || key === 'tests.adversarialSuites' || key === 'tests.reporting' || key === 'tests.visual' || key === 'tests.qualityRubrics' || key === 'tests.campaigns') return true;
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

/** Fail closed before resolving a Webview-supplied path in the Extension Host. */
export function canOpenLinkedAdversarialSuite(profile: TurnStageProfile, path: unknown): path is string {
  return isSafeAdversarialSuitePath(path) && Boolean(profile.tests?.adversarialSuites?.includes(path));
}

function completedOperation(detail: string, uri: vscode.Uri): { status: 'completed'; detail: string; path: string } {
  return { status: 'completed', detail, path: uri.toString() };
}

function cancelledOperation(): { status: 'cancelled'; detail: string } { return { status: 'cancelled', detail: localize('Operation cancelled.') }; }

async function mergeImportedScenarios(profile: TurnStageProfile, imported: readonly ScenarioDefinition[]): Promise<ScenarioDefinition[] | undefined> {
  const existing = profile.tests?.scenarios ?? [];
  const collisions = imported.filter((scenario) => existing.some((candidate) => candidate.id === scenario.id));
  if (!collisions.length) return [...existing, ...structuredClone(imported)];
  const replaceLabel = localize('Replace conflicting cases');
  const renameLabel = localize('Keep both and rename imports');
  const choice = await vscode.window.showWarningMessage(
    localize('{count} imported case IDs already exist. Choose how to continue; nothing will be overwritten silently.', { count: String(collisions.length) }),
    { modal: true, detail: collisions.slice(0, 20).map((scenario) => scenario.id).join(', ') },
    replaceLabel,
    renameLabel,
  );
  if (choice === replaceLabel) {
    const ids = new Set(imported.map((scenario) => scenario.id));
    return [...existing.filter((scenario) => !ids.has(scenario.id)), ...structuredClone(imported)];
  }
  if (choice === renameLabel) {
    const ids = new Set(existing.map((scenario) => scenario.id));
    const renamed = imported.map((scenario) => {
      const id = nextScenarioId(ids, scenario.id);
      ids.add(id);
      return { ...structuredClone(scenario), id };
    });
    return [...existing, ...renamed];
  }
  return undefined;
}

function nextScenarioId(ids: ReadonlySet<string>, preferred: string): string {
  if (!ids.has(preferred)) return preferred;
  for (let index = 2; index <= 10_000; index++) if (!ids.has(`${preferred}-${index}`)) return `${preferred}-${index}`;
  throw new Error(localize('Could not create a unique imported case ID.'));
}
function slugScenarioId(value: string): string { return value.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback; }
function formatStorageBytes(value: number): string {
  const bytes = Math.max(0, Number.isFinite(value) ? value : 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
function isDisposedWebviewError(error: unknown): boolean { return error instanceof Error && error.message.includes('Webview is disposed'); }
async function readBoundedTextFile(uri: vscode.Uri): Promise<string> {
  if ((await vscode.workspace.fs.stat(uri)).size > 5 * 1024 * 1024) throw new Error(localize('Adversarial import files cannot exceed 5 MB.'));
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(localize('Adversarial import files cannot exceed 5 MB.'));
  return new TextDecoder().decode(bytes);
}
