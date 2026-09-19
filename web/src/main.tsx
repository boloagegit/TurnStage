import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { applyEdits, modify } from 'jsonc-parser';
import type { HostMessage, HostPayload, WebviewMessage } from '../../src/shared/protocol';
import { PROTOCOL_VERSION } from '../../src/shared/protocol';
import type { LocalRun, LocalRunSummary, TurnStageEnvironment, TurnStageProfile } from '../../src/shared/types';
import { ProfileCodec } from '../../src/extension/config/profileCodec';
import { ProfileValidator } from '../../src/extension/config/profileValidator';
import { MappingEngine } from '../../src/extension/mapping/mappingEngine';
import { validateFormSubmission } from '../../src/extension/editors/formSubmission';
import { buildCapturedScenario } from '../../src/extension/testing/scenarioCapture';
import { BrowserSession, type BrowserSessionState } from './browserSession';
import { WebTestController } from './webTestController';
import { WebCampaignController } from './webCampaignController';
import { WebInsightsController } from './webInsightsController';
import { ArtifactStore } from './artifactStore';
import { redactKnownSecrets } from '../../src/shared/redaction';
import { loadEnvironments, loadPreferences, loadProfiles, saveEnvironments, savePreferences, saveProfiles, type StoredEnvironment, type StoredProfile, type WebThemePreference } from './storage';
import { loadOfficialCatalog, mergeCatalogEntries, type OfficialCatalogResult } from './catalog';
import { applyWebAppearance, bindSystemAppearance } from './theme';
import { decodeWebProfileBundle, encodeWebProfileBundle } from './profileBundle';
import { IconButton } from '../../src/webview/Icon';
import { copyText } from '../../src/webview/clipboardText';
import { t } from '../../src/webview/i18n';
import { browserUuid } from './browserCrypto';
import { loadProfileOrganization, normalizeProfileOrganization, saveProfileOrganization, type ProfileOrganization } from './profileOrganization';
import { ProfileReferencePanel, type ProfileSourceSaveResult, type ReferencePage } from './ProfileReferencePanel';
import { profileUrl, requestedProfileId } from './profileUrl';
import { schemaDiagnostics, webCompatibilityDiagnostics, type ProfileSourceDiagnostic } from './profileSourceDiagnostics';
import basicRaw from '../../resources/templates/basic-sse-chat.turnstage.jsonc?raw';
import agentRaw from '../../resources/templates/agent-flow.turnstage.jsonc?raw';
import enterpriseRaw from '../../resources/templates/enterprise-chat.turnstage.jsonc?raw';
import environmentRaw from '../../resources/templates/local.environment.jsonc?raw';
import './vscode-token-compat.css';
import './web.css';

type VsCodeApiState = Record<string, unknown>;
type BridgeApi = { postMessage(message: unknown): void; getState(): VsCodeApiState | undefined; setState(state: VsCodeApiState): void };

const codec = new ProfileCodec();
const validator = new ProfileValidator();
const bundledProfiles = new Map([['basic-sse-chat', basicRaw], ['agent-flow', agentRaw], ['enterprise-chat', enterpriseRaw]]);
const bundledEnvironments = new Map([['local', environmentRaw]]);
const preferences = loadPreferences();
const secrets = new Map<string, string>();
const artifacts = new ArtifactStore();
let catalog: OfficialCatalogResult;
let officialProfiles: StoredProfile[] = [];
let officialEnvironments: StoredEnvironment[] = [];
let profiles: StoredProfile[] = [];
let active: StoredProfile;
let environments: StoredEnvironment[] = [];
let activeEnvironmentItem: StoredEnvironment;
let runSummaries: LocalRunSummary[] = [];
const recordedTurns = new Set<string>();
let webviewState: VsCodeApiState | undefined;
let session: BrowserSession;
let tests: WebTestController;
let campaigns: WebCampaignController;
let insights: WebInsightsController;
let onLibraryChanged: (() => void) | undefined;
let onOpenReference: ((page: ReferencePage) => void) | undefined;

const disposeAppearance = bindSystemAppearance(() => preferences.theme ?? 'system');
window.addEventListener('beforeunload', () => { secrets.clear(); disposeAppearance(); });
(window as typeof window & { acquireVsCodeApi?: () => BridgeApi }).acquireVsCodeApi = () => ({
  postMessage: (message) => void handleWebviewMessage(message),
  getState: () => webviewState,
  setState: (value) => { webviewState = value; },
});

void bootstrap();

async function bootstrap(): Promise<void> {
  catalog = await loadOfficialCatalog({
    bundledProfiles,
    bundledEnvironments,
    parseProfile: (raw) => codec.parse(raw).profile,
    parseEnvironment,
    validateProfile: (raw, environmentRaws) => {
      const parsed = codec.parse(raw);
      const catalogEnvironments = environmentRaws.flatMap((environmentSource) => { const environment = parseEnvironment(environmentSource); return environment ? [environment] : []; });
      return Boolean(parsed.profile) && !validator.validate(parsed.profile, parsed.tree, catalogEnvironments).some((issue) => issue.severity === 'error');
    },
  });
  officialProfiles = catalog.profiles;
  officialEnvironments = catalog.environments;
  profiles = mergeCatalogEntries(officialProfiles, loadProfiles());
  const requestedId = requestedProfileId(window.location.search);
  active = profiles.find((item) => item.id === requestedId) ?? profiles.find((item) => item.id === preferences.activeProfileId) ?? profiles[0]!;
  window.history.replaceState(window.history.state, '', profileUrl(window.location.href, active.id));
  environments = mergeCatalogEntries(officialEnvironments, loadEnvironments());
  activeEnvironmentItem = environmentFor(activeProfile());
  session = createSession(active);
  tests = new WebTestController(() => activeProfile(), () => activeEnvironment(), secrets, post, () => preferences.locale ?? navigator.language);
  campaigns = new WebCampaignController(() => activeProfile(), tests, post);
  insights = new WebInsightsController(() => activeProfile(), () => session.current, post);
  createRoot(document.getElementById('profile-root')!).render(<ProfileLibrary />);
  await import('../../src/webview/main');
}

function createSession(item: StoredProfile): BrowserSession {
  const profile = codec.parse(item.raw).profile ?? fallbackProfile(item);
  const next = new BrowserSession(profile, activeEnvironment(), secrets, (state) => {
    if (session !== next) return;
    post({ type: 'session.snapshot', snapshot: state.snapshot, runs: runSummaries, requestPreview: state.requestPreview, networkEntries: state.networkEntries });
    void retainCompletedRun(profile, state);
  });
  void next.start();
  return next;
}

async function handleWebviewMessage(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as WebviewMessage;
  try {
    switch (message.type) {
      case 'webview.ready': hydrate(message.requestId); break;
      case 'profile.duplicate': duplicateActive(); break;
      case 'profile.patch': patchProfile(message.path, message.value); break;
      case 'profile.save': post({ type: 'profile.editState', dirty: false }, message.requestId); break;
      case 'profile.validate': validateActive(message.requestId); break;
      case 'profile.openFirstIssue': post({ type: 'workspace.navigate', destination: { pane: 'configure', section: 'general' } }, message.requestId); break;
      case 'control.set': session.setControl(message.controlId, message.value); break;
      case 'session.start': await session.start(); break;
      case 'opening.retry': await session.start(); break;
      case 'opening.useFallback': session.useOpeningFallback(); break;
      case 'request.send': await session.send(message.text, message.interaction); break;
      case 'citation.open': openCitation(message.citationId); break;
      case 'action.invoke': await invokeAction(message.actionId, message.sourceMessageId, message.requestId); break;
      case 'form.submit': {
        const submission = validateFormSubmission(session.current.snapshot.messages, message.formId, message.sourceMessageId, message.values);
        post({ type: 'form.accepted', formId: message.formId, sourceMessageId: message.sourceMessageId }, message.requestId);
        await session.send(submission.form.submit.messageTemplate, { kind: 'formSubmit', formId: message.formId, formValues: submission.values, sourceMessageId: message.sourceMessageId });
        break;
      }
      case 'form.cancel': break;
      case 'request.abort': await session.abort(); break;
      case 'conversation.clear': if (confirmSessionChange('clear')) session.clear(); break;
      case 'conversation.new': if (confirmSessionChange('restart')) await session.newConversation(); break;
      case 'run.import': await importRun(message.requestId); break;
      case 'run.export': await exportRun(message.runId, message.requestId); break;
      case 'run.delete': if (window.confirm('Delete this browser-local run? This cannot be undone.')) await deleteRun(message.runId); break;
      case 'run.clear': if (window.confirm('Delete every browser-local conversation run? This cannot be undone.')) await clearRuns(); break;
      case 'run.replay.play': await replayRun(message.runId, message.speed); break;
      case 'run.replay.pause': session.pauseReplay(); break;
      case 'run.replay.resume': session.resumeReplay(); break;
      case 'run.replay.stop': session.stopReplay(); break;
      case 'run.replay.step': session.stepReplay(); break;
      case 'run.replay.speed': session.setReplaySpeed(message.speed); break;
      case 'mapping.test': {
        const rawEvent = { sequence: 1, receivedAt: Date.now(), elapsedMs: 0, protocol: message.event.protocol, raw: message.event.raw, data: message.event.data, ...(message.event.eventName ? { sse: { event: message.event.eventName } } : {}) };
        const profile = activeProfile();
        const result = new MappingEngine(profile.stream).map(rawEvent);
        post({ type: 'mapping.test.result', result: { ruleIds: result.ruleIds, normalized: result.events, errors: result.errors } }, message.requestId);
        break;
      }
      case 'test.runAll': await tests.run('runAll'); break;
      case 'test.runContracts': await tests.run('runContracts'); break;
      case 'test.runCase': await tests.run('runCase', message.scenarioId, message.kind, message.suiteId); break;
      case 'test.runSelection': await tests.runCases(message.cases); break;
      case 'test.history.rerun': await tests.rerunHistory(message.runId, message.kind); break;
      case 'test.history.export': await tests.exportRunReport(message.runId, message.format, message.kind); break;
      case 'test.history.request': await tests.postHistory(); break;
      case 'test.history.clear': await tests.clearHistory(message.kind); break;
      case 'test.baseline.accept': await tests.acceptBaseline(message.runId); break;
      case 'test.rerun': await tests.rerun(message.status); break;
      case 'test.cancel': tests.cancel(); break;
      case 'test.capture': await captureTest(message.source, message.suggestedKind ?? 'contract', message.requestId); break;
      case 'adversarial.capture': await captureTest({ kind: 'conversation' }, 'adversarial', message.requestId); break;
      case 'test.evidence.open': await tests.openEvidence(message.evidenceId); post({ type: 'inspector.focus', tab: message.location.kind === 'network' ? 'Network' : message.location.kind === 'normalizedEvent' ? 'Normalized' : 'Raw Events', evidenceId: message.evidenceId, networkId: message.location.kind === 'network' ? message.location.networkId : undefined, sequence: message.location.kind === 'rawEvent' || message.location.kind === 'normalizedEvent' ? message.location.sequence : undefined }); break;
      case 'test.report.export': await tests.exportReport(message.format, message.evidenceId, message.kind); break;
      case 'test.timeline.open': await tests.postTimeline(message.evidenceId); break;
      case 'test.evidenceBundle.export': await tests.exportEvidenceBundle(); break;
      case 'campaign.preview': await campaigns.preview(message.campaignId); break;
      case 'campaign.run': await campaigns.run(message.campaignId); break;
      case 'campaign.cancel': campaigns.cancel(message.campaignId); break;
      case 'campaign.resume': await campaigns.run(message.campaignId, message.runId); break;
      case 'campaign.acceptBaseline': await campaigns.acceptBaseline(message.campaignId, message.runId); break;
      case 'campaign.exportResults': await campaigns.exportResults(message.campaignId, message.runId); break;
      case 'campaign.copilotSummary':
      case 'copilot.diagnose':
      case 'copilot.qualityReview':
      case 'copilot.profileDoctor': notifyUnavailable('GitHub Copilot features are available only in the VS Code extension.', message.requestId); break;
      case 'connection.analyze': insights.analyzeConnection(); break;
      case 'visual.baseline.save': await insights.saveBaseline(message.dataUrl, message.viewport); break;
      case 'visual.compare': await insights.compare(message.dataUrl, message.viewport); break;
      case 'adversarial.catalog.request': await tests.postCatalog('adversarial'); break;
      case 'contract.catalog.request': await tests.postCatalog('contract'); break;
      case 'adversarial.case.request': await tests.loadCase('adversarial', message.sourcePath, message.scenarioId); break;
      case 'contract.case.request': await tests.loadCase('contract', message.sourcePath, message.scenarioId); break;
      case 'adversarial.case.save': await tests.saveCase('adversarial', message.sourcePath, message.scenarioId, message.expectedRevision, message.scenario); break;
      case 'adversarial.case.delete': await tests.deleteCase('adversarial', message.sourcePath, message.scenarioId, message.expectedRevision); break;
      case 'adversarial.openLinkedSuite': await tests.exportSuite(message.path); break;
      case 'contract.case.save': await tests.saveCase('contract', message.sourcePath, message.scenarioId, message.expectedRevision, message.scenario); break;
      case 'contract.case.delete': await tests.deleteCase('contract', message.sourcePath, message.scenarioId, message.expectedRevision); break;
      case 'contract.openLinkedSuite': await tests.exportSuite(message.path); break;
      case 'adversarial.file':
        if (message.action === 'csvTemplate') tests.exportTemplate('adversarial');
        else if (message.action === 'importCsv') await tests.importSuite('adversarial', 'csv');
        else if (message.action === 'importJsonl') await tests.importSuite('adversarial', 'jsonl');
        else if (message.action === 'importJsonc') await tests.importSuite('adversarial', 'jsonc');
        else if (message.action === 'linkSuite' || message.action === 'linkJsonc') notifyUnavailable('Linking workspace files is available only in the VS Code extension.', message.requestId);
        else if (message.action === 'exportCsv') await tests.exportSuites('adversarial', 'csv');
        else if (message.action === 'exportJsonc') await tests.exportSuites('adversarial', 'jsonc');
        else if (message.action === 'exportJsonl') await tests.exportSuites('adversarial', 'jsonl');
        break;
      case 'contract.file':
        if (message.action === 'csvTemplate') tests.exportTemplate('contract');
        else if (message.action === 'importJsonc') await tests.importSuite('contract', 'jsonc');
        else if (message.action === 'importCsv') await tests.importSuite('contract', 'csv');
        else if (message.action === 'exportJsonc') await tests.exportSuites('contract', 'jsonc');
        else if (message.action === 'exportCsv') await tests.exportSuites('contract', 'csv');
        else notifyUnavailable('Linking workspace files is available only in the VS Code extension.', message.requestId);
        break;
      case 'uri.open': openExternalUri(message.uri); break;
      case 'profile.openAsText': onOpenReference?.('source'); break;
      case 'artifact.action': if (message.action === 'copyPath') await copyText(message.artifactId); else notifyUnavailable('The browser already downloaded this artifact. Use the browser Downloads panel to open or reveal it.', message.requestId); break;
      case 'history.remote.apply': notifyUnavailable('Remote session references require an application backend and are not stored by TurnStage Web.', message.requestId); break;
      case 'output.open': notifyUnavailable('Output logs are shown in the browser developer console.', message.requestId); break;
      case 'testExplorer.open': notifyUnavailable('VS Code Test Explorer is unavailable in Web. Use the Tests workspace.', message.requestId); break;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (message.type === 'visual.baseline.save' || message.type === 'visual.compare') post({ type: 'visual.error', operation: message.type === 'visual.baseline.save' ? 'baseline' : 'compare', message: detail }, message.requestId);
    else post({ type: 'request.error', error: { type: 'WebRuntimeError', message: detail } }, message.requestId);
  }
}

function hydrate(requestId?: string): void {
  const locale = normalizeLocale(preferences.locale ?? navigator.language);
  post({ type: 'host.ready', trusted: true, remoteName: 'Browser', locale, direction: 'ltr', hostKind: 'web' }, requestId);
  postProfile();
  const current = session.current;
  post({ type: 'session.snapshot', snapshot: current.snapshot, runs: runSummaries, requestPreview: current.requestPreview, networkEntries: current.networkEntries });
  post({ type: 'test.results', results: [], automationResults: [] });
  void refreshRuns();
  void campaigns.postDashboard();
  void tests.postHistory();
}

function postProfile(): void {
  const parsed = codec.parse(active.raw);
  post({ type: 'profile.snapshot', profile: parsed.profile, ...(parsed.errors.length ? { parseError: 'Invalid JSONC' } : {}), version: active.updatedAt, environments: environments.map((item) => item.id), readOnly: Boolean(active.builtIn) });
  post({ type: 'profile.validation', diagnostics: diagnostics(active.raw) });
  post({ type: 'profile.editState', dirty: false });
  void campaigns.postDashboard();
}

function patchProfile(path: Array<string | number>, value: unknown): void {
  const source = active;
  if (source.builtIn) { notifyUnavailable('This server-managed Profile is read-only. Select Duplicate to create an editable browser-local copy.'); return; }
  const draft = source;
  const previousId = draft.id;
  const edits = modify(draft.raw, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  const raw = applyEdits(draft.raw, edits);
  const parsed = codec.parse(raw);
  if (!parsed.profile) { post({ type: 'profile.validation', diagnostics: diagnostics(raw) }); return; }
  const profile = parsed.profile;
  if (profile.id !== previousId && profiles.some((item) => item.id === profile.id)) { post({ type: 'profile.validation', diagnostics: [{ severity: 'error', message: `Profile id ${profile.id} already exists in this browser.`, offset: 0, length: 1 }] }); return; }
  active = { ...draft, id: profile.id, name: profile.name, raw, updatedAt: Date.now() };
  profiles = replaceProfile(profiles, previousId, active);
  persistLibrary();
  activeEnvironmentItem = environmentFor(profile);
  session.updateProfile(profile, activeEnvironment());
  void session.start();
  postProfile();
  onLibraryChanged?.();
}

function validateActive(requestId?: string): void {
  const issues = diagnostics(active.raw);
  post({ type: 'profile.validation', diagnostics: issues }, requestId);
  post({ type: 'profile.validated', valid: issues.length === 0 }, requestId);
}

function diagnostics(raw: string): ProfileSourceDiagnostic[] {
  const parsed = codec.parse(raw);
  if (parsed.errors.length) return parsed.errors.map((error) => ({ code: 'jsonc.syntax', severity: 'error', message: `Invalid JSONC (${error.error})`, offset: error.offset, length: error.length, path: [] }));
  if (!parsed.profile) return [{ code: 'jsonc.root', severity: 'error', message: 'The profile root must be an object.', offset: 0, length: 1, path: [] }];
  const availableEnvironments = environments.flatMap((item) => { const environment = parseEnvironment(item.raw); return environment ? [environment] : []; });
  const semantic = validator.validate(parsed.profile, parsed.tree, availableEnvironments).map((issue) => ({ ...issue, code: 'profile.semantic', path: [] }));
  return [...schemaDiagnostics(parsed.profile, parsed.tree, preferences.locale), ...semantic, ...webCompatibilityDiagnostics(parsed.profile, parsed.tree, availableEnvironments, preferences.locale)];
}

function selectProfile(id: string): void {
  const selected = profiles.find((item) => item.id === id);
  if (!selected) return;
  session?.dispose();
  active = selected;
  activeEnvironmentItem = environmentFor(activeProfile());
  preferences.activeProfileId = active.id;
  preferences.activeEnvironmentId = activeEnvironmentItem.id;
  savePreferences(preferences);
  window.history.replaceState(window.history.state, '', profileUrl(window.location.href, active.id));
  runSummaries = [];
  session = createSession(active);
  postProfile();
  void tests.postHistory();
  const current = session.current;
  post({ type: 'session.snapshot', snapshot: current.snapshot, runs: runSummaries, networkEntries: [] });
  void refreshRuns();
  onLibraryChanged?.();
}

async function retainCompletedRun(profile: TurnStageProfile, state: BrowserSessionState): Promise<void> {
  if (state.snapshot.replay || !['completed', 'failed', 'aborted'].includes(state.snapshot.turnState) || profile.history?.localRuns?.enabled === false) return;
  const user = [...state.snapshot.messages].reverse().find((item) => item.role === 'user');
  const turnId = typeof user?.metadata?.clientRequestId === 'string' ? user.metadata.clientRequestId : undefined;
  if (!turnId || recordedTurns.has(turnId)) return;
  recordedTurns.add(turnId);
  const failed = state.snapshot.errors.at(-1);
  const result: LocalRun['result'] = state.snapshot.turnState === 'completed' ? { type: 'completed' } : state.snapshot.turnState === 'aborted' ? { type: 'aborted', reason: 'user_cancel' } : { type: 'failed', error: failed ?? { type: 'BrowserRequestError', message: 'The browser request failed.' } };
  const settings = profile.history?.localRuns;
  const run: LocalRun = {
    id: turnId,
    profileId: profile.id,
    createdAt: Date.now(),
    request: state.requestPreview as LocalRun['request'],
    metrics: structuredClone(state.snapshot.metrics),
    result,
    ...(settings?.recordRawEvents === false ? {} : { rawEvents: structuredClone(state.snapshot.rawEvents) }),
    ...(settings?.recordNormalizedEvents === false ? {} : { normalizedEvents: structuredClone(state.snapshot.normalizedEvents) }),
    ...(settings?.recordChatSnapshot === false ? {} : { snapshot: structuredClone(state.snapshot) }),
  };
  const safe = redactKnownSecrets(run, [...secrets.values()]) as LocalRun;
  await artifacts.put<LocalRun>('runs', { id: `${profile.id}:${turnId}`, profileId: profile.id, kind: 'conversation', name: new Date(run.createdAt).toISOString(), updatedAt: run.createdAt, value: safe });
  const retention = Math.max(1, Math.min(100, settings?.maxRuns ?? 20));
  const stored = (await artifacts.list<LocalRun>('runs', profile.id)).filter((item) => item.kind === 'conversation');
  for (const stale of stored.slice(retention)) await artifacts.delete('runs', stale.id);
  await refreshRuns();
}

async function refreshRuns(): Promise<void> {
  const records = await artifacts.list<LocalRun>('runs', active.id);
  runSummaries = records.filter((item) => item.kind === 'conversation').map(({ value }) => summarizeRun(value));
  const current = session.current;
  post({ type: 'session.snapshot', snapshot: current.snapshot, runs: runSummaries, requestPreview: current.requestPreview, networkEntries: current.networkEntries });
}

function summarizeRun(run: LocalRun): LocalRunSummary {
  return { id: run.id, profileId: run.profileId, createdAt: run.createdAt, metrics: run.metrics, result: run.result, replayable: Boolean(run.rawEvents?.length), hasSnapshot: Boolean(run.snapshot), rawEventCount: run.rawEvents?.length, normalizedEventCount: run.normalizedEvents?.length };
}

async function findRun(runId: string): Promise<LocalRun | undefined> {
  return (await artifacts.list<LocalRun>('runs', active.id)).find((item) => item.kind === 'conversation' && item.value.id === runId)?.value;
}

async function replayRun(runId: string, speed: 0.25 | 0.5 | 1 | 2 | 4): Promise<void> {
  const run = await findRun(runId);
  if (!run) throw new Error('The selected browser-local run no longer exists.');
  if (!session.replayRun(run, speed)) throw new Error('This run has no raw events or another request is active.');
}

async function exportRun(runId: string, requestId?: string): Promise<void> {
  const run = await findRun(runId);
  if (!run) throw new Error('The selected browser-local run no longer exists.');
  const name = `turnstage-run-${run.id}.json`;
  download(name, JSON.stringify({ format: 'turnstage-run', version: 1, exportedAt: Date.now(), run }, null, 2), 'application/json');
  post({ type: 'run.exported', path: name }, requestId);
}

async function importRun(requestId?: string): Promise<void> {
  const selected = await pickFile('.json,application/json');
  if (!selected) return;
  if (selected.text.length > 20 * 1024 * 1024) throw new Error('The selected run is larger than 20 MB.');
  const parsed = JSON.parse(selected.text) as { format?: string; version?: number; run?: unknown };
  const candidate = parsed.format === 'turnstage-run' && parsed.version === 1 ? parsed.run : parsed;
  if (!candidate || typeof candidate !== 'object') throw new Error('The selected file is not a supported TurnStage run export.');
  const run = candidate as LocalRun;
  if (run.profileId !== active.id || typeof run.id !== 'string' || !run.metrics || !run.result) throw new Error(`This run does not belong to profile ${active.id}.`);
  const duplicate = Boolean(await findRun(run.id));
  const imported = redactKnownSecrets({ ...structuredClone(run), id: duplicate ? browserUuid() : run.id }, [...secrets.values()]) as LocalRun;
  await artifacts.put<LocalRun>('runs', { id: `${active.id}:${imported.id}`, profileId: active.id, kind: 'conversation', name: selected.name, updatedAt: Date.now(), value: imported });
  await refreshRuns();
  post({ type: 'run.imported', path: selected.name, runId: imported.id, duplicate }, requestId);
}

async function deleteRun(runId: string): Promise<void> {
  const records = await artifacts.list<LocalRun>('runs', active.id);
  const record = records.find((item) => item.kind === 'conversation' && item.value.id === runId);
  if (!record) return;
  await artifacts.delete('runs', record.id);
  await refreshRuns();
  post({ type: 'run.history.changed', deletedCount: 1, deletedBytes: JSON.stringify(record.value).length });
}

async function clearRuns(): Promise<void> {
  const records = (await artifacts.list<LocalRun>('runs', active.id)).filter((item) => item.kind === 'conversation');
  for (const record of records) await artifacts.delete('runs', record.id);
  await refreshRuns();
  post({ type: 'run.history.changed', deletedCount: records.length, deletedBytes: records.reduce((sum, item) => sum + JSON.stringify(item.value).length, 0) });
}

async function captureTest(source: { kind: 'conversation' } | { kind: 'run'; runId: string } | { kind: 'evidence'; evidenceId: string }, kind: 'contract' | 'adversarial', requestId?: string): Promise<void> {
  const snapshot = source.kind === 'conversation' ? session.current.snapshot : source.kind === 'run' ? (await findRun(source.runId))?.snapshot : (await tests.evidenceResult(source.evidenceId))?.result.evidence.snapshot;
  if (!snapshot) throw new Error('The selected browser-local evidence is no longer available.');
  const existing = new Set((await tests.scenarioEntries()).map((item) => item.scenario.id));
  const lastText = [...snapshot.messages].reverse().find((item) => item.role === 'user')?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join(' ').trim();
  const forbidText = kind === 'adversarial' ? window.prompt('Forbidden response text for this adversarial draft:')?.trim() : undefined;
  if (kind === 'adversarial' && !forbidText) return;
  const scenario = buildCapturedScenario({ kind, name: (lastText || `Captured ${kind} case`).slice(0, 120), snapshot, profile: activeProfile(), source, existingIds: existing, ...(forbidText ? { forbid: { content: [forbidText] } } : {}) });
  const sourcePath = await tests.saveCapturedScenario(scenario, kind);
  post({ type: 'test.captured', detail: t('Test case saved: {name}', { name: scenario.name }), kind, scenarioId: scenario.id, sourcePath }, requestId);
  post({ type: 'workspace.navigate', destination: kind === 'adversarial' ? { pane: 'adversarial', section: 'cases' } : { pane: 'tests', section: 'scenarios' } });
}

function importProfile(file: File): void {
  void file.text().then((source) => {
    const bundle = decodeWebProfileBundle(source);
    if (bundle) { importProfileBundle(bundle.profile, bundle.environment); return; }
    const parsed = codec.parse(source);
    if (!parsed.profile) throw new Error('The selected file is not valid TurnStage JSONC.');
    const id = uniqueId(parsed.profile.id);
    const raw = id === parsed.profile.id ? source : applyEdits(source, modify(source, ['id'], id, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const item: StoredProfile = { id, name: parsed.profile.name, raw, updatedAt: Date.now() };
    profiles = [...profiles, item];
    persistLibrary();
    selectProfile(item.id);
  }).catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
}

function importProfileBundle(profileValue: TurnStageProfile, environmentValue: TurnStageEnvironment): void {
  let environmentRaw = JSON.stringify(environmentValue, null, 2);
  const parsedEnvironment = parseEnvironment(environmentRaw);
  if (!parsedEnvironment) throw new Error('The bundled Environment is not a valid TurnStage environment.');
  let profileRaw = JSON.stringify(profileValue, null, 2);
  const parsedProfile = codec.parse(profileRaw).profile;
  if (!parsedProfile) throw new Error('The bundled Profile is not a valid TurnStage Profile.');
  if (parsedProfile.environment !== parsedEnvironment.id) throw new Error('The bundled Profile does not reference its bundled Environment.');

  const environmentId = uniqueEnvironmentId(parsedEnvironment.id);
  if (environmentId !== parsedEnvironment.id) {
    environmentRaw = applyEdits(environmentRaw, modify(environmentRaw, ['id'], environmentId, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    profileRaw = applyEdits(profileRaw, modify(profileRaw, ['environment'], environmentId, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  const profileId = uniqueId(parsedProfile.id);
  if (profileId !== parsedProfile.id) profileRaw = applyEdits(profileRaw, modify(profileRaw, ['id'], profileId, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));

  const finalProfile = codec.parse(profileRaw);
  const finalEnvironment = parseEnvironment(environmentRaw);
  if (!finalProfile.profile || !finalEnvironment) throw new Error('The imported Profile bundle could not be normalized.');
  const issues = validator.validate(finalProfile.profile, finalProfile.tree, [finalEnvironment]);
  const firstError = issues.find((issue) => issue.severity === 'error');
  if (firstError) throw new Error(`The bundled Profile is invalid: ${firstError.message}`);

  const timestamp = Date.now();
  const profileItem: StoredProfile = { id: profileId, name: finalProfile.profile.name, raw: profileRaw, updatedAt: timestamp };
  const environmentItem: StoredEnvironment = { id: environmentId, name: finalEnvironment.name, raw: environmentRaw, updatedAt: timestamp };
  const previousProfiles = profiles.filter((item) => !item.builtIn);
  const previousEnvironments = environments.filter((item) => !item.builtIn);
  const nextProfiles = [...previousProfiles, profileItem];
  const nextEnvironments = [...previousEnvironments, environmentItem];
  try {
    saveEnvironments(nextEnvironments);
    saveProfiles(nextProfiles);
  } catch (error) {
    try { saveEnvironments(previousEnvironments); saveProfiles(previousProfiles); } catch { /* Preserve the original storage failure. */ }
    throw error;
  }
  profiles = mergeCatalogEntries(officialProfiles, nextProfiles);
  environments = mergeCatalogEntries(officialEnvironments, nextEnvironments);
  activeEnvironmentItem = environmentItem;
  selectProfile(profileItem.id);
}

function createBlankProfile(): void {
  const labels = copy(normalizeLocale(preferences.locale ?? navigator.language));
  const id = uniqueId('profile');
  const profile: TurnStageProfile = {
    version: 1,
    id,
    name: labels.newProfileName,
    environment: activeEnvironmentItem.id,
    conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat', variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
    stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
  };
  const item: StoredProfile = { id, name: profile.name, raw: JSON.stringify(profile, null, 2), updatedAt: Date.now() };
  profiles = [...profiles, item];
  persistLibrary();
  selectProfile(item.id);
}

function duplicateProfile(source: StoredProfile): StoredProfile {
  const item = deriveLocalProfile(source);
  profiles = [...profiles, item];
  persistLibrary();
  selectProfile(item.id);
  return item;
}
function duplicateActive(): void { duplicateProfile(active); }

function saveProfileSource(id: string, raw: string): ProfileSourceSaveResult {
  const source = profiles.find((item) => item.id === id);
  if (!source || source.builtIn) return { ok: false, error: 'This Profile is read-only.' };
  const issues = diagnostics(raw).filter((issue) => issue.severity === 'error');
  if (issues.length) return { ok: false, error: issues[0]!.message, offset: issues[0]!.offset };
  const profile = codec.parse(raw).profile;
  if (!profile) return { ok: false, error: 'Invalid JSONC.' };
  if (profile.id !== id && profiles.some((item) => item.id === profile.id)) return { ok: false, error: `Profile id ${profile.id} already exists in this browser.` };
  const updated: StoredProfile = { ...source, id: profile.id, name: profile.name, raw, updatedAt: Date.now() };
  const next = replaceProfile(profiles, id, updated);
  try { saveProfiles(next.filter((item) => !item.builtIn)); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  profiles = next;
  if (active.id === id) selectProfile(updated.id);
  else onLibraryChanged?.();
  return { ok: true, id: updated.id, raw };
}

function exportProfile(item: StoredProfile): void {
  const profile = codec.parse(item.raw).profile ?? fallbackProfile(item);
  const environmentItem = environments.find((item) => item.id === profile.environment);
  if (!environmentItem) { window.alert(`Profile ${profile.name} references an Environment that is not available in this browser.`); return; }
  const environment = parseEnvironment(environmentItem.raw);
  if (!environment) { window.alert(`Environment ${environmentItem.name} is invalid and cannot be exported.`); return; }
  try {
    download(`${item.id}.turnstage-profile.json`, encodeWebProfileBundle(profile, environment), 'application/json');
  } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
}

function deleteProfile(item: StoredProfile): void {
  if (item.builtIn || profiles.length <= 1) return;
  const locale = normalizeLocale(preferences.locale ?? navigator.language);
  const restoresOfficial = officialProfiles.some((official) => official.id === item.id);
  const message = restoresOfficial
    ? locale === 'zh-TW' ? `還原預設設定檔「${item.name}」？\n\n目前瀏覽器中的個人修改會被移除。` : locale === 'ja' ? `デフォルトのプロファイル「${item.name}」に戻しますか？\n\nこのブラウザー内の変更は削除されます。` : locale === 'ko' ? `기본 프로필 "${item.name}"(으)로 복원할까요?\n\n이 브라우저에 저장된 개인 변경 사항이 제거됩니다.` : `Restore the default Profile "${item.name}"?\n\nBrowser-local changes to this Profile will be removed.`
    : locale === 'zh-TW' ? `刪除設定檔「${item.name}」？\n\n此瀏覽器中的設定檔會被移除。` : locale === 'ja' ? `プロファイル「${item.name}」を削除しますか？\n\nこのブラウザーに保存されたプロファイルは削除されます。` : locale === 'ko' ? `프로필 "${item.name}"을(를) 삭제할까요?\n\n이 브라우저에 저장된 프로필이 제거됩니다.` : `Delete Profile "${item.name}"?\n\nThis browser-local Profile will be removed.`;
  if (!window.confirm(message)) return;
  const deletedId = item.id;
  const wasActive = active.id === deletedId;
  const localProfiles = profiles.filter((item) => !item.builtIn && item.id !== deletedId);
  profiles = mergeCatalogEntries(officialProfiles, localProfiles);
  if (wasActive) active = profiles.find((item) => item.id === deletedId) ?? profiles[0]!;
  persistLibrary();
  if (wasActive) selectProfile(active.id);
  else onLibraryChanged?.();
}

function confirmSessionChange(action: 'clear' | 'restart'): boolean {
  const locale = normalizeLocale(preferences.locale ?? navigator.language);
  const messages = {
    'zh-TW': action === 'clear' ? '清除目前對話？\n\n訊息、對話 ID、網路請求與事件資料都會移除；錄製的執行記錄會保留。' : '開始新對話？\n\n目前訊息、對話 ID 與事件資料會清除；錄製的執行記錄會保留。',
    ja: action === 'clear' ? '現在の会話を消去しますか？\n\nメッセージ、会話 ID、通信履歴、イベントデータが削除されます。記録済みの実行履歴は残ります。' : '新しい会話を始めますか？\n\n現在のメッセージ、会話 ID、イベントデータが削除されます。記録済みの実行履歴は残ります。',
    ko: action === 'clear' ? '현재 대화를 지울까요?\n\n메시지, 대화 ID, 네트워크 기록 및 이벤트 데이터가 제거됩니다. 저장된 실행 기록은 유지됩니다.' : '새 대화를 시작할까요?\n\n현재 메시지, 대화 ID 및 이벤트 데이터가 제거됩니다. 저장된 실행 기록은 유지됩니다.',
    en: action === 'clear' ? 'Clear the current conversation?\n\nMessages, conversation ID, network entries, and event data will be removed. Recorded runs are kept.' : 'Start a new conversation?\n\nCurrent messages, conversation ID, and event data will be cleared. Recorded runs are kept.',
  };
  return window.confirm(messages[locale as keyof typeof messages] ?? messages.en);
}

function persistLibrary(): void {
  saveProfiles(profiles.filter((item) => !item.builtIn));
  preferences.activeProfileId = active.id;
  savePreferences(preferences);
}

function post(payload: HostPayload, requestId: string = browserUuid()): void {
  // Match the structured-clone boundary used by VS Code and omit undefined fields.
  const message = JSON.parse(JSON.stringify({ ...payload, protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'turnstage-web', requestId })) as HostMessage;
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function notifyUnavailable(message: string, requestId?: string): void { post({ type: 'request.error', error: { type: 'WebCapabilityUnavailable', message } }, requestId); }
function openExternalUri(uri: string): void { if (!/^https?:\/\//iu.test(uri)) throw new Error('TurnStage Web can open only HTTP or HTTPS links.'); window.open(uri, '_blank', 'noopener,noreferrer'); }

function openCitation(citationId: string): void {
  const citation = session.current.snapshot.messages.flatMap((item) => item.citations).find((item) => item.id === citationId);
  const uri = citation?.uri;
  if (!uri || !/^https?:\/\//iu.test(uri)) throw new Error('TurnStage Web can open only HTTP or HTTPS citations.');
  openExternalUri(uri);
}

async function invokeAction(actionId: string, sourceMessageId: string | undefined, requestId?: string): Promise<void> {
  const source = sourceMessageId ? session.current.snapshot.messages.find((item) => item.id === sourceMessageId) : undefined;
  if (actionId === 'message.copy') {
    await copyText(source?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('') ?? '');
    if (sourceMessageId) post({ type: 'action.feedback', actionId, sourceMessageId, status: 'success', message: 'Message copied.' }, requestId);
    return;
  }
  if (actionId === 'message.retry') { const text = [...session.current.snapshot.messages].reverse().find((item) => item.role === 'user')?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join(''); if (text) await session.send(text, { kind: 'retry', sourceMessageId }); return; }
  if (actionId === 'request.abort') { await session.abort(); return; }
  if (actionId === 'conversation.new') { if (confirmSessionChange('restart')) await session.newConversation(); return; }
  if (actionId === 'conversation.clear') { if (confirmSessionChange('clear')) session.clear(); return; }
  const action = source?.actions.find((item) => item.id === actionId || item.actionId === actionId);
  if (!action) throw new Error('The selected response action is no longer available.');
  if (action.confirm && !window.confirm(`${action.confirm.title}\n\n${action.confirm.message ?? ''}`)) return;
  const payload = action.payload ?? {};
  const payloadText = [payload.text, payload.prompt, payload.message].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (['request.send', 'request.resend', 'followup.send'].includes(action.actionId)) {
    const text = payloadText ?? [...session.current.snapshot.messages].reverse().find((item) => item.role === 'user')?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('');
    if (!text) throw new Error('This response action does not provide a message to send.');
    await session.send(text, { kind: 'responseAction', actionId: action.id, actionKey: typeof payload.interactionKey === 'string' ? payload.interactionKey : action.actionId, sourceMessageId });
    return;
  }
  if (action.actionId === 'citation.open' && typeof payload.citationId === 'string') { openCitation(payload.citationId); return; }
  if (action.actionId === 'uri.open' && typeof payload.uri === 'string') { openExternalUri(payload.uri); return; }
  if (['input.fill', 'event.inspect', 'form.open', 'form.submit', 'form.cancel'].includes(action.actionId)) return;
  throw new Error(`Response action ${action.actionId} is unavailable in the browser runtime.`);
}

function DisclosureChevron(): React.JSX.Element {
  return <svg className="disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ProfileLibrary(): React.JSX.Element {
  const [, render] = useState(0);
  const [, renderSecrets] = useState(0);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | 'official' | 'local'>('all');
  const [organization, setOrganization] = useState(loadProfileOrganization);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [referencePage, setReferencePage] = useState<ReferencePage | undefined>();
  const [referenceProfileId, setReferenceProfileId] = useState<string | undefined>();
  const [itemMenu, setItemMenu] = useState<{ id: string; top: number; left: number } | undefined>();
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeProfileButton = useRef<HTMLButtonElement>(null);
  const itemMenuRef = useRef<HTMLDivElement>(null);
  const itemMenuTrigger = useRef<HTMLButtonElement>(null);
  onLibraryChanged = () => render((value) => value + 1);
  onOpenReference = (page) => { setReferenceProfileId(active.id); setReferencePage(page); };
  const locale = normalizeLocale(preferences.locale ?? navigator.language);
  const labels = useMemo(() => copy(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.getElementById('profile-root')?.setAttribute('aria-label', labels.profiles);
  }, [locale, labels.profiles]);
  useEffect(() => { activeProfileButton.current?.scrollIntoView({ block: 'nearest' }); }, [active.id]);
  useEffect(() => { if (libraryOpen) searchInput.current?.focus(); }, [libraryOpen]);
  useEffect(() => {
    if (!itemMenu) return;
    itemMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!itemMenuRef.current?.contains(event.target as Node) && !itemMenuTrigger.current?.contains(event.target as Node)) setItemMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setItemMenu(undefined); itemMenuTrigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [itemMenu]);
  useEffect(() => {
    if (!libraryOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setLibraryOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [libraryOpen]);
  const updateOrganization = (next: ProfileOrganization) => { const normalized = normalizeProfileOrganization(next); setOrganization(normalized); saveProfileOrganization(normalized); };
  const createFolder = (parentId?: string) => {
    const name = window.prompt(labels.folderName)?.trim().slice(0, 60);
    if (!name || organization.folders.length >= 100) return;
    let depth = 0;
    let ancestor = parentId;
    while (ancestor) { depth++; ancestor = organization.folders.find((folder) => folder.id === ancestor)?.parentId; }
    if (depth >= 8) return;
    updateOrganization({ ...organization, folders: [...organization.folders, { id: browserUuid(), name, ...(parentId ? { parentId } : {}) }] });
  };
  const renameFolder = (id: string, previous: string) => {
    const name = window.prompt(labels.renameFolder, previous)?.trim().slice(0, 60);
    if (!name) return;
    updateOrganization({ ...organization, folders: organization.folders.map((folder) => folder.id === id ? { ...folder, name } : folder) });
  };
  const deleteFolder = (id: string, name: string) => {
    if (!window.confirm(labels.confirmDeleteFolder.replace('{name}', name))) return;
    const parentId = organization.folders.find((folder) => folder.id === id)?.parentId;
    const assignments = { ...organization.assignments };
    for (const [profileId, folderId] of Object.entries(assignments)) if (folderId === id) { if (parentId) assignments[profileId] = parentId; else delete assignments[profileId]; }
    updateOrganization({ folders: organization.folders.filter((folder) => folder.id !== id).map((folder) => folder.parentId === id ? { ...folder, parentId } : folder), assignments, collapsed: organization.collapsed.filter((folderId) => folderId !== `folder:${id}`) });
  };
  const moveFolder = (id: string, direction: -1 | 1) => {
    const folders = [...organization.folders];
    const index = folders.findIndex((folder) => folder.id === id);
    const siblings = folders.map((folder, position) => folder.parentId === folders[index]?.parentId ? position : -1).filter((position) => position >= 0);
    const siblingIndex = siblings.indexOf(index);
    const target = siblings[siblingIndex + direction];
    if (index < 0 || target === undefined) return;
    [folders[index], folders[target]] = [folders[target]!, folders[index]!];
    updateOrganization({ ...organization, folders });
  };
  const assignFolder = (profileId: string, folderId: string) => {
    const assignments = { ...organization.assignments };
    if (folderId) assignments[profileId] = folderId; else delete assignments[profileId];
    updateOrganization({ ...organization, assignments });
  };
  const toggleFolder = (id: string) => updateOrganization({ ...organization, collapsed: organization.collapsed.includes(id) ? organization.collapsed.filter((item) => item !== id) : [...organization.collapsed, id] });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProfiles = profiles.filter((item) => {
    if (source === 'official' && !item.builtIn) return false;
    if (source === 'local' && item.builtIn) return false;
    if (!normalizedQuery) return true;
    return [item.name, item.id, item.official?.category, ...(item.official?.tags ?? [])].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
  type LibraryGroup = { id: string; name: string; items: StoredProfile[]; children: LibraryGroup[]; customId?: string };
  const officialRoot: LibraryGroup = { id: 'official', name: labels.official, items: [], children: [] };
  const localRoot: LibraryGroup = { id: 'local', name: labels.browser, items: [], children: [] };
  const serverFolders = new Map<string, LibraryGroup>();
  const customFolders = new Map(organization.folders.map((folder) => [folder.id, { id: `folder:${folder.id}`, name: folder.name, items: [], children: [], customId: folder.id } as LibraryGroup]));
  for (const folder of organization.folders) (folder.parentId ? customFolders.get(folder.parentId) : localRoot)?.children.push(customFolders.get(folder.id)!);
  for (const item of visibleProfiles) {
    const assigned = organization.assignments[item.id];
    if (!item.builtIn && assigned && customFolders.has(assigned)) { customFolders.get(assigned)!.items.push(item); continue; }
    if (!item.builtIn) { localRoot.items.push(item); continue; }
    let parent = officialRoot;
    const path: string[] = [];
    for (const segment of item.official?.folderPath ?? []) {
      path.push(segment);
      const key = path.join('/');
      let group = serverFolders.get(key);
      if (!group) { group = { id: `server:${key}`, name: segment, items: [], children: [] }; serverFolders.set(key, group); parent.children.push(group); }
      parent = group;
    }
    parent.items.push(item);
  }
  const hasContent = (group: LibraryGroup): boolean => group.items.length > 0 || group.children.some(hasContent);
  const groups = [officialRoot, localRoot].filter((group) => hasContent(group) || group.id === 'local' && source !== 'official' && !normalizedQuery && organization.folders.length > 0);
  const folderPath = (id: string): string => { const names: string[] = []; let current = organization.folders.find((folder) => folder.id === id); while (current) { names.unshift(current.name); current = organization.folders.find((folder) => folder.id === current?.parentId); } return names.join(' / '); };
  const countProfiles = (group: LibraryGroup): number => group.items.length + group.children.reduce((count, child) => count + countProfiles(child), 0);
  const openItemMenu = (item: StoredProfile, button: HTMLButtonElement) => {
    if (itemMenu?.id === item.id) { setItemMenu(undefined); return; }
    const bounds = button.getBoundingClientRect();
    itemMenuTrigger.current = button;
    setFolderPickerOpen(false);
    const menuHeight = 168;
    setItemMenu({ id: item.id, top: bounds.bottom + menuHeight > window.innerHeight ? Math.max(8, bounds.top - menuHeight) : bounds.bottom + 4, left: Math.max(8, Math.min(bounds.right - 210, window.innerWidth - 218)) });
  };
  const menuItem = profiles.find((item) => item.id === itemMenu?.id);
  const referenceItem = profiles.find((item) => item.id === referenceProfileId) ?? active;
  const closeItemMenu = () => { setItemMenu(undefined); itemMenuTrigger.current?.focus(); };
  const navigateItemMenu = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { setItemMenu(undefined); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  };
  const renderGroup = (group: LibraryGroup, depth = 0): React.JSX.Element => {
    const collapsed = !normalizedQuery && organization.collapsed.includes(group.id);
    const siblings = organization.folders.filter((folder) => folder.parentId === organization.folders.find((folder) => folder.id === group.customId)?.parentId);
    const siblingIndex = siblings.findIndex((folder) => folder.id === group.customId);
    return <section className="profile-folder" key={group.id} style={{ '--folder-depth': depth } as React.CSSProperties}><div className="folder-heading"><button className="folder-toggle" aria-expanded={!collapsed} aria-controls={`profiles-${group.id}`} onClick={() => toggleFolder(group.id)}><span aria-hidden="true" className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} /><span className="folder-name" title={group.name}>{group.name}</span><span className="folder-count">{countProfiles(group)}</span></button>{group.customId && <div className="folder-actions"><IconButton className="sidebar-icon" icon="folder-opened" label={`${labels.newSubfolder}: ${group.name}`} disabled={depth >= 8 || organization.folders.length >= 100} onClick={() => createFolder(group.customId)} /><IconButton className="sidebar-icon" icon="arrow-up" label={`${labels.moveFolderUp}: ${group.name}`} disabled={siblingIndex <= 0} onClick={() => moveFolder(group.customId!, -1)} /><IconButton className="sidebar-icon" icon="arrow-down" label={`${labels.moveFolderDown}: ${group.name}`} disabled={siblingIndex >= siblings.length - 1} onClick={() => moveFolder(group.customId!, 1)} /><IconButton className="sidebar-icon" icon="edit" label={`${labels.renameFolder}: ${group.name}`} onClick={() => renameFolder(group.customId!, group.name)} /><IconButton className="sidebar-icon" icon="trash" label={`${labels.deleteFolder}: ${group.name}`} onClick={() => deleteFolder(group.customId!, group.name)} /></div>}</div><div id={`profiles-${group.id}`} hidden={collapsed}>{group.items.map((item) => { const sourceLabel = profileSourceLabel(item, labels); return <div className={`profile-item-row${itemMenu?.id === item.id ? ' menu-open' : ''}`} key={item.id}><button ref={item.id === active.id ? activeProfileButton : undefined} className={`profile-item${item.id === active.id ? ' active' : ''}`} aria-label={`${item.name}, ${sourceLabel}`} aria-current={item.id === active.id ? 'page' : undefined} onClick={() => { setItemMenu(undefined); selectProfile(item.id); setLibraryOpen(false); }}><span className="profile-glyph" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span><strong>{item.name}</strong><small>{sourceLabel}</small></span></button><IconButton className="profile-item-more" icon="ellipsis" label={`${labels.profileActions}: ${item.name}`} aria-haspopup="menu" aria-expanded={itemMenu?.id === item.id} onClick={(event) => openItemMenu(item, event.currentTarget)} /></div>; })}{group.children.filter((child) => hasContent(child) || !normalizedQuery && source === 'all').map((child) => renderGroup(child, depth + 1))}</div></section>;
  };
  const secretNames = [...new Set([
    ...[...active.raw.matchAll(/\$\{secret\.([A-Za-z0-9_.-]+)\}/gu)].map((match) => match[1]!),
    ...Object.values(activeEnvironment().secretReferences ?? {}),
  ])];
  return <div className={`profile-library${libraryOpen ? ' library-open' : ''}`}>
    <header className="brand"><span className="brand-mark" aria-hidden="true">T</span><h1><strong>TurnStage</strong><small>Web</small></h1></header>
    <div className="library-heading"><span>{labels.profiles}</span><div className="library-heading-actions" role="group" aria-label={labels.profileActions}><IconButton className="sidebar-icon" icon="add" label={labels.newProfile} onClick={createBlankProfile} /><IconButton className="sidebar-icon" icon="file-add" label={labels.import} onClick={() => input.current?.click()} /><IconButton className="sidebar-icon" icon="folder-opened" label={labels.newFolder} onClick={() => createFolder()} /><IconButton className="sidebar-icon compact-library-toggle" icon={libraryOpen ? 'close' : 'search'} label={libraryOpen ? labels.closeLibrary : labels.searchProfiles} onClick={() => setLibraryOpen(!libraryOpen)} /></div></div>
    <input ref={input} className="visually-hidden" type="file" aria-label={labels.import} accept=".jsonc,.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importProfile(file); event.target.value = ''; }} />
    <div className="library-filters"><label className="library-search"><span className="visually-hidden">{labels.searchProfiles}</span><input ref={searchInput} type="search" value={query} placeholder={labels.searchProfiles} onChange={(event) => setQuery(event.target.value)} /></label><label className="visually-hidden" htmlFor="profile-source-filter">{labels.filterSource}</label><select id="profile-source-filter" value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">{labels.allSources}</option><option value="official">{labels.official}</option><option value="local">{labels.browser}</option></select></div>
    <nav aria-label={labels.profiles}>{groups.length === 0 && <p className="library-empty">{labels.noProfilesFound}</p>}{groups.map((group) => renderGroup(group))}</nav>
    <footer>
      <button type="button" className="profile-guide-link" onClick={() => { setReferenceProfileId(active.id); setReferencePage('guide'); }}><span className="codicon codicon-book" aria-hidden="true" />{labels.profileGuide}</button>
      <details className="sidebar-preferences"><summary><span className="codicon codicon-settings-gear" aria-hidden="true" />{labels.displayPreferences}<DisclosureChevron /></summary><div><label>{labels.language}<select value={locale} onChange={(event) => { preferences.locale = event.target.value; savePreferences(preferences); window.location.reload(); }}><option value="en">English</option><option value="zh-TW">繁體中文</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label><label>{labels.theme}<select value={preferences.theme ?? 'system'} onChange={(event) => { preferences.theme = event.target.value as WebThemePreference; savePreferences(preferences); applyWebAppearance(preferences.theme); render((value) => value + 1); }}><option value="system">{labels.themeSystem}</option><option value="dark">{labels.themeDark}</option><option value="light">{labels.themeLight}</option></select></label></div></details>
      {secretNames.length > 0 && <details className="secret-editor"><summary>{labels.secrets}</summary>{secretNames.map((name) => <label key={name}>{name}<input type="password" autoComplete="off" value={secrets.get(name) ?? ''} placeholder={labels.memoryOnly} onChange={(event) => { if (event.target.value) secrets.set(name, event.target.value); else secrets.delete(name); renderSecrets((value) => value + 1); }} /></label>)}</details>}
      {catalog.warning && <p className="catalog-note catalog-note--warning" role="status" title={catalog.warning}>{labels.catalogFallback}</p>}
    </footer>
    {referencePage && <ProfileReferencePanel page={referencePage} onClose={() => setReferencePage(undefined)} profileId={referenceItem.id} profileName={referenceItem.name} raw={referenceItem.raw} locale={locale} readOnly={Boolean(referenceItem.builtIn)} onValidate={diagnostics} onSave={(raw) => {
      const previousId = referenceItem.id;
      const result = saveProfileSource(previousId, raw);
      if (result.ok) {
        setReferenceProfileId(result.id);
        if (previousId !== result.id && organization.assignments[previousId]) {
          const assignments = { ...organization.assignments, [result.id]: organization.assignments[previousId]! };
          delete assignments[previousId];
          updateOrganization({ ...organization, assignments });
        }
      }
      return result;
    }} onDuplicate={() => { const item = duplicateProfile(referenceItem); setReferenceProfileId(item.id); return item; }} onDownload={(value) => download(`${referenceItem.id}.turnstage.jsonc`, value, 'application/json')} onCopy={copyText} />}
    {itemMenu && menuItem && createPortal(
      <div ref={itemMenuRef} className="profile-item-menu" role="menu" aria-label={`${labels.profileActions}: ${menuItem.name}`} style={{ top: itemMenu.top, left: itemMenu.left, maxHeight: Math.max(80, window.innerHeight - itemMenu.top - 8) }} onKeyDown={navigateItemMenu}>
        <button type="button" role="menuitem" onClick={() => { closeItemMenu(); setReferenceProfileId(menuItem.id); setReferencePage('source'); }}>{menuItem.builtIn ? labels.viewJsonc : labels.editJsonc}</button>
        <button type="button" role="menuitem" onClick={() => { closeItemMenu(); duplicateProfile(menuItem); }}>{labels.duplicate}</button>
        <button type="button" role="menuitem" onClick={() => { closeItemMenu(); exportProfile(menuItem); }}>{labels.export}</button>
        {!menuItem.builtIn && organization.folders.length > 0 && <>
          <button type="button" role="menuitem" className="profile-item-folder-toggle" aria-expanded={folderPickerOpen} onClick={() => setFolderPickerOpen(!folderPickerOpen)}>{labels.moveToFolder}<DisclosureChevron /></button>
          {folderPickerOpen && <div className="profile-item-folder-list" role="group" aria-label={labels.moveToFolder}>
            <button type="button" role="menuitemradio" aria-checked={!organization.assignments[menuItem.id]} onClick={() => { assignFolder(menuItem.id, ''); closeItemMenu(); }}>{menuItem.builtIn ? labels.official : labels.browser}</button>
            {organization.folders.map((folder) => <button type="button" key={folder.id} role="menuitemradio" aria-checked={organization.assignments[menuItem.id] === folder.id} title={folderPath(folder.id)} onClick={() => { assignFolder(menuItem.id, folder.id); closeItemMenu(); }}>{folderPath(folder.id)}</button>)}
          </div>}
        </>}
        {!menuItem.builtIn && <button type="button" role="menuitem" onClick={() => { closeItemMenu(); deleteProfile(menuItem); }}>{officialProfiles.some((item) => item.id === menuItem.id) ? labels.reset : labels.delete}</button>}
      </div>, document.body)}
  </div>;
}

function activeProfile(): TurnStageProfile { return codec.parse(active.raw).profile ?? fallbackProfile(active); }
function activeEnvironment(): TurnStageEnvironment { return parseEnvironment(activeEnvironmentItem.raw) ?? { version: 1, id: '__invalid_environment__', name: 'Invalid environment', variables: {} }; }
function environmentFor(profile: TurnStageProfile): StoredEnvironment {
  const id = profile.environment ?? preferences.activeEnvironmentId;
  const selected = environments.find((item) => item.id === id) ?? (!profile.environment ? environments[0] : undefined);
  if (selected) return selected;
  const missing = { version: 1, id: `__missing_environment__:${id ?? 'none'}`, name: 'Missing environment', variables: {} };
  return { id: missing.id, name: missing.name, raw: JSON.stringify(missing), updatedAt: 0 };
}
function parseEnvironment(raw: string): TurnStageEnvironment | undefined {
  const value = codec.parse(raw).profile as unknown as Partial<TurnStageEnvironment> | undefined;
  return value && Number.isInteger(value.version) && typeof value.id === 'string' && value.id.trim() && typeof value.name === 'string' && value.name.trim() && value.variables && typeof value.variables === 'object' && !Array.isArray(value.variables)
    ? value as TurnStageEnvironment : undefined;
}
function fallbackProfile(item: StoredProfile): TurnStageProfile { return { version: 1, id: item.id, name: item.name, conversation: { send: { method: 'POST', url: 'http://127.0.0.1/' } }, stream: { transport: 'sse', mappings: [] } }; }
function deriveLocalProfile(source: StoredProfile): StoredProfile {
  const parsed = codec.parse(source.raw).profile ?? fallbackProfile(source);
  const id = uniqueId(`${parsed.id}-copy`);
  const name = `${parsed.name} Copy`;
  let raw = applyEdits(source.raw, modify(source.raw, ['id'], id, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  raw = applyEdits(raw, modify(raw, ['name'], name, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  const reference = source.official ?? source.basedOn;
  return { id, name, raw, updatedAt: Date.now(), ...(reference ? { basedOn: reference } : {}) };
}
function replaceProfile(items: StoredProfile[], previousId: string, next: StoredProfile): StoredProfile[] { const index = items.findIndex((item) => item.id === previousId); return index < 0 ? [...items, next] : items.map((item, position) => position === index ? next : item); }
function uniqueId(base: string): string { let id = base; let index = 2; while (profiles.some((item) => item.id === id)) id = `${base}-${index++}`; return id; }
function uniqueEnvironmentId(base: string): string { let id = base; let index = 2; while (environments.some((item) => item.id === id)) id = `${base}-${index++}`; return id; }
function normalizeLocale(value: string): string { if (value.toLowerCase().startsWith('zh')) return 'zh-TW'; if (value.toLowerCase().startsWith('ja')) return 'ja'; if (value.toLowerCase().startsWith('ko')) return 'ko'; return 'en'; }
function profileSourceLabel(item: StoredProfile, labels: ReturnType<typeof copy>): string {
  if (item.official) return [labels.official, item.official.category].filter(Boolean).join(' · ');
  const basedOn = item.basedOn;
  if (!basedOn) return labels.browser;
  const current = officialProfiles.find((official) => {
    const reference = official.official;
    return reference?.catalogId === basedOn.catalogId && reference.entryId === basedOn.entryId;
  });
  const currentReference = current?.official;
  const updated = currentReference && basedOn.entryVersion && currentReference.entryVersion
    ? currentReference.entryVersion !== basedOn.entryVersion
    : currentReference?.catalogRevision !== basedOn.catalogRevision;
  return updated ? `${labels.browser} · ${labels.officialUpdated}` : `${labels.browser} · ${labels.officialCopy}`;
}
function download(name: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function pickFile(accept: string): Promise<{ name: string; text: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    let settled = false;
    const finish = (value?: { name: string; text: string }) => { if (!settled) { settled = true; resolve(value); } };
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) finish();
      else void file.text().then((text) => finish({ name: file.name, text }), () => finish());
    };
    window.addEventListener('focus', () => { setTimeout(() => { if (!input.files?.length) finish(); }, 300); }, { once: true });
    input.click();
  });
}
function copy(locale: string) {
  const common = locale === 'zh-TW' ? {
    profiles: '設定檔', profileActions: '設定檔動作', newProfile: '新增設定檔', newProfileName: '新設定檔', import: '匯入設定檔',
    official: '預設', browser: '本機', officialCopy: '源自預設設定檔', officialUpdated: '預設設定檔已有新版',
    duplicate: '複製', export: '匯出', delete: '刪除', reset: '還原預設', profileGuide: '設定檔指南', viewJsonc: '檢視 JSONC', editJsonc: '編輯 JSONC', moveToFolder: '移至資料夾',
    catalogFallback: '無法載入預設設定檔，已改用內建範本。', language: '顯示語言', theme: '外觀主題', displayPreferences: '語言與外觀', themeSystem: '跟隨系統', themeDark: '深色', themeLight: '淺色',
    secrets: '工作階段密鑰', memoryOnly: '僅保留於記憶體',
    searchProfiles: '搜尋設定檔', filterSource: '篩選來源', allSources: '全部', noProfilesFound: '沒有符合的設定檔', newFolder: '新增資料夾', newSubfolder: '新增子資料夾', moveFolderUp: '上移資料夾', moveFolderDown: '下移資料夾', folderName: '資料夾名稱', folder: '資料夾', renameFolder: '重新命名資料夾', deleteFolder: '刪除資料夾', confirmDeleteFolder: '刪除「{name}」資料夾？其中的設定檔與子資料夾會移到上一層。', closeLibrary: '收合設定檔側欄',
  } : locale === 'ja' ? {
    profiles: 'プロファイル', profileActions: 'プロファイル操作', newProfile: '新規プロファイル', newProfileName: '新規プロファイル', import: 'インポート',
    official: 'デフォルト', browser: 'ローカル', officialCopy: 'デフォルトから作成', officialUpdated: 'デフォルトに更新あり',
    duplicate: '複製', export: '書き出し', delete: '削除', reset: 'デフォルトに戻す', profileGuide: 'プロファイルガイド', viewJsonc: 'JSONC を表示', editJsonc: 'JSONC を編集', moveToFolder: 'フォルダーへ移動',
    catalogFallback: 'デフォルトを読み込めません。内蔵プリセットを使用しています。', language: '表示言語', theme: '外観テーマ', displayPreferences: '言語と外観', themeSystem: 'システム設定', themeDark: 'ダーク', themeLight: 'ライト',
    secrets: 'セッションシークレット', memoryOnly: 'メモリのみ',
    searchProfiles: 'プロファイルを検索', filterSource: '提供元で絞り込み', allSources: 'すべて', noProfilesFound: '該当するプロファイルはありません', newFolder: 'フォルダーを作成', newSubfolder: 'サブフォルダーを作成', moveFolderUp: 'フォルダーを上へ', moveFolderDown: 'フォルダーを下へ', folderName: 'フォルダー名', folder: 'フォルダー', renameFolder: 'フォルダー名を変更', deleteFolder: 'フォルダーを削除', confirmDeleteFolder: '「{name}」フォルダーを削除しますか？プロファイルとサブフォルダーは親フォルダーに移動します。', closeLibrary: 'プロファイル一覧を閉じる',
  } : locale === 'ko' ? {
    profiles: '프로필', profileActions: '프로필 작업', newProfile: '새 프로필', newProfileName: '새 프로필', import: '가져오기',
    official: '기본', browser: '로컬', officialCopy: '기본 프로필에서 생성', officialUpdated: '기본 프로필 업데이트 있음',
    duplicate: '복제', export: '내보내기', delete: '삭제', reset: '기본값 복원', profileGuide: '프로필 가이드', viewJsonc: 'JSONC 보기', editJsonc: 'JSONC 편집', moveToFolder: '폴더로 이동',
    catalogFallback: '기본 프로필을 불러오지 못했습니다. 내장 프리셋을 사용합니다.', language: '표시 언어', theme: '화면 테마', displayPreferences: '언어 및 화면', themeSystem: '시스템 설정', themeDark: '어둡게', themeLight: '밝게',
    secrets: '세션 비밀', memoryOnly: '메모리에만 저장',
    searchProfiles: '프로필 검색', filterSource: '출처별 필터', allSources: '전체', noProfilesFound: '일치하는 프로필이 없습니다', newFolder: '폴더 만들기', newSubfolder: '하위 폴더 만들기', moveFolderUp: '폴더 위로', moveFolderDown: '폴더 아래로', folderName: '폴더 이름', folder: '폴더', renameFolder: '폴더 이름 변경', deleteFolder: '폴더 삭제', confirmDeleteFolder: '“{name}” 폴더를 삭제할까요? 프로필과 하위 폴더는 상위 폴더로 이동합니다.', closeLibrary: '프로필 목록 닫기',
  } : {
    profiles: 'Profiles', profileActions: 'Profile actions', newProfile: 'New profile', newProfileName: 'New Profile', import: 'Import profile',
    official: 'Default', browser: 'Local', officialCopy: 'Based on default profile', officialUpdated: 'Default profile updated',
    duplicate: 'Duplicate', export: 'Export', delete: 'Delete', reset: 'Restore default', profileGuide: 'Profile guide', viewJsonc: 'View JSONC', editJsonc: 'Edit JSONC', moveToFolder: 'Move to folder',
    catalogFallback: 'Default profiles unavailable. Using bundled presets.', language: 'Display language', theme: 'Appearance theme', displayPreferences: 'Language and appearance', themeSystem: 'Use system setting', themeDark: 'Dark', themeLight: 'Light',
    secrets: 'Session secrets', memoryOnly: 'Memory only',
    searchProfiles: 'Search profiles', filterSource: 'Filter by source', allSources: 'All', noProfilesFound: 'No matching profiles', newFolder: 'New folder', newSubfolder: 'New subfolder', moveFolderUp: 'Move folder up', moveFolderDown: 'Move folder down', folderName: 'Folder name', folder: 'Folder', renameFolder: 'Rename folder', deleteFolder: 'Delete folder', confirmDeleteFolder: 'Delete “{name}”? Profiles and subfolders will move up one level.', closeLibrary: 'Close profile sidebar',
  };
  return common;
}
