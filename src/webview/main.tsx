import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage, MappingTestResult, WebviewPayload, WorkspaceSection } from '../shared/protocol';
import { isHostMessage, isWorkspaceSection, PROTOCOL_VERSION } from '../shared/protocol';
import type { ChatMessage, LocalRunSummary, NetworkExchange, RawStreamEvent, RemoteSessionReference, ReplaySnapshot, SessionSnapshot, TurnStageProfile } from '../shared/types';
import { mappingDraftFromRawEvent } from './configEditors';
import { ClipboardButton } from './ClipboardButton';
import { IconButton, ProductIcon } from './Icon';
import { CHAT_VIEWPORT_PRESETS, DEFAULT_CHAT_VIEWPORT, MobileChatPreview, type ChatViewportState, type MessageActionFeedback } from './MobileChatPreview';
import { SETTINGS_SECTIONS, SettingsWorkspace, type SettingsSectionId } from './SettingsWorkspace';
import { dateTimeAttribute, formatDateTime, formatDuration, formatNumber, localizeHumanized, setLocale, t } from './i18n';
import { resolveUiLayout } from './uiConfig';
import './styles.css';

declare function acquireVsCodeApi<T = unknown>(): { postMessage(message: unknown): void; getState(): T | undefined; setState(state: T): void };
export type EventMappingFilter = 'all' | 'matched' | 'unmatched';
export type EventIssueFilter = 'all' | 'valid' | 'parse-error' | 'mapping-error';
export type EventTerminalFilter = 'all' | 'terminal' | 'non-terminal';
export interface EventFilterState { query: string; eventType: string; mapping: EventMappingFilter; issue: EventIssueFilter; terminal: EventTerminalFilter }
export interface InspectorEventFilters { raw: EventFilterState; normalized: EventFilterState }
type RightPaneMode = 'debug' | 'configure';
interface WebviewState { section?: WorkspaceSection; configurationSection?: SettingsSectionId; rightPaneMode?: RightPaneMode; draft?: string; inspectorTab?: InspectorTab; splitPercent?: number; splitCustomized?: boolean; selectedMessageId?: string; selectedRawSequence?: number; chatViewport?: ChatViewportState; eventFilters?: Partial<InspectorEventFilters> }
type VsCodeApi = { postMessage(message: unknown): void; getState(): WebviewState | undefined; setState(state: WebviewState): void };
const rootElement = typeof document === 'undefined' ? undefined : document.getElementById('root');
const instanceId = rootElement?.dataset.instanceId ?? 'test-instance';
const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi<WebviewState>()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
const savedState = vscode.getState();
const savedSplitCustomized = savedState?.splitCustomized === true;
const inspectorTabs = ['Network', 'Raw Events', 'Normalized', 'Metrics', 'Errors', 'Runs'] as const; type InspectorTab = typeof inspectorTabs[number];
const savedInspectorTab = (savedState as { inspectorTab?: unknown } | undefined)?.inspectorTab;
export const DEFAULT_SPLIT_PERCENT = 64;
export const ACCESSIBLE_EVENT_WINDOW_SIZE = 200;
export const DEFAULT_EVENT_FILTERS: EventFilterState = { query: '', eventType: 'all', mapping: 'all', issue: 'all', terminal: 'all' };

function post(message: WebviewPayload): void { vscode.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId: crypto.randomUUID() }); }

function App(): React.JSX.Element {
  const savedSection = isWorkspaceSection(savedState?.section) ? savedState.section : 'test';
  const [configurationSection, setConfigurationSection] = useState<SettingsSectionId>(isSettingsSectionId(savedState?.configurationSection) ? savedState.configurationSection : savedSection === 'test' ? 'general' : savedSection);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>(isRightPaneMode(savedState?.rightPaneMode) ? savedState.rightPaneMode : savedSection === 'test' ? 'debug' : 'configure');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(savedInspectorTab === 'Request' ? 'Network' : isInspectorTab(savedInspectorTab) ? savedInspectorTab : 'Raw Events'); const [draft, setDraft] = useState(savedState?.draft ?? ''); const [splitPercent, setSplitPercent] = useState(initialSplitPercent(savedState?.splitPercent, savedSplitCustomized)); const [splitCustomized, setSplitCustomized] = useState(savedSplitCustomized); const [selectedMessageId, setSelectedMessageId] = useState(savedState?.selectedMessageId); const [selectedRawSequence, setSelectedRawSequence] = useState(savedState?.selectedRawSequence);
  const [chatViewport, setChatViewport] = useState<ChatViewportState>(isChatViewportState(savedState?.chatViewport) ? savedState.chatViewport : { ...DEFAULT_CHAT_VIEWPORT });
  const [eventFilters, setEventFilters] = useState<InspectorEventFilters>(() => normalizeInspectorEventFilters(savedState?.eventFilters));
  const [acceptedForms, setAcceptedForms] = useState<ReadonlySet<string>>(() => new Set());
  const [messageActionFeedback, setMessageActionFeedback] = useState<MessageActionFeedback>();
  const [profile, setProfile] = useState<TurnStageProfile>(); const [snapshot, setSnapshot] = useState<SessionSnapshot>(); const [runs, setRuns] = useState<LocalRunSummary[]>([]); const [requestPreview, setRequestPreview] = useState<unknown>(); const [networkEntries, setNetworkEntries] = useState<NetworkExchange[]>([]); const [diagnostics, setDiagnostics] = useState<Array<{ severity: string; message: string }>>([]); const [notice, setNotice] = useState(''); const [mappingTestResult, setMappingTestResult] = useState<MappingTestResult>(); const [remoteName, setRemoteName] = useState<string>(); const [, setLocaleVersion] = useState(0);
  useEffect(() => { const listener = (event: MessageEvent<HostMessage>) => { if (!isHostMessage(event.data, instanceId)) return; const message = event.data; if (message.type === 'host.ready') { setLocale(message.locale, message.direction); setLocaleVersion((current) => current + 1); setRemoteName(message.remoteName); } else if (message.type === 'workspace.section') { if (message.section === 'test') setRightPaneMode('debug'); else { setConfigurationSection(message.section); setRightPaneMode('configure'); } requestAnimationFrame(() => document.getElementById('right-pane-panel')?.focus()); } else if (message.type === 'profile.snapshot') setProfile(message.profile); else if (message.type === 'profile.validation') setDiagnostics(message.diagnostics); else if (message.type === 'profile.validated') { if (message.valid) setNotice(t('Profile is valid.')); } else if (message.type === 'session.snapshot') { setSnapshot(message.snapshot); setRuns(message.runs); setRequestPreview(message.requestPreview); setNetworkEntries(message.networkEntries ?? []); } else if (message.type === 'mapping.test.result') setMappingTestResult(message.result); else if (message.type === 'request.error') setNotice(message.error.message); else if (message.type === 'action.feedback') setMessageActionFeedback({ actionId: message.actionId, sourceMessageId: message.sourceMessageId, status: message.status, message: message.message }); else if (message.type === 'form.accepted') { setAcceptedForms((current) => new Set(current).add(`${message.sourceMessageId ?? ''}:${message.formId}`)); setNotice(t('Form submitted.')); } else if (message.type === 'run.imported') setNotice(t(message.duplicate ? 'Run imported as a copy from {path}' : 'Run imported from {path}', { path: message.path })); else if (message.type === 'run.exported') setNotice(t('Run exported to {path}', { path: message.path })); else if (message.type === 'workspaceTrust.changed') setSnapshot((current) => current ? { ...current, trusted: message.trusted } : current); }; window.addEventListener('message', listener); post({ type: 'webview.ready' }); return () => window.removeEventListener('message', listener); }, []);
  useEffect(() => { if (!messageActionFeedback || messageActionFeedback.status === 'pending') return; const timeout = window.setTimeout(() => setMessageActionFeedback(undefined), 2400); return () => window.clearTimeout(timeout); }, [messageActionFeedback]);
  useEffect(() => { setAcceptedForms(new Set()); setSelectedMessageId(undefined); setSelectedRawSequence(undefined); setMessageActionFeedback(undefined); }, [snapshot?.sessionId]);
  useEffect(() => { vscode.setState({ section: rightPaneMode === 'configure' ? configurationSection : 'test', configurationSection, rightPaneMode, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence, chatViewport, eventFilters }); }, [configurationSection, rightPaneMode, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence, chatViewport, eventFilters]);
  useEffect(() => {
    if (!profile) return;
    const preferredTab = resolveUiLayout(profile.ui).initialInspectorTab;
    if (preferredTab && componentVisible(profile, 'metrics')) setInspectorTab(preferredTab);
  }, [profile?.ui?.layout?.preset, profile?.ui?.components?.metrics?.visible]);
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
    setEventFilters((current) => ({ ...current, raw: { ...DEFAULT_EVENT_FILTERS } }));
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
  if (!profile) return <main className="empty"><h1>TurnStage</h1><p>{diagnostics[0]?.message ?? t('Loading profile…')}</p><button onClick={() => post({ type: 'profile.openAsText' })}>{t('Open as Text')}</button></main>;
  return <main className="app">
    <a className="skip" href="#main-panel">{t('Skip to content')}</a>
    {snapshot?.trusted === false && <div className="trust-banner" role="status"><strong>{t('Restricted mode.')}</strong> {t('This workspace is not trusted. Network requests are disabled; fixture replay remains available.')}</div>}
    {diagnostics.length > 0 && <div className="validation-banner" role="alert"><strong>{t(diagnostics.length === 1 ? '{count} configuration issue.' : '{count} configuration issues.', { count: formatNumber(diagnostics.length) })}</strong> {t('Requests are blocked until errors are fixed.')} <button className="link-button" disabled={isInteractionLocked(profile, 'configuration.open', active)} onClick={() => post({ type: 'profile.openAsText' })}>{t('Open as Text')}</button></div>}
    <section id="main-panel" tabIndex={-1} className="panel" aria-label={t('Test')}>
      <TestWorkspace profile={profile} snapshot={snapshot} runs={runs} networkEntries={networkEntries} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} requestPreview={requestPreview} splitPercent={splitPercent} setSplitPercent={setSplitPercent} splitCustomized={splitCustomized} setSplitCustomized={setSplitCustomized} chatViewport={chatViewport} setChatViewport={setChatViewport} eventFilters={eventFilters} setEventFilters={setEventFilters} selectedMessageId={selectedMessageId} selectedRawSequence={selectedRawSequence} acceptedForms={acceptedForms} messageActionFeedback={messageActionFeedback} onMessageActionFeedback={setMessageActionFeedback} onSelectMessage={selectMessage} onSelectEvent={selectEvent} onCreateMapping={(event) => { post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, mappingDraftFromRawEvent(event, profile)] }); setNotice(t('Created mapping draft from raw event #{sequence}.', { sequence: formatNumber(event.sequence) })); }} rightPaneMode={rightPaneMode} setRightPaneMode={setRightPaneMode} configurationSection={configurationSection} setConfigurationSection={setConfigurationSection} mappingTestResult={mappingTestResult} remoteName={remoteName} />
    </section>
    <div className="sr-status" role="status" aria-live="polite">{notice || terminalAnnouncement(snapshot?.turnState)}</div>
  </main>;
}

function TestWorkspace({ profile, snapshot, runs, networkEntries, active, continuationBlocked, draft, setDraft, send, inspectorTab, setInspectorTab, requestPreview, splitPercent, setSplitPercent, splitCustomized, setSplitCustomized, chatViewport, setChatViewport, eventFilters, setEventFilters, selectedMessageId, selectedRawSequence, acceptedForms, messageActionFeedback, onMessageActionFeedback, onSelectMessage, onSelectEvent, onCreateMapping, rightPaneMode, setRightPaneMode, configurationSection, setConfigurationSection, mappingTestResult, remoteName }: {
  profile: TurnStageProfile;
  snapshot?: SessionSnapshot;
  runs: LocalRunSummary[];
  networkEntries: NetworkExchange[];
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
  selectedMessageId?: string;
  selectedRawSequence?: number;
  acceptedForms: ReadonlySet<string>;
  messageActionFeedback?: MessageActionFeedback;
  onMessageActionFeedback: (feedback: MessageActionFeedback | undefined) => void;
  onSelectMessage: (messageId: string) => void;
  onSelectEvent: (event: Record<string, unknown>) => void;
  onCreateMapping: (event: RawStreamEvent) => void;
  rightPaneMode: RightPaneMode;
  setRightPaneMode: (mode: RightPaneMode) => void;
  configurationSection: SettingsSectionId;
  setConfigurationSection: (section: SettingsSectionId) => void;
  mappingTestResult?: MappingTestResult;
  remoteName?: string;
}): React.JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const layout = resolveUiLayout(profile.ui);
  const showRightPane = layout.showInspector || rightPaneMode === 'configure' || selectedMessageId !== undefined;
  const rightPanePosition = rightPaneMode === 'configure' ? 'right' : layout.inspectorPosition;
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
  const workspaceClassName = ['test-workspace', `test-workspace--${layout.preset}`, `test-workspace--inspector-${rightPanePosition}`, rightPaneMode === 'configure' ? 'test-workspace--configuration-open' : '', layout.compact ? 'test-workspace--compact' : ''].filter(Boolean).join(' ');
  const decrementKey = rightPanePosition === 'right' ? 'ArrowLeft' : 'ArrowUp';
  const incrementKey = rightPanePosition === 'right' ? 'ArrowRight' : 'ArrowDown';
  const selectRightPaneMode = (mode: RightPaneMode, focus = false) => {
    setRightPaneMode(mode);
    if (focus) focusAfterRender(() => document.getElementById(`right-pane-${mode}-tab`)?.focus());
  };
  return <div className="test-surface">
    <ProfileIdentityBar profile={profile} onConfigure={() => setRightPaneMode('configure')} />
    <div ref={workspaceRef} className={workspaceClassName} style={{ '--preview-size': trackSizes.preview, '--inspector-size': trackSizes.inspector } as React.CSSProperties}>
    <section ref={previewRef} className="preview-pane">
      <MobileChatPreview profile={profile} snapshot={snapshot} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} post={post} viewport={chatViewport} onViewportChange={setChatViewport} selectedMessageId={rightPaneMode === 'debug' ? selectedMessageId : undefined} onSelectMessage={onSelectMessage} acceptedForms={acceptedForms} messageActionFeedback={messageActionFeedback} onMessageActionFeedback={onMessageActionFeedback} />
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
            selectRightPaneMode(event.key === 'ArrowLeft' || event.key === 'Home' ? 'debug' : 'configure', true);
          }}>
            <button id="right-pane-debug-tab" type="button" role="tab" tabIndex={rightPaneMode === 'debug' ? 0 : -1} aria-selected={rightPaneMode === 'debug'} aria-controls="right-pane-panel" onClick={() => selectRightPaneMode('debug')}>{t('Debug')}</button>
            <button id="right-pane-configure-tab" type="button" role="tab" tabIndex={rightPaneMode === 'configure' ? 0 : -1} aria-selected={rightPaneMode === 'configure'} aria-controls="right-pane-panel" onClick={() => selectRightPaneMode('configure')}>{t('Configure')}</button>
          </div>
          <span>{rightPaneMode === 'debug' ? t('{count} raw events', { count: formatNumber(snapshot?.rawEvents.length ?? 0) }) : t('Edits JSONC')}</span>
        </header>
        <div id="right-pane-panel" className="right-pane-panel" role="tabpanel" aria-labelledby={`right-pane-${rightPaneMode}-tab`} tabIndex={-1}>
          {rightPaneMode === 'debug'
            ? <Inspector profile={profile} snapshot={snapshot} runs={runs} networkEntries={networkEntries} active={active} tab={inspectorTab} setTab={setInspectorTab} requestPreview={requestPreview} interactive={!isInteractionLocked(profile, 'inspector.open', active)} eventFilters={eventFilters} onEventFiltersChange={setEventFilters} onCreateMapping={onCreateMapping} selectedSequence={selectedRawSequence} onSelectEvent={onSelectEvent} />
            : <SettingsWorkspace embedded section={configurationSection} onSectionChange={setConfigurationSection} profile={profile} snapshot={snapshot} requestPreview={requestPreview} remoteName={remoteName} mappingTestResult={mappingTestResult} post={post} />}
        </div>
      </aside>
    </>}
    </div>
  </div>;
}

export function ProfileIdentityBar({ profile, onConfigure }: { profile: TurnStageProfile; onConfigure?: () => void }): React.JSX.Element {
  return <header className="profile-identity" aria-label={t('TurnStage profile identity')}>
    <div className="profile-identity__primary">
      <ProductIcon name="target" />
      <strong title={profile.name}>{profile.name || t('Untitled profile')}</strong>
      <span>{t('TurnStage Profile')}</span>
    </div>
    <div className="profile-identity__actions">
      <div className="profile-identity__meta">
        <code>{profile.id}</code>
        <span aria-hidden="true">·</span>
        <span>{profile.environment || t('No environment')}</span>
      </div>
      {onConfigure && <IconButton icon="settings-gear" label={t('Configure profile')} type="button" onClick={onConfigure} />}
    </div>
  </header>;
}

export function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  const text = safeJson(value);
  return <pre className="json"><code>{text}</code><ClipboardButton text={text} label={t('Copy JSON')} /></pre>;
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? '' : result;
  } catch {
    return t('Unable to display this value.');
  }
}

export function Inspector({ profile, snapshot, runs = [], networkEntries = [], active = false, tab, setTab, requestPreview, full = false, interactive = true, eventFilters = normalizeInspectorEventFilters(), onEventFiltersChange = () => undefined, onCreateMapping, selectedSequence, onSelectEvent }: { profile?: TurnStageProfile; snapshot?: SessionSnapshot; runs?: LocalRunSummary[]; networkEntries?: NetworkExchange[]; active?: boolean; tab: InspectorTab; setTab: (tab: InspectorTab) => void; requestPreview: unknown; full?: boolean; interactive?: boolean; eventFilters?: InspectorEventFilters; onEventFiltersChange?: (filters: InspectorEventFilters) => void; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
  const availableTabs: InspectorTab[] = profile && !componentVisible(profile, 'metrics') ? inspectorTabs.filter((item): item is InspectorTab => item !== 'Metrics') : [...inspectorTabs];
  const effectiveTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;
  const data = effectiveTab === 'Raw Events' ? snapshot?.rawEvents ?? [] : effectiveTab === 'Normalized' ? snapshot?.normalizedEvents ?? [] : [];
  const eventKind = effectiveTab === 'Normalized' ? 'normalized' : 'raw';
  const filters = eventFilters[eventKind];
  const terminalRawSequences = useMemo(() => terminalSequences(snapshot?.normalizedEvents ?? []), [snapshot?.normalizedEvents]);
  const types = useMemo(() => [...new Set(data.map((item) => eventLabel(item)))].sort(), [data]);
  const filtered = useMemo(() => data.filter((item) => eventMatchesFilters(item, filters, eventKind, terminalRawSequences)), [data, eventKind, filters, terminalRawSequences]);
  const updateFilters = (patch: Partial<EventFilterState>) => onEventFiltersChange({ ...eventFilters, [eventKind]: { ...filters, ...patch } });
  const filtersActive = filters.query !== '' || filters.eventType !== 'all' || filters.mapping !== 'all' || filters.issue !== 'all' || filters.terminal !== 'all';
  const panelContent = effectiveTab === 'Network'
    ? <NetworkInspector entries={networkEntries} legacyRequestPreview={requestPreview} />
    : effectiveTab === 'Raw Events' || effectiveTab === 'Normalized'
      ? <div className="event-inspector">
        <div className="event-filters">
          <label className="event-search"><span className="sr-only">{t('Search events')}</span><input type="search" value={filters.query} placeholder={t('Search events')} aria-label={t('Search events')} disabled={!interactive} onChange={(event) => updateFilters({ query: event.target.value })} /></label>
          <label><span className="sr-only">{t('Event type')}</span><select value={filters.eventType} aria-label={t('Event type')} onChange={(event) => updateFilters({ eventType: event.target.value })} disabled={!interactive}><option value="all">{t('All types')}</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          {eventKind === 'raw' && <label><span className="sr-only">{t('Mapping status')}</span><select value={filters.mapping} aria-label={t('Mapping status')} onChange={(event) => updateFilters({ mapping: event.target.value as EventMappingFilter })} disabled={!interactive}><option value="all">{t('All mappings')}</option><option value="matched">{t('Matched')}</option><option value="unmatched">{t('Unmatched')}</option></select></label>}
          {eventKind === 'raw' && <label><span className="sr-only">{t('Event health')}</span><select value={filters.issue} aria-label={t('Event health')} onChange={(event) => updateFilters({ issue: event.target.value as EventIssueFilter })} disabled={!interactive}><option value="all">{t('All health')}</option><option value="valid">{t('Valid')}</option><option value="parse-error">{t('Parse errors')}</option><option value="mapping-error">{t('Mapping errors')}</option></select></label>}
          <label><span className="sr-only">{t('Terminal status')}</span><select value={filters.terminal} aria-label={t('Terminal status')} onChange={(event) => updateFilters({ terminal: event.target.value as EventTerminalFilter })} disabled={!interactive}><option value="all">{t('All events')}</option><option value="terminal">{t('Terminal')}</option><option value="non-terminal">{t('Non-terminal')}</option></select></label>
          <IconButton icon="clear-all" label={t('Clear event filters')} disabled={!interactive || !filtersActive} onClick={() => onEventFiltersChange({ ...eventFilters, [eventKind]: { ...DEFAULT_EVENT_FILTERS } })} />
          <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(data.length) })}</span>
        </div>
        <VirtualEvents items={filtered} kind={eventKind} terminalRawSequences={terminalRawSequences} label={t(effectiveTab)} onCreateMapping={effectiveTab === 'Raw Events' && interactive ? onCreateMapping : undefined} selectedSequence={selectedSequence} onSelectEvent={onSelectEvent} />
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
    <div className="mini-tabs" role="tablist" aria-orientation="horizontal" aria-label={t('Inspector views')}>{availableTabs.map((item) => <button key={item} id={inspectorTabId(item)} role="tab" aria-selected={effectiveTab === item} aria-controls={inspectorPanelId(item)} tabIndex={effectiveTab === item ? 0 : -1} disabled={!interactive} onClick={() => setTab(item)} onKeyDown={(event) => handleTabKeyDown(event, item)}>{t(item)}</button>)}</div>
    {snapshot?.droppedEventCount ? <p className="warning">{t('{count} old events were dropped due to buffer limits.', { count: formatNumber(snapshot.droppedEventCount) })}</p> : null}
    {snapshot?.droppedNormalizedEventCount ? <p className="warning">{t('{count} old normalized events were dropped due to buffer limits.', { count: formatNumber(snapshot.droppedNormalizedEventCount) })}</p> : null}
    {snapshot?.droppedMessageCount ? <p className="warning">{t('{count} old messages were dropped due to conversation limits.', { count: formatNumber(snapshot.droppedMessageCount) })}</p> : null}
    {availableTabs.map((item) => <section key={item} id={inspectorPanelId(item)} role="tabpanel" aria-labelledby={inspectorTabId(item)} hidden={effectiveTab !== item} tabIndex={effectiveTab === item ? 0 : -1} style={{ display: effectiveTab === item ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{effectiveTab === item ? panelContent : null}</section>)}
  </div>;
}

const networkDetailTabs = ['Headers', 'Payload', 'Response', 'Timing'] as const;
type NetworkDetailTab = typeof networkDetailTabs[number];

export function NetworkInspector({ entries, legacyRequestPreview }: { entries: NetworkExchange[]; legacyRequestPreview?: unknown }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [detailTab, setDetailTab] = useState<NetworkDetailTab>('Headers');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => entries.filter((entry) => !normalizedQuery || `${entry.kind} ${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.state} ${entry.variantId ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)), [entries, normalizedQuery]);
  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered.at(-1);
  const selectedIndex = selected ? filtered.findIndex((entry) => entry.id === selected.id) : -1;
  const select = (entry: NetworkExchange, focus = false) => {
    setSelectedId(entry.id);
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
    setDetailTab(tab);
    requestAnimationFrame(() => document.getElementById(networkDetailTabId(tab))?.focus());
  };
  if (!entries.length) return <div className="network-empty"><div className="empty-state compact"><strong>{t('No network requests')}</strong><p>{t('Start a session or send a message to capture requests.')}</p></div>{legacyRequestPreview !== undefined && <details><summary>{t('Last redacted request preview')}</summary><JsonBlock value={legacyRequestPreview} /></details>}</div>;
  return <div className={`network-inspector ${selected ? 'network-inspector--detail' : ''}`}>
    <div className="network-toolbar">
      <label><span className="sr-only">{t('Filter network requests')}</span><input type="search" value={query} placeholder={t('Filter')} aria-label={t('Filter network requests')} onChange={(event) => setQuery(event.target.value)} /></label>
      <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(entries.length) })}</span>
    </div>
    <div className="network-table">
      <div className="network-table__header" aria-hidden="true"><span>{t('Name')}</span><span>{t('Method')}</span><span>{t('Status')}</span><span>{t('Type')}</span><span>{t('Time')}</span><span>{t('Size')}</span></div>
      <div className="network-table__rows" role="listbox" aria-label={t('Network requests')}>
        {!filtered.length ? <div className="empty-state compact"><strong>{t('No matching requests')}</strong></div> : filtered.map((entry, index) => {
          const active = entry.id === selected?.id;
          return <button type="button" id={networkRowId(entry.id)} role="option" aria-selected={active} tabIndex={active || (selectedIndex < 0 && index === 0) ? 0 : -1} className={`network-row ${active ? 'selected' : ''}`} key={entry.id} onClick={() => select(entry)} onKeyDown={(event) => handleRowKeyDown(event, index)}>
            <span className="network-name"><ProductIcon name={networkStateIcon(entry)} /><span><strong>{networkRequestName(entry)}</strong><small>{t(networkKindLabel(entry.kind))}{entry.attempt > 1 ? ` · ${t('Attempt {attempt}', { attempt: formatNumber(entry.attempt) })}` : ''}</small></span></span>
            <span>{entry.method}</span><span className={`network-status network-status--${entry.state}`}>{entry.status ?? localizeHumanized(entry.state)}</span><span>{entry.protocol ?? responseContentType(entry)}</span><span>{entry.timing.total === undefined ? '—' : formatDuration(entry.timing.total)}</span><span>{formatBytes(entry.transferredBytes)}</span>
          </button>;
        })}
      </div>
    </div>
    {selected && <section className="network-detail" aria-label={t('Request details')}>
      <header><div><strong title={selected.url}>{networkRequestName(selected)}</strong><span>{selected.method} · {selected.status ?? localizeHumanized(selected.state)} · {formatDuration(selected.timing.total ?? 0)}</span></div></header>
      <div className="network-detail-tabs" role="tablist" aria-label={t('Request detail views')}>{networkDetailTabs.map((tab) => <button key={tab} id={networkDetailTabId(tab)} role="tab" aria-selected={detailTab === tab} aria-controls={networkDetailPanelId(tab)} tabIndex={detailTab === tab ? 0 : -1} onClick={() => setDetailTab(tab)} onKeyDown={(event) => handleDetailTabKeyDown(event, tab)}>{t(tab)}</button>)}</div>
      {networkDetailTabs.map((tab) => <div key={tab} id={networkDetailPanelId(tab)} role="tabpanel" aria-labelledby={networkDetailTabId(tab)} hidden={detailTab !== tab} className="network-detail-panel">{detailTab === tab ? <NetworkDetailContent entry={selected} tab={tab} /> : null}</div>)}
    </section>}
  </div>;
}

function NetworkDetailContent({ entry, tab }: { entry: NetworkExchange; tab: NetworkDetailTab }): React.JSX.Element {
  if (tab === 'Payload') return entry.requestBody === undefined ? <p className="muted network-detail-empty">{t('No request payload.')}</p> : <JsonBlock value={entry.requestBody} />;
  if (tab === 'Response') return <div className="network-response"><pre>{entry.responseBodyPreview || t('No response body captured.')}</pre>{entry.responseBodyTruncated && <p className="warning">{t('Response preview was truncated at the safety limit.')}</p>}</div>;
  if (tab === 'Timing') return <dl className="network-properties"><NetworkProperty label={t('Started')} value={formatDateTime(entry.startedAt)} /><NetworkProperty label={t('Headers')} value={optionalDuration(entry.timing.headers)} /><NetworkProperty label={t('First chunk')} value={optionalDuration(entry.timing.firstChunk)} /><NetworkProperty label={t('Total')} value={optionalDuration(entry.timing.total)} /><NetworkProperty label={t('Request timeout')} value={optionalDuration(entry.timing.timeout)} /><NetworkProperty label={t('Idle timeout')} value={optionalDuration(entry.timing.idleTimeout)} />{entry.timing.retryDelay !== undefined && <NetworkProperty label={t('Retry delay')} value={formatDuration(entry.timing.retryDelay)} />}</dl>;
  return <div className="network-headers"><dl className="network-properties"><NetworkProperty label={t('Request URL')} value={entry.url} /><NetworkProperty label={t('Request method')} value={entry.method} /><NetworkProperty label={t('Status')} value={entry.status === undefined ? localizeHumanized(entry.state) : String(entry.status)} /><NetworkProperty label={t('Request type')} value={t(networkKindLabel(entry.kind))} />{entry.variantId && <NetworkProperty label={t('Variant')} value={entry.variantId} />}</dl><NetworkHeaderGroup title={t('Request headers')} headers={entry.requestHeaders} /><NetworkHeaderGroup title={t('Response headers')} headers={entry.responseHeaders ?? {}} />{entry.error && <section><h4>{t('Error')}</h4><JsonBlock value={entry.error} /></section>}</div>;
}

function NetworkHeaderGroup({ title, headers }: { title: string; headers: Record<string, string> }): React.JSX.Element { const items = Object.entries(headers); return <section><h4>{title}</h4>{items.length ? <dl className="network-header-list">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <p className="muted">{t('No headers captured.')}</p>}</section>; }
function NetworkProperty({ label, value }: { label: string; value: string }): React.JSX.Element { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function networkRequestName(entry: NetworkExchange): string { try { const url = new URL(entry.url); return url.pathname.split('/').filter(Boolean).at(-1) || url.host; } catch { return entry.kind; } }
function networkKindLabel(kind: NetworkExchange['kind']): string { return kind === 'opening' ? 'Opening' : kind === 'stop' ? 'Stop request' : 'Conversation stream'; }
function responseContentType(entry: NetworkExchange): string { return Object.entries(entry.responseHeaders ?? {}).find(([name]) => name.toLocaleLowerCase() === 'content-type')?.[1]?.split(';')[0] ?? 'fetch'; }
function networkStateIcon(entry: NetworkExchange): 'check' | 'warning' | 'circle-filled' | 'stop' { if (entry.state === 'failed') return 'warning'; if (entry.state === 'aborted') return 'stop'; if (entry.state === 'pending' || entry.state === 'streaming') return 'circle-filled'; return 'check'; }
function networkRowId(id: string): string { return `network-row-${stableIdToken(id)}`; }
function networkDetailTabId(tab: NetworkDetailTab): string { return `network-detail-tab-${stableIdToken(tab)}`; }
function networkDetailPanelId(tab: NetworkDetailTab): string { return `network-detail-panel-${stableIdToken(tab)}`; }
function optionalDuration(value: number | undefined): string { return value === undefined ? '—' : formatDuration(value); }
function formatBytes(value: number): string { if (value < 1024) return `${formatNumber(value)} B`; if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 1024))} KB`; return `${formatNumber(Math.round(value / (1024 * 1024)))} MB`; }

export function VirtualEvents({ items, kind = 'raw', terminalRawSequences = new Set<number>(), label, onCreateMapping, selectedSequence, onSelectEvent }: { items: Array<Record<string, any>>; kind?: 'raw' | 'normalized'; terminalRawSequences?: ReadonlySet<number>; label: string; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
  const rowHeight = 30;
  const listRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uncontrolledSelectedSequence, setUncontrolledSelectedSequence] = useState<number>();
  const effectiveSelectedSequence = selectedSequence ?? uncontrolledSelectedSequence;
  const selectedIndex = effectiveSelectedSequence === undefined ? -1 : items.findIndex((item) => eventSequence(item) === effectiveSelectedSequence);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  const screenReader = typeof document !== 'undefined' && document.body?.classList.contains('vscode-using-screen-reader');
  const start = Math.max(0, Math.floor(top / rowHeight) - 4);
  const viewportStart = Math.floor(top / rowHeight);
  const viewportEnd = viewportStart + Math.ceil(height / rowHeight);
  const selectedInViewport = selectedIndex >= 0 && selectedIndex >= Math.max(0, viewportStart - 2) && selectedIndex <= viewportEnd + 2;
  const accessibleAnchor = selectedInViewport ? selectedIndex : Math.max(activeIndex, viewportStart);
  const visibleStart = screenReader ? accessibleEventWindowStart(accessibleAnchor, items.length, ACCESSIBLE_EVENT_WINDOW_SIZE) : start;
  const visibleCount = screenReader ? ACCESSIBLE_EVENT_WINDOW_SIZE : Math.ceil(height / rowHeight) + 8;
  const visible = items.slice(visibleStart, visibleStart + visibleCount);
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : items.length ? Math.min(Math.max(activeIndex, 0), items.length - 1) : -1;

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const updateHeight = () => setHeight(element.clientHeight || 480);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const nextTop = Math.max(0, selectedIndex * rowHeight - rowHeight * 2);
    const list = listRef.current;
    if (list) {
      if (typeof list.scrollTo === 'function') list.scrollTo({ top: nextTop });
      else list.scrollTop = nextTop;
    }
    setTop(nextTop);
    focusAfterRender(() => document.getElementById(`inspector-event-${String(effectiveSelectedSequence)}`)?.focus());
  }, [effectiveSelectedSequence, selectedIndex]);

  useEffect(() => {
    setActiveIndex((current) => selectedIndex >= 0 ? selectedIndex : items.length ? Math.min(Math.max(current, 0), items.length - 1) : 0);
  }, [items, selectedIndex]);

  const selectEventAt = (index: number) => {
    const item = items[index];
    if (!item) return;
    setActiveIndex(index);
    setUncontrolledSelectedSequence(eventSequence(item));
    onSelectEvent?.(item);
    focusAfterRender(() => document.getElementById(eventRowId(item, index))?.focus());
  };

  const handleEventKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectEventAt(index);
      return;
    }
    const nextIndex = getRovingIndex(index, event.key, items.length, 'vertical');
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectEventAt(nextIndex);
  };

  const accessibleEnd = Math.min(items.length, visibleStart + ACCESSIBLE_EVENT_WINDOW_SIZE);
  const accessibleWindow = screenReader && items.length > ACCESSIBLE_EVENT_WINDOW_SIZE;
  const selectedDetailId = selectedItem ? eventDetailId(kind, selectedItem, selectedIndex) : undefined;
  return <div className={`event-browser ${selectedItem ? 'event-browser--detail' : ''} ${accessibleWindow ? 'event-browser--accessible-window' : ''}`.trim()}>
    {screenReader && items.length > ACCESSIBLE_EVENT_WINDOW_SIZE && <p className="event-accessibility-notice" role="status" aria-live="polite">{t('Showing events {start}–{end} of {total} for screen reader performance.', { start: formatNumber(visibleStart + 1), end: formatNumber(accessibleEnd), total: formatNumber(items.length) })}</p>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{selectedItem ? t('Event payload opened for {event} #{sequence}.', { event: eventLabel(selectedItem), sequence: formatNumber(selectedItem.sequence) }) : ''}</span>
    <div ref={listRef} className="virtual-list" role="listbox" aria-label={label} onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      {!items.length ? <div className="empty-state compact"><strong>{t('No matching events')}</strong></div> : <div className="virtual-space" style={{ height: items.length * rowHeight }}><div style={{ transform: `translateY(${visibleStart * rowHeight}px)` }}>{visible.map((item, index) => {
        const itemSequence = eventSequence(item);
        const selected = itemSequence === effectiveSelectedSequence;
        const itemIndex = visibleStart + index;
        const status = eventRowStatus(item, kind, terminalRawSequences);
        return <button type="button" role="option" id={eventRowId(item, itemIndex)} aria-selected={selected} aria-controls={eventDetailId(kind, item, itemIndex)} aria-setsize={items.length} aria-posinset={itemIndex + 1} data-disclosure-state={selected ? 'expanded' : 'collapsed'} tabIndex={itemIndex === rovingIndex ? 0 : -1} title={t('View event payload')} className={`event-row ${selected ? 'selected' : ''}`} key={`${item.sequence}-${eventLabel(item)}-${index}`} onClick={() => selectEventAt(itemIndex)} onKeyDown={(event) => handleEventKeyDown(event, itemIndex)}>
          <span className="event-disclosure"><ProductIcon name={selected ? 'chevron-down' : 'chevron-right'} /></span><span>#{formatNumber(item.sequence)}</span><strong>{eventLabel(item)}</strong><span className={`event-status event-status--${status.kind}`} title={t(status.label)} aria-label={t(status.label)}><ProductIcon name={status.icon} /></span><span>+{formatDuration(item.elapsedMs ?? 0)}</span>
        </button>;
      })}</div></div>}
    </div>
    {selectedItem && <section id={selectedDetailId} className="event-detail" aria-labelledby={`${selectedDetailId}-heading`}>
      <header><div><strong id={`${selectedDetailId}-heading`}>{t('Event payload')}</strong><span>{eventLabel(selectedItem)} · #{formatNumber(selectedItem.sequence)} · +{formatDuration(selectedItem.elapsedMs ?? 0)}</span></div>{onCreateMapping && <button onClick={() => onCreateMapping(selectedItem as RawStreamEvent)}>{t('Create mapping draft')}</button>}</header>
      <JsonBlock value={selectedItem} />
    </section>}
  </div>;
}
function MetricGrid({ metrics, enabled }: { metrics?: SessionSnapshot['metrics']; enabled?: string[] }): React.JSX.Element { if (!metrics) return <p className="muted">{t('No metrics yet.')}</p>; const allow = enabled?.length ? new Set(enabled) : undefined; const entries = Object.entries(metrics).filter(([key, value]) => value !== undefined && (!allow || allow.has(key))); if (!entries.length) return <p className="muted">{t('No enabled metrics have values yet.')}</p>; return <dl className="metrics">{entries.map(([key, value]) => <div key={key}><dt>{localizeHumanized(key)}</dt><dd>{typeof value === 'number' ? (/latency|duration|gap/i.test(key) ? formatDuration(value) : formatNumber(value)) : String(value)}</dd></div>)}</dl>; }

export function Replay({ runs, replay, remoteSessions, active, trusted }: { runs: LocalRunSummary[]; replay?: ReplaySnapshot; remoteSessions?: RemoteSessionReference[]; active: boolean; trusted: boolean }): React.JSX.Element {
  const [speed, setSpeed] = useState<ReplaySnapshot['speed']>(replay?.speed ?? 1); useEffect(() => { if (replay) setSpeed(replay.speed); }, [replay?.speed]);
  const playing = replay?.status === 'playing'; const paused = replay?.status === 'paused'; const loaded = Boolean(replay?.runId) && (playing || paused || replay?.status === 'stopped'); const progress = replay?.total ? Math.round((replay.index / replay.total) * 100) : 0;
  const requestActive = active && !playing && !paused;
  const changeSpeed = (value: ReplaySnapshot['speed']) => { setSpeed(value); if (replay?.runId) post({ type: 'run.replay.speed', speed: value }); };
  return <div className="content-page replay-page"><header className="page-heading"><div><h2>{t('Recorded runs')}</h2><p>{t('Replay raw events through the same mapping and reducer pipeline.')}</p></div><div className="page-heading-actions"><IconButton icon="desktop-download" label={t('Import run')} disabled={!trusted || active} onClick={() => post({ type: 'run.import' })} /></div></header>{remoteSessions && remoteSessions.length > 0 && <section className="remote-sessions" aria-labelledby="remote-sessions-heading"><div className="section-heading"><div><h3 id="remote-sessions-heading">{t('Remote session references')}</h3><p>{t('Reference-only history keeps metadata locally; applying one does not fetch or expose remote messages.')}</p></div></div><ul>{remoteSessions.map((session) => <li key={session.conversationId}><div><strong>{session.title}</strong><span><code>{session.conversationId}</code> · {session.actorId ?? t('No actor')} · {session.environmentId ?? t('No environment')} · <time dateTime={dateTimeAttribute(session.createdAt)}>{formatDateTime(session.createdAt)}</time></span></div><button disabled={active} onClick={() => post({ type: 'history.remote.apply', conversationId: session.conversationId })}>{t('Apply')}</button></li>)}</ul></section>}<section className="replay-deck" aria-label={t('Replay controls')}><div className="transport-controls"><button disabled={!playing} onClick={() => post({ type: 'run.replay.pause' })}>{t('Pause')}</button><button className={paused ? 'primary' : undefined} disabled={!paused} onClick={() => post({ type: 'run.replay.resume' })}>{t('Resume')}</button><button disabled={!loaded} onClick={() => post({ type: 'run.replay.stop' })}>{t('Stop')}</button><button disabled={!paused} onClick={() => post({ type: 'run.replay.step' })}>{t('Step')}</button></div><label>{t('Playback speed')}<select value={speed} onChange={(event) => changeSpeed(Number(event.target.value) as ReplaySnapshot['speed'])}>{[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{formatNumber(value)}×</option>)}</select></label><div className="replay-progress" role="status" aria-live="polite"><div><strong>{replay ? localizeHumanized(replay.status) : t('Ready')}</strong><span>{replay ? t('{current} / {total} events', { current: formatNumber(replay.index), total: formatNumber(replay.total) }) : t('Select a run to begin')}</span></div><progress value={progress} max={100} aria-label={t('Replay progress')}>{progress}%</progress></div>{requestActive && <p className="replay-blocked">{t('Finish or stop the current request before replaying a run.')}</p>}</section>{runs.length ? <ul className="run-list">{runs.map((run) => { const replayable = run.replayable; const replaying = replay?.runId === run.id && (playing || paused); return <li className={replay?.runId === run.id ? 'active-run' : ''} key={run.id}><div><strong>{formatDateTime(run.createdAt)}</strong><span>{localizeHumanized(run.result.type)} · {t('{count} events', { count: formatNumber(run.metrics.eventCount) })} · {formatDuration(run.metrics.totalDuration ?? 0)}</span><RunSummaryDetails run={run} />{!replayable && <span className="run-availability"><ProductIcon name="warning" />{t('Not replayable: raw events were not recorded.')}</span>}{replayable && !run.hasSnapshot && <span className="run-availability"><ProductIcon name="info" />{t('Replay starts without recorded chat context.')}</span>}</div><div className="actions"><button className={replayable ? 'primary' : undefined} disabled={active || !replayable} onClick={() => post({ type: 'run.replay.play', runId: run.id, speed })}>{t(replaying ? 'Replaying' : 'Replay')}</button><button disabled={!trusted} onClick={() => post({ type: 'run.export', runId: run.id })}>{t('Export')}</button></div></li>; })}</ul> : <div className="empty-state"><strong>{t('No recorded runs')}</strong><p>{t('Completed, failed, and aborted turns appear here.')}</p></div>}</div>;
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

const TERMINAL_EVENT_TYPES = new Set(['stream.completed', 'stream.failed', 'stream.aborted']);
const MAPPING_FILTERS = new Set<EventMappingFilter>(['all', 'matched', 'unmatched']);
const ISSUE_FILTERS = new Set<EventIssueFilter>(['all', 'valid', 'parse-error', 'mapping-error']);
const TERMINAL_FILTERS = new Set<EventTerminalFilter>(['all', 'terminal', 'non-terminal']);

export function normalizeEventFilterState(value: unknown): EventFilterState {
  const candidate = value && typeof value === 'object' ? value as Partial<EventFilterState> : {};
  return {
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 512) : '',
    eventType: typeof candidate.eventType === 'string' && candidate.eventType.length <= 256 ? candidate.eventType : 'all',
    mapping: MAPPING_FILTERS.has(candidate.mapping as EventMappingFilter) ? candidate.mapping as EventMappingFilter : 'all',
    issue: ISSUE_FILTERS.has(candidate.issue as EventIssueFilter) ? candidate.issue as EventIssueFilter : 'all',
    terminal: TERMINAL_FILTERS.has(candidate.terminal as EventTerminalFilter) ? candidate.terminal as EventTerminalFilter : 'all'
  };
}

export function normalizeInspectorEventFilters(value?: Partial<InspectorEventFilters>): InspectorEventFilters {
  return { raw: normalizeEventFilterState(value?.raw), normalized: normalizeEventFilterState(value?.normalized) };
}

export function terminalSequences(normalizedEvents: Array<Record<string, unknown>>): ReadonlySet<number> {
  return new Set(normalizedEvents.filter((item) => TERMINAL_EVENT_TYPES.has(String(item.type))).map((item) => typeof item.rawSequence === 'number' ? item.rawSequence : item.sequence).filter((value): value is number => typeof value === 'number'));
}

function isTerminalEvent(item: Record<string, any>, kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): boolean {
  return kind === 'normalized' ? TERMINAL_EVENT_TYPES.has(eventLabel(item)) : terminalRawSequences.has(item.sequence);
}

export function eventMatchesFilters(item: Record<string, any>, filters: EventFilterState, kind: 'raw' | 'normalized', terminalRawSequences: ReadonlySet<number>): boolean {
  if (filters.eventType !== 'all' && eventLabel(item) !== filters.eventType) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  if (query && !safeJson(item).toLocaleLowerCase().includes(query)) return false;
  if (kind === 'raw') {
    const matched = typeof item.mappingRuleId === 'string' && Boolean(item.mappingRuleId.trim());
    if (filters.mapping === 'matched' && !matched) return false;
    if (filters.mapping === 'unmatched' && matched) return false;
    const issue: EventIssueFilter = item.parseError ? 'parse-error' : item.mappingError ? 'mapping-error' : 'valid';
    if (filters.issue !== 'all' && filters.issue !== issue) return false;
  }
  const terminal = isTerminalEvent(item, kind, terminalRawSequences);
  if (filters.terminal === 'terminal' && !terminal) return false;
  if (filters.terminal === 'non-terminal' && terminal) return false;
  return true;
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

function isRightPaneMode(value: unknown): value is RightPaneMode {
  return value === 'debug' || value === 'configure';
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
