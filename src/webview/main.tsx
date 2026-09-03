import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AdversarialCaseCatalog, HostMessage, MappingTestResult, TestOperationSnapshot, WebviewPayload, WorkspaceSection } from '../shared/protocol';
import { isHostMessage, isWorkspaceSection, PROTOCOL_VERSION } from '../shared/protocol';
import type { AdversarialResultSummary, CampaignDashboardV1, ChatMessage, ConnectionDoctorSummary, EvidenceTimelineEntry, EvidenceTimelineSummary, LocalRunSummary, NetworkExchange, RawStreamEvent, RemoteSessionReference, ReplaySnapshot, ScenarioEvidenceLocation, SessionSnapshot, TurnStageProfile } from '../shared/types';
import { mappingDraftFromRawEvent } from './configEditors';
import { JsonViewer, safeJson } from './JsonViewer';
import { IconButton, ProductIcon } from './Icon';
import { CHAT_VIEWPORT_PRESETS, DEFAULT_CHAT_VIEWPORT, MobileChatPreview, type ChatViewportState, type MessageActionFeedback, type VisualFeedback } from './MobileChatPreview';
import { AdversarialWorkspace, DEFAULT_ADVERSARIAL_CASE_COLLECTION, DEFAULT_ADVERSARIAL_RESULT_COLLECTION, normalizeAdversarialCaseCollectionState, normalizeAdversarialResultCollectionState, RED_TEAM_SECTIONS, SETTINGS_SECTIONS, SettingsWorkspace, type AdversarialCaseCollectionState, type AdversarialResultCollectionState, type LinkedAdversarialCaseEditorState, type RedTeamSectionId, type SettingsSectionId } from './SettingsWorkspace';
import { dateTimeAttribute, formatDateTime, formatDuration, formatNumber, localizeHumanized, setLocale, t } from './i18n';
import { resolveUiLayout } from './uiConfig';
import { applySessionDelta } from '../shared/sessionDelta';
import './styles.css';

declare function acquireVsCodeApi<T = unknown>(): { postMessage(message: unknown): void; getState(): T | undefined; setState(state: T): void };
export type EventMappingFilter = 'all' | 'matched' | 'unmatched';
export type EventIssueFilter = 'all' | 'valid' | 'problem' | 'parse-error' | 'mapping-error';
export type EventTerminalFilter = 'all' | 'terminal' | 'non-terminal';
export interface EventFilterState { query: string; turn: string; eventType: string; mapping: EventMappingFilter; issue: EventIssueFilter; terminal: EventTerminalFilter }
export interface InspectorEventFilters { raw: EventFilterState; normalized: EventFilterState }
export interface CollapsedEventTurns { raw: string[]; normalized: string[] }
const MAPPING_FILTERS = new Set<EventMappingFilter>(['all', 'matched', 'unmatched']);
const ISSUE_FILTERS = new Set<EventIssueFilter>(['all', 'valid', 'problem', 'parse-error', 'mapping-error']);
const TERMINAL_FILTERS = new Set<EventTerminalFilter>(['all', 'terminal', 'non-terminal']);
const eventSearchTextCache = new WeakMap<object, string>();
const rightPaneModes = ['debug', 'adversarial', 'configure'] as const;
type RightPaneMode = typeof rightPaneModes[number];
const WEBVIEW_STATE_VERSION = 4;
const scrollPositionKeys = ['chat', 'adversarial', 'events.raw', 'events.normalized', ...SETTINGS_SECTIONS.map((section) => `configure.${section.id}`)] as const;
type ScrollPositionKey = typeof scrollPositionKeys[number];
const networkDetailTabs = ['Headers', 'Payload', 'Response', 'Timing'] as const;
type NetworkDetailTab = typeof networkDetailTabs[number];
const inspectorTabs = ['Network', 'Raw Events', 'Normalized', 'Metrics', 'Errors', 'Runs'] as const; type InspectorTab = typeof inspectorTabs[number];
export const DEFAULT_SPLIT_PERCENT = 64;
export const ACCESSIBLE_EVENT_WINDOW_SIZE = 200;
export const DEFAULT_EVENT_FILTERS: EventFilterState = { query: '', turn: 'all', eventType: 'all', mapping: 'all', issue: 'all', terminal: 'all' };
export interface NetworkInspectorState { query: string; selectedId?: string; detailTab: NetworkDetailTab }
export interface WebviewState { version?: number; sessionId?: string; section?: WorkspaceSection; configurationSection?: SettingsSectionId; rightPaneMode?: RightPaneMode; redTeamSection?: RedTeamSectionId; draft?: string; inspectorTab?: InspectorTab; splitPercent?: number; splitCustomized?: boolean; selectedMessageId?: string; selectedRawSequence?: number; selectedNetworkId?: string; activeEvidenceId?: string; selectedCampaignId?: string; chatViewport?: ChatViewportState; eventFilters?: Partial<InspectorEventFilters>; collapsedEventTurns?: Partial<CollapsedEventTurns>; scrollPositions?: Partial<Record<ScrollPositionKey, number>>; expandedAdversarialCaseId?: string; adversarialCaseCollection?: Partial<AdversarialCaseCollectionState>; adversarialResultCollection?: Partial<AdversarialResultCollectionState>; networkInspector?: Partial<NetworkInspectorState>; acceptedForms?: string[] }
type VsCodeApi = { postMessage(message: unknown): void; getState(): WebviewState | undefined; setState(state: WebviewState): void };
type OperationNotice = string | { message: string; artifactId: string };
const rootElement = typeof document === 'undefined' ? undefined : document.getElementById('root');
const instanceId = rootElement?.dataset.instanceId ?? 'test-instance';
const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi<WebviewState>()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
const savedState = normalizeWebviewState(vscode.getState());
const savedSplitCustomized = savedState?.splitCustomized === true;
const savedInspectorTab = (savedState as { inspectorTab?: unknown } | undefined)?.inspectorTab;

function post(message: WebviewPayload): void { vscode.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId: crypto.randomUUID() }); }

function App(): React.JSX.Element {
  const savedSection = isWorkspaceSection(savedState?.section) ? savedState.section : 'test';
  const [configurationSection, setConfigurationSection] = useState<SettingsSectionId>(isSettingsSectionId(savedState?.configurationSection) ? savedState.configurationSection : savedSection === 'test' ? 'general' : savedSection);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>(isRightPaneMode(savedState?.rightPaneMode) ? savedState.rightPaneMode : savedSection === 'test' ? 'debug' : 'configure');
  const [redTeamSection, setRedTeamSection] = useState<RedTeamSectionId>(RED_TEAM_SECTIONS.includes(savedState?.redTeamSection as RedTeamSectionId) ? savedState!.redTeamSection as RedTeamSectionId : 'results');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(savedInspectorTab === 'Request' ? 'Network' : isInspectorTab(savedInspectorTab) ? savedInspectorTab : 'Raw Events'); const [draft, setDraft] = useState(savedState?.draft ?? ''); const [splitPercent, setSplitPercent] = useState(initialSplitPercent(savedState?.splitPercent, savedSplitCustomized)); const [splitCustomized, setSplitCustomized] = useState(savedSplitCustomized); const [selectedMessageId, setSelectedMessageId] = useState(savedState?.selectedMessageId); const [selectedRawSequence, setSelectedRawSequence] = useState(savedState?.selectedRawSequence); const [selectedNetworkId, setSelectedNetworkId] = useState(savedState?.selectedNetworkId);
  const [activeEvidenceId, setActiveEvidenceId] = useState(savedState?.activeEvidenceId);
  const [chatViewport, setChatViewport] = useState<ChatViewportState>(isChatViewportState(savedState?.chatViewport) ? savedState.chatViewport : { ...DEFAULT_CHAT_VIEWPORT });
  const [eventFilters, setEventFilters] = useState<InspectorEventFilters>(() => normalizeInspectorEventFilters(savedState?.eventFilters));
  const [collapsedEventTurns, setCollapsedEventTurns] = useState<CollapsedEventTurns>(() => normalizeCollapsedEventTurns(savedState?.collapsedEventTurns));
  const [expandedAdversarialCaseId, setExpandedAdversarialCaseId] = useState(savedState?.expandedAdversarialCaseId);
  const [adversarialCaseCollection, setAdversarialCaseCollection] = useState<AdversarialCaseCollectionState>(() => normalizeAdversarialCaseCollectionState(savedState?.adversarialCaseCollection));
  const [adversarialResultCollection, setAdversarialResultCollection] = useState<AdversarialResultCollectionState>(() => normalizeAdversarialResultCollectionState(savedState?.adversarialResultCollection));
  const [selectedCampaignId, setSelectedCampaignId] = useState(savedState?.selectedCampaignId);
  const [networkInspector, setNetworkInspector] = useState<NetworkInspectorState>(() => normalizeNetworkInspectorState(savedState?.networkInspector));
  const scrollPositionsRef = useRef<Partial<Record<ScrollPositionKey, number>>>({ ...savedState?.scrollPositions });
  const stateRef = useRef<WebviewState | undefined>(undefined);
  const persistTimerRef = useRef<number | undefined>(undefined);
  const profileInspectorDefaultApplied = useRef(!shouldApplyProfileInspectorDefault(savedState));
  const [acceptedForms, setAcceptedForms] = useState<ReadonlySet<string>>(() => new Set(savedState?.acceptedForms));
  const [messageActionFeedback, setMessageActionFeedback] = useState<MessageActionFeedback>();
  const [visualFeedback, setVisualFeedback] = useState<VisualFeedback>();
  const [testResults, setTestResults] = useState<AdversarialResultSummary[]>([]);
  const [adversarialCaseCatalog, setAdversarialCaseCatalog] = useState<AdversarialCaseCatalog>();
  const [linkedAdversarialCaseEditor, setLinkedAdversarialCaseEditor] = useState<LinkedAdversarialCaseEditorState>();
  const [campaignDashboard, setCampaignDashboard] = useState<CampaignDashboardV1>();
  const [activeTimeline, setActiveTimeline] = useState<{ evidenceId: string; timeline: EvidenceTimelineSummary }>();
  const [connectionResult, setConnectionResult] = useState<ConnectionDoctorSummary>();
  const [profile, setProfile] = useState<TurnStageProfile>(); const [snapshot, setSnapshot] = useState<SessionSnapshot>(); const [runs, setRuns] = useState<LocalRunSummary[]>([]); const [requestPreview, setRequestPreview] = useState<unknown>(); const [networkEntries, setNetworkEntries] = useState<NetworkExchange[]>([]); const [diagnostics, setDiagnostics] = useState<Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }>>([]); const [profileDirty, setProfileDirty] = useState(false); const [notice, setNotice] = useState<OperationNotice>(''); const [mappingTestResult, setMappingTestResult] = useState<MappingTestResult>(); const [remoteName, setRemoteName] = useState<string>(); const [, setLocaleVersion] = useState(0);
  const snapshotRef = useRef<SessionSnapshot | undefined>(undefined);
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (!isHostMessage(event.data, instanceId)) return;
      const message = event.data;
      if (message.type === 'host.ready') { setLocale(message.locale, message.direction); setLocaleVersion((current) => current + 1); setRemoteName(message.remoteName); }
      else if (message.type === 'workspace.section') { if (message.section === 'test') setRightPaneMode('debug'); else { setConfigurationSection(message.section); setRightPaneMode('configure'); } requestAnimationFrame(() => document.getElementById('right-pane-panel')?.focus()); }
      else if (message.type === 'workspace.navigate') {
        const destination = message.destination;
        if (destination.pane === 'chat') focusAfterRender(() => (document.querySelector('.mobile-chat-preview__composer textarea, .mobile-chat-preview__composer input') as HTMLElement | null)?.focus());
        else if (destination.pane === 'debug') { setRightPaneMode('debug'); setInspectorTab(destination.tab); focusAfterRender(() => document.getElementById('right-pane-panel')?.focus()); }
        else if (destination.pane === 'adversarial') { setRightPaneMode('adversarial'); setRedTeamSection(destination.section); focusAfterRender(() => document.getElementById(`red-team-${destination.section}`)?.focus()); }
        else { const section = destination.section === 'test' ? 'general' : destination.section; setRightPaneMode('configure'); setConfigurationSection(section); focusAfterRender(() => document.getElementById(`settings-panel-${section}`)?.focus()); }
      }
      else if (message.type === 'inspector.focus') { profileInspectorDefaultApplied.current = true; setRightPaneMode('debug'); setActiveEvidenceId(message.evidenceId); setInspectorTab(message.tab); setSelectedNetworkId(message.networkId); setSelectedRawSequence(message.sequence); setSelectedMessageId(message.messageId); if (message.tab === 'Raw Events') setEventFilters((current) => ({ ...current, raw: { ...DEFAULT_EVENT_FILTERS } })); if (message.tab === 'Normalized') setEventFilters((current) => ({ ...current, normalized: { ...DEFAULT_EVENT_FILTERS } })); setNotice(t('Opened test failure evidence.')); focusAfterRender(() => { const target = message.networkId ? document.getElementById(networkRowId(message.networkId)) : message.sequence === undefined ? document.getElementById('right-pane-panel') : document.getElementById(`inspector-event-${String(message.sequence)}`); target?.focus(); }); }
      else if (message.type === 'profile.snapshot') { setProfile(message.profile); setConnectionResult(undefined); }
      else if (message.type === 'profile.validation') setDiagnostics(message.diagnostics);
      else if (message.type === 'profile.editState') setProfileDirty(message.dirty);
      else if (message.type === 'profile.validated') { if (message.valid) setNotice(t('Profile is valid.')); }
      else if (message.type === 'session.snapshot') { snapshotRef.current = message.snapshot; setSnapshot(message.snapshot); setRuns(message.runs); setRequestPreview(message.requestPreview); setNetworkEntries(message.networkEntries ?? []); setConnectionResult(undefined); }
      else if (message.type === 'session.delta') { const next = applySessionDelta(snapshotRef.current, message.delta); if (!next) { post({ type: 'webview.ready' }); return; } snapshotRef.current = next; setSnapshot(next); if (message.delta.runs) setRuns(message.delta.runs); if (message.delta.requestPreviewChanged) setRequestPreview(message.delta.requestPreview); if (message.delta.networkEntries) setNetworkEntries(message.delta.networkEntries); setConnectionResult(undefined); }
      else if (message.type === 'mapping.test.result') setMappingTestResult(message.result);
      else if (message.type === 'request.error') setNotice(message.error.message);
      else if (message.type === 'action.feedback') setMessageActionFeedback({ actionId: message.actionId, sourceMessageId: message.sourceMessageId, status: message.status, message: message.message });
      else if (message.type === 'form.accepted') { setAcceptedForms((current) => new Set(current).add(`${message.sourceMessageId ?? ''}:${message.formId}`)); setNotice(t('Form submitted.')); }
      else if (message.type === 'run.imported') setNotice(t(message.duplicate ? 'Run imported as a copy from {path}' : 'Run imported from {path}', { path: message.path }));
      else if (message.type === 'run.exported') setNotice(message.artifactId ? { message: t('Run exported to {path}', { path: message.path }), artifactId: message.artifactId } : t('Run exported to {path}', { path: message.path }));
      else if (message.type === 'run.history.changed') setNotice(t(message.deletedCount === 1 ? 'Deleted {count} recorded run.' : 'Deleted {count} recorded runs.', { count: formatNumber(message.deletedCount) }));
      else if (message.type === 'adversarial.operation') setNotice(message.artifactId ? { message: message.detail, artifactId: message.artifactId } : message.detail);
      else if (message.type === 'adversarial.captured') setNotice(message.detail);
      else if (message.type === 'adversarial.catalog') setAdversarialCaseCatalog(message.catalog);
      else if (message.type === 'adversarial.case.loaded') setLinkedAdversarialCaseEditor({ status: 'loaded', detail: message.detail });
      else if (message.type === 'adversarial.case.saved') { setLinkedAdversarialCaseEditor({ status: 'saved', detail: message.detail }); setNotice(t('Linked case saved and verified from disk.')); }
      else if (message.type === 'adversarial.case.error') setLinkedAdversarialCaseEditor({ status: 'error', sourcePath: message.sourcePath, scenarioId: message.scenarioId, message: message.message, conflict: message.conflict });
      else if (message.type === 'test.results') setTestResults(message.results);
      else if (message.type === 'test.exported') { const text = t(message.kind === 'evidenceBundle' ? 'Evidence Bundle exported to {path}' : 'Test report exported to {path}', { path: message.path }); setNotice(message.artifactId ? { message: text, artifactId: message.artifactId } : text); }
      else if (message.type === 'campaign.dashboard') setCampaignDashboard(message.dashboard);
      else if (message.type === 'campaign.preview') { const summary = t('{cases} cases · {attempts} attempts · up to {requests} requests', { cases: formatNumber(message.selectedCases), attempts: formatNumber(message.plannedAttempts), requests: formatNumber(message.plannedRequests) }); setNotice(message.warnings.length ? `${summary} · ${message.warnings.join(' ')}` : summary); }
      else if (message.type === 'campaign.exported') setNotice({ message: t('Campaign results exported to {path}', { path: message.path }), artifactId: message.artifactId });
      else if (message.type === 'test.timeline') { setActiveEvidenceId(message.evidenceId); setActiveTimeline({ evidenceId: message.evidenceId, timeline: message.timeline }); }
      else if (message.type === 'connection.result') setConnectionResult(message.result);
      else if (message.type === 'visual.result') setVisualFeedback(message);
      else if (message.type === 'workspaceTrust.changed') setSnapshot((current) => { const next = current ? { ...current, trusted: message.trusted } : current; if (next) snapshotRef.current = next; return next; });
    };
    window.addEventListener('message', listener);
    post({ type: 'webview.ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => { if (!messageActionFeedback || messageActionFeedback.status === 'pending') return; const timeout = window.setTimeout(() => setMessageActionFeedback(undefined), 2400); return () => window.clearTimeout(timeout); }, [messageActionFeedback]);
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(''), 3200); return () => window.clearTimeout(timeout); }, [notice]);
  const checkpointSessionId = useRef(savedState?.sessionId);
  useEffect(() => {
    const nextSessionId = snapshot?.sessionId;
    if (!nextSessionId) return;
    const previousSessionId = checkpointSessionId.current;
    checkpointSessionId.current = nextSessionId;
    if (previousSessionId === nextSessionId) return;
    setAcceptedForms(new Set());
    setMessageActionFeedback(undefined);
    if (previousSessionId !== undefined || (selectedMessageId && !snapshot.messages.some((message) => message.id === selectedMessageId))) setSelectedMessageId(undefined);
    if (previousSessionId !== undefined || (selectedRawSequence !== undefined && !snapshot.rawEvents.some((event) => event.sequence === selectedRawSequence))) setSelectedRawSequence(undefined);
    if (previousSessionId !== undefined) setCollapsedEventTurns({ raw: [], normalized: [] });
  }, [snapshot?.sessionId]);
  const persistState = useCallback(() => {
    if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = undefined;
    if (stateRef.current) vscode.setState({ ...stateRef.current, scrollPositions: { ...scrollPositionsRef.current } });
  }, []);
  const scheduleStatePersist = useCallback(() => {
    if (persistTimerRef.current !== undefined) return;
    persistTimerRef.current = window.setTimeout(persistState, 80);
  }, [persistState]);
  const updateScrollPosition = useCallback((key: ScrollPositionKey, value: number) => {
    const normalized = normalizeScrollPosition(value);
    if (scrollPositionsRef.current[key] === normalized) return;
    scrollPositionsRef.current = { ...scrollPositionsRef.current, [key]: normalized };
    scheduleStatePersist();
  }, [scheduleStatePersist]);
  useEffect(() => {
    stateRef.current = { version: WEBVIEW_STATE_VERSION, sessionId: snapshot?.sessionId, section: rightPaneMode === 'configure' ? configurationSection : 'test', configurationSection, rightPaneMode, redTeamSection, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence, selectedNetworkId, activeEvidenceId, selectedCampaignId, chatViewport, eventFilters, collapsedEventTurns, expandedAdversarialCaseId, adversarialCaseCollection, adversarialResultCollection, networkInspector, acceptedForms: [...acceptedForms] };
    scheduleStatePersist();
  }, [snapshot?.sessionId, configurationSection, rightPaneMode, redTeamSection, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence, selectedNetworkId, activeEvidenceId, selectedCampaignId, chatViewport, eventFilters, collapsedEventTurns, expandedAdversarialCaseId, adversarialCaseCollection, adversarialResultCollection, networkInspector, acceptedForms, scheduleStatePersist]);
  useEffect(() => {
    const flushIfHidden = () => { if (document.visibilityState === 'hidden') persistState(); };
    window.addEventListener('pagehide', persistState);
    document.addEventListener('visibilitychange', flushIfHidden);
    return () => { window.removeEventListener('pagehide', persistState); document.removeEventListener('visibilitychange', flushIfHidden); persistState(); };
  }, [persistState]);
  useEffect(() => {
    if (!profile || profileInspectorDefaultApplied.current) return;
    profileInspectorDefaultApplied.current = true;
    const preferredTab = resolveUiLayout(profile.ui).initialInspectorTab;
    if (preferredTab && componentVisible(profile, 'metrics')) setInspectorTab(preferredTab);
  }, [profile?.ui?.layout?.preset, profile?.ui?.components?.metrics?.visible]);
  useEffect(() => { if (profile && inspectorTab === 'Metrics' && !componentVisible(profile, 'metrics')) setInspectorTab('Raw Events'); }, [inspectorTab, profile?.ui?.components?.metrics?.visible]);
  const active = snapshot ? ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(snapshot.turnState) : false;
  const continuationBlocked = snapshot?.turnState === 'failed' && profile?.errorPolicy?.allowContinuation === false;
  const send = (text = draft, interaction: any = { kind: 'manual' }) => { if (!text.trim() || active || snapshot?.trusted !== true) return; post({ type: 'request.send', text, interaction }); setDraft(''); };
  const selectMessage = (messageId: string) => {
    setSelectedMessageId(messageId);
    const message = snapshot?.messages.find((item) => item.id === messageId);
    const sequences = rawSequencesForMessage(message);
    const sequence = sequences.at(-1);
    setRightPaneMode('debug');
    setInspectorTab('Raw Events');
    setSelectedRawSequence(sequence);
    const turn = typeof message?.metadata?.clientRequestId === 'string' ? message.metadata.clientRequestId : 'all';
    setEventFilters((current) => ({ ...current, raw: { ...DEFAULT_EVENT_FILTERS, turn } }));
    setMessageActionFeedback({
      actionId: 'message.inspectRaw',
      sourceMessageId: messageId,
      status: sequence === undefined ? 'info' : 'success',
      message: sequence === undefined ? t('Opened Debug, but this message has no linked raw events.') : t('Opened raw event #{sequence} in Debug.', { sequence: formatNumber(sequence) }),
    });
    if (sequence === undefined) focusAfterRender(() => document.getElementById('right-pane-panel')?.focus());
  };
  const selectEvent = (event: Record<string, unknown>) => {
    const rawSequence = typeof event.rawSequence === 'number' ? event.rawSequence : typeof event.sequence === 'number' ? event.sequence : undefined;
    setSelectedRawSequence(rawSequence);
    const message = snapshot?.messages.find((item) => rawSequence !== undefined && rawSequencesForMessage(item).includes(rawSequence));
    setSelectedMessageId(message?.id);
  };
  if (!profile) return <main className="empty"><h1>TurnStage</h1><p>{diagnostics[0]?.message ?? t('Loading profile…')}</p><button onClick={() => post({ type: 'profile.openAsText' })}>{t('Open as text')}</button></main>;
  return <main className="app">
    <a className="skip" href="#main-panel">{t('Skip to content')}</a>
    {snapshot?.trusted === false && <div className="trust-banner" role="status"><strong>{t('Restricted mode.')}</strong> {t('This workspace is not trusted. Network requests are disabled; fixture replay remains available.')}</div>}
    {diagnostics.length > 0 && <div className="validation-banner" role="alert"><strong>{t(diagnostics.length === 1 ? '{count} configuration issue.' : '{count} configuration issues.', { count: formatNumber(diagnostics.length) })}</strong> {t('Requests are blocked until errors are fixed.')} <button className="link-button" disabled={isInteractionLocked(profile, 'configuration.open', active)} onClick={() => post({ type: 'profile.openAsText' })}>{t('Open as text')}</button></div>}
    {notice && <div className="operation-status" role="status" aria-live="polite" aria-atomic="true"><ProductIcon name="info" /><span>{typeof notice === 'string' ? notice : notice.message}</span>{typeof notice !== 'string' && <div className="operation-status__actions"><button type="button" onClick={() => post({ type: 'artifact.action', artifactId: notice.artifactId, action: 'open' })}>{t('Open')}</button><IconButton icon="folder-opened" label={t('Reveal in file explorer')} type="button" onClick={() => post({ type: 'artifact.action', artifactId: notice.artifactId, action: 'reveal' })} /><IconButton icon="copy" label={t('Copy path')} type="button" onClick={() => post({ type: 'artifact.action', artifactId: notice.artifactId, action: 'copyPath' })} /></div>}<IconButton icon="clear-all" label={t('Dismiss notification')} type="button" onClick={() => setNotice('')} /></div>}
    <section id="main-panel" tabIndex={-1} className="panel" aria-label={t('Test')}>
      <TestWorkspace profile={profile} snapshot={snapshot} runs={runs} networkEntries={networkEntries} testResults={testResults} adversarialCaseCatalog={adversarialCaseCatalog} linkedAdversarialCaseEditor={linkedAdversarialCaseEditor} adversarialCaseCollection={adversarialCaseCollection} setAdversarialCaseCollection={setAdversarialCaseCollection} adversarialResultCollection={adversarialResultCollection} setAdversarialResultCollection={setAdversarialResultCollection} campaignDashboard={campaignDashboard} activeEvidenceId={activeEvidenceId} activeTimeline={activeTimeline && activeTimeline.evidenceId === activeEvidenceId ? activeTimeline.timeline : undefined} onCloseEvidence={() => { setActiveEvidenceId(undefined); setActiveTimeline(undefined); }} connectionResult={connectionResult} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} requestPreview={requestPreview} splitPercent={splitPercent} setSplitPercent={setSplitPercent} splitCustomized={splitCustomized} setSplitCustomized={setSplitCustomized} chatViewport={chatViewport} setChatViewport={setChatViewport} eventFilters={eventFilters} setEventFilters={setEventFilters} collapsedEventTurns={collapsedEventTurns} setCollapsedEventTurns={setCollapsedEventTurns} selectedMessageId={selectedMessageId} selectedRawSequence={selectedRawSequence} selectedNetworkId={selectedNetworkId} acceptedForms={acceptedForms} messageActionFeedback={messageActionFeedback} visualFeedback={visualFeedback} onMessageActionFeedback={setMessageActionFeedback} onSelectMessage={selectMessage} onSelectEvent={selectEvent} onCreateMapping={(event) => { post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, mappingDraftFromRawEvent(event, profile)] }); setNotice(t('Created mapping draft from raw event #{sequence}.', { sequence: formatNumber(event.sequence) })); }} rightPaneMode={rightPaneMode} setRightPaneMode={setRightPaneMode} redTeamSection={redTeamSection} setRedTeamSection={setRedTeamSection} selectedCampaignId={selectedCampaignId} setSelectedCampaignId={setSelectedCampaignId} configurationSection={configurationSection} setConfigurationSection={setConfigurationSection} mappingTestResult={mappingTestResult} remoteName={remoteName} profileDirty={profileDirty} diagnostics={diagnostics} scrollPositions={scrollPositionsRef.current} onScrollPositionChange={updateScrollPosition} expandedAdversarialCaseId={expandedAdversarialCaseId} setExpandedAdversarialCaseId={setExpandedAdversarialCaseId} networkInspector={networkInspector} setNetworkInspector={setNetworkInspector} />
    </section>
    <div className="sr-status" role="status" aria-live="polite">{terminalAnnouncement(snapshot?.turnState)}</div>
  </main>;
}

function TestWorkspace({ profile, snapshot, runs, networkEntries, testResults, adversarialCaseCatalog, linkedAdversarialCaseEditor, adversarialCaseCollection, setAdversarialCaseCollection, adversarialResultCollection, setAdversarialResultCollection, campaignDashboard, activeEvidenceId, activeTimeline, onCloseEvidence, connectionResult, active, continuationBlocked, draft, setDraft, send, inspectorTab, setInspectorTab, requestPreview, splitPercent, setSplitPercent, splitCustomized, setSplitCustomized, chatViewport, setChatViewport, eventFilters, setEventFilters, collapsedEventTurns, setCollapsedEventTurns, selectedMessageId, selectedRawSequence, selectedNetworkId, acceptedForms, messageActionFeedback, visualFeedback, onMessageActionFeedback, onSelectMessage, onSelectEvent, onCreateMapping, rightPaneMode, setRightPaneMode, redTeamSection, setRedTeamSection, selectedCampaignId, setSelectedCampaignId, configurationSection, setConfigurationSection, mappingTestResult, remoteName, profileDirty, diagnostics, scrollPositions, onScrollPositionChange, expandedAdversarialCaseId, setExpandedAdversarialCaseId, networkInspector, setNetworkInspector }: {
  profile: TurnStageProfile;
  snapshot?: SessionSnapshot;
  runs: LocalRunSummary[];
  networkEntries: NetworkExchange[];
  testResults: AdversarialResultSummary[];
  adversarialCaseCatalog?: AdversarialCaseCatalog;
  linkedAdversarialCaseEditor?: LinkedAdversarialCaseEditorState;
  adversarialCaseCollection: AdversarialCaseCollectionState;
  setAdversarialCaseCollection: (state: AdversarialCaseCollectionState) => void;
  adversarialResultCollection: AdversarialResultCollectionState;
  setAdversarialResultCollection: (state: AdversarialResultCollectionState) => void;
  campaignDashboard?: CampaignDashboardV1;
  activeEvidenceId?: string;
  activeTimeline?: EvidenceTimelineSummary;
  onCloseEvidence: () => void;
  connectionResult?: ConnectionDoctorSummary;
  active: boolean;
  continuationBlocked: boolean;
  draft: string;
  setDraft: (value: string) => void;
  send: (text?: string, interaction?: any) => void;
  inspectorTab: InspectorTab;
  setInspectorTab: (tab: InspectorTab) => void;
  requestPreview: unknown;
  splitPercent: number;
  setSplitPercent: (value: number) => void;
  splitCustomized: boolean;
  setSplitCustomized: (value: boolean) => void;
  chatViewport: ChatViewportState;
  setChatViewport: (value: ChatViewportState) => void;
  eventFilters: InspectorEventFilters;
  setEventFilters: (value: InspectorEventFilters) => void;
  collapsedEventTurns: CollapsedEventTurns;
  setCollapsedEventTurns: (value: CollapsedEventTurns) => void;
  selectedMessageId?: string;
  selectedRawSequence?: number;
  selectedNetworkId?: string;
  acceptedForms: ReadonlySet<string>;
  messageActionFeedback?: MessageActionFeedback;
  visualFeedback?: VisualFeedback;
  onMessageActionFeedback: (feedback: MessageActionFeedback | undefined) => void;
  onSelectMessage: (messageId: string) => void;
  onSelectEvent: (event: Record<string, unknown>) => void;
  onCreateMapping: (event: RawStreamEvent) => void;
  rightPaneMode: RightPaneMode;
  setRightPaneMode: (mode: RightPaneMode) => void;
  redTeamSection: RedTeamSectionId;
  setRedTeamSection: (section: RedTeamSectionId) => void;
  selectedCampaignId?: string;
  setSelectedCampaignId: (id: string | undefined) => void;
  configurationSection: SettingsSectionId;
  setConfigurationSection: (section: SettingsSectionId) => void;
  mappingTestResult?: MappingTestResult;
  remoteName?: string;
  profileDirty: boolean;
  diagnostics: Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }>;
  scrollPositions: Partial<Record<ScrollPositionKey, number>>;
  onScrollPositionChange: (key: ScrollPositionKey, value: number) => void;
  expandedAdversarialCaseId?: string;
  setExpandedAdversarialCaseId: (id: string | undefined) => void;
  networkInspector: NetworkInspectorState;
  setNetworkInspector: (state: NetworkInspectorState) => void;
}): React.JSX.Element {
  const [testOperation, setTestOperation] = useState<TestOperationSnapshot>();
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (isHostMessage(event.data, instanceId) && event.data.type === 'test.operation') setTestOperation(event.data.operation);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const layout = resolveUiLayout(profile.ui);
  const showRightPane = layout.showInspector || rightPaneMode !== 'debug' || selectedMessageId !== undefined;
  const rightPanePosition = rightPaneMode === 'debug' ? layout.inspectorPosition : 'right';
  const layoutSignature = `${layout.preset}:${rightPanePosition}:${layout.inspectorWidth ?? 'auto'}:${rightPaneMode}`;
  const hasConfiguredRightWidth = rightPanePosition === 'right' && layout.inspectorWidth !== undefined;
  const previousLayoutSignature = useRef(layoutSignature);
  useEffect(() => {
    if (previousLayoutSignature.current === layoutSignature) return;
    previousLayoutSignature.current = layoutSignature;
    setSplitCustomized(false);
  }, [layoutSignature, setSplitCustomized]);
  useEffect(() => {
    const workspace = workspaceRef.current;
    const preview = previewRef.current;
    if (!showRightPane || !hasConfiguredRightWidth || splitCustomized || !workspace || !preview) return;
    const update = () => {
      const workspaceRect = workspace.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const available = workspaceRect.width;
      const occupied = previewRect.width;
      if (previewRect.width >= workspaceRect.width - 1) return;
      if (available) setSplitPercent(clampSplit((occupied / available) * 100));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [hasConfiguredRightWidth, showRightPane, layoutSignature, setSplitPercent, splitCustomized]);
  const resizeFromPointer = (clientX: number, clientY: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    const available = rightPanePosition === 'right' ? rect?.width : rect?.height;
    if (!rect || !available) return;
    const offset = rightPanePosition === 'right' ? clientX - rect.left : clientY - rect.top;
    setSplitCustomized(true);
    setSplitPercent(clampSplit((offset / available) * 100));
  };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => resizeFromPointer(moveEvent.clientX, moveEvent.clientY);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
  };
  const trackSizes = splitTrackSizes(splitPercent, hasConfiguredRightWidth ? layout.inspectorWidth : undefined, splitCustomized);
  const workspaceClassName = ['test-workspace', `test-workspace--${layout.preset}`, `test-workspace--inspector-${rightPanePosition}`, rightPaneMode !== 'debug' ? 'test-workspace--configuration-open' : '', layout.compact ? 'test-workspace--compact' : ''].filter(Boolean).join(' ');
  const decrementKey = rightPanePosition === 'right' ? 'ArrowLeft' : 'ArrowUp';
  const incrementKey = rightPanePosition === 'right' ? 'ArrowRight' : 'ArrowDown';
  const selectRightPaneMode = (mode: RightPaneMode, focus = false) => {
    setRightPaneMode(mode);
    if (focus) focusAfterRender(() => document.getElementById(`right-pane-${mode}-tab`)?.focus());
  };
  const activeEvidence = resolveActiveEvidence(testResults, activeEvidenceId);
  const replayActive = snapshot?.replay && (snapshot.replay.status === 'playing' || snapshot.replay.status === 'paused') ? snapshot.replay : undefined;
  return <div className="test-surface">
    <div className="test-surface__header">{replayActive && <ReplayOperationStatus replay={replayActive} onOpenControls={() => { setRightPaneMode('debug'); setInspectorTab('Runs'); }} />}{activeEvidence && <EvidenceReviewBar results={testResults} selection={activeEvidence} inspectorTab={inspectorTab} onReviewTimeline={() => { setRightPaneMode('adversarial'); setRedTeamSection('timeline'); post({ type: 'test.timeline.open', evidenceId: activeEvidence.evidenceId }); }} onClose={onCloseEvidence} />}</div>
    <div ref={workspaceRef} className={workspaceClassName} style={{ '--preview-size': trackSizes.preview, '--inspector-size': trackSizes.inspector } as React.CSSProperties}>
    <section ref={previewRef} className="preview-pane">
      <MobileChatPreview profile={profile} snapshot={snapshot} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} post={post} viewport={chatViewport} onViewportChange={setChatViewport} onConfigure={() => setRightPaneMode('configure')} selectedMessageId={rightPaneMode === 'debug' ? selectedMessageId : undefined} onSelectMessage={onSelectMessage} acceptedForms={acceptedForms} messageActionFeedback={messageActionFeedback} visualFeedback={visualFeedback} onMessageActionFeedback={onMessageActionFeedback} initialMessageScrollTop={scrollPositions.chat} onMessageScrollTopChange={(value) => onScrollPositionChange('chat', value)} />
    </section>
    {showRightPane && <>
      <div className={`splitter splitter--${rightPanePosition}`} role="separator" aria-label={t('Resize chat preview and right panel')} aria-orientation={rightPanePosition === 'right' ? 'vertical' : 'horizontal'} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(splitPercent)} tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => {
        if (event.key === decrementKey || event.key === incrementKey) { event.preventDefault(); setSplitCustomized(true); setSplitPercent(clampSplit(splitPercent + (event.key === decrementKey ? -2 : 2))); }
        else if (event.key === 'Home') { event.preventDefault(); setSplitCustomized(true); setSplitPercent(10); }
        else if (event.key === 'End') { event.preventDefault(); setSplitCustomized(true); setSplitPercent(90); }
      }}><span aria-hidden="true" /></div>
      <aside className="debug-pane" aria-label={t('Debug and profile configuration')}>
        <header className="right-pane-heading">
          <div className="right-pane-tabs" role="tablist" aria-label={t('Right panel')} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const currentIndex = rightPaneModes.indexOf(rightPaneMode);
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? rightPaneModes.length - 1 : (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + rightPaneModes.length) % rightPaneModes.length;
            selectRightPaneMode(rightPaneModes[nextIndex]!, true);
          }}>
            <button id="right-pane-debug-tab" type="button" role="tab" tabIndex={rightPaneMode === 'debug' ? 0 : -1} aria-selected={rightPaneMode === 'debug'} aria-controls="right-pane-panel" onClick={() => selectRightPaneMode('debug')}>{t('Debug')}</button>
            <button id="right-pane-adversarial-tab" type="button" role="tab" tabIndex={rightPaneMode === 'adversarial' ? 0 : -1} aria-selected={rightPaneMode === 'adversarial'} aria-controls="right-pane-panel" onClick={() => selectRightPaneMode('adversarial')}>{t('Red Team')}</button>
            <button id="right-pane-configure-tab" type="button" role="tab" tabIndex={rightPaneMode === 'configure' ? 0 : -1} aria-selected={rightPaneMode === 'configure'} aria-controls="right-pane-panel" onClick={() => selectRightPaneMode('configure')}>{t('Configure')}</button>
          </div>
          <span>{rightPaneMode === 'debug' ? t('{count} raw events', { count: formatNumber(snapshot?.rawEvents.length ?? 0) }) : rightPaneMode === 'adversarial' ? t('{count} adversarial cases', { count: formatNumber(profile.tests?.scenarios?.filter((scenario) => scenario.adversarial).length ?? 0) }) : t('Edits profile JSONC')}</span>
        </header>
        <div id="right-pane-panel" className="right-pane-panel" role="tabpanel" aria-labelledby={`right-pane-${rightPaneMode}-tab`} tabIndex={-1}>
          {rightPaneMode === 'debug'
            ? <Inspector profile={profile} snapshot={snapshot} runs={runs} networkEntries={networkEntries} active={active} tab={inspectorTab} setTab={setInspectorTab} requestPreview={requestPreview} interactive={!isInteractionLocked(profile, 'inspector.open', active)} eventFilters={eventFilters} onEventFiltersChange={setEventFilters} collapsedEventTurns={collapsedEventTurns} onCollapsedEventTurnsChange={setCollapsedEventTurns} onCreateMapping={onCreateMapping} selectedSequence={selectedRawSequence} selectedNetworkId={selectedNetworkId} onSelectEvent={onSelectEvent} scrollPositions={scrollPositions} onScrollPositionChange={onScrollPositionChange} networkInspector={networkInspector} onNetworkInspectorChange={setNetworkInspector} />
            : rightPaneMode === 'adversarial'
              ? <AdversarialWorkspace profile={profile} testResults={testResults} campaignDashboard={campaignDashboard} testOperation={testOperation} activeEvidenceId={activeEvidenceId} timeline={activeEvidence && activeTimeline ? <CausalTimeline timeline={activeTimeline} onOpen={(location) => post({ type: 'test.evidence.open', evidenceId: activeEvidence.evidenceId, location })} /> : undefined} trusted={snapshot?.trusted === true} post={post} scrollTop={scrollPositions.adversarial} onScrollTopChange={(value) => onScrollPositionChange('adversarial', value)} activeSection={redTeamSection} onActiveSectionChange={setRedTeamSection} selectedCampaignId={selectedCampaignId} onSelectedCampaignIdChange={setSelectedCampaignId} expandedCaseId={expandedAdversarialCaseId} onExpandedCaseIdChange={setExpandedAdversarialCaseId} linkedCaseCatalog={adversarialCaseCatalog} linkedCaseEditor={linkedAdversarialCaseEditor} caseCollection={adversarialCaseCollection} onCaseCollectionChange={setAdversarialCaseCollection} resultCollection={adversarialResultCollection} onResultCollectionChange={setAdversarialResultCollection} />
              : <SettingsWorkspace embedded section={configurationSection} onSectionChange={setConfigurationSection} profile={profile} snapshot={snapshot} requestPreview={requestPreview} remoteName={remoteName} mappingTestResult={mappingTestResult} connectionResult={connectionResult} testResults={testResults} campaignDashboard={campaignDashboard} testOperation={testOperation} profileDirty={profileDirty} diagnostics={diagnostics} post={post} scrollStateKey={configurationSection} scrollTop={scrollPositions[`configure.${configurationSection}`]} onScrollTopChange={(value) => onScrollPositionChange(`configure.${configurationSection}`, value)} />}
        </div>
      </aside>
    </>}
    </div>
  </div>;
}

type AdversarialAttemptNavigation = NonNullable<NonNullable<AdversarialResultSummary['repetitions']>['attempts']>[number];
export interface ActiveEvidenceSelection { result: AdversarialResultSummary; attempt?: AdversarialAttemptNavigation; evidenceId: string }

export function resolveActiveEvidence(results: readonly AdversarialResultSummary[], evidenceId: string | undefined): ActiveEvidenceSelection | undefined {
  if (!evidenceId) return undefined;
  for (const result of results) {
    if (result.evidenceId === evidenceId) return { result, evidenceId };
    const attempt = result.repetitions?.attempts?.find((candidate) => candidate.evidenceId === evidenceId);
    if (attempt) return { result, attempt, evidenceId };
  }
  return undefined;
}

export function EvidenceReviewBar({ results, selection, inspectorTab, onReviewTimeline, onClose }: { results: readonly AdversarialResultSummary[]; selection: ActiveEvidenceSelection; inspectorTab: InspectorTab; onReviewTimeline: () => void; onClose: () => void }): React.JSX.Element {
  const caseIndex = Math.max(0, results.indexOf(selection.result));
  const attempts = selection.result.repetitions?.attempts ?? [];
  const open = (result: AdversarialResultSummary, attempt?: AdversarialAttemptNavigation) => {
    const evidenceId = attempt?.evidenceId ?? result.evidenceId;
    if (!evidenceId) return;
    const locations = evidenceLocations(result, attempt);
    post({ type: 'test.evidence.open', evidenceId, location: preferredEvidenceLocation(locations, inspectorTab) ?? { kind: 'profile', path: 'tests.scenarios' } });
  };
  const selectCase = (index: number) => { const result = results[index]; if (result) open(result); };
  const attemptValue = selection.attempt ? `attempt:${selection.attempt.attempt}` : 'aggregate';
  return <section className="evidence-review" aria-label={t('Evidence review')}>
    <header className="evidence-review__heading">
      <strong>{t('Evidence review')}</strong>
      <div className="evidence-review__heading-actions">
        <button type="button" onClick={onReviewTimeline}>{t('Timeline')}</button>
        <IconButton type="button" icon="export" label={t('Export this case as HTML')} onClick={() => post({ type: 'test.report.export', format: 'html', evidenceId: selection.evidenceId })} />
        <IconButton type="button" icon="close" label={t('Close evidence review')} onClick={onClose} />
      </div>
    </header>
    <div className="evidence-review__navigator" role="group" aria-label={t('Evidence result navigation')}>
      <IconButton type="button" icon="arrow-left" label={t('Previous test case')} disabled={caseIndex <= 0} onClick={() => selectCase(caseIndex - 1)} />
      <label className="evidence-review__case"><span className="sr-only">{t('Test case')}</span><select aria-label={t('Test case')} title={`${selection.result.scenarioName} · ${t(adversarialOutcomeLabel(selection.result.outcome))}`} value={selection.result.evidenceId} onChange={(event) => { const result = results.find((candidate) => candidate.evidenceId === event.target.value); if (result) open(result); }}>{results.map((result, index) => <option value={result.evidenceId} key={result.evidenceId}>{formatNumber(index + 1)} / {formatNumber(results.length)} · {result.scenarioName}</option>)}</select></label>
      <IconButton type="button" icon="arrow-right" label={t('Next test case')} disabled={caseIndex >= results.length - 1} onClick={() => selectCase(caseIndex + 1)} />
      {attempts.length > 0 && <label className="evidence-review__attempt"><span className="sr-only">{t('Test attempt')}</span><select aria-label={t('Test attempt')} value={attemptValue} onChange={(event) => { if (event.target.value === 'aggregate') open(selection.result); else { const attempt = attempts.find((candidate) => `attempt:${candidate.attempt}` === event.target.value); if (attempt?.evidenceId) open(selection.result, attempt); } }}><option value="aggregate">{t('Aggregate result')}</option>{attempts.map((attempt) => <option key={attempt.attempt} value={`attempt:${attempt.attempt}`} disabled={!attempt.evidenceId}>{t('Attempt {attempt}: {outcome}', { attempt: formatNumber(attempt.attempt), outcome: t(adversarialOutcomeLabel(attempt.outcome)) })}{attempt.evidenceId ? '' : ` · ${t('Evidence unavailable')}`}</option>)}</select></label>}
    </div>
    <EvidenceSummary result={selection.result} attempt={selection.attempt} evidenceId={selection.evidenceId} />
  </section>;
}

export function EvidenceSummary({ result, attempt, evidenceId = result.evidenceId }: { result: AdversarialResultSummary; attempt?: AdversarialAttemptNavigation; evidenceId?: string }): React.JSX.Element {
  const detail = attempt ? undefined : result.primaryFinding ?? result.primaryIssue;
  const repetitions = result.repetitions;
  const locations = evidenceLocations(result, attempt);
  const visibleLocations = locations.slice(0, 3);
  const additionalLocations = locations.slice(3);
  const outcome = attempt?.outcome ?? result.outcome;
  const outcomeIcon = outcome === 'resisted' ? 'check' : outcome === 'attackSucceeded' ? 'target' : 'warning';
  const fallbackDetail = `${t(result.findingCount === 1 ? '{count} finding' : '{count} findings', { count: formatNumber(result.findingCount) })} · ${t(result.issueCount === 1 ? '{count} evidence issue' : '{count} evidence issues', { count: formatNumber(result.issueCount) })}`;
  return <section className={`evidence-summary evidence-summary--${outcome}`} aria-labelledby="active-evidence-heading">
    <ProductIcon name={outcomeIcon} />
    <div className="evidence-summary__body">
      <h2 id="active-evidence-heading" className="evidence-summary__heading" aria-label={t('{outcome}: {scenario}', { outcome: t(adversarialOutcomeLabel(outcome)), scenario: result.scenarioName })}><span className={`adversarial-outcome adversarial-outcome--${outcome}`}>{t(adversarialOutcomeLabel(outcome))}</span><span aria-hidden="true">·</span><span>{result.scenarioName}{attempt ? ` · ${t('Attempt {attempt}', { attempt: formatNumber(attempt.attempt) })}` : ''}</span></h2>
      <p>{attempt ? t('{completed} turns completed · {duration}', { completed: formatNumber(attempt.completedTurns), duration: formatDuration(attempt.durationMs) }) : detail?.label ?? fallbackDetail}</p>
      {!attempt && <span>{detail?.turnId ? t('Turn {turn}: {turnId}', { turn: formatNumber((detail.turnIndex ?? 0) + 1), turnId: detail.turnId }) : t('{completed}/{planned} turns completed', { completed: formatNumber(result.completedTurns), planned: formatNumber(result.plannedTurns) })}{result.primaryFinding?.ruleId ? ` · ${result.primaryFinding.ruleId}` : ''}</span>}
      {!attempt && repetitions && <span>{t('{resisted}/{requested} resisted · {completed} attempts · {stability}', {
        resisted: formatNumber(repetitions.counts.resisted),
        requested: formatNumber(repetitions.requestedAttempts),
        completed: formatNumber(repetitions.completedAttempts),
        stability: t(adversarialStabilityLabel(repetitions.stability)),
      })}{repetitions.sampleComplete ? '' : ` · ${t('Incomplete sample')}`}</span>}
      {!attempt && result.reliability && <span>{t('Reliability: {rate} · {verdict}', {
        rate: result.reliability.resistanceRate === undefined ? t('Unavailable') : `${formatNumber(result.reliability.resistanceRate * 100)}%`,
        verdict: t(result.reliability.verdict === 'meetsTarget' ? 'Meets target' : result.reliability.verdict === 'doesNotMeetTarget' ? 'Does not meet target' : 'Insufficient evidence'),
      })}{result.reliability.durationP95Ms === undefined ? '' : ` · ${t('p95 {duration}', { duration: formatDuration(result.reliability.durationP95Ms) })}`}</span>}
    </div>
    <div className="evidence-summary__actions" role="group" aria-label={t('Open evidence location')}>
      {visibleLocations.map((location, index) => <button className={index === 0 ? 'primary' : undefined} key={`${evidenceId}-${location.kind}-${index}`} type="button" onClick={() => post({ type: 'test.evidence.open', evidenceId, location })}>{index === 0 ? t('Open {location}', { location: t(evidenceLocationLabel(location.kind)) }) : t(evidenceLocationLabel(location.kind))}</button>)}
      {additionalLocations.length > 0 && <details className="evidence-summary__more">
        <summary aria-label={t('More evidence locations')} title={t('More evidence locations')}><ProductIcon name="ellipsis" /></summary>
        <div>{additionalLocations.map((location, index) => <button key={`${evidenceId}-${location.kind}-more-${index}`} type="button" onClick={() => post({ type: 'test.evidence.open', evidenceId, location })}>{t(evidenceLocationLabel(location.kind))}</button>)}</div>
      </details>}
      {!locations.length && <span className="muted">{t('Evidence unavailable')}</span>}
    </div>
  </section>;
}

function evidenceLocations(result: AdversarialResultSummary, attempt?: AdversarialAttemptNavigation): ScenarioEvidenceLocation[] {
  const candidates = attempt
    ? [attempt.primaryLocation, ...(attempt.availableLocations ?? [])]
    : [result.primaryLocation, ...result.availableLocations];
  return candidates.filter((location): location is ScenarioEvidenceLocation => Boolean(location)).filter((location, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(location)) === index);
}

function preferredEvidenceLocation(locations: readonly ScenarioEvidenceLocation[], inspectorTab: InspectorTab): ScenarioEvidenceLocation | undefined {
  const kind = inspectorTab === 'Network' ? 'network' : inspectorTab === 'Raw Events' ? 'rawEvent' : inspectorTab === 'Normalized' ? 'normalizedEvent' : undefined;
  return (kind ? locations.find((location) => location.kind === kind) : undefined) ?? locations[0];
}

export function CausalTimeline({ timeline, onOpen }: { timeline: EvidenceTimelineSummary; onOpen: (location: ScenarioEvidenceLocation) => void }): React.JSX.Element {
  const visible = timeline.entries.slice(0, 16);
  const hiddenCount = Math.max(0, timeline.entries.length - visible.length);
  const completeness = timeline.completeness === 'complete' ? t('Complete evidence') : timeline.completeness === 'partial' ? t('Partial evidence') : t('Missing evidence');
  const decisiveId = visible.find((entry) => entry.status === 'failure' && (entry.phase === 'finding' || entry.phase === 'error'))?.id ?? visible.find((entry) => entry.status === 'failure')?.id;
  return <details className="causal-timeline" open>
    <summary><span>{t('Evidence trail')}</span><small>{t('{count} events · {completeness}', { count: formatNumber(timeline.entries.length), completeness })}</small></summary>
    {timeline.missingPhases.length > 0 && <p className="causal-timeline__missing"><ProductIcon name="warning" />{t('Evidence is incomplete: {phases}.', { phases: timeline.missingPhases.map(timelinePhaseLabel).join(', ') })}</p>}
    <ol>
      {visible.map((entry, index) => <TimelineEntry key={entry.id} entry={entry} deltaMs={index === 0 ? undefined : Math.max(0, entry.elapsedMs - visible[index - 1]!.elapsedMs)} decisive={entry.id === decisiveId} onOpen={onOpen} />)}
    </ol>
    {hiddenCount > 0 && <p>{t('{count} additional timeline events are not shown.', { count: formatNumber(hiddenCount) })}</p>}
    {timeline.truncated && <p>{t('Timeline evidence reached the safe retention limit.')}</p>}
  </details>;
}

function TimelineEntry({ entry, deltaMs, decisive, onOpen }: { entry: EvidenceTimelineEntry; deltaMs?: number; decisive?: boolean; onOpen: (location: ScenarioEvidenceLocation) => void }): React.JSX.Element {
  const content = <><span className="causal-timeline__entry-meta"><span>{timelineStageLabel(entry.phase)}</span><time>{formatDuration(entry.elapsedMs)}</time>{deltaMs === undefined ? <small>{t('Start')}</small> : <small>+{formatDuration(deltaMs)}</small>}</span><span className="causal-timeline__entry-label">{t(entry.label)}</span>{decisive && <strong>{t('Decisive evidence')}</strong>}</>;
  return <li className={`causal-timeline__entry causal-timeline__entry--${entry.status}${decisive ? ' is-decisive' : ''}`}>
    <ProductIcon name={entry.status === 'failure' ? 'error' : entry.status === 'warning' || entry.status === 'unknown' ? 'warning' : 'circle-filled'} />
    {entry.location ? <button type="button" onClick={() => onOpen(entry.location!)} aria-label={t('Open {label} evidence at {elapsed}', { label: t(entry.label), elapsed: formatDuration(entry.elapsedMs) })}>{content}</button> : <div>{content}</div>}
  </li>;
}

function timelineStageLabel(phase: EvidenceTimelineEntry['phase']): string {
  if (phase === 'request' || phase === 'headers') return t('Request');
  if (phase === 'firstChunk' || phase === 'firstEvent' || phase === 'firstMappedEvent' || phase === 'ttft') return t('Stream');
  return t('Decision');
}

function timelinePhaseLabel(phase: EvidenceTimelineSummary['missingPhases'][number]): string {
  if (phase === 'firstChunk') return t('first chunk');
  if (phase === 'firstEvent') return t('first event');
  if (phase === 'firstMappedEvent') return t('first mapped event');
  return t(localizeHumanized(phase));
}

function adversarialStabilityLabel(stability: NonNullable<AdversarialResultSummary['repetitions']>['stability']): string {
  if (stability === 'stable-pass') return 'Stable resistance';
  if (stability === 'stable-fail') return 'Stable attack success';
  if (stability === 'unstable') return 'Unstable result';
  return 'Inconclusive';
}

export const JsonBlock = JsonViewer;

export function Inspector({ profile, snapshot, runs = [], networkEntries = [], active = false, tab, setTab, requestPreview, full = false, interactive = true, eventFilters = normalizeInspectorEventFilters(), onEventFiltersChange = () => undefined, collapsedEventTurns = normalizeCollapsedEventTurns(), onCollapsedEventTurnsChange = () => undefined, onCreateMapping, selectedSequence, selectedNetworkId, onSelectEvent, scrollPositions = {}, onScrollPositionChange = () => undefined, networkInspector, onNetworkInspectorChange }: { profile?: TurnStageProfile; snapshot?: SessionSnapshot; runs?: LocalRunSummary[]; networkEntries?: NetworkExchange[]; active?: boolean; tab: InspectorTab; setTab: (tab: InspectorTab) => void; requestPreview: unknown; full?: boolean; interactive?: boolean; eventFilters?: InspectorEventFilters; onEventFiltersChange?: (filters: InspectorEventFilters) => void; collapsedEventTurns?: CollapsedEventTurns; onCollapsedEventTurnsChange?: (turns: CollapsedEventTurns) => void; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; selectedNetworkId?: string; onSelectEvent?: (event: Record<string, unknown>) => void; scrollPositions?: Partial<Record<ScrollPositionKey, number>>; onScrollPositionChange?: (key: ScrollPositionKey, value: number) => void; networkInspector?: NetworkInspectorState; onNetworkInspectorChange?: (state: NetworkInspectorState) => void }): React.JSX.Element {
  const availableTabs: InspectorTab[] = profile && !componentVisible(profile, 'metrics') ? inspectorTabs.filter((item): item is InspectorTab => item !== 'Metrics') : [...inspectorTabs];
  const effectiveTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;
  const data = effectiveTab === 'Raw Events' ? snapshot?.rawEvents ?? [] : effectiveTab === 'Normalized' ? snapshot?.normalizedEvents ?? [] : [];
  const eventKind = effectiveTab === 'Normalized' ? 'normalized' : 'raw';
  const filters = eventFilters[eventKind];
  const deferredQuery = useDeferredValue(filters.query);
  const effectiveFilters = deferredQuery === filters.query ? filters : { ...filters, query: deferredQuery };
  const eventDeltas = useMemo(() => eventKind === 'raw' ? eventTimeDeltas(data) : undefined, [data, eventKind]);
  const terminalRawSequences = useMemo(() => terminalSequences(snapshot?.normalizedEvents ?? []), [snapshot?.normalizedEvents]);
  const types = useMemo(() => [...new Set(data.map((item) => eventLabel(item)))].sort(), [data]);
  const turns = useMemo(() => eventTurnOptions(data), [data]);
  const filtered = useMemo(() => data.filter((item) => eventMatchesFilters(item, effectiveFilters, eventKind, terminalRawSequences)), [data, effectiveFilters, eventKind, terminalRawSequences]);
  const updateFilters = (patch: Partial<EventFilterState>) => onEventFiltersChange({ ...eventFilters, [eventKind]: { ...filters, ...patch } });
  const filtersActive = filters.query !== '' || filters.turn !== 'all' || filters.eventType !== 'all' || filters.mapping !== 'all' || filters.issue !== 'all' || filters.terminal !== 'all';
  const panelContent = effectiveTab === 'Network'
    ? <NetworkInspector entries={networkEntries} legacyRequestPreview={requestPreview} selectedEntryId={selectedNetworkId} state={networkInspector} onStateChange={onNetworkInspectorChange} />
    : effectiveTab === 'Raw Events' || effectiveTab === 'Normalized'
      ? <div className="event-inspector">
        <div className="event-filters">
          <label className="event-search"><span className="sr-only">{t('Search events')}</span><input type="search" value={filters.query} placeholder={t('Search events')} aria-label={t('Search events')} disabled={!interactive} onChange={(event) => updateFilters({ query: event.target.value })} /></label>
          <label className="event-turn-filter"><span className="sr-only">{t('Conversation turn')}</span><select value={turns.some((turn) => turn.key === filters.turn) ? filters.turn : 'all'} aria-label={t('Conversation turn')} onChange={(event) => updateFilters({ turn: event.target.value })} disabled={!interactive}><option value="all">{t('All turns')}</option>{turns.map((turn) => <option key={turn.key} value={turn.key}>{turn.label} ({formatNumber(turn.count)})</option>)}</select></label>
          <details className="event-filter-more">
            <summary>{t(filtersActive ? 'Filters active' : 'Filters')}</summary>
            <div>
              <label><span>{t('Event type')}</span><select value={filters.eventType} aria-label={t('Event type')} onChange={(event) => updateFilters({ eventType: event.target.value })} disabled={!interactive}><option value="all">{t('All types')}</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              {eventKind === 'raw' && <label><span>{t('Mapping status')}</span><select value={filters.mapping} aria-label={t('Mapping status')} onChange={(event) => updateFilters({ mapping: event.target.value as EventMappingFilter })} disabled={!interactive}><option value="all">{t('All mappings')}</option><option value="matched">{t('Matched')}</option><option value="unmatched">{t('Unmatched')}</option></select></label>}
              {eventKind === 'raw' && <label><span>{t('Event health')}</span><select value={filters.issue} aria-label={t('Event health')} onChange={(event) => updateFilters({ issue: event.target.value as EventIssueFilter })} disabled={!interactive}><option value="all">{t('All health')}</option><option value="problem">{t('Problems only')}</option><option value="valid">{t('Valid')}</option><option value="parse-error">{t('Parse errors')}</option><option value="mapping-error">{t('Mapping errors')}</option></select></label>}
              <label><span>{t('Terminal status')}</span><select value={filters.terminal} aria-label={t('Terminal status')} onChange={(event) => updateFilters({ terminal: event.target.value as EventTerminalFilter })} disabled={!interactive}><option value="all">{t('All events')}</option><option value="terminal">{t('Terminal')}</option><option value="non-terminal">{t('Non-terminal')}</option></select></label>
              <button type="button" aria-label={t('Clear event filters')} disabled={!interactive || !filtersActive} onClick={() => onEventFiltersChange({ ...eventFilters, [eventKind]: { ...DEFAULT_EVENT_FILTERS } })}>{t('Clear filters')}</button>
            </div>
          </details>
          {eventKind === 'raw' && <button type="button" className="event-problems-filter" aria-pressed={filters.issue === 'problem'} disabled={!interactive} onClick={() => updateFilters({ issue: filters.issue === 'problem' ? 'all' : 'problem' })}>{t('Problems only')}</button>}
          <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(data.length) })}</span>
        </div>
        {filtered.length ? <VirtualEvents items={filtered} messages={snapshot?.messages ?? []} kind={eventKind} eventDeltas={eventDeltas} terminalRawSequences={terminalRawSequences} label={t(effectiveTab)} collapsedTurnKeys={collapsedEventTurns[eventKind]} onCollapsedTurnKeysChange={(keys) => onCollapsedEventTurnsChange({ ...collapsedEventTurns, [eventKind]: keys })} onCreateMapping={effectiveTab === 'Raw Events' && interactive ? onCreateMapping : undefined} selectedSequence={selectedSequence} onSelectEvent={onSelectEvent} initialScrollTop={scrollPositions[`events.${eventKind}`]} onScrollTopChange={(value) => onScrollPositionChange(`events.${eventKind}`, value)} /> : <div className="empty-state compact empty-state--action"><strong>{t(filtersActive ? 'No events match the current filters.' : 'No events recorded yet.')}</strong>{filtersActive ? <button type="button" onClick={() => onEventFiltersChange({ ...eventFilters, [eventKind]: { ...DEFAULT_EVENT_FILTERS } })}>{t('Clear filters')}</button> : <button type="button" disabled={!interactive || active} onClick={() => post({ type: 'session.start' })}>{t('Start session')}</button>}</div>}
      </div>
      : effectiveTab === 'Metrics'
        ? <MetricGrid metrics={snapshot?.metrics} enabled={profile?.metrics?.enabled} />
        : effectiveTab === 'Errors'
          ? <div className="error-list">{snapshot?.errors.length ? snapshot.errors.map((error, index) => <details key={`${error.type}-${index}`}><summary>{error.type}</summary><p>{error.message}</p><JsonBlock value={error} /></details>) : <p className="muted">{t('No runtime errors.')}</p>}</div>
          : <Replay runs={runs} replay={snapshot?.replay} remoteSessions={snapshot?.remoteSessions} active={active} trusted={snapshot?.trusted === true} />;
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: InspectorTab) => {
    const currentIndex = availableTabs.indexOf(currentTab);
    const nextIndex = getRovingIndex(currentIndex, event.key, availableTabs.length, 'horizontal');
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = availableTabs[nextIndex];
    if (!nextTab) return;
    setTab(nextTab);
    requestAnimationFrame(() => document.getElementById(inspectorTabId(nextTab))?.focus());
  };
  return <div className={`inspector-content ${full ? 'full' : ''}`}>
    <div className="mini-tabs" role="tablist" aria-orientation="horizontal" aria-label={t('Evidence views')}>{availableTabs.map((item) => <button key={item} id={inspectorTabId(item)} role="tab" aria-selected={effectiveTab === item} aria-controls={inspectorPanelId(item)} tabIndex={effectiveTab === item ? 0 : -1} disabled={!interactive} onClick={() => setTab(item)} onKeyDown={(event) => handleTabKeyDown(event, item)}>{t(inspectorTabLabel(item))}</button>)}</div>
    {snapshot?.droppedEventCount ? <p className="warning">{t('{count} old events were dropped due to buffer limits.', { count: formatNumber(snapshot.droppedEventCount) })}</p> : null}
    {snapshot?.droppedNormalizedEventCount ? <p className="warning">{t('{count} old normalized events were dropped due to buffer limits.', { count: formatNumber(snapshot.droppedNormalizedEventCount) })}</p> : null}
    {snapshot?.droppedMessageCount ? <p className="warning">{t('{count} old messages were dropped due to conversation limits.', { count: formatNumber(snapshot.droppedMessageCount) })}</p> : null}
    {availableTabs.map((item) => <section key={item} id={inspectorPanelId(item)} role="tabpanel" aria-labelledby={inspectorTabId(item)} hidden={effectiveTab !== item} tabIndex={effectiveTab === item ? 0 : -1} style={{ display: effectiveTab === item ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{effectiveTab === item ? panelContent : null}</section>)}
  </div>;
}

export function NetworkInspector({ entries, legacyRequestPreview, selectedEntryId, state, onStateChange }: { entries: NetworkExchange[]; legacyRequestPreview?: unknown; selectedEntryId?: string; state?: NetworkInspectorState; onStateChange?: (state: NetworkInspectorState) => void }): React.JSX.Element {
  const [uncontrolledState, setUncontrolledState] = useState<NetworkInspectorState>(() => normalizeNetworkInspectorState(state));
  const currentState = state ?? uncontrolledState;
  const { query, selectedId, detailTab } = currentState;
  const updateState = (patch: Partial<NetworkInspectorState>) => {
    const next = normalizeNetworkInspectorState({ ...currentState, ...patch });
    if (!state) setUncontrolledState(next);
    onStateChange?.(next);
  };
  useEffect(() => { if (selectedEntryId && entries.some((entry) => entry.id === selectedEntryId)) updateState({ selectedId: selectedEntryId }); }, [entries, selectedEntryId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => entries.filter((entry) => !normalizedQuery || `${entry.kind} ${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.state} ${entry.variantId ?? ''} ${entry.correlation?.traceId ?? ''} ${entry.correlation?.spanId ?? ''} ${entry.correlation?.requestId ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)), [entries, normalizedQuery]);
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered.at(-1);
  const selectedIndex = selected ? filtered.findIndex((entry) => entry.id === selected.id) : -1;
  const select = (entry: NetworkExchange, focus = false) => {
    updateState({ selectedId: entry.id });
    if (focus) requestAnimationFrame(() => document.getElementById(networkRowId(entry.id))?.focus());
  };
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = getRovingIndex(index, event.key, filtered.length, 'vertical');
    if (next === undefined) return;
    event.preventDefault();
    const entry = filtered[next];
    if (entry) select(entry, true);
  };
  const handleDetailTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: NetworkDetailTab) => {
    const next = getRovingIndex(networkDetailTabs.indexOf(current), event.key, networkDetailTabs.length, 'horizontal');
    if (next === undefined) return;
    event.preventDefault();
    const tab = networkDetailTabs[next];
    if (!tab) return;
    updateState({ detailTab: tab });
    requestAnimationFrame(() => document.getElementById(networkDetailTabId(tab))?.focus());
  };
  if (!entries.length) return <div className="network-empty"><div className="empty-state compact"><strong>{t('No network requests')}</strong><p>{t('Start a session or send a message to capture requests.')}</p></div>{legacyRequestPreview !== undefined && <details><summary>{t('Last redacted request preview')}</summary><JsonBlock value={legacyRequestPreview} /></details>}</div>;
  return <div className={`network-inspector ${selected ? 'network-inspector--detail' : ''}`}>
    <div className="network-toolbar">
      <label><span className="sr-only">{t('Filter network requests')}</span><input type="search" value={query} placeholder={t('Filter')} aria-label={t('Filter network requests')} onChange={(event) => updateState({ query: event.target.value })} /></label>
      <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(entries.length) })}</span>
    </div>
    <div className="network-table">
      <div className="network-table__header" aria-hidden="true"><span>{t('Name')}</span><span>{t('Method')}</span><span>{t('Status')}</span><span>{t('Type')}</span><span>{t('Time')}</span><span>{t('Size')}</span></div>
      <div className="network-table__rows" role="listbox" aria-label={t('Network requests')}>
        {!filtered.length ? <div className="empty-state compact"><strong>{t('No matching requests')}</strong></div> : filtered.map((entry, index) => {
          const active = entry.id === selected?.id;
          const accessibleName = `${networkRequestName(entry)}${entry.attempt > 1 ? `, ${t('Attempt {attempt}', { attempt: formatNumber(entry.attempt) })}` : ''}`;
          return <button type="button" id={networkRowId(entry.id)} role="option" aria-label={t('{name}, method {method}, status {status}, type {type}, time {time}, size {size}', { name: accessibleName, method: entry.method, status: String(entry.status ?? localizeHumanized(entry.state)), type: entry.protocol ?? responseContentType(entry), time: entry.timing.total === undefined ? '—' : formatDuration(entry.timing.total), size: formatBytes(entry.transferredBytes) })} aria-selected={active} tabIndex={active || (selectedIndex < 0 && index === 0) ? 0 : -1} className={`network-row ${active ? 'selected' : ''}`} key={entry.id} onClick={() => select(entry)} onKeyDown={(event) => handleRowKeyDown(event, index)}>
            <span className="network-name"><ProductIcon name={networkStateIcon(entry)} /><span><strong>{networkRequestName(entry)}</strong><small>{t(networkKindLabel(entry.kind))}{entry.attempt > 1 ? ` · ${t('Attempt {attempt}', { attempt: formatNumber(entry.attempt) })}` : ''}</small></span></span>
            <span>{entry.method}</span><span className={`network-status network-status--${entry.state}`}>{entry.status ?? localizeHumanized(entry.state)}</span><span>{entry.protocol ?? responseContentType(entry)}</span><span>{entry.timing.total === undefined ? '—' : formatDuration(entry.timing.total)}</span><span>{formatBytes(entry.transferredBytes)}</span>
          </button>;
        })}
      </div>
    </div>
    {selected && <section className="network-detail" aria-label={t('Request details')}>
      <header><div><strong title={selected.url}>{networkRequestName(selected)}</strong><span>{selected.method} · {selected.status ?? localizeHumanized(selected.state)} · {formatDuration(selected.timing.total ?? 0)}</span></div></header>
      <div className="network-detail-tabs" role="tablist" aria-label={t('Request detail views')}>{networkDetailTabs.map((tab) => <button key={tab} id={networkDetailTabId(tab)} role="tab" aria-selected={detailTab === tab} aria-controls={networkDetailPanelId(tab)} tabIndex={detailTab === tab ? 0 : -1} onClick={() => updateState({ detailTab: tab })} onKeyDown={(event) => handleDetailTabKeyDown(event, tab)}>{t(tab)}</button>)}</div>
      {networkDetailTabs.map((tab) => <div key={tab} id={networkDetailPanelId(tab)} role="tabpanel" aria-labelledby={networkDetailTabId(tab)} hidden={detailTab !== tab} className="network-detail-panel">{detailTab === tab ? <NetworkDetailContent entry={selected} tab={tab} /> : null}</div>)}
    </section>}
  </div>;
}

function NetworkDetailContent({ entry, tab }: { entry: NetworkExchange; tab: NetworkDetailTab }): React.JSX.Element {
  if (tab === 'Payload') return entry.requestBody === undefined ? <p className="muted network-detail-empty">{t('No request payload.')}</p> : <JsonBlock value={entry.requestBody} />;
  if (tab === 'Response') {
    const parsed = parseJsonPreview(entry.responseBodyPreview);
    return <div className="network-response">{parsed.ok ? <JsonBlock value={parsed.value} /> : <pre>{entry.responseBodyPreview || t('No response body captured.')}</pre>}{entry.responseBodyTruncated && <p className="warning">{t('Response preview was truncated at the safety limit.')}</p>}</div>;
  }
  if (tab === 'Timing') return <dl className="network-properties"><NetworkProperty label={t('Started')} value={formatDateTime(entry.startedAt)} /><NetworkProperty label={t('Headers')} value={optionalDuration(entry.timing.headers)} /><NetworkProperty label={t('First chunk')} value={optionalDuration(entry.timing.firstChunk)} /><NetworkProperty label={t('Total')} value={optionalDuration(entry.timing.total)} /><NetworkProperty label={t('Request timeout')} value={optionalDuration(entry.timing.timeout)} /><NetworkProperty label={t('Idle timeout')} value={optionalDuration(entry.timing.idleTimeout)} />{entry.timing.retryDelay !== undefined && <NetworkProperty label={t('Retry delay')} value={formatDuration(entry.timing.retryDelay)} />}</dl>;
  return <div className="network-headers"><dl className="network-properties"><NetworkProperty label={t('Request URL')} value={entry.url} /><NetworkProperty label={t('Request method')} value={entry.method} /><NetworkProperty label={t('Status')} value={entry.status === undefined ? localizeHumanized(entry.state) : String(entry.status)} /><NetworkProperty label={t('Request type')} value={t(networkKindLabel(entry.kind))} />{entry.variantId && <NetworkProperty label={t('Variant')} value={entry.variantId} />}</dl>{entry.correlation && <section><h4>{t('Correlation')}</h4><dl className="network-properties">{entry.correlation.traceId && <NetworkProperty label={t('Trace ID')} value={entry.correlation.traceId} />}{entry.correlation.spanId && <NetworkProperty label={t('Span ID')} value={entry.correlation.spanId} />}{entry.correlation.traceFlags && <NetworkProperty label={t('Trace flags')} value={entry.correlation.traceFlags} />}{entry.correlation.requestId && <NetworkProperty label={entry.correlation.requestIdHeader ?? t('Request ID')} value={entry.correlation.requestId} />}</dl></section>}<NetworkHeaderGroup title={t('Request headers')} headers={entry.requestHeaders} /><NetworkHeaderGroup title={t('Response headers')} headers={entry.responseHeaders ?? {}} />{entry.error && <section><h4>{t('Error')}</h4><JsonBlock value={entry.error} /></section>}</div>;
}

function parseJsonPreview(value: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!value || !/^[\s]*[{[]/u.test(value)) return { ok: false };
  try { return { ok: true, value: JSON.parse(value) as unknown }; } catch { return { ok: false }; }
}

function NetworkHeaderGroup({ title, headers }: { title: string; headers: Record<string, string> }): React.JSX.Element { const items = Object.entries(headers); return <section><h4>{title}</h4>{items.length ? <dl className="network-header-list">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{isSensitiveHeaderName(name) ? '••••••••' : value}</dd></div>)}</dl> : <p className="muted">{t('No headers captured.')}</p>}</section>; }
function NetworkProperty({ label, value }: { label: string; value: string }): React.JSX.Element { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function isSensitiveHeaderName(name: string): boolean { return /^(?:authorization|proxy-authorization|cookie2?|set-cookie|x-api-key|api-key)$/iu.test(name) || /(?:^|[-_])(?:token|secret|credential|password|api[-_]?key)(?:$|[-_])/iu.test(name); }
function networkRequestName(entry: NetworkExchange): string { try { const url = new URL(entry.url); return url.pathname.split('/').filter(Boolean).at(-1) || url.host; } catch { return entry.kind; } }
function networkKindLabel(kind: NetworkExchange['kind']): string { return kind === 'opening' ? 'Opening' : kind === 'stop' ? 'Stop request' : 'Conversation stream'; }
function responseContentType(entry: NetworkExchange): string { return Object.entries(entry.responseHeaders ?? {}).find(([name]) => name.toLocaleLowerCase() === 'content-type')?.[1]?.split(';')[0] ?? 'fetch'; }
function networkStateIcon(entry: NetworkExchange): 'check' | 'warning' | 'circle-filled' | 'stop' { if (entry.state === 'failed') return 'warning'; if (entry.state === 'aborted') return 'stop'; if (entry.state === 'pending' || entry.state === 'streaming') return 'circle-filled'; return 'check'; }
function networkRowId(id: string): string { return `network-row-${stableIdToken(id)}`; }
function networkDetailTabId(tab: NetworkDetailTab): string { return `network-detail-tab-${stableIdToken(tab)}`; }
function networkDetailPanelId(tab: NetworkDetailTab): string { return `network-detail-panel-${stableIdToken(tab)}`; }
function optionalDuration(value: number | undefined): string { return value === undefined ? '—' : formatDuration(value); }
function formatBytes(value: number): string { if (value < 1024) return `${formatNumber(value)} B`; if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 1024))} KB`; return `${formatNumber(Math.round(value / (1024 * 1024)))} MB`; }

/** Calculate gaps from the complete event stream so filtering never changes timing semantics. */
export function eventTimeDeltas(items: Array<Record<string, any>>): ReadonlyMap<number, number | undefined> {
  const deltas = new Map<number, number | undefined>();
  let previousElapsed: number | undefined;
  let previousReceived: number | undefined;
  let previousTurn: string | undefined;
  for (const item of items) {
    const sequence = eventSequence(item);
    const turn = eventTurnKey(item);
    const elapsed = typeof item.elapsedMs === 'number' && Number.isFinite(item.elapsedMs) ? item.elapsedMs : undefined;
    const received = typeof item.receivedAt === 'number' && Number.isFinite(item.receivedAt) ? item.receivedAt : undefined;
    const sameTurn = previousTurn === turn;
    const delta = sameTurn && elapsed !== undefined && previousElapsed !== undefined && elapsed >= previousElapsed
      ? elapsed - previousElapsed
      : sameTurn && received !== undefined && previousReceived !== undefined && received >= previousReceived ? received - previousReceived : undefined;
    if (sequence !== undefined) deltas.set(sequence, delta);
    previousElapsed = elapsed;
    previousReceived = received;
    previousTurn = turn;
  }
  return deltas;
}

export interface EventTurnGroup {
  key: string;
  label: string;
  excerpt?: string;
  items: Array<Record<string, any>>;
  durationMs: number;
  issueCount: number;
  terminal: boolean;
}

export type EventTreeRow =
  | { kind: 'turn'; group: EventTurnGroup }
  | { kind: 'event'; group: EventTurnGroup; item: Record<string, any>; eventIndex: number };

/** Build stable conversation-turn groups without cloning event payloads. */
export function buildEventTurnGroups(items: Array<Record<string, any>>, messages: readonly ChatMessage[], kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): EventTurnGroup[] {
  const excerpts = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.metadata?.clientRequestId !== 'string') continue;
    const text = message.parts.map((part) => typeof part.text === 'string' ? part.text : '').join(' ').replace(/\s+/gu, ' ').trim();
    if (text) excerpts.set(message.metadata.clientRequestId, text.length > 96 ? `${text.slice(0, 95)}…` : text);
  }
  const groups = new Map<string, EventTurnGroup & { order: number }>();
  for (const item of items) {
    const key = eventTurnKey(item);
    const turnIndex = typeof item.turnIndex === 'number' ? item.turnIndex : Number.MAX_SAFE_INTEGER;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: typeof item.turnIndex === 'number' ? t('Turn {turn}', { turn: formatNumber(item.turnIndex + 1) }) : t('Unassigned'),
        excerpt: excerpts.get(key),
        items: [],
        durationMs: 0,
        issueCount: 0,
        terminal: false,
        order: turnIndex,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    const elapsed = typeof item.elapsedMs === 'number' && Number.isFinite(item.elapsedMs) ? Math.max(0, item.elapsedMs) : 0;
    group.durationMs = Math.max(group.durationMs, elapsed);
    if ((kind === 'raw' && (item.parseError || item.mappingError)) || eventLabel(item) === 'stream.failed') group.issueCount += 1;
    if (isTerminalEvent(item, kind, terminalRawSequences)) group.terminal = true;
  }
  return [...groups.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label)).map((group) => ({ key: group.key, label: group.label, ...(group.excerpt ? { excerpt: group.excerpt } : {}), items: group.items, durationMs: group.durationMs, issueCount: group.issueCount, terminal: group.terminal }));
}

export function flattenEventTree(groups: readonly EventTurnGroup[], collapsedTurnKeys: ReadonlySet<string>): EventTreeRow[] {
  const rows: EventTreeRow[] = [];
  for (const group of groups) {
    rows.push({ kind: 'turn', group });
    if (!collapsedTurnKeys.has(group.key)) group.items.forEach((item, eventIndex) => rows.push({ kind: 'event', group, item, eventIndex }));
  }
  return rows;
}

export function VirtualEvents({ items, messages = [], kind = 'raw', eventDeltas, terminalRawSequences = new Set<number>(), label, collapsedTurnKeys, onCollapsedTurnKeysChange, onCreateMapping, selectedSequence, onSelectEvent, initialScrollTop, onScrollTopChange }: { items: Array<Record<string, any>>; messages?: readonly ChatMessage[]; kind?: 'raw' | 'normalized'; eventDeltas?: ReadonlyMap<number, number | undefined>; terminalRawSequences?: ReadonlySet<number>; label: string; collapsedTurnKeys?: readonly string[]; onCollapsedTurnKeysChange?: (keys: string[]) => void; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void; initialScrollTop?: number; onScrollTopChange?: (value: number) => void }): React.JSX.Element {
  const rowHeight = 32;
  const listRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  const [top, setTop] = useState(() => normalizeScrollPosition(initialScrollTop));
  const [height, setHeight] = useState(480);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uncontrolledSelectedSequence, setUncontrolledSelectedSequence] = useState<number>();
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<string[]>([]);
  const effectiveSelectedSequence = selectedSequence ?? uncontrolledSelectedSequence;
  const collapsed = useMemo(() => new Set(collapsedTurnKeys ?? uncontrolledCollapsed), [collapsedTurnKeys, uncontrolledCollapsed]);
  const groups = useMemo(() => buildEventTurnGroups(items, messages, kind, terminalRawSequences), [items, kind, messages, terminalRawSequences]);
  const rows = useMemo(() => flattenEventTree(groups, collapsed), [collapsed, groups]);
  const selectedItem = effectiveSelectedSequence === undefined ? undefined : items.find((item) => eventSequence(item) === effectiveSelectedSequence);
  const selectedGroup = selectedItem ? groups.find((group) => group.key === eventTurnKey(selectedItem)) : undefined;
  const selectedRowIndex = effectiveSelectedSequence === undefined ? -1 : rows.findIndex((row) => row.kind === 'event' && eventSequence(row.item) === effectiveSelectedSequence);
  const screenReader = typeof document !== 'undefined' && document.body?.classList.contains('vscode-using-screen-reader');
  const viewportStart = Math.floor(top / rowHeight);
  const viewportEnd = viewportStart + Math.ceil(height / rowHeight);
  const selectedInViewport = selectedRowIndex >= 0 && selectedRowIndex >= Math.max(0, viewportStart - 2) && selectedRowIndex <= viewportEnd + 2;
  const accessibleAnchor = selectedInViewport ? selectedRowIndex : Math.max(activeIndex, viewportStart);
  const virtualized = !screenReader && rows.length > ACCESSIBLE_EVENT_WINDOW_SIZE;
  const visibleStart = screenReader ? accessibleEventWindowStart(accessibleAnchor, rows.length, ACCESSIBLE_EVENT_WINDOW_SIZE) : virtualized ? Math.max(0, viewportStart - 4) : 0;
  const visibleCount = screenReader ? ACCESSIBLE_EVENT_WINDOW_SIZE : virtualized ? Math.ceil(height / rowHeight) + 8 : rows.length;
  const visible = rows.slice(visibleStart, visibleStart + visibleCount);
  const rovingIndex = selectedRowIndex >= 0 ? selectedRowIndex : rows.length ? Math.min(Math.max(activeIndex, 0), rows.length - 1) : -1;

  const updateCollapsed = useCallback((next: ReadonlySet<string>) => {
    const normalized = [...next].slice(0, 500);
    if (collapsedTurnKeys === undefined) setUncontrolledCollapsed(normalized);
    onCollapsedTurnKeysChange?.(normalized);
  }, [collapsedTurnKeys, onCollapsedTurnKeysChange]);
  const toggleGroup = useCallback((key: string, force?: boolean) => {
    const next = new Set(collapsed);
    const shouldCollapse = force ?? !next.has(key);
    if (shouldCollapse) next.add(key); else next.delete(key);
    updateCollapsed(next);
  }, [collapsed, updateCollapsed]);

  useEffect(() => {
    if (selectedGroup && collapsed.has(selectedGroup.key)) {
      const next = new Set(collapsed);
      next.delete(selectedGroup.key);
      updateCollapsed(next);
    }
  }, [collapsed, selectedGroup, updateCollapsed]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const updateHeight = () => setHeight(element.clientHeight || 480);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || restoredScroll.current) return;
    restoredScroll.current = true;
    list.scrollTop = normalizeScrollPosition(initialScrollTop);
    setTop(list.scrollTop);
  }, [initialScrollTop]);

  useEffect(() => {
    if (selectedSequence === undefined || selectedRowIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const rowTop = selectedRowIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewportTop = list.scrollTop;
    const viewportBottom = viewportTop + (list.clientHeight || height);
    const nextTop = rowTop < viewportTop ? rowTop : rowBottom > viewportBottom ? Math.max(0, rowBottom - (list.clientHeight || height)) : viewportTop;
    if (nextTop !== viewportTop) {
      if (typeof list.scrollTo === 'function') list.scrollTo({ top: nextTop }); else list.scrollTop = nextTop;
      setTop(nextTop);
    }
    focusAfterRender(() => document.getElementById(`inspector-event-${String(selectedSequence)}`)?.focus());
  }, [height, selectedRowIndex, selectedSequence]);

  useEffect(() => { setActiveIndex((current) => selectedRowIndex >= 0 ? selectedRowIndex : rows.length ? Math.min(Math.max(current, 0), rows.length - 1) : 0); }, [rows, selectedRowIndex]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const maximum = Math.max(0, rows.length * rowHeight - (list.clientHeight || height));
    if (top <= maximum) return;
    list.scrollTop = maximum;
    setTop(maximum);
    onScrollTopChange?.(maximum);
  }, [height, onScrollTopChange, rows.length, top]);

  const focusRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setActiveIndex(index);
    focusAfterRender(() => document.getElementById(eventTreeRowId(row, index))?.focus());
  };
  const selectEvent = (row: Extract<EventTreeRow, { kind: 'event' }>, index: number) => {
    setActiveIndex(index);
    setUncontrolledSelectedSequence(eventSequence(row.item));
    onSelectEvent?.(row.item);
    focusAfterRender(() => document.getElementById(eventRowId(row.item, index))?.focus());
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, row: EventTreeRow, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (row.kind === 'turn') toggleGroup(row.group.key); else selectEvent(row, index);
      return;
    }
    if (row.kind === 'turn' && event.key === 'ArrowLeft' && !collapsed.has(row.group.key)) { event.preventDefault(); toggleGroup(row.group.key, true); return; }
    if (row.kind === 'turn' && event.key === 'ArrowRight') { event.preventDefault(); if (collapsed.has(row.group.key)) toggleGroup(row.group.key, false); else focusRow(index + 1); return; }
    if (row.kind === 'event' && event.key === 'ArrowLeft') { event.preventDefault(); focusRow(rows.findIndex((candidate) => candidate.kind === 'turn' && candidate.group.key === row.group.key)); return; }
    const nextIndex = getRovingIndex(index, event.key, rows.length, 'vertical');
    if (nextIndex !== undefined) { event.preventDefault(); focusRow(nextIndex); }
  };

  const accessibleEnd = Math.min(rows.length, visibleStart + ACCESSIBLE_EVENT_WINDOW_SIZE);
  const accessibleWindow = screenReader && rows.length > ACCESSIBLE_EVENT_WINDOW_SIZE;
  const selectedItemIndex = selectedItem ? items.indexOf(selectedItem) : -1;
  const selectedDetailId = selectedItem ? eventDetailId(kind, selectedItem, selectedItemIndex) : undefined;
  const selectedDelta = selectedItem ? eventDeltas?.get(eventSequence(selectedItem) ?? -1) : undefined;
  return <div className={`event-browser ${selectedItem ? 'event-browser--detail' : ''} ${accessibleWindow ? 'event-browser--accessible-window' : ''}`.trim()}>
    {screenReader && rows.length > ACCESSIBLE_EVENT_WINDOW_SIZE && <p className="event-accessibility-notice" role="status" aria-live="polite">{t('Showing event rows {start}–{end} of {total} for screen reader performance.', { start: formatNumber(visibleStart + 1), end: formatNumber(accessibleEnd), total: formatNumber(rows.length) })}</p>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{selectedItem ? t('Event payload opened for {event} #{sequence}.', { event: eventLabel(selectedItem), sequence: formatNumber(selectedItem.sequence) }) : ''}</span>
    <div ref={listRef} className="virtual-list event-tree" role="tree" aria-label={label} onScroll={(event) => { const next = event.currentTarget.scrollTop; setTop(next); onScrollTopChange?.(next); }}>
      {!items.length ? <div className="empty-state compact"><strong>{t('No matching events')}</strong></div> : <div className="virtual-space" style={{ height: rows.length * rowHeight }}><div style={{ transform: `translateY(${visibleStart * rowHeight}px)` }}>{visible.map((row, visibleIndex) => {
        const rowIndex = visibleStart + visibleIndex;
        if (row.kind === 'turn') {
          const isCollapsed = collapsed.has(row.group.key);
          const state = row.group.issueCount > 0 ? { icon: 'warning' as const, label: t(row.group.issueCount === 1 ? '{count} issue' : '{count} issues', { count: formatNumber(row.group.issueCount) }) } : row.group.terminal ? { icon: 'check' as const, label: t('Completed') } : { icon: 'circle-filled' as const, label: t('No terminal event') };
          return <button type="button" role="treeitem" aria-level={1} aria-expanded={!isCollapsed} aria-setsize={groups.length} aria-posinset={groups.indexOf(row.group) + 1} id={eventTreeRowId(row, rowIndex)} tabIndex={rowIndex === rovingIndex ? 0 : -1} className="event-turn-row" key={`turn:${row.group.key}`} onClick={() => toggleGroup(row.group.key)} onKeyDown={(event) => handleKeyDown(event, row, rowIndex)}>
            <span className="event-disclosure"><ProductIcon name={isCollapsed ? 'chevron-right' : 'chevron-down'} /></span><strong>{row.group.label}</strong>{row.group.excerpt && <span className="event-turn-excerpt" title={row.group.excerpt}>{row.group.excerpt}</span>}<span className="event-turn-meta">{t('{count} events · {duration}', { count: formatNumber(row.group.items.length), duration: formatDuration(row.group.durationMs) })}</span><span className={`event-status ${row.group.issueCount ? 'event-status--error' : row.group.terminal ? 'event-status--matched' : 'event-status--unmatched'}`} title={state.label} aria-label={state.label}><ProductIcon name={state.icon} /></span>
          </button>;
        }
        const itemSequence = eventSequence(row.item);
        const selected = itemSequence === effectiveSelectedSequence;
        const status = eventRowStatus(row.item, kind, terminalRawSequences);
        const eventDelta = itemSequence === undefined ? undefined : eventDeltas?.get(itemSequence);
        return <button type="button" role="treeitem" aria-level={2} aria-selected={selected} aria-controls={eventDetailId(kind, row.item, rowIndex)} aria-setsize={row.group.items.length} aria-posinset={row.eventIndex + 1} id={eventRowId(row.item, rowIndex)} data-disclosure-state={selected ? 'expanded' : 'collapsed'} tabIndex={rowIndex === rovingIndex ? 0 : -1} title={t('View event payload')} className={`event-row event-row--child ${eventDeltas ? 'event-row--with-delta' : ''} ${selected ? 'selected' : ''}`.trim()} key={`${row.group.key}:${String(row.item.sequence)}:${eventLabel(row.item)}`} onClick={() => selectEvent(row, rowIndex)} onKeyDown={(event) => handleKeyDown(event, row, rowIndex)}>
          <span className="event-tree-indent" aria-hidden="true" /><span className="event-disclosure"><ProductIcon name={selected ? 'chevron-down' : 'chevron-right'} /></span><span className="event-turn" title={eventTurnDescription(row.item)}>#{formatNumber(typeof row.item.turnSequence === 'number' ? row.item.turnSequence : row.eventIndex + 1)}</span><strong>{eventLabel(row.item)}</strong><span className={`event-status event-status--${status.kind}`} title={t(status.label)} aria-label={t(status.label)}><ProductIcon name={status.icon} /></span><span className="event-time-total"><span className="sr-only">{t('Total elapsed')}</span>+{formatDuration(row.item.elapsedMs ?? 0)}</span>{eventDeltas && <span className="event-time-gap"><span className="sr-only">{t('Since previous event')}</span>Δ{eventDelta === undefined ? '—' : formatDuration(eventDelta)}</span>}
        </button>;
      })}</div></div>}
    </div>
    {selectedItem && <section id={selectedDetailId} className="event-detail" aria-labelledby={`${selectedDetailId}-heading`}>
      <header><div><strong id={`${selectedDetailId}-heading`}>{t('Event payload')}</strong><span>{eventLabel(selectedItem)} · {eventTurnDescription(selectedItem)} · {t('Total {duration}', { duration: formatDuration(selectedItem.elapsedMs ?? 0) })}{eventDeltas ? ` · ${t('Gap {duration}', { duration: selectedDelta === undefined ? '—' : formatDuration(selectedDelta) })}` : ''}</span></div>{onCreateMapping && <button onClick={() => onCreateMapping(selectedItem as RawStreamEvent)}>{t('Create mapping draft')}</button>}</header>
      <JsonBlock value={selectedItem} />
    </section>}
  </div>;
}

function eventTreeRowId(row: EventTreeRow, fallbackIndex: number): string {
  return row.kind === 'turn' ? `inspector-event-turn-${stableIdToken(row.group.key)}` : eventRowId(row.item, fallbackIndex);
}
function MetricGrid({ metrics, enabled }: { metrics?: SessionSnapshot['metrics']; enabled?: string[] }): React.JSX.Element { if (!metrics) return <p className="muted">{t('No metrics yet.')}</p>; const allow = enabled?.length ? new Set(enabled) : undefined; const entries = Object.entries(metrics).filter(([key, value]) => value !== undefined && (!allow || allow.has(key))); if (!entries.length) return <p className="muted">{t('No enabled metrics have values yet.')}</p>; return <dl className="metrics">{entries.map(([key, value]) => <div key={key}><dt>{localizeHumanized(key)}</dt><dd>{typeof value === 'number' ? (/latency|duration|gap/i.test(key) ? formatDuration(value) : formatNumber(value)) : String(value)}</dd></div>)}</dl>; }

function ReplayOperationStatus({ replay, onOpenControls }: { replay: ReplaySnapshot; onOpenControls: () => void }): React.JSX.Element {
  const progress = replay.total ? Math.round((replay.index / replay.total) * 100) : 0;
  return <div className={`runtime-operation runtime-operation--${replay.status}`} role="status" aria-live="polite" aria-atomic="true">
    <ProductIcon name={replay.status === 'paused' ? 'warning' : 'circle-filled'} />
    <div><strong>{t(replay.status === 'paused' ? 'Replay paused' : 'Replaying recorded run…')}</strong><span>{t('{current} / {total} events', { current: formatNumber(replay.index), total: formatNumber(replay.total) })}</span></div>
    <div className="runtime-operation__actions"><IconButton type="button" icon="list-tree" label={t('Open replay controls')} onClick={onOpenControls} /><IconButton type="button" icon="stop" label={t('Stop replay')} onClick={() => post({ type: 'run.replay.stop' })} /></div>
    <progress value={progress} max={100} aria-label={t('Replay progress')}>{progress}%</progress>
  </div>;
}

export function Replay({ runs, replay, remoteSessions, active, trusted }: { runs: LocalRunSummary[]; replay?: ReplaySnapshot; remoteSessions?: RemoteSessionReference[]; active: boolean; trusted: boolean }): React.JSX.Element {
  const [speed, setSpeed] = useState<ReplaySnapshot['speed']>(replay?.speed ?? 1); useEffect(() => { if (replay) setSpeed(replay.speed); }, [replay?.speed]);
  const playing = replay?.status === 'playing'; const paused = replay?.status === 'paused'; const loaded = Boolean(replay?.runId) && (playing || paused || replay?.status === 'stopped'); const progress = replay?.total ? Math.round((replay.index / replay.total) * 100) : 0;
  const requestActive = active && !playing && !paused;
  const changeSpeed = (value: ReplaySnapshot['speed']) => { setSpeed(value); if (replay?.runId) post({ type: 'run.replay.speed', speed: value }); };
  return <div className="content-page replay-page"><header className="page-heading"><div><h2>{t('Recorded runs')}</h2><p>{t('Replay raw events through the same mapping and reducer pipeline.')}</p></div><div className="page-heading-actions"><IconButton icon="desktop-download" label={t('Import run')} disabled={!trusted || active} onClick={() => post({ type: 'run.import' })} /><details className="page-heading-more"><summary aria-label={t('More recorded run actions')} title={t('More recorded run actions')}><ProductIcon name="ellipsis" /></summary><div><button type="button" className="danger-subtle" disabled={!trusted || active || !runs.length} onClick={() => post({ type: 'run.clear' })}>{t('Clear replay history…')}</button></div></details></div></header>{remoteSessions && remoteSessions.length > 0 && <section className="remote-sessions" aria-labelledby="remote-sessions-heading"><div className="section-heading"><div><h3 id="remote-sessions-heading">{t('Remote session references')}</h3><p>{t('Reference-only history keeps metadata locally; applying one does not fetch or expose remote messages.')}</p></div></div><ul>{remoteSessions.map((session) => <li key={session.conversationId}><div><strong>{session.title}</strong><span><code>{session.conversationId}</code> · {session.actorId ?? t('No actor')} · {session.environmentId ?? t('No environment')} · <time dateTime={dateTimeAttribute(session.createdAt)}>{formatDateTime(session.createdAt)}</time></span></div><button disabled={active} onClick={() => post({ type: 'history.remote.apply', conversationId: session.conversationId })}>{t('Apply')}</button></li>)}</ul></section>}<section className="replay-deck" aria-label={t('Replay controls')}><div className="transport-controls"><button disabled={!playing} onClick={() => post({ type: 'run.replay.pause' })}>{t('Pause')}</button><button className={paused ? 'primary' : undefined} disabled={!paused} onClick={() => post({ type: 'run.replay.resume' })}>{t('Resume')}</button><button disabled={!loaded} onClick={() => post({ type: 'run.replay.stop' })}>{t('Stop')}</button><button disabled={!paused} onClick={() => post({ type: 'run.replay.step' })}>{t('Step')}</button></div><label>{t('Playback speed')}<select value={speed} onChange={(event) => changeSpeed(Number(event.target.value) as ReplaySnapshot['speed'])}>{[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{formatNumber(value)}×</option>)}</select></label><div className="replay-progress" role="status" aria-live="polite"><div><strong>{replay ? localizeHumanized(replay.status) : t('Ready')}</strong><span>{replay ? t('{current} / {total} events', { current: formatNumber(replay.index), total: formatNumber(replay.total) }) : t('Select a run to begin')}</span></div><progress value={progress} max={100} aria-label={t('Replay progress')}>{progress}%</progress></div>{requestActive && <p className="replay-blocked">{t('Finish or stop the current request before replaying a run.')}</p>}</section>{runs.length ? <ul className="run-list">{runs.map((run) => { const replayable = run.replayable; const replaying = replay?.runId === run.id && (playing || paused); return <li className={replay?.runId === run.id ? 'active-run' : ''} key={run.id}><div><strong>{formatDateTime(run.createdAt)}</strong><span>{localizeHumanized(run.result.type)} · {t('{count} events', { count: formatNumber(run.metrics.eventCount) })} · {formatDuration(run.metrics.totalDuration ?? 0)}</span><RunSummaryDetails run={run} />{!replayable && <span className="run-availability"><ProductIcon name="warning" />{t('Not replayable: raw events were not recorded.')}</span>}{replayable && !run.hasSnapshot && <span className="run-availability"><ProductIcon name="info" />{t('Replay starts without recorded chat context.')}</span>}</div><div className="run-actions"><button className={replayable ? 'primary' : undefined} disabled={active || !replayable} onClick={() => post({ type: 'run.replay.play', runId: run.id, speed })}>{t(replaying ? 'Replaying' : 'Replay')}</button><details><summary aria-label={t('More actions for recorded run')} title={t('More actions for recorded run')}><ProductIcon name="ellipsis" /></summary><div><button type="button" disabled={!trusted} onClick={() => post({ type: 'run.export', runId: run.id })}>{t('Export')}</button><button type="button" className="danger-subtle" disabled={!trusted || active} onClick={() => post({ type: 'run.delete', runId: run.id })}>{t('Delete run…')}</button></div></details></div></li>; })}</ul> : <div className="empty-state empty-state--action"><strong>{t('No recorded runs')}</strong><p>{t('Completed, failed, and aborted turns appear here.')}</p><div><button type="button" className="primary" disabled={!trusted || active} onClick={() => post({ type: 'session.start' })}>{t('Start session')}</button><button type="button" disabled={!trusted || active} onClick={() => post({ type: 'run.import' })}>{t('Import run')}</button></div></div>}</div>;
}

function RunSummaryDetails({ run }: { run: LocalRunSummary }): React.JSX.Element {
  return <details className="run-details"><summary>{t('Run details')}</summary><dl>
    {run.request?.method && <div><dt>{t('Method')}</dt><dd>{run.request.method}</dd></div>}
    {run.request?.url && <div><dt>{t('URL')}</dt><dd title={run.request.url}>{run.request.url}</dd></div>}
    {run.request?.variantId && <div><dt>{t('Variant')}</dt><dd>{run.request.variantId}</dd></div>}
    <div><dt>{t('Raw events')}</dt><dd>{formatNumber(run.rawEventCount ?? run.metrics.eventCount)}</dd></div>
    <div><dt>{t('Normalized events')}</dt><dd>{formatNumber(run.normalizedEventCount ?? 0)}</dd></div>
    <div><dt>{t('Messages')}</dt><dd>{formatNumber(run.messageCount ?? 0)}</dd></div>
    <div><dt>{t('Errors')}</dt><dd>{formatNumber(run.errorCount ?? (run.result.type === 'failed' ? 1 : 0))}</dd></div>
    <div><dt>{t('Reconnects')}</dt><dd>{formatNumber(run.metrics.reconnectCount ?? 0)}</dd></div>
  </dl></details>;
}

export type RovingOrientation = 'horizontal' | 'vertical';

/** Return the next item for a roving-tabindex composite widget. */
export function getRovingIndex(currentIndex: number, key: string, itemCount: number, orientation: RovingOrientation): number | undefined {
  if (itemCount <= 0) return undefined;
  const safeIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  const delta = orientation === 'horizontal'
    ? key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : undefined
    : key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : undefined;
  if (delta === undefined) return undefined;
  return (safeIndex + delta + itemCount) % itemCount;
}

function stableIdToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function inspectorTabId(tab: InspectorTab): string { return `inspector-tab-${stableIdToken(tab)}`; }
export function inspectorPanelId(tab: InspectorTab): string { return `inspector-panel-${stableIdToken(tab)}`; }

function eventRowId(item: Record<string, any>, fallbackIndex: number): string {
  const sequence = eventSequence(item);
  return `inspector-event-${sequence === undefined ? `item-${fallbackIndex}` : String(sequence)}`;
}

function eventDetailId(kind: 'raw' | 'normalized', item: Record<string, any>, fallbackIndex: number): string {
  const sequence = eventSequence(item);
  return `inspector-${kind}-event-detail-${sequence === undefined ? `item-${fallbackIndex}` : String(sequence)}`;
}

/** Keep assistive technology DOM bounded while preserving the full list position metadata. */
export function accessibleEventWindowStart(anchorIndex: number, itemCount: number, windowSize = ACCESSIBLE_EVENT_WINDOW_SIZE): number {
  if (itemCount <= windowSize) return 0;
  const safeWindowSize = Math.max(1, Math.floor(windowSize));
  const safeAnchor = Number.isInteger(anchorIndex) ? Math.max(0, Math.min(anchorIndex, itemCount - 1)) : 0;
  return Math.max(0, Math.min(itemCount - safeWindowSize, safeAnchor - Math.floor(safeWindowSize / 2)));
}

function focusAfterRender(callback: () => void): void {
  if (typeof document === 'undefined') return;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else callback();
}

function eventLabel(item: Record<string, any>): string { return String(item.type ?? item.sse?.event ?? 'message'); }
function eventSequence(item: Record<string, any>): number | undefined { return typeof item.rawSequence === 'number' ? item.rawSequence : typeof item.sequence === 'number' ? item.sequence : undefined; }
export function eventTurnKey(item: Record<string, any>): string { return typeof item.turnId === 'string' && item.turnId ? item.turnId : typeof item.turnIndex === 'number' ? `index:${item.turnIndex}` : 'legacy'; }
export function eventTurnOptions(items: Array<Record<string, any>>): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, { key: string; label: string; count: number; order: number }>();
  for (const item of items) {
    const key = eventTurnKey(item);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { key, label: typeof item.turnIndex === 'number' ? t('Turn {turn}', { turn: formatNumber(item.turnIndex + 1) }) : t('Unassigned'), count: 1, order: typeof item.turnIndex === 'number' ? item.turnIndex : Number.MAX_SAFE_INTEGER });
  }
  return [...counts.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label)).map(({ key, label, count }) => ({ key, label, count }));
}
function eventTurnDescription(item: Record<string, any>): string {
  if (typeof item.turnIndex !== 'number') return t('Unassigned · event #{sequence}', { sequence: formatNumber(item.sequence) });
  const localSequence = typeof item.turnSequence === 'number' ? item.turnSequence : item.sequence;
  return t('Turn {turn} · event {event} · global #{sequence}', { turn: formatNumber(item.turnIndex + 1), event: formatNumber(localSequence), sequence: formatNumber(item.sequence) });
}

const TERMINAL_EVENT_TYPES = new Set(['stream.completed', 'stream.failed', 'stream.aborted']);
export function normalizeEventFilterState(value: unknown): EventFilterState {
  const candidate = value && typeof value === 'object' ? value as Partial<EventFilterState> : {};
  return {
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 512) : '',
    turn: typeof candidate.turn === 'string' && candidate.turn.length <= 512 ? candidate.turn : 'all',
    eventType: typeof candidate.eventType === 'string' && candidate.eventType.length <= 256 ? candidate.eventType : 'all',
    mapping: MAPPING_FILTERS.has(candidate.mapping as EventMappingFilter) ? candidate.mapping as EventMappingFilter : 'all',
    issue: ISSUE_FILTERS.has(candidate.issue as EventIssueFilter) ? candidate.issue as EventIssueFilter : 'all',
    terminal: TERMINAL_FILTERS.has(candidate.terminal as EventTerminalFilter) ? candidate.terminal as EventTerminalFilter : 'all'
  };
}

export function normalizeInspectorEventFilters(value?: Partial<InspectorEventFilters>): InspectorEventFilters {
  return { raw: normalizeEventFilterState(value?.raw), normalized: normalizeEventFilterState(value?.normalized) };
}

export function normalizeCollapsedEventTurns(value?: Partial<CollapsedEventTurns>): CollapsedEventTurns {
  const normalize = (candidate: unknown): string[] => Array.isArray(candidate)
    ? [...new Set(candidate.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512))].slice(0, 500)
    : [];
  return { raw: normalize(value?.raw), normalized: normalize(value?.normalized) };
}

export function normalizeScrollPosition(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10_000_000, Math.max(0, Math.round(value))) : 0;
}

export function normalizeNetworkInspectorState(value: unknown): NetworkInspectorState {
  const candidate = value && typeof value === 'object' ? value as Partial<NetworkInspectorState> : {};
  return {
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 512) : '',
    ...(typeof candidate.selectedId === 'string' && candidate.selectedId.length <= 512 ? { selectedId: candidate.selectedId } : {}),
    detailTab: networkDetailTabs.includes(candidate.detailTab as NetworkDetailTab) ? candidate.detailTab as NetworkDetailTab : 'Headers'
  };
}

export function normalizeWebviewState(value: unknown): WebviewState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as WebviewState;
  const scrollPositions: Partial<Record<ScrollPositionKey, number>> = {};
  if (candidate.scrollPositions && typeof candidate.scrollPositions === 'object') {
    for (const key of scrollPositionKeys) {
      const position = candidate.scrollPositions[key];
      if (typeof position === 'number' && Number.isFinite(position)) scrollPositions[key] = normalizeScrollPosition(position);
    }
  }
  const candidateInspectorTab = (candidate as { inspectorTab?: unknown }).inspectorTab;
  return {
    version: WEBVIEW_STATE_VERSION,
    ...boundedOptionalString('sessionId', candidate.sessionId),
    ...(isWorkspaceSection(candidate.section) ? { section: candidate.section } : {}),
    ...(isSettingsSectionId(candidate.configurationSection) ? { configurationSection: candidate.configurationSection } : {}),
    ...(isRightPaneMode(candidate.rightPaneMode) ? { rightPaneMode: candidate.rightPaneMode } : {}),
    ...(RED_TEAM_SECTIONS.includes(candidate.redTeamSection as RedTeamSectionId) ? { redTeamSection: candidate.redTeamSection as RedTeamSectionId } : {}),
    ...(typeof candidate.draft === 'string' ? { draft: candidate.draft.slice(0, 100_000) } : {}),
    ...(candidateInspectorTab === 'Request' ? { inspectorTab: 'Network' } : isInspectorTab(candidateInspectorTab) ? { inspectorTab: candidateInspectorTab } : {}),
    ...(typeof candidate.splitPercent === 'number' && Number.isFinite(candidate.splitPercent) ? { splitPercent: clampSplit(candidate.splitPercent) } : {}),
    ...(typeof candidate.splitCustomized === 'boolean' ? { splitCustomized: candidate.splitCustomized } : {}),
    ...boundedOptionalString('selectedMessageId', candidate.selectedMessageId),
    ...(typeof candidate.selectedRawSequence === 'number' && Number.isSafeInteger(candidate.selectedRawSequence) && candidate.selectedRawSequence >= 0 ? { selectedRawSequence: candidate.selectedRawSequence } : {}),
    ...boundedOptionalString('selectedNetworkId', candidate.selectedNetworkId),
    ...boundedOptionalString('activeEvidenceId', candidate.activeEvidenceId),
    ...boundedOptionalString('selectedCampaignId', candidate.selectedCampaignId),
    ...(isChatViewportState(candidate.chatViewport) ? { chatViewport: candidate.chatViewport } : {}),
    ...(candidate.eventFilters && typeof candidate.eventFilters === 'object' ? { eventFilters: normalizeInspectorEventFilters(candidate.eventFilters) } : {}),
    ...(candidate.collapsedEventTurns && typeof candidate.collapsedEventTurns === 'object' ? { collapsedEventTurns: normalizeCollapsedEventTurns(candidate.collapsedEventTurns) } : {}),
    ...(Object.keys(scrollPositions).length ? { scrollPositions } : {}),
    ...boundedOptionalString('expandedAdversarialCaseId', candidate.expandedAdversarialCaseId),
    ...(candidate.adversarialCaseCollection && typeof candidate.adversarialCaseCollection === 'object' ? { adversarialCaseCollection: normalizeAdversarialCaseCollectionState(candidate.adversarialCaseCollection) } : { adversarialCaseCollection: { ...DEFAULT_ADVERSARIAL_CASE_COLLECTION } }),
    ...(candidate.adversarialResultCollection && typeof candidate.adversarialResultCollection === 'object' ? { adversarialResultCollection: normalizeAdversarialResultCollectionState(candidate.adversarialResultCollection) } : { adversarialResultCollection: { ...DEFAULT_ADVERSARIAL_RESULT_COLLECTION } }),
    ...(candidate.networkInspector && typeof candidate.networkInspector === 'object' ? { networkInspector: normalizeNetworkInspectorState(candidate.networkInspector) } : {}),
    ...(Array.isArray(candidate.acceptedForms) ? { acceptedForms: [...new Set(candidate.acceptedForms.filter((item): item is string => typeof item === 'string' && item.length <= 512))].slice(0, 500) } : {})
  };
}

function boundedOptionalString<K extends 'sessionId' | 'selectedMessageId' | 'selectedNetworkId' | 'activeEvidenceId' | 'expandedAdversarialCaseId' | 'selectedCampaignId'>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === 'string' && value.length <= 512 ? { [key]: value } as Partial<Record<K, string>> : {};
}

export function terminalSequences(normalizedEvents: Array<Record<string, unknown>>): ReadonlySet<number> {
  return new Set(normalizedEvents.filter((item) => TERMINAL_EVENT_TYPES.has(String(item.type))).map((item) => typeof item.rawSequence === 'number' ? item.rawSequence : item.sequence).filter((value): value is number => typeof value === 'number'));
}

function isTerminalEvent(item: Record<string, any>, kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): boolean {
  return kind === 'normalized' ? TERMINAL_EVENT_TYPES.has(eventLabel(item)) : terminalRawSequences.has(item.sequence);
}

export function eventMatchesFilters(item: Record<string, any>, filters: EventFilterState, kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): boolean {
  if (filters.turn !== 'all' && eventTurnKey(item) !== filters.turn) return false;
  if (filters.eventType !== 'all' && eventLabel(item) !== filters.eventType) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  if (query && !eventSearchText(item).includes(query)) return false;
  if (kind === 'raw') {
    const matched = typeof item.mappingRuleId === 'string' && Boolean(item.mappingRuleId.trim());
    if (filters.mapping === 'matched' && !matched) return false;
    if (filters.mapping === 'unmatched' && matched) return false;
    const issue: EventIssueFilter = item.parseError ? 'parse-error' : item.mappingError ? 'mapping-error' : 'valid';
    if (filters.issue === 'problem' && issue === 'valid') return false;
    if (filters.issue !== 'all' && filters.issue !== 'problem' && filters.issue !== issue) return false;
  }
  const terminal = isTerminalEvent(item, kind, terminalRawSequences);
  if (filters.terminal === 'terminal' && !terminal) return false;
  if (filters.terminal === 'non-terminal' && terminal) return false;
  return true;
}

function eventSearchText(item: Record<string, any>): string {
  const cached = eventSearchTextCache.get(item);
  if (cached !== undefined) return cached;
  const value = safeJson(item).toLocaleLowerCase();
  eventSearchTextCache.set(item, value);
  return value;
}

function eventRowStatus(item: Record<string, any>, kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): { kind: string; label: string; icon: 'check' | 'warning' | 'circle-filled' | 'stop' } {
  if (kind === 'raw' && item.parseError) return { kind: 'error', label: 'Parse error', icon: 'warning' };
  if (kind === 'raw' && item.mappingError) return { kind: 'error', label: 'Mapping error', icon: 'warning' };
  if (isTerminalEvent(item, kind, terminalRawSequences)) return { kind: 'terminal', label: 'Terminal event', icon: 'stop' };
  if (kind === 'raw' && !item.mappingRuleId) return { kind: 'unmatched', label: 'Unmatched event', icon: 'circle-filled' };
  return { kind: 'matched', label: 'Matched event', icon: 'check' };
}

/** Resolve active-turn UI locks from profile policy, with safe defaults. */
function isInteractionLocked(profile: TurnStageProfile, id: string, active: boolean): boolean {
  if (!active) return false;
  const policy = profile.ui?.locks?.whileTurnActive;
  if (policy?.allow?.includes(id)) return false;
  if (policy?.disable?.includes(id)) return true;
  // Stop, inspector, history viewing, configuration, and copy remain usable.
  if (id === 'stop' || id === 'inspector.open' || id === 'history.open' || id === 'configuration.open' || id === 'message.copy' || id === 'history.remote.open') return false;
  // Controls, composer, starters, and new conversation are locked by default.
  return true;
}

function componentVisible(profile: TurnStageProfile, name: string): boolean { return profile.ui?.components?.[name]?.visible !== false; }

function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

function isInspectorTab(value: unknown): value is InspectorTab {
  return inspectorTabs.includes(value as InspectorTab);
}

export function shouldApplyProfileInspectorDefault(state: WebviewState | undefined): boolean {
  return !isInspectorTab(state?.inspectorTab);
}

function inspectorTabLabel(tab: InspectorTab): string {
  return tab === 'Normalized' ? 'Normalized Events' : tab;
}

function adversarialOutcomeLabel(outcome: AdversarialResultSummary['outcome']): string {
  if (outcome === 'resisted') return 'Resisted';
  if (outcome === 'attackSucceeded') return 'Attack succeeded';
  if (outcome === 'infrastructureError') return 'Infrastructure error';
  return 'Indeterminate';
}

function evidenceLocationLabel(kind: AdversarialResultSummary['primaryLocation']['kind']): string {
  if (kind === 'network') return 'Network';
  if (kind === 'rawEvent') return 'Raw Events';
  if (kind === 'normalizedEvent') return 'Normalized Events';
  if (kind === 'message') return 'Chat';
  return 'Profile';
}

function isRightPaneMode(value: unknown): value is RightPaneMode {
  return rightPaneModes.includes(value as RightPaneMode);
}

export function clampSplit(value: number): number { return Math.min(90, Math.max(10, Number.isFinite(value) ? value : DEFAULT_SPLIT_PERCENT)); }

function isChatViewportState(value: unknown): value is ChatViewportState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatViewportState>;
  const presets = ['responsive', 'custom', ...CHAT_VIEWPORT_PRESETS.map((preset) => preset.id)];
  return presets.includes(String(candidate.preset)) && ['fit', '100', '75', '50'].includes(String(candidate.zoom)) && Number.isFinite(candidate.width) && Number.isFinite(candidate.height);
}

export function initialSplitPercent(savedPercent: number | undefined, splitCustomized: boolean): number {
  return splitCustomized ? clampSplit(savedPercent ?? DEFAULT_SPLIT_PERCENT) : DEFAULT_SPLIT_PERCENT;
}

export function splitTrackSizes(splitPercent: number, inspectorWidth?: number, splitCustomized = false): { preview: string; inspector: string } {
  const clamped = clampSplit(splitPercent);
  if (!splitCustomized && Number.isFinite(inspectorWidth)) return { preview: '1fr', inspector: `${Math.round(inspectorWidth!)}px` };
  return { preview: `${clamped}fr`, inspector: `${100 - clamped}fr` };
}
export function rawSequencesForMessage(message?: ChatMessage): number[] {
  return Array.isArray(message?.metadata?.rawSequences)
    ? message.metadata.rawSequences.filter((value): value is number => typeof value === 'number')
    : [];
}

function terminalAnnouncement(state?: string): string { if (state === 'completed') return t('Response completed'); if (state === 'failed') return t('Response failed'); if (state === 'aborted') return t('Response stopped'); return ''; }
if (rootElement) createRoot(rootElement).render(<App />);
