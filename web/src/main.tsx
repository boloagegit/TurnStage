import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
const defaultEnvironment = codec.parse(environmentRaw).profile as unknown as TurnStageEnvironment;
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
  active = profiles.find((item) => item.id === preferences.activeProfileId) ?? profiles[0]!;
  environments = mergeCatalogEntries(officialEnvironments, loadEnvironments());
  activeEnvironmentItem = environments.find((item) => item.id === (activeProfile().environment ?? preferences.activeEnvironmentId)) ?? environments[0]!;
  session = createSession(active);
  tests = new WebTestController(() => activeProfile(), () => activeEnvironment(), secrets, post);
  campaigns = new WebCampaignController(() => activeProfile(), tests, post);
  insights = new WebInsightsController(() => activeProfile(), () => session.current, post);
  createRoot(document.getElementById('profile-root')!).render(<ProfileLibrary />);
  await import('../../src/webview/main');
}

function createSession(item: StoredProfile): BrowserSession {
  const profile = codec.parse(item.raw).profile ?? fallbackProfile(item);
  const next = new BrowserSession(profile, activeEnvironment(), secrets, (state) => {
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
      case 'conversation.clear': session.clear(); break;
      case 'conversation.new': await session.newConversation(); break;
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
      case 'test.runCase': await tests.run('runCase', message.scenarioId, message.kind); break;
      case 'test.rerun': await tests.rerun(message.status); break;
      case 'test.cancel': tests.cancel(); break;
      case 'test.capture': await captureTest(message.source, message.suggestedKind ?? 'contract', message.requestId); break;
      case 'adversarial.capture': await captureTest({ kind: 'conversation' }, 'adversarial', message.requestId); break;
      case 'test.evidence.open': await tests.openEvidence(message.evidenceId); post({ type: 'inspector.focus', tab: message.location.kind === 'network' ? 'Network' : message.location.kind === 'normalizedEvent' ? 'Normalized' : 'Raw Events', evidenceId: message.evidenceId, networkId: message.location.kind === 'network' ? message.location.networkId : undefined, sequence: message.location.kind === 'rawEvent' || message.location.kind === 'normalizedEvent' ? message.location.sequence : undefined }); break;
      case 'test.report.export': await tests.exportReport(message.format, message.evidenceId); break;
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
      case 'adversarial.openLinkedSuite': await tests.exportSuite(message.path); break;
      case 'contract.case.save': await tests.saveCase('contract', message.sourcePath, message.scenarioId, message.expectedRevision, message.scenario); break;
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
        else notifyUnavailable('Linking workspace files is available only in the VS Code extension.', message.requestId);
        break;
      case 'uri.open': openExternalUri(message.uri); break;
      case 'profile.openAsText': download(`${active.id}.turnstage.jsonc`, active.raw, 'application/json'); break;
      case 'artifact.action': if (message.action === 'copyPath') await navigator.clipboard.writeText(message.artifactId); else notifyUnavailable('The browser already downloaded this artifact. Use the browser Downloads panel to open or reveal it.', message.requestId); break;
      case 'history.remote.apply': notifyUnavailable('Remote session references require an application backend and are not stored by TurnStage Web.', message.requestId); break;
      case 'output.open': notifyUnavailable('Output logs are shown in the browser developer console.', message.requestId); break;
      case 'testExplorer.open': notifyUnavailable('VS Code Test Explorer is unavailable in Web. Use the Tests workspace.', message.requestId); break;
    }
  } catch (error) {
    post({ type: 'request.error', error: { type: 'WebRuntimeError', message: error instanceof Error ? error.message : String(error) } }, message.requestId);
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
  const selectedEnvironment = environments.find((item) => item.id === profile.environment);
  if (selectedEnvironment) activeEnvironmentItem = selectedEnvironment;
  session.updateProfile(profile, activeEnvironment());
  postProfile();
  onLibraryChanged?.();
}

function validateActive(requestId?: string): void {
  const issues = diagnostics(active.raw);
  post({ type: 'profile.validation', diagnostics: issues }, requestId);
  post({ type: 'profile.validated', valid: issues.length === 0 }, requestId);
}

function diagnostics(raw: string): Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }> {
  const parsed = codec.parse(raw);
  if (parsed.errors.length) return parsed.errors.map((error) => ({ severity: 'error', message: `Invalid JSONC (${error.error})`, offset: error.offset, length: error.length }));
  if (!parsed.profile) return [{ severity: 'error', message: 'The profile root must be an object.', offset: 0, length: 1 }];
  return validator.validate(parsed.profile, parsed.tree, environments.flatMap((item) => { const environment = parseEnvironment(item.raw); return environment ? [environment] : []; }));
}

function selectProfile(id: string): void {
  const selected = profiles.find((item) => item.id === id);
  if (!selected) return;
  active = selected;
  const selectedEnvironment = environments.find((item) => item.id === activeProfile().environment);
  if (selectedEnvironment) activeEnvironmentItem = selectedEnvironment;
  preferences.activeProfileId = active.id;
  preferences.activeEnvironmentId = activeEnvironmentItem.id;
  savePreferences(preferences);
  runSummaries = [];
  session = createSession(active);
  postProfile();
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
  const imported = redactKnownSecrets({ ...structuredClone(run), id: duplicate ? crypto.randomUUID() : run.id }, [...secrets.values()]) as LocalRun;
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
  post({ type: 'test.captured', detail: `Saved ${scenario.name} to browser-local captured cases.`, kind, scenarioId: scenario.id, sourcePath }, requestId);
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

function importEnvironment(file: File): void {
  void file.text().then((source) => {
    const parsed = parseEnvironment(source);
    if (!parsed) throw new Error('The selected file is not a valid TurnStage environment JSONC.');
    const id = uniqueEnvironmentId(parsed.id);
    const raw = id === parsed.id ? source : applyEdits(source, modify(source, ['id'], id, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const item: StoredEnvironment = { id, name: parsed.name, raw, updatedAt: Date.now() };
    environments = [...environments, item];
    persistEnvironments();
    selectEnvironment(id);
  }).catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
}

function selectEnvironment(id: string): void {
  const selected = environments.find((item) => item.id === id);
  if (!selected) return;
  activeEnvironmentItem = selected;
  persistEnvironments();
  if (activeProfile().environment !== id) { patchProfile(['environment'], id); return; }
  session.updateProfile(activeProfile(), activeEnvironment());
  postProfile();
  onLibraryChanged?.();
}

function updateEnvironment(raw: string): void {
  const parsed = parseEnvironment(raw);
  if (!parsed) { window.alert('Environment JSONC requires version, id, name, and a variables object.'); return; }
  const source = activeEnvironmentItem;
  const previousId = source.id;
  let nextRaw = raw;
  let nextId = parsed.id;
  let nextName = parsed.name;
  if (source.builtIn) {
    nextId = uniqueEnvironmentId(parsed.id === source.id ? `${source.id}-copy` : parsed.id);
    nextName = parsed.name === source.name ? `${source.name} Copy` : parsed.name;
    nextRaw = applyEdits(nextRaw, modify(nextRaw, ['id'], nextId, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    nextRaw = applyEdits(nextRaw, modify(nextRaw, ['name'], nextName, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  } else if (parsed.id !== previousId && environments.some((item) => item.id === parsed.id)) { window.alert(`Environment id ${parsed.id} already exists in this browser.`); return; }
  activeEnvironmentItem = { id: nextId, name: nextName, raw: nextRaw, updatedAt: Date.now(), ...(source.official || source.basedOn ? { basedOn: source.official ?? source.basedOn } : {}) };
  environments = source.builtIn ? [...environments, activeEnvironmentItem] : environments.map((item) => item.id === previousId ? activeEnvironmentItem : item);
  persistEnvironments();
  session.updateProfile(activeProfile(), activeEnvironment());
  postProfile();
  onLibraryChanged?.();
}

function duplicateActive(): void {
  const item = deriveLocalProfile(active);
  profiles = [...profiles, item];
  persistLibrary();
  selectProfile(item.id);
}

function exportActive(): void {
  const profile = activeProfile();
  const environmentItem = environments.find((item) => item.id === profile.environment);
  if (!environmentItem) { window.alert(`Profile ${profile.name} references an Environment that is not available in this browser.`); return; }
  const environment = parseEnvironment(environmentItem.raw);
  if (!environment) { window.alert(`Environment ${environmentItem.name} is invalid and cannot be exported.`); return; }
  try {
    download(`${active.id}.turnstage-profile.json`, encodeWebProfileBundle(profile, environment), 'application/json');
  } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
}

function deleteActive(): void {
  if (active.builtIn || profiles.length <= 1 || !window.confirm(`Delete ${active.name}?`)) return;
  const deletedId = active.id;
  const localProfiles = profiles.filter((item) => !item.builtIn && item.id !== deletedId);
  profiles = mergeCatalogEntries(officialProfiles, localProfiles);
  active = profiles.find((item) => item.id === deletedId) ?? profiles[0]!;
  persistLibrary();
  selectProfile(active.id);
}

function persistLibrary(): void {
  saveProfiles(profiles.filter((item) => !item.builtIn));
  preferences.activeProfileId = active.id;
  savePreferences(preferences);
}

function persistEnvironments(): void {
  saveEnvironments(environments.filter((item) => !item.builtIn));
  preferences.activeEnvironmentId = activeEnvironmentItem.id;
  savePreferences(preferences);
}

function post(payload: HostPayload, requestId: string = crypto.randomUUID()): void {
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
    await navigator.clipboard.writeText(source?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('') ?? '');
    if (sourceMessageId) post({ type: 'action.feedback', actionId, sourceMessageId, status: 'success', message: 'Message copied.' }, requestId);
    return;
  }
  if (actionId === 'message.retry') { const text = [...session.current.snapshot.messages].reverse().find((item) => item.role === 'user')?.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join(''); if (text) await session.send(text, { kind: 'retry', sourceMessageId }); return; }
  if (actionId === 'request.abort') { await session.abort(); return; }
  if (actionId === 'conversation.new') { await session.newConversation(); return; }
  if (actionId === 'conversation.clear') { session.clear(); return; }
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

function ProfileLibrary(): React.JSX.Element {
  const [, render] = useState(0);
  const [, renderSecrets] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const environmentInput = useRef<HTMLInputElement>(null);
  const activeProfileButton = useRef<HTMLButtonElement>(null);
  onLibraryChanged = () => render((value) => value + 1);
  const locale = normalizeLocale(preferences.locale ?? navigator.language);
  const labels = useMemo(() => copy(locale), [locale]);
  const overridesOfficial = !active.builtIn && officialProfiles.some((item) => item.id === active.id);
  useEffect(() => { activeProfileButton.current?.scrollIntoView({ block: 'nearest' }); }, [active.id]);
  const secretNames = [...new Set([
    ...[...active.raw.matchAll(/\$\{secret\.([A-Za-z0-9_.-]+)\}/gu)].map((match) => match[1]!),
    ...Object.values(activeEnvironment().secretReferences ?? {}),
  ])];
  return <div className="profile-library">
    <header className="brand"><span className="brand-mark" aria-hidden="true">T</span><h1><strong>TurnStage</strong><small>Web</small></h1></header>
    <div className="library-heading"><span>{labels.profiles}</span><div className="library-heading-actions" role="group" aria-label={labels.profileActions}><IconButton className="sidebar-icon" icon="add" label={labels.newProfile} onClick={createBlankProfile} /><IconButton className="sidebar-icon" icon="arrow-up" label={labels.import} onClick={() => input.current?.click()} /></div></div>
    <input ref={input} className="visually-hidden" type="file" aria-label={labels.import} accept=".jsonc,.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importProfile(file); event.target.value = ''; }} />
    <nav aria-label={labels.profiles}>{profiles.map((item) => { const sourceLabel = profileSourceLabel(item, labels); return <button key={item.id} ref={item.id === active.id ? activeProfileButton : undefined} className={`profile-item${item.id === active.id ? ' active' : ''}`} aria-label={`${item.name}, ${sourceLabel}`} aria-current={item.id === active.id ? 'page' : undefined} onClick={() => selectProfile(item.id)}><span className="profile-glyph" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span><strong>{item.name}</strong><small>{sourceLabel}</small></span></button>; })}</nav>
    <footer>
      <div className="sidebar-actions"><button onClick={duplicateActive}>{labels.duplicate}</button><button onClick={exportActive}>{labels.export}</button><button disabled={Boolean(active.builtIn)} onClick={deleteActive}>{overridesOfficial ? labels.reset : labels.delete}</button></div>
      <label>{labels.language}<select value={locale} onChange={(event) => { preferences.locale = event.target.value; savePreferences(preferences); window.location.reload(); }}><option value="en">English</option><option value="zh-TW">繁體中文</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label>
      <label>{labels.theme}<select value={preferences.theme ?? 'system'} onChange={(event) => { preferences.theme = event.target.value as WebThemePreference; savePreferences(preferences); applyWebAppearance(preferences.theme); render((value) => value + 1); }}><option value="system">{labels.themeSystem}</option><option value="dark">{labels.themeDark}</option><option value="light">{labels.themeLight}</option></select></label>
      <details className="environment-editor"><summary>{labels.environments}</summary>
        <label>{labels.activeEnvironment}<select value={activeEnvironmentItem.id} onChange={(event) => selectEnvironment(event.target.value)}>{environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="environment-actions"><button onClick={() => environmentInput.current?.click()}>{labels.importEnvironment}</button><button onClick={() => download(`${activeEnvironmentItem.id}.environment.jsonc`, activeEnvironmentItem.raw, 'application/json')}>{labels.exportEnvironment}</button></div>
        <input ref={environmentInput} className="visually-hidden" type="file" aria-label={labels.importEnvironment} accept=".jsonc,.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importEnvironment(file); event.target.value = ''; }} />
        <label>{labels.environmentJson}<textarea key={`${activeEnvironmentItem.id}:${activeEnvironmentItem.updatedAt}`} defaultValue={activeEnvironmentItem.raw} spellCheck={false} onBlur={(event) => updateEnvironment(event.target.value)} /></label>
      </details>
      {secretNames.length > 0 && <details className="secret-editor"><summary>{labels.secrets}</summary>{secretNames.map((name) => <label key={name}>{name}<input type="password" autoComplete="off" value={secrets.get(name) ?? ''} placeholder={labels.memoryOnly} onChange={(event) => { if (event.target.value) secrets.set(name, event.target.value); else secrets.delete(name); renderSecrets((value) => value + 1); }} /></label>)}</details>}
      {active.builtIn && <p className="catalog-note">{labels.officialReadOnly}</p>}
      {catalog.warning ? <p className="catalog-note catalog-note--warning" role="status" title={catalog.warning}>{labels.catalogFallback}</p> : <p className="catalog-note">{labels.catalog}: {catalog.catalogId} · {catalog.revision}</p>}
      <p>{labels.storage}</p>
    </footer>
  </div>;
}

function activeProfile(): TurnStageProfile { return codec.parse(active.raw).profile ?? fallbackProfile(active); }
function activeEnvironment(): TurnStageEnvironment { return parseEnvironment(activeEnvironmentItem.raw) ?? defaultEnvironment; }
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
function copy(locale: string) { return locale === 'zh-TW' ? { profiles: '設定檔', profileActions: '設定檔動作', newProfile: '新增設定檔', newProfileName: '新設定檔', import: '匯入設定檔', official: '官方範本', browser: '瀏覽器本機', officialCopy: '源自官方範本', officialUpdated: '官方範本已有新版', duplicate: '複製', export: '匯出可攜檔', delete: '刪除', reset: '還原官方', officialReadOnly: '官方範本由伺服器管理且為唯讀；請按「複製」建立瀏覽器本機副本後再編輯。', catalog: '官方 Catalog', catalogFallback: '官方 Catalog 無法載入，已使用隨附範本。', language: '顯示語言', theme: '外觀主題', themeSystem: '跟隨系統', themeDark: '深色', themeLight: '淺色', environments: '環境', activeEnvironment: '目前環境', importEnvironment: '匯入', exportEnvironment: '匯出', environmentJson: '環境 JSONC', secrets: '工作階段密鑰', memoryOnly: '僅保留於記憶體', storage: '個人設定檔與環境儲存在此瀏覽器。直接寫入其中的憑證也會保存並包含於可攜匯出檔。' } : locale === 'ja' ? { profiles: 'プロファイル', profileActions: 'プロファイル操作', newProfile: '新規プロファイル', newProfileName: '新規プロファイル', import: 'インポート', official: '公式プリセット', browser: 'ブラウザー', officialCopy: '公式プリセットから作成', officialUpdated: '公式プリセットに更新あり', duplicate: '複製', export: 'ポータブル書き出し', delete: '削除', reset: '公式版に戻す', officialReadOnly: '公式プリセットはサーバー管理の読み取り専用です。「複製」を選んでブラウザー内のコピーを作成してから編集してください。', catalog: '公式カタログ', catalogFallback: '公式カタログを読み込めなかったため、同梱プリセットを使用しています。', language: '表示言語', theme: '外観テーマ', themeSystem: 'システム設定', themeDark: 'ダーク', themeLight: 'ライト', environments: '環境', activeEnvironment: '使用中の環境', importEnvironment: 'インポート', exportEnvironment: 'エクスポート', environmentJson: '環境 JSONC', secrets: 'セッションシークレット', memoryOnly: 'メモリのみ', storage: '個人プロファイルと環境はこのブラウザーに保存されます。直接記述した認証情報は保存され、ポータブル書き出しにも含まれます。' } : locale === 'ko' ? { profiles: '프로필', profileActions: '프로필 작업', newProfile: '새 프로필', newProfileName: '새 프로필', import: '가져오기', official: '공식 프리셋', browser: '브라우저 로컬', officialCopy: '공식 프리셋에서 생성', officialUpdated: '공식 프리셋 업데이트 있음', duplicate: '복제', export: '휴대용 내보내기', delete: '삭제', reset: '공식 버전 복원', officialReadOnly: '공식 프리셋은 서버에서 관리되는 읽기 전용 항목입니다. 편집하려면 “복제”를 눌러 브라우저 로컬 사본을 만드세요.', catalog: '공식 카탈로그', catalogFallback: '공식 카탈로그를 불러오지 못해 기본 프리셋을 사용합니다.', language: '표시 언어', theme: '화면 테마', themeSystem: '시스템 설정', themeDark: '어둡게', themeLight: '밝게', environments: '환경', activeEnvironment: '활성 환경', importEnvironment: '가져오기', exportEnvironment: '내보내기', environmentJson: '환경 JSONC', secrets: '세션 비밀', memoryOnly: '메모리에만 저장', storage: '개인 프로필과 환경은 이 브라우저에 저장됩니다. 직접 입력한 자격 증명도 저장되며 휴대용 내보내기에 포함됩니다.' } : { profiles: 'Profiles', profileActions: 'Profile actions', newProfile: 'New profile', newProfileName: 'New Profile', import: 'Import profile', official: 'Official preset', browser: 'Browser local', officialCopy: 'Based on official preset', officialUpdated: 'Official preset updated', duplicate: 'Duplicate', export: 'Portable export', delete: 'Delete', reset: 'Restore official', officialReadOnly: 'Official presets are server-managed and read-only. Select Duplicate to create an editable browser-local copy.', catalog: 'Official catalog', catalogFallback: 'The official catalog could not be loaded. Bundled presets are active.', language: 'Display language', theme: 'Appearance theme', themeSystem: 'Use system setting', themeDark: 'Dark', themeLight: 'Light', environments: 'Environments', activeEnvironment: 'Active environment', importEnvironment: 'Import', exportEnvironment: 'Export', environmentJson: 'Environment JSONC', secrets: 'Session secrets', memoryOnly: 'Memory only', storage: 'Personal Profiles and Environments are saved in this browser. Credentials written into them are also saved and included in portable exports.' }; }
