import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage, MappingTestResult, WebviewPayload, WorkspaceSection } from '../shared/protocol';
import { isWorkspaceSection, PROTOCOL_VERSION } from '../shared/protocol';
import type { ChatMessage, LocalRun, RawStreamEvent, RemoteSessionReference, ReplaySnapshot, SessionSnapshot, TurnStageProfile } from '../shared/types';
import { mappingDraftFromRawEvent } from './configEditors';
import { IconButton } from './Icon';
import { MobileChatPreview } from './MobileChatPreview';
import { SettingsWorkspace } from './SettingsWorkspace';
import { formatDateTime, formatDuration, formatNumber, localizeHumanized, setLocale, t } from './i18n';
import './styles.css';

declare function acquireVsCodeApi<T = unknown>(): { postMessage(message: unknown): void; getState(): T | undefined; setState(state: T): void };
interface WebviewState { section?: WorkspaceSection; draft?: string; inspectorTab?: InspectorTab; splitPercent?: number; selectedMessageId?: string; selectedRawSequence?: number }
const vscode = acquireVsCodeApi<WebviewState>();
const savedState = vscode.getState();
const rootElement = document.getElementById('root')!; const instanceId = rootElement.dataset.instanceId!;
const inspectorTabs = ['Request', 'Raw Events', 'Normalized', 'Metrics', 'Errors', 'Runs'] as const; type InspectorTab = typeof inspectorTabs[number];

function post(message: WebviewPayload): void { vscode.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, editorInstanceId: instanceId, requestId: crypto.randomUUID() }); }

function App(): React.JSX.Element {
  const [section, setSection] = useState<WorkspaceSection>(isWorkspaceSection(savedState?.section) ? savedState.section : 'test'); const [inspectorTab, setInspectorTab] = useState<InspectorTab>(savedState?.inspectorTab ?? 'Raw Events'); const [draft, setDraft] = useState(savedState?.draft ?? ''); const [splitPercent, setSplitPercent] = useState(clampSplit(savedState?.splitPercent ?? 50)); const [selectedMessageId, setSelectedMessageId] = useState(savedState?.selectedMessageId); const [selectedRawSequence, setSelectedRawSequence] = useState(savedState?.selectedRawSequence);
  const [profile, setProfile] = useState<TurnStageProfile>(); const [snapshot, setSnapshot] = useState<SessionSnapshot>(); const [runs, setRuns] = useState<LocalRun[]>([]); const [requestPreview, setRequestPreview] = useState<unknown>(); const [diagnostics, setDiagnostics] = useState<Array<{ severity: string; message: string }>>([]); const [notice, setNotice] = useState(''); const [mappingTestResult, setMappingTestResult] = useState<MappingTestResult>(); const [remoteName, setRemoteName] = useState<string>(); const [, setLocaleVersion] = useState(0);
  useEffect(() => { const listener = (event: MessageEvent<HostMessage>) => { const message = event.data; if (message.protocolVersion !== 1 || message.editorInstanceId !== instanceId) return; if (message.type === 'host.ready') { setLocale(message.locale, message.direction); setLocaleVersion((current) => current + 1); setRemoteName(message.remoteName); } else if (message.type === 'workspace.section') { setSection(message.section); requestAnimationFrame(() => document.getElementById('main-panel')?.focus()); } else if (message.type === 'profile.snapshot') setProfile(message.profile); else if (message.type === 'profile.validation') setDiagnostics(message.diagnostics); else if (message.type === 'session.snapshot') { setSnapshot(message.snapshot); setRuns(message.runs); setRequestPreview(message.requestPreview); } else if (message.type === 'mapping.test.result') setMappingTestResult(message.result); else if (message.type === 'request.error') setNotice(message.error.message); else if (message.type === 'run.exported') setNotice(t('Run exported to {path}', { path: message.path })); else if (message.type === 'workspaceTrust.changed') setSnapshot((current) => current ? { ...current, trusted: message.trusted } : current); }; window.addEventListener('message', listener); post({ type: 'webview.ready' }); return () => window.removeEventListener('message', listener); }, []);
  useEffect(() => { vscode.setState({ section, draft, inspectorTab, splitPercent, selectedMessageId, selectedRawSequence }); }, [section, draft, inspectorTab, splitPercent, selectedMessageId, selectedRawSequence]);
  const active = snapshot ? ['submitting', 'waitingStart', 'streaming', 'stopping'].includes(snapshot.turnState) : false;
  const continuationBlocked = snapshot?.turnState === 'failed' && profile?.errorPolicy?.allowContinuation === false;
  const send = (text = draft, interaction: any = { kind: 'manual' }) => { if (!text.trim() || active) return; post({ type: 'request.send', text, interaction }); setDraft(''); };
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
    <header className="editor-toolbar"><div className="editor-title"><h1>{profile.name}</h1><span className="editor-context">{section === 'test' ? t('Test') : localizeHumanized(section)}</span><span className="editor-meta">{profile.environment ?? t('No environment')} · {profile.stream.transport.toUpperCase()} · <Status state={snapshot?.turnState ?? snapshot?.sessionState ?? 'notStarted'} /></span></div><div className="header-actions">{section === 'test' && <IconButton icon="add" label={t('New conversation')} onClick={() => post({ type: 'conversation.new' })} disabled={active || isInteractionLocked(profile, 'newConversation', active)} />}</div></header>
    {snapshot?.trusted === false && <div className="trust-banner" role="status"><strong>{t('Restricted mode.')}</strong> {t('This workspace is not trusted. Network requests are disabled; fixture replay remains available.')}</div>}
    {diagnostics.length > 0 && <div className="validation-banner" role="alert"><strong>{t(diagnostics.length === 1 ? '{count} configuration issue.' : '{count} configuration issues.', { count: formatNumber(diagnostics.length) })}</strong> {t('Requests are blocked until errors are fixed.')} <button className="link-button" disabled={isInteractionLocked(profile, 'configuration.open', active)} onClick={() => post({ type: 'profile.openAsText' })}>{t('Open as Text')}</button></div>}
    <section id="main-panel" tabIndex={-1} className="panel" aria-label={section === 'test' ? t('Test') : t('{section} settings', { section: localizeHumanized(section) })}>
      {section === 'test' && <TestWorkspace profile={profile} snapshot={snapshot} runs={runs} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} requestPreview={requestPreview} splitPercent={splitPercent} setSplitPercent={setSplitPercent} selectedMessageId={selectedMessageId} selectedRawSequence={selectedRawSequence} onSelectMessage={selectMessage} onSelectEvent={selectEvent} onCreateMapping={(event) => { post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, mappingDraftFromRawEvent(event, profile)] }); setNotice(t('Created mapping draft from raw event #{sequence}.', { sequence: formatNumber(event.sequence) })); }} />}
      {section !== 'test' && <SettingsWorkspace section={section} profile={profile} snapshot={snapshot} requestPreview={requestPreview} remoteName={remoteName} mappingTestResult={mappingTestResult} post={post} />}
    </section>
    <div className="sr-status" role="status" aria-live="polite">{notice || terminalAnnouncement(snapshot?.turnState)}</div>
  </main>;
}

function TestWorkspace({ profile, snapshot, runs, active, continuationBlocked, draft, setDraft, send, inspectorTab, setInspectorTab, requestPreview, splitPercent, setSplitPercent, selectedMessageId, selectedRawSequence, onSelectMessage, onSelectEvent, onCreateMapping }: {
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
  selectedMessageId?: string;
  selectedRawSequence?: number;
  onSelectMessage: (messageId: string) => void;
  onSelectEvent: (event: Record<string, unknown>) => void;
  onCreateMapping: (event: RawStreamEvent) => void;
}): React.JSX.Element {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeFromClientX = (clientX: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplitPercent(clampSplit(((clientX - rect.left) / rect.width) * 100));
  };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => resizeFromClientX(moveEvent.clientX);
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  return <div ref={workspaceRef} className="test-workspace" style={{ '--preview-percent': `${splitPercent}%` } as React.CSSProperties}>
    <section className="preview-pane" aria-label={t('Mobile chat preview')}>
      <MobileChatPreview profile={profile} snapshot={snapshot} active={active} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} post={post} selectedMessageId={selectedMessageId} onSelectMessage={onSelectMessage} />
    </section>
    <div className="splitter" role="separator" aria-label={t('Resize chat preview and debug panels')} aria-orientation="vertical" aria-valuemin={35} aria-valuemax={65} aria-valuenow={Math.round(splitPercent)} tabIndex={0} onPointerDown={beginResize} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSplitPercent(clampSplit(splitPercent + (event.key === 'ArrowLeft' ? -2 : 2))); } else if (event.key === 'Home') { event.preventDefault(); setSplitPercent(35); } else if (event.key === 'End') { event.preventDefault(); setSplitPercent(65); } }}><span aria-hidden="true" /></div>
    <aside className="debug-pane" aria-label={t('Debug and stream information')}>
      <header className="debug-heading"><strong>{t('Debug').toLocaleUpperCase()}</strong><span>{t('{count} raw events', { count: formatNumber(snapshot?.rawEvents.length ?? 0) })}</span></header>
      <Inspector profile={profile} snapshot={snapshot} runs={runs} active={active} tab={inspectorTab} setTab={setInspectorTab} requestPreview={requestPreview} interactive={!isInteractionLocked(profile, 'inspector.open', active)} onCreateMapping={onCreateMapping} selectedSequence={selectedRawSequence} onSelectEvent={onSelectEvent} />
    </aside>
  </div>;
}

function Status({ state }: { state: string }): React.JSX.Element { return <span className={`status status-${state}`}><span aria-hidden="true">●</span> {localizeHumanized(state)}</span>; }

function JsonBlock({ value }: { value: unknown }): React.JSX.Element { return <pre className="json"><code>{JSON.stringify(value, null, 2)}</code><IconButton icon="copy" label={t('Copy JSON')} onClick={() => navigator.clipboard.writeText(JSON.stringify(value, null, 2))} /></pre>; }

function Inspector({ profile, snapshot, runs = [], active = false, tab, setTab, requestPreview, full = false, interactive = true, onCreateMapping, selectedSequence, onSelectEvent }: { profile?: TurnStageProfile; snapshot?: SessionSnapshot; runs?: LocalRun[]; active?: boolean; tab: InspectorTab; setTab: (tab: InspectorTab) => void; requestPreview: unknown; full?: boolean; interactive?: boolean; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
  const availableTabs: InspectorTab[] = profile && !componentVisible(profile, 'metrics') ? inspectorTabs.filter((item): item is InspectorTab => item !== 'Metrics') : [...inspectorTabs];
  const effectiveTab = availableTabs.includes(tab) ? tab : availableTabs[0]!;
  const data = effectiveTab === 'Raw Events' ? snapshot?.rawEvents ?? [] : effectiveTab === 'Normalized' ? snapshot?.normalizedEvents ?? [] : [];
  const [query, setQuery] = useState(''); const [eventType, setEventType] = useState('all');
  const types = useMemo(() => [...new Set(data.map((item) => eventLabel(item)))].sort(), [data]);
  const filtered = useMemo(() => data.filter((item) => (eventType === 'all' || eventLabel(item) === eventType) && (!query.trim() || JSON.stringify(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [data, eventType, query]);
  return <div className={`inspector-content ${full ? 'full' : ''}`}>
    <div className="mini-tabs" role="tablist" aria-label={t('Inspector views')}>{availableTabs.map((item) => <button key={item} role="tab" aria-selected={effectiveTab === item} tabIndex={effectiveTab === item ? 0 : -1} disabled={!interactive} onClick={() => setTab(item)}>{t(item)}</button>)}</div>
    {snapshot?.droppedEventCount ? <p className="warning">{t('{count} old events were dropped due to buffer limits.', { count: formatNumber(snapshot.droppedEventCount) })}</p> : null}
    {effectiveTab === 'Request' && <JsonBlock value={requestPreview ?? { message: t('Build a request to see its redacted preview.') }} />}
    {(effectiveTab === 'Raw Events' || effectiveTab === 'Normalized') && <div className="event-inspector">
      <div className="event-filters">
        <label><span className="sr-only">{t('Search events')}</span><input type="search" value={query} placeholder={t('Search events')} aria-label={t('Search events')} disabled={!interactive} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span className="sr-only">{t('Event type')}</span><select value={eventType} aria-label={t('Event type')} onChange={(event) => setEventType(event.target.value)} disabled={!interactive}><option value="all">{t('All types')}</option>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <span role="status">{t('{filtered} of {total}', { filtered: formatNumber(filtered.length), total: formatNumber(data.length) })}</span>
      </div>
      <VirtualEvents items={filtered} onCreateMapping={effectiveTab === 'Raw Events' && interactive ? onCreateMapping : undefined} selectedSequence={selectedSequence} onSelectEvent={onSelectEvent} />
    </div>}
    {effectiveTab === 'Metrics' && <MetricGrid metrics={snapshot?.metrics} />}
    {effectiveTab === 'Errors' && <div className="error-list">{snapshot?.errors.length ? snapshot.errors.map((error, index) => <details key={`${error.type}-${index}`}><summary>{error.type}</summary><p>{error.message}</p><JsonBlock value={error} /></details>) : <p className="muted">{t('No runtime errors.')}</p>}</div>}
    {effectiveTab === 'Runs' && <Replay runs={runs} replay={snapshot?.replay} remoteSessions={snapshot?.remoteSessions} active={active} />}
  </div>;
}

function VirtualEvents({ items, onCreateMapping, selectedSequence, onSelectEvent }: { items: Array<Record<string, any>>; onCreateMapping?: (event: RawStreamEvent) => void; selectedSequence?: number; onSelectEvent?: (event: Record<string, unknown>) => void }): React.JSX.Element {
  const rowHeight = 30;
  const listRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(480);
  const screenReader = document.body.classList.contains('vscode-using-screen-reader');
  const selectedItem = items.find((item) => eventSequence(item) === selectedSequence);
  const start = Math.max(0, Math.floor(top / rowHeight) - 4);
  const visible = screenReader ? items : items.slice(start, start + Math.ceil(height / rowHeight) + 8);
  const visibleStart = screenReader ? 0 : start;

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
    const selectedIndex = items.findIndex((item) => eventSequence(item) === selectedSequence);
    if (selectedIndex < 0) return;
    const nextTop = Math.max(0, selectedIndex * rowHeight - rowHeight * 2);
    listRef.current?.scrollTo({ top: nextTop });
    setTop(nextTop);
  }, [items, selectedSequence]);

  return <div className={`event-browser ${selectedItem ? 'event-browser--detail' : ''}`}>
    <div ref={listRef} className="virtual-list" role="listbox" aria-label={t('Inspector views')} onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      {!items.length ? <div className="empty-state compact"><strong>{t('No matching events')}</strong></div> : <div className="virtual-space" style={{ height: screenReader ? 'auto' : items.length * rowHeight }}><div style={{ transform: screenReader ? undefined : `translateY(${visibleStart * rowHeight}px)` }}>{visible.map((item, index) => {
        const itemSequence = eventSequence(item);
        const selected = itemSequence === selectedSequence;
        return <button type="button" role="option" aria-selected={selected} className={`event-row ${selected ? 'selected' : ''}`} key={`${item.sequence}-${eventLabel(item)}-${index}`} onClick={() => onSelectEvent?.(item)}>
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

function Replay({ runs, replay, remoteSessions, active }: { runs: LocalRun[]; replay?: ReplaySnapshot; remoteSessions?: RemoteSessionReference[]; active: boolean }): React.JSX.Element {
  const [speed, setSpeed] = useState<ReplaySnapshot['speed']>(replay?.speed ?? 1); useEffect(() => { if (replay) setSpeed(replay.speed); }, [replay?.speed]);
  const playing = replay?.status === 'playing'; const paused = replay?.status === 'paused'; const loaded = Boolean(replay?.runId) && (playing || paused || replay?.status === 'stopped'); const progress = replay?.total ? Math.round((replay.index / replay.total) * 100) : 0;
  const changeSpeed = (value: ReplaySnapshot['speed']) => { setSpeed(value); if (replay?.runId) post({ type: 'run.replay.speed', speed: value }); };
  return <div className="content-page replay-page"><header className="page-heading"><div><h2>{t('Recorded runs')}</h2><p>{t('Replay raw events through the same mapping and reducer pipeline.')}</p></div></header>{remoteSessions && remoteSessions.length > 0 && <section className="remote-sessions" aria-labelledby="remote-sessions-heading"><div className="section-heading"><div><h3 id="remote-sessions-heading">{t('Remote session references')}</h3><p>{t('Reference-only history keeps metadata locally; applying one does not fetch or expose remote messages.')}</p></div></div><ul>{remoteSessions.map((session) => <li key={session.conversationId}><div><strong>{session.title}</strong><span><code>{session.conversationId}</code> · {session.actorId ?? t('No actor')} · {session.environmentId ?? t('No environment')} · <time dateTime={new Date(session.createdAt).toISOString()}>{formatDateTime(session.createdAt)}</time></span></div><button disabled={active} onClick={() => post({ type: 'history.remote.apply', conversationId: session.conversationId })}>{t('Apply')}</button></li>)}</ul></section>}<section className="replay-deck" aria-label={t('Replay controls')}><div className="transport-controls"><button disabled={!playing} onClick={() => post({ type: 'run.replay.pause' })}>{t('Pause')}</button><button className="primary" disabled={!paused} onClick={() => post({ type: 'run.replay.resume' })}>{t('Resume')}</button><button disabled={!loaded} onClick={() => post({ type: 'run.replay.stop' })}>{t('Stop')}</button><button disabled={!paused} onClick={() => post({ type: 'run.replay.step' })}>{t('Step')}</button></div><label>{t('Playback speed')}<select value={speed} onChange={(event) => changeSpeed(Number(event.target.value) as ReplaySnapshot['speed'])}>{[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{formatNumber(value)}×</option>)}</select></label><div className="replay-progress"><div><strong>{replay ? localizeHumanized(replay.status) : t('Ready')}</strong><span>{replay ? t('{current} / {total} events', { current: formatNumber(replay.index), total: formatNumber(replay.total) }) : t('Select a run to begin')}</span></div><progress value={progress} max={100} aria-label={t('Replay progress')}>{progress}%</progress></div></section>{runs.length ? <ul className="run-list">{runs.map((run) => <li className={replay?.runId === run.id ? 'active-run' : ''} key={run.id}><div><strong>{formatDateTime(run.createdAt)}</strong><span>{localizeHumanized(run.result.type)} · {t('{count} events', { count: formatNumber(run.metrics.eventCount) })} · {formatDuration(run.metrics.totalDuration ?? 0)}</span></div><div className="actions"><button className="primary" disabled={playing && replay?.runId === run.id} onClick={() => post({ type: 'run.replay.play', runId: run.id, speed })}>{t(replay?.runId === run.id && playing ? 'Playing' : 'Play')}</button><button onClick={() => post({ type: 'run.export', runId: run.id })}>{t('Export')}</button></div></li>)}</ul> : <div className="empty-state"><strong>{t('No recorded runs')}</strong><p>{t('Completed, failed, and aborted turns appear here.')}</p></div>}</div>;
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

export function clampSplit(value: number): number { return Math.min(65, Math.max(35, Number.isFinite(value) ? value : 50)); }
export function rawSequencesForMessage(message?: ChatMessage): number[] {
  return Array.isArray(message?.metadata?.rawSequences)
    ? message.metadata.rawSequences.filter((value): value is number => typeof value === 'number')
    : [];
}

function terminalAnnouncement(state?: string): string { if (state === 'completed') return t('Response completed'); if (state === 'failed') return t('Response failed'); if (state === 'aborted') return t('Response stopped'); return ''; }
createRoot(rootElement).render(<App />);
