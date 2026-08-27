import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage, MappingTestResult, WebviewPayload, WorkspaceSection } from '../shared/protocol';
import { isHostMessage, isWorkspaceSection, PROTOCOL_VERSION } from '../shared/protocol';
import type { ChatMessage, LocalRun, RawStreamEvent, RemoteSessionReference, ReplaySnapshot, SessionSnapshot, TurnStageProfile } from '../shared/types';
import { mappingDraftFromRawEvent } from './configEditors';
import { ClipboardButton } from './ClipboardButton';
import { MobileChatPreview } from './MobileChatPreview';
import { SettingsWorkspace } from './SettingsWorkspace';
import { dateTimeAttribute, formatDateTime, formatDuration, formatNumber, localizeHumanized, setLocale, t } from './i18n';
import { resolveUiLayout } from './uiConfig';
import './styles.css';

declare function acquireVsCodeApi<T = unknown>(): { postMessage(message: unknown): void; getState(): T | undefined; setState(state: T): void };
interface WebviewState { section?: WorkspaceSection; draft?: string; inspectorTab?: InspectorTab; splitPercent?: number; splitCustomized?: boolean; selectedMessageId?: string; selectedRawSequence?: number }
type VsCodeApi = { postMessage(message: unknown): void; getState(): WebviewState | undefined; setState(state: WebviewState): void };
const rootElement = typeof document === 'undefined' ? undefined : document.getElementById('root');
const instanceId = rootElement?.dataset.instanceId ?? 'test-instance';
const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function'
  ? acquireVsCodeApi<WebviewState>()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
const savedState = vscode.getState();
const inspectorTabs = ['Request', 'Raw Events', 'Normalized', 'Metrics', 'Errors', 'Runs'] as const; type InspectorTab = typeof inspectorTabs[number];
export const DEFAULT_SPLIT_PERCENT = 64;
export const ACCESSIBLE_EVENT_WINDOW_SIZE = 200;

function post(message: WebviewPayload): void { vscode.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId: crypto.randomUUID() }); }

function App(): React.JSX.Element {
  const [section, setSection] = useState<WorkspaceSection>(isWorkspaceSection(savedState?.section) ? savedState.section : 'test'); const [inspectorTab, setInspectorTab] = useState<InspectorTab>(savedState?.inspectorTab ?? 'Raw Events'); const [draft, setDraft] = useState(savedState?.draft ?? ''); const [splitPercent, setSplitPercent] = useState(clampSplit(savedState?.splitPercent ?? DEFAULT_SPLIT_PERCENT)); const [splitCustomized, setSplitCustomized] = useState(savedState?.splitCustomized ?? false); const [selectedMessageId, setSelectedMessageId] = useState(savedState?.selectedMessageId); const [selectedRawSequence, setSelectedRawSequence] = useState(savedState?.selectedRawSequence);
  const [profile, setProfile] = useState<TurnStageProfile>(); const [snapshot, setSnapshot] = useState<SessionSnapshot>(); const [runs, setRuns] = useState<LocalRun[]>([]); const [requestPreview, setRequestPreview] = useState<unknown>(); const [diagnostics, setDiagnostics] = useState<Array<{ severity: string; message: string }>>([]); const [notice, setNotice] = useState(''); const [mappingTestResult, setMappingTestResult] = useState<MappingTestResult>(); const [remoteName, setRemoteName] = useState<string>(); const [, setLocaleVersion] = useState(0);
  useEffect(() => { const listener = (event: MessageEvent<HostMessage>) => { if (!isHostMessage(event.data, instanceId)) return; const message = event.data; if (message.type === 'host.ready') { setLocale(message.locale, message.direction); setLocaleVersion((current) => current + 1); setRemoteName(message.remoteName); } else if (message.type === 'workspace.section') { setSection(message.section); requestAnimationFrame(() => document.getElementById('main-panel')?.focus()); } else if (message.type === 'profile.snapshot') setProfile(message.profile); else if (message.type === 'profile.validation') setDiagnostics(message.diagnostics); else if (message.type === 'session.snapshot') { setSnapshot(message.snapshot); setRuns(message.runs); setRequestPreview(message.requestPreview); } else if (message.type === 'mapping.test.result') setMappingTestResult(message.result); else if (message.type === 'request.error') setNotice(message.error.message); else if (message.type === 'run.exported') setNotice(t('Run exported to {path}', { path: message.path })); else if (message.type === 'workspaceTrust.changed') setSnapshot((current) => current ? { ...current, trusted: message.trusted } : current); }; window.addEventListener('message', listener); post({ type: 'webview.ready' }); return () => window.removeEventListener('message', listener); }, []);
  useEffect(() => { vscode.setState({ section, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence }); }, [section, draft, inspectorTab, splitPercent, splitCustomized, selectedMessageId, selectedRawSequence]);
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
    if (sequences.length) { setSelectedRawSequence(sequences.at(-1)); setInspectorTab('Raw Events'); }
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
    <section id="main-panel" tabIndex={-1} className="panel" aria-label={section === 'test' ? t('Test') : t('{section} profile configuration', { section: localizeHumanized(section) })}>
      {section === 'test' && <TestWorkspace profile={profile} snapshot={snapshot} runs={runs} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} requestPreview={requestPreview} splitPercent={splitPercent} setSplitPercent={setSplitPercent} splitCustomized={splitCustomized} setSplitCustomized={setSplitCustomized} selectedMessageId={selectedMessageId} selectedRawSequence={selectedRawSequence} onSelectMessage={selectMessage} onSelectEvent={selectEvent} onCreateMapping={(event) => { post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, mappingDraftFromRawEvent(event, profile)] }); setNotice(t('Created mapping draft from raw event #{sequence}.', { sequence: formatNumber(event.sequence) })); }} />}
      {section !== 'test' && <SettingsWorkspace section={section} onSectionChange={setSection} profile={profile} snapshot={snapshot} requestPreview={requestPreview} remoteName={remoteName} mappingTestResult={mappingTestResult} post={post} />}
    </section>
    <div className="sr-status" role="status" aria-live="polite">{notice || terminalAnnouncement(snapshot?.turnState)}</div>
  </main>;
}

function TestWorkspace({ profile, snapshot, runs, active, continuationBlocked, draft, setDraft, send, inspectorTab, setInspectorTab, requestPreview, splitPercent, setSplitPercent, splitCustomized, setSplitCustomized, selectedMessageId, selectedRawSequence, onSelectMessage, onSelectEvent, onCreateMapping }: {
  profile: TurnStageProfile;
  snapshot?: SessionSnapshot;
  runs: LocalRun[];
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
  selectedMessageId?: string;
  selectedRawSequence?: number;
  onSelectMessage: (messageId: string) => void;
  onSelectEvent: (event: Record<string, unknown>) => void;
  onCreateMapping: (event: RawStreamEvent) => void;
}): React.JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const layout = resolveUiLayout(profile.ui);
  const layoutSignature = `${layout.preset}:${layout.inspectorPosition}:${layout.inspectorWidth ?? 'auto'}`;
  const hasConfiguredRightWidth = layout.inspectorPosition === 'right' && Boolean(layout.inspectorWidth);
  const previousLayoutSignature = useRef(layoutSignature);
  useEffect(() => {
    if (previousLayoutSignature.current === layoutSignature) return;
    previousLayoutSignature.current = layoutSignature;
    setSplitCustomized(false);
  }, [layoutSignature, setSplitCustomized]);
  useEffect(() => {
    const workspace = workspaceRef.current;
    const preview = previewRef.current;
    if (!layout.showInspector || !workspace || !preview) return;
    const update = () => {
      const workspaceRect = workspace.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const available = layout.inspectorPosition === 'right' ? workspaceRect.width : workspaceRect.height;
      const occupied = layout.inspectorPosition === 'right' ? previewRect.width : previewRect.height;
      if (layout.inspectorPosition === 'right' && previewRect.width >= workspaceRect.width - 1) return;
      if (available) setSplitPercent(clampSplit((occupied / available) * 100));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [layout.inspectorPosition, layout.showInspector, layoutSignature, setSplitPercent]);
  const resizeFromPointer = (clientX: number, clientY: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    const available = layout.inspectorPosition === 'right' ? rect?.width : rect?.height;
    if (!rect || !available) return;
    const offset = layout.inspectorPosition === 'right' ? clientX - rect.left : clientY - rect.top;
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
  const inspectorSize = hasConfiguredRightWidth && !splitCustomized ? `${layout.inspectorWidth}px` : `${100 - splitPercent}%`;
  const workspaceClassName = ['test-workspace', `test-workspace--${layout.preset}`, `test-workspace--inspector-${layout.inspectorPosition}`, layout.compact ? 'test-workspace--compact' : ''].filter(Boolean).join(' ');
  const decrementKey = layout.inspectorPosition === 'right' ? 'ArrowLeft' : 'ArrowUp';
  const incrementKey = layout.inspectorPosition === 'right' ? 'ArrowRight' : 'ArrowDown';
  return <div ref={workspaceRef} className={workspaceClassName} style={{ '--preview-percent': `${splitPercent}%`, '--inspector-size': inspectorSize } as React.CSSProperties}>
    <section ref={previewRef} className="preview-pane" aria-label={t('Mobile chat preview')}>
      <MobileChatPreview profile={profile} snapshot={snapshot} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} post={post} selectedMessageId={selectedMessageId} onSelectMessage={onSelectMessage} />
    </section>
    {layout.showInspector && <>
      <div className={`splitter splitter--${layout.inspectorPosition}`} role="separator" aria-label={t('Resize chat preview and debug panels')} aria-orientation={layout.inspectorPosition === 'right' ? 'vertical' : 'horizontal'} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(splitPercent)} tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => {
        if (event.key === decrementKey || event.key === incrementKey) { event.preventDefault(); setSplitCustomized(true); setSplitPercent(clampSplit(splitPercent + (event.key === decrementKey ? -2 : 2))); }
        else if (event.key === 'Home') { event.preventDefault(); setSplitCustomized(true); setSplitPercent(10); }
        else if (event.key === 'End') { event.preventDefault(); setSplitCustomized(true); setSplitPercent(90); }
      }}><span aria-hidden="true" /></div>
      <aside className="debug-pane" aria-label={t('Debug and stream information')}>
        <header className="debug-heading"><strong>{t('Debug').toLocaleUpperCase()}</strong><span>{t('{count} raw events', { count: formatNumber(snapshot?.rawEvents.length ?? 0) })}</span></header>
        <Inspector profile={profile} snapshot={snapshot} runs={runs} active={active} tab={inspectorTab} setTab={setInspectorTab} requestPreview={requestPreview} interactive={!isInteractionLocked(profile, 'inspector.open', active)} onCreateMapping={onCreateMapping} selectedSequence={selectedRawSequence} onSelectEvent={onSelectEvent} />
      </aside>
    </>}
  </div>;
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

function Inspector({ profile, snapshot, runs = [], active = false, tab, setTab, requestPreview, full = false, interactive = true, onCreateMapping, selectedSequence, onSelectEvent }: { profile?: TurnStageProfile; snapshot?: SessionSnapshot; runs?: LocalRun[]; active?: boolean; tab: InspectorTab; setTab: (tab: InspectorTab) => void; requestPreview: unknown; full?: boolean; interactive?: boolean; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
  const availableTabs: InspectorTab[] = profile && !componentVisible(profile, 'metrics') ? inspectorTabs.filter((item): item is InspectorTab => item !== 'Metrics') : [...inspectorTabs];
  const effectiveTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;
  const data = effectiveTab === 'Raw Events' ? snapshot?.rawEvents ?? [] : effectiveTab === 'Normalized' ? snapshot?.normalizedEvents ?? [] : [];
  const [query, setQuery] = useState(''); const [eventType, setEventType] = useState('all');
  const types = useMemo(() => [...new Set(data.map((item) => eventLabel(item)))].sort(), [data]);
  const filtered = useMemo(() => data.filter((item) => (eventType === 'all' || eventLabel(item) === eventType) && (!query.trim() || JSON.stringify(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [data, eventType, query]);
  const panelContent = effectiveTab === 'Request'
    ? <JsonBlock value={requestPreview ?? { message: t('Build a request to see its redacted preview.') }} />
    : effectiveTab === 'Raw Events' || effectiveTab === 'Normalized'
      ? <div className="event-inspector">
        <div className="event-filters">
          <label><span className="sr-only">{t('Search events')}</span><input type="search" value={query} placeholder={t('Search events')} aria-label={t('Search events')} disabled={!interactive} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span className="sr-only">{t('Event type')}</span><select value={eventType} aria-label={t('Event type')} onChange={(event) => setEventType(event.target.value)} disabled={!interactive}><option value="all">{t('All types')}</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(data.length) })}</span>
        </div>
        <VirtualEvents items={filtered} label={t(effectiveTab)} onCreateMapping={effectiveTab === 'Raw Events' && interactive ? onCreateMapping : undefined} selectedSequence={selectedSequence} onSelectEvent={onSelectEvent} />
      </div>
      : effectiveTab === 'Metrics'
        ? <MetricGrid metrics={snapshot?.metrics} />
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
    {availableTabs.map((item) => <section key={item} id={inspectorPanelId(item)} role="tabpanel" aria-labelledby={inspectorTabId(item)} hidden={effectiveTab !== item} tabIndex={effectiveTab === item ? 0 : -1} style={{ display: effectiveTab === item ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{effectiveTab === item ? panelContent : null}</section>)}
  </div>;
}

export function VirtualEvents({ items, label, onCreateMapping, selectedSequence, onSelectEvent }: { items: Array<Record<string, any>>; label: string; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
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
    listRef.current?.scrollTo({ top: nextTop });
    setTop(nextTop);
  }, [items, effectiveSelectedSequence, selectedIndex]);

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
  return <div className={`event-browser ${selectedItem ? 'event-browser--detail' : ''} ${accessibleWindow ? 'event-browser--accessible-window' : ''}`.trim()}>
    {screenReader && items.length > ACCESSIBLE_EVENT_WINDOW_SIZE && <p className="event-accessibility-notice" role="status" aria-live="polite">{t('Showing events {start}–{end} of {total} for screen reader performance.', { start: formatNumber(visibleStart + 1), end: formatNumber(accessibleEnd), total: formatNumber(items.length) })}</p>}
    <div ref={listRef} className="virtual-list" role="listbox" aria-label={label} onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      {!items.length ? <div className="empty-state compact"><strong>{t('No matching events')}</strong></div> : <div className="virtual-space" style={{ height: items.length * rowHeight }}><div style={{ transform: `translateY(${visibleStart * rowHeight}px)` }}>{visible.map((item, index) => {
        const itemSequence = eventSequence(item);
        const selected = itemSequence === effectiveSelectedSequence;
        const itemIndex = visibleStart + index;
        return <button type="button" role="option" id={eventRowId(item, itemIndex)} aria-selected={selected} aria-setsize={items.length} aria-posinset={itemIndex + 1} tabIndex={itemIndex === rovingIndex ? 0 : -1} className={`event-row ${selected ? 'selected' : ''}`} key={`${item.sequence}-${eventLabel(item)}-${index}`} onClick={() => selectEventAt(itemIndex)} onKeyDown={(event) => handleEventKeyDown(event, itemIndex)}>
          <span>#{formatNumber(item.sequence)}</span><strong>{eventLabel(item)}</strong><span>+{formatDuration(item.elapsedMs ?? 0)}</span>
        </button>;
      })}</div></div>}
    </div>
    {selectedItem && <section className="event-detail" aria-label={`${eventLabel(selectedItem)} #${formatNumber(selectedItem.sequence)}`}>
      <header><div><strong>{eventLabel(selectedItem)}</strong><span>#{formatNumber(selectedItem.sequence)} · +{formatDuration(selectedItem.elapsedMs ?? 0)}</span></div>{onCreateMapping && <button onClick={() => onCreateMapping(selectedItem as RawStreamEvent)}>{t('Create mapping draft')}</button>}</header>
      <JsonBlock value={selectedItem} />
    </section>}
  </div>;
}
function MetricGrid({ metrics }: { metrics?: SessionSnapshot['metrics'] }): React.JSX.Element { if (!metrics) return <p className="muted">{t('No metrics yet.')}</p>; return <dl className="metrics">{Object.entries(metrics).filter(([, value]) => value !== undefined).map(([key, value]) => <div key={key}><dt>{localizeHumanized(key)}</dt><dd>{typeof value === 'number' ? (/latency|duration|gap/i.test(key) ? formatDuration(value) : formatNumber(value)) : String(value)}</dd></div>)}</dl>; }

function Replay({ runs, replay, remoteSessions, active, trusted }: { runs: LocalRun[]; replay?: ReplaySnapshot; remoteSessions?: RemoteSessionReference[]; active: boolean; trusted: boolean }): React.JSX.Element {
  const [speed, setSpeed] = useState<ReplaySnapshot['speed']>(replay?.speed ?? 1); useEffect(() => { if (replay) setSpeed(replay.speed); }, [replay?.speed]);
  const playing = replay?.status === 'playing'; const paused = replay?.status === 'paused'; const loaded = Boolean(replay?.runId) && (playing || paused || replay?.status === 'stopped'); const progress = replay?.total ? Math.round((replay.index / replay.total) * 100) : 0;
  const changeSpeed = (value: ReplaySnapshot['speed']) => { setSpeed(value); if (replay?.runId) post({ type: 'run.replay.speed', speed: value }); };
  return <div className="content-page replay-page"><header className="page-heading"><div><h2>{t('Recorded runs')}</h2><p>{t('Replay raw events through the same mapping and reducer pipeline.')}</p></div></header>{remoteSessions && remoteSessions.length > 0 && <section className="remote-sessions" aria-labelledby="remote-sessions-heading"><div className="section-heading"><div><h3 id="remote-sessions-heading">{t('Remote session references')}</h3><p>{t('Reference-only history keeps metadata locally; applying one does not fetch or expose remote messages.')}</p></div></div><ul>{remoteSessions.map((session) => <li key={session.conversationId}><div><strong>{session.title}</strong><span><code>{session.conversationId}</code> · {session.actorId ?? t('No actor')} · {session.environmentId ?? t('No environment')} · <time dateTime={dateTimeAttribute(session.createdAt)}>{formatDateTime(session.createdAt)}</time></span></div><button disabled={active} onClick={() => post({ type: 'history.remote.apply', conversationId: session.conversationId })}>{t('Apply')}</button></li>)}</ul></section>}<section className="replay-deck" aria-label={t('Replay controls')}><div className="transport-controls"><button disabled={!playing} onClick={() => post({ type: 'run.replay.pause' })}>{t('Pause')}</button><button className="primary" disabled={!paused} onClick={() => post({ type: 'run.replay.resume' })}>{t('Resume')}</button><button disabled={!loaded} onClick={() => post({ type: 'run.replay.stop' })}>{t('Stop')}</button><button disabled={!paused} onClick={() => post({ type: 'run.replay.step' })}>{t('Step')}</button></div><label>{t('Playback speed')}<select value={speed} onChange={(event) => changeSpeed(Number(event.target.value) as ReplaySnapshot['speed'])}>{[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{formatNumber(value)}×</option>)}</select></label><div className="replay-progress"><div><strong>{replay ? localizeHumanized(replay.status) : t('Ready')}</strong><span>{replay ? t('{current} / {total} events', { current: formatNumber(replay.index), total: formatNumber(replay.total) }) : t('Select a run to begin')}</span></div><progress value={progress} max={100} aria-label={t('Replay progress')}>{progress}%</progress></div></section>{runs.length ? <ul className="run-list">{runs.map((run) => <li className={replay?.runId === run.id ? 'active-run' : ''} key={run.id}><div><strong>{formatDateTime(run.createdAt)}</strong><span>{localizeHumanized(run.result.type)} · {t('{count} events', { count: formatNumber(run.metrics.eventCount) })} · {formatDuration(run.metrics.totalDuration ?? 0)}</span></div><div className="actions"><button className="primary" disabled={playing && replay?.runId === run.id} onClick={() => post({ type: 'run.replay.play', runId: run.id, speed })}>{t(replay?.runId === run.id && playing ? 'Playing' : 'Play')}</button><button disabled={!trusted} onClick={() => post({ type: 'run.export', runId: run.id })}>{t('Export')}</button></div></li>)}</ul> : <div className="empty-state"><strong>{t('No recorded runs')}</strong><p>{t('Completed, failed, and aborted turns appear here.')}</p></div>}</div>;
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

export function clampSplit(value: number): number { return Math.min(90, Math.max(10, Number.isFinite(value) ? value : DEFAULT_SPLIT_PERCENT)); }
export function rawSequencesForMessage(message?: ChatMessage): number[] {
  return Array.isArray(message?.metadata?.rawSequences)
    ? message.metadata.rawSequences.filter((value): value is number => typeof value === 'number')
    : [];
}

function terminalAnnouncement(state?: string): string { if (state === 'completed') return t('Response completed'); if (state === 'failed') return t('Response failed'); if (state === 'aborted') return t('Response stopped'); return ''; }
if (rootElement) createRoot(rootElement).render(<App />);
