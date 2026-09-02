import React, { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AdversarialCaseCatalog, LinkedAdversarialCaseSummary, MappingTestResult, TestOperationSnapshot, WebviewPayload } from '../shared/protocol';
import type { AdversarialForbidDefinition, AdversarialResultSummary, CampaignDashboardV1, ConnectionDoctorSummary, QualityRubricDefinition, ScenarioAssertionDefinition, ScenarioAssertionOperator, ScenarioDefinition, ScenarioPerformanceMetric, ScenarioReportFormat, ScenarioStepDefinition, SessionSnapshot, TestCampaignDefinition, TurnStageProfile } from '../shared/types';
import { EventsEditor, FlowEditor, UiConfigEditor } from './configEditors';
import { IconButton, ProductIcon } from './Icon';
import { ClipboardButton } from './ClipboardButton';
import { formatDuration, formatNumber, localizeHumanized, t } from './i18n';
import './settingsWorkspace.css';

/**
 * Keep this callback local to the workspace so it can also be used by hosts
 * that add the protocol envelope outside of the React tree.
 */
export type SettingsWorkspacePost = (message: WebviewPayload) => void;

export type AdversarialCaseModeFilter = 'all' | 'singleTurn' | 'multiTurn';
export type AdversarialCaseSort = 'sourceOrder' | 'name' | 'mode';
export interface AdversarialCaseCollectionState {
  query: string;
  mode: AdversarialCaseModeFilter;
  source: string;
  tag: string;
  sort: AdversarialCaseSort;
  page: number;
  pageSize: 25 | 50 | 100;
}
export const DEFAULT_ADVERSARIAL_CASE_COLLECTION: AdversarialCaseCollectionState = { query: '', mode: 'all', source: 'all', tag: 'all', sort: 'sourceOrder', page: 0, pageSize: 25 };

export const RED_TEAM_SECTIONS = ['results', 'cases', 'campaigns', 'timeline'] as const;
export type RedTeamSectionId = typeof RED_TEAM_SECTIONS[number];
export type AdversarialResultOutcomeFilter = 'all' | AdversarialResultSummary['outcome'];
export type AdversarialResultStabilityFilter = 'all' | 'stable-pass' | 'stable-fail' | 'unstable' | 'inconclusive' | 'single-run';
export interface AdversarialResultCollectionState {
  query: string;
  outcome: AdversarialResultOutcomeFilter;
  stability: AdversarialResultStabilityFilter;
  attentionOnly?: boolean;
  page: number;
  pageSize: 25 | 50 | 100;
}
export const DEFAULT_ADVERSARIAL_RESULT_COLLECTION: AdversarialResultCollectionState = { query: '', outcome: 'all', stability: 'all', attentionOnly: false, page: 0, pageSize: 25 };

export function normalizeAdversarialResultCollectionState(value: unknown): AdversarialResultCollectionState {
  const candidate = value && typeof value === 'object' ? value as Partial<AdversarialResultCollectionState> : {};
  const outcomes: AdversarialResultOutcomeFilter[] = ['all', 'resisted', 'attackSucceeded', 'indeterminate', 'infrastructureError'];
  const stability: AdversarialResultStabilityFilter[] = ['all', 'stable-pass', 'stable-fail', 'unstable', 'inconclusive', 'single-run'];
  return {
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 512) : '',
    outcome: outcomes.includes(candidate.outcome as AdversarialResultOutcomeFilter) ? candidate.outcome as AdversarialResultOutcomeFilter : 'all',
    stability: stability.includes(candidate.stability as AdversarialResultStabilityFilter) ? candidate.stability as AdversarialResultStabilityFilter : 'all',
    attentionOnly: candidate.attentionOnly === true,
    page: Number.isSafeInteger(candidate.page) && Number(candidate.page) >= 0 ? Math.min(19, Number(candidate.page)) : 0,
    pageSize: candidate.pageSize === 50 || candidate.pageSize === 100 ? candidate.pageSize : 25,
  };
}

export function filterAdversarialResults(results: readonly AdversarialResultSummary[], collection: AdversarialResultCollectionState): AdversarialResultSummary[] {
  const query = collection.query.trim().toLocaleLowerCase();
  return results.filter((result) => {
    if (collection.outcome !== 'all' && result.outcome !== collection.outcome) return false;
    const stability = result.repetitions?.stability ?? 'single-run';
    if (collection.stability !== 'all' && stability !== collection.stability) return false;
    if (collection.attentionOnly && result.outcome === 'resisted' && !['unstable', 'inconclusive'].includes(stability) && result.repetitions?.sampleComplete !== false) return false;
    return !query || `${result.scenarioName}\u001f${result.scenarioId}`.toLocaleLowerCase().includes(query);
  });
}

export function normalizeAdversarialCaseCollectionState(value: unknown): AdversarialCaseCollectionState {
  const candidate = value && typeof value === 'object' ? value as Partial<AdversarialCaseCollectionState> : {};
  return {
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 512) : '',
    mode: ['all', 'singleTurn', 'multiTurn'].includes(String(candidate.mode)) ? candidate.mode as AdversarialCaseModeFilter : 'all',
    source: typeof candidate.source === 'string' && candidate.source.length <= 4096 ? candidate.source : 'all',
    tag: typeof candidate.tag === 'string' && candidate.tag.length <= 256 ? candidate.tag : 'all',
    sort: ['sourceOrder', 'name', 'mode'].includes(String(candidate.sort)) ? candidate.sort as AdversarialCaseSort : 'sourceOrder',
    page: Number.isSafeInteger(candidate.page) && Number(candidate.page) >= 0 ? Math.min(399, Number(candidate.page)) : 0,
    pageSize: candidate.pageSize === 50 || candidate.pageSize === 100 ? candidate.pageSize : 25,
  };
}

export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Profile identity and runtime context.' },
  { id: 'opening-flow', label: 'Opening & Flow', description: 'Opening behavior, variants, stop, and recovery.' },
  { id: 'request', label: 'Request', description: 'Endpoint, timing, payload, and redacted preview.' },
  { id: 'stream-mapping', label: 'Stream & Mapping', description: 'Transport, framing, and event mappings.' },
  { id: 'chat-ui', label: 'Chat UI', description: 'Layout, composer, streaming effects, visibility, and interaction locks.' },
  { id: 'scenario-tests', label: 'Scenarios', description: 'Multi-turn inputs, assertions, and contract-test setup.' },
  { id: 'history-errors', label: 'History & Errors', description: 'Local run retention and failure behavior.' },
  { id: 'security', label: 'Security', description: 'Trust, URI schemes, domains, and commands.' }
] as const;

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

export interface SettingsWorkspaceProps {
  profile: TurnStageProfile;
  post: SettingsWorkspacePost;
  mappingTestResult?: MappingTestResult;
  connectionResult?: ConnectionDoctorSummary;
  snapshot?: SessionSnapshot;
  requestPreview?: unknown;
  remoteName?: string;
  testResults?: AdversarialResultSummary[];
  campaignDashboard?: CampaignDashboardV1;
  testOperation?: TestOperationSnapshot;
  profileDirty?: boolean;
  diagnostics?: Array<{ severity: 'error' | 'warning'; message: string; offset: number; length: number }>;
  /** The section selected by the host tree/editor. */
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  /** Use the compact, single-pane layout beside the Chat preview. */
  embedded?: boolean;
  /** Section-scoped scroll checkpoint restored when VS Code recreates the Webview. */
  scrollStateKey?: string;
  scrollTop?: number;
  onScrollTopChange?: (value: number) => void;
}

type PatchPath = Array<string | number>;

function useRestoredScrollPosition(ref: React.RefObject<HTMLDivElement | null>, key: string, scrollTop: number | undefined): void {
  const restoredKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || restoredKey.current === key) return;
    restoredKey.current = key;
    element.scrollTop = typeof scrollTop === 'number' && Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  }, [key, ref, scrollTop]);
}

/** A profile-scoped, single-section settings editor. */
export function SettingsWorkspace({
  profile,
  post,
  mappingTestResult,
  connectionResult,
  snapshot,
  requestPreview,
  remoteName,
  testResults = [],
  campaignDashboard,
  testOperation,
  profileDirty = false,
  diagnostics = [],
  section,
  onSectionChange,
  embedded = false,
  scrollStateKey = section,
  scrollTop,
  onScrollTopChange
}: SettingsWorkspaceProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useRestoredScrollPosition(scrollRef, scrollStateKey, scrollTop);
  const patch = (path: PatchPath, value: unknown) => post({ type: 'profile.patch', path, value });

  const active = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0];
  const sectionTitleId = `profile-configuration-section-title-${active.id}`;
  const sectionDescriptionId = `profile-configuration-section-description-${active.id}`;
  return <div className={`settings-workspace ${embedded ? 'settings-workspace--embedded' : ''}`}>
    <header className={`settings-header ${embedded ? 'settings-header--embedded' : ''}`} aria-label={t('Profile configuration toolbar')}>
      {embedded
        ? <label className="settings-section-picker">
          <span className="sr-only">{t('Profile configuration sections')}</span>
          <select value={active.id} aria-label={t('Profile configuration sections')} onChange={(event) => onSectionChange(event.target.value as SettingsSectionId)}>
            {SETTINGS_SECTIONS.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
          </select>
        </label>
        : <div className="settings-title-block">
          <p id="profile-configuration-title" className="settings-surface-title">{t('Profile Configuration')}</p>
          <p className="settings-subtitle"><span>{profile.name || t('Untitled profile')}</span><span aria-hidden="true">·</span><code>{profile.id}</code><span aria-hidden="true">·</span><span>{profile.environment || t('No environment selected')}</span></p>
        </div>}
      <div className="settings-header-actions" role="group" aria-label={t('Profile configuration actions')}>
        <span className={`profile-edit-status ${profileDirty ? 'is-dirty' : diagnostics.length ? 'has-issues' : ''}`} role="status">{profileDirty ? t('Unsaved changes') : diagnostics.length ? t('{count} issues', { count: formatNumber(diagnostics.length) }) : t('Saved')}</span>
        {diagnostics.length > 0 && <IconButton icon="warning" label={t('Show first issue')} type="button" onClick={() => post({ type: 'profile.openFirstIssue' })} />}
        <IconButton icon="save" label={t('Save Profile')} type="button" disabled={!profileDirty} onClick={() => post({ type: 'profile.save' })} />
        <IconButton icon="file-code" label={t('Open JSONC')} type="button" onClick={() => post({ type: 'profile.openAsText' })} />
        <IconButton icon="check" label={t('Validate')} type="button" className="settings-primary-action" onClick={() => post({ type: 'profile.validate' })} />
      </div>
    </header>

    <div ref={scrollRef} className="settings-main" id="settings-content" onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}>
      <div className="settings-content-layout">
        {!embedded && <nav className="settings-section-nav" aria-label={t('Profile configuration sections')}>
          <div className="settings-section-nav-list">
            {SETTINGS_SECTIONS.map((item) => <button key={item.id} type="button" className={active.id === item.id ? 'is-active' : ''} aria-current={active.id === item.id ? 'page' : undefined} onClick={() => onSectionChange(item.id)}>{t(item.label)}</button>)}
          </div>
        </nav>}
        <section
          id={`settings-panel-${active.id}`}
          className="settings-panel"
          aria-labelledby={sectionTitleId}
          aria-describedby={sectionDescriptionId}
          tabIndex={-1}
        >
          <div className="settings-panel-heading">
            <div className="settings-panel-title">
              <h1 id={sectionTitleId}>{t(active.label)}</h1>
              <p id={sectionDescriptionId} className="settings-section-description">{t(active.description)}</p>
            </div>
            <span className="settings-section-count">{t('Profile')} <code>{profile.id}</code></span>
          </div>
          {active.id === 'general' && <GeneralSection profile={profile} snapshot={snapshot} post={post} patch={patch} />}
          {active.id === 'opening-flow' && <OpeningFlowSection profile={profile} post={post} />}
          {active.id === 'request' && <RequestSection profile={profile} snapshot={snapshot} requestPreview={requestPreview} remoteName={remoteName} connectionResult={connectionResult} post={post} patch={patch} />}
          {active.id === 'stream-mapping' && <StreamMappingSection profile={profile} snapshot={snapshot} mappingTestResult={mappingTestResult} post={post} patch={patch} />}
          {active.id === 'chat-ui' && <ChatUiSection profile={profile} post={post} />}
          {active.id === 'scenario-tests' && <ScenarioTestsSection view="contracts" profile={profile} patch={patch} post={post} testResults={testResults} campaignDashboard={campaignDashboard} testOperation={testOperation} />}
          {active.id === 'history-errors' && <HistoryErrorsSection profile={profile} snapshot={snapshot} patch={patch} />}
          {active.id === 'security' && <SecuritySection profile={profile} snapshot={snapshot} remoteName={remoteName} patch={patch} />}
        </section>
      </div>
    </div>
  </div>;
}

export function AdversarialWorkspace({ profile, post, testResults = [], campaignDashboard, testOperation, activeEvidenceId, timeline, trusted = false, scrollTop, onScrollTopChange, activeSection = 'results', onActiveSectionChange = () => undefined, selectedCampaignId, onSelectedCampaignIdChange, expandedCaseId, onExpandedCaseIdChange, linkedCaseCatalog, caseCollection = DEFAULT_ADVERSARIAL_CASE_COLLECTION, onCaseCollectionChange = () => undefined, resultCollection = DEFAULT_ADVERSARIAL_RESULT_COLLECTION, onResultCollectionChange = () => undefined }: {
  profile: TurnStageProfile;
  post: SettingsWorkspacePost;
  testResults?: AdversarialResultSummary[];
  campaignDashboard?: CampaignDashboardV1;
  testOperation?: TestOperationSnapshot;
  activeEvidenceId?: string;
  timeline?: React.ReactNode;
  trusted?: boolean;
  scrollTop?: number;
  onScrollTopChange?: (value: number) => void;
  activeSection?: RedTeamSectionId;
  onActiveSectionChange?: (section: RedTeamSectionId) => void;
  selectedCampaignId?: string;
  onSelectedCampaignIdChange?: (id: string | undefined) => void;
  expandedCaseId?: string;
  onExpandedCaseIdChange?: (id: string | undefined) => void;
  linkedCaseCatalog?: AdversarialCaseCatalog;
  caseCollection?: AdversarialCaseCollectionState;
  onCaseCollectionChange?: (state: AdversarialCaseCollectionState) => void;
  resultCollection?: AdversarialResultCollectionState;
  onResultCollectionChange?: (state: AdversarialResultCollectionState) => void;
}): React.JSX.Element {
  const patch = (path: PatchPath, value: unknown) => post({ type: 'profile.patch', path, value });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inlineCaseCount = profile.tests?.scenarios?.filter((scenario) => scenario.adversarial).length ?? 0;
  const campaignCount = profile.tests?.campaigns?.length ?? 0;
  const suiteSignature = (profile.tests?.adversarialSuites ?? []).join('\u001f');
  useRestoredScrollPosition(scrollRef, 'adversarial', scrollTop);
  useEffect(() => { post({ type: 'adversarial.catalog.request' }); }, [post, suiteSignature]);
  const selectSection = (section: RedTeamSectionId) => {
    onActiveSectionChange(section);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    requestAnimationFrame(() => document.getElementById(`red-team-${section}`)?.focus());
  };
  const handleSectionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, section: RedTeamSectionId) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = RED_TEAM_SECTIONS.indexOf(section);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? RED_TEAM_SECTIONS.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + RED_TEAM_SECTIONS.length) % RED_TEAM_SECTIONS.length;
    const nextSection = RED_TEAM_SECTIONS[nextIndex]!;
    selectSection(nextSection);
    requestAnimationFrame(() => document.getElementById(`red-team-${nextSection}-tab`)?.focus());
  };
  return <div className="settings-workspace settings-workspace--embedded red-team-workspace">
    <header className="settings-header settings-header--embedded" aria-label={t('Red Team toolbar')}>
      <div className="red-team-title"><strong>{t('Red Team')}</strong><span>{t('Bounded adversarial cases, results, and causal evidence.')}</span></div>
      <div className="settings-header-actions" role="group" aria-label={t('Red Team actions')}>
        <IconButton icon="file-code" label={t('Open JSONC')} type="button" onClick={() => post({ type: 'profile.openAsText' })} />
        <IconButton icon="check" label={t('Validate')} type="button" className="settings-primary-action" onClick={() => post({ type: 'profile.validate' })} />
      </div>
    </header>
    <div ref={scrollRef} className="settings-main" onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}>
      <section className="settings-panel red-team-panel" aria-labelledby="red-team-panel-title" tabIndex={-1}>
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><h1 id="red-team-panel-title">{t('Adversarial testing')}</h1><p className="settings-section-description">{t('Author known attacks, run bounded samples, and inspect causal evidence without changing formal outcomes.')}</p></div>
          <span className="settings-section-count">{t('{count} inline cases', { count: formatNumber(inlineCaseCount) })}</span>
        </div>
        <nav className="red-team-section-nav" aria-label={t('Red Team sections')} role="tablist">
          <button id="red-team-results-tab" type="button" role="tab" tabIndex={activeSection === 'results' ? 0 : -1} aria-controls="red-team-results" aria-label={`${t('Results')}: ${formatNumber(testResults.length)}`} aria-selected={activeSection === 'results'} onClick={() => selectSection('results')} onKeyDown={(event) => handleSectionKeyDown(event, 'results')}><span>{t('Results')}</span><strong>{formatNumber(testResults.length)}</strong></button>
          <button id="red-team-cases-tab" type="button" role="tab" tabIndex={activeSection === 'cases' ? 0 : -1} aria-controls="red-team-cases" aria-label={`${t('Cases')}: ${formatNumber(inlineCaseCount)}`} aria-selected={activeSection === 'cases'} onClick={() => selectSection('cases')} onKeyDown={(event) => handleSectionKeyDown(event, 'cases')}><span>{t('Cases')}</span><strong>{formatNumber(inlineCaseCount)}</strong></button>
          <button id="red-team-campaigns-tab" type="button" role="tab" tabIndex={activeSection === 'campaigns' ? 0 : -1} aria-controls="red-team-campaigns" aria-label={`${t('Campaigns')}: ${formatNumber(campaignCount)}`} aria-selected={activeSection === 'campaigns'} onClick={() => selectSection('campaigns')} onKeyDown={(event) => handleSectionKeyDown(event, 'campaigns')}><span>{t('Campaigns')}</span><strong>{formatNumber(campaignCount)}</strong></button>
          <button id="red-team-timeline-tab" type="button" role="tab" tabIndex={activeSection === 'timeline' ? 0 : -1} aria-controls="red-team-timeline" aria-label={`${t('Timeline')}: ${activeEvidenceId ? t('Selected') : '—'}`} aria-selected={activeSection === 'timeline'} onClick={() => selectSection('timeline')} onKeyDown={(event) => handleSectionKeyDown(event, 'timeline')}><span>{t('Timeline')}</span><strong>{activeEvidenceId ? t('Selected') : '—'}</strong></button>
        </nav>
        <ScenarioTestsSection view="adversarial" adversarialSection={activeSection} onAdversarialSectionChange={selectSection} profile={profile} patch={patch} post={post} testResults={testResults} campaignDashboard={campaignDashboard} testOperation={testOperation} activeEvidenceId={activeEvidenceId} timeline={timeline} trusted={trusted} selectedCampaignId={selectedCampaignId} onSelectedCampaignIdChange={onSelectedCampaignIdChange} expandedCaseId={expandedCaseId} onExpandedCaseIdChange={onExpandedCaseIdChange} linkedCaseCatalog={linkedCaseCatalog} caseCollection={caseCollection} onCaseCollectionChange={onCaseCollectionChange} resultCollection={resultCollection} onResultCollectionChange={onResultCollectionChange} />
      </section>
    </div>
  </div>;
}

function GeneralSection({ profile, snapshot, post, patch }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; post: SettingsWorkspacePost; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const controls = profile.controls ?? [];
  return <div className="settings-section-stack">
    <section className="settings-card" aria-labelledby="general-profile-heading">
      <SectionHeading id="general-profile-heading" title={t('Profile details')} description={t('These values identify the profile in the tree view and in request context.')} />
      <div className="settings-form-grid">
        <SettingField label={t('Display name')} id="settings-profile-name" hint={t('Shown at the top of this profile configuration.')}>
          <PatchInput id="settings-profile-name" value={profile.name} onCommit={(value) => patch(['name'], value)} required autoComplete="off" />
        </SettingField>
        <SettingField label={t('Profile ID')} id="settings-profile-id" hint={t('The ID is stable and is used for local run storage.')}>
          <input id="settings-profile-id" value={profile.id} readOnly aria-readonly="true" />
        </SettingField>
        <SettingField label={t('Description')} id="settings-profile-description" hint={t('Optional context for teammates and future runs.')} wide>
          <PatchInput id="settings-profile-description" value={profile.description ?? ''} onCommit={(value) => patch(['description'], value || undefined)} multiline rows={3} />
        </SettingField>
        <SettingField label={t('Environment ID')} id="settings-profile-environment" hint={t('The environment is resolved by the Extension Host when a run starts.')}>
          <PatchInput id="settings-profile-environment" value={profile.environment ?? ''} onCommit={(value) => patch(['environment'], value || undefined)} autoComplete="off" placeholder="local" />
        </SettingField>
        <SettingField label={t('Schema version')} id="settings-profile-version" hint={t('Schema migrations are handled by TurnStage.')}>
          <input id="settings-profile-version" value={String(profile.version)} readOnly aria-readonly="true" />
        </SettingField>
      </div>
    </section>

    <section className="settings-card" aria-labelledby="general-context-heading">
      <SectionHeading id="general-context-heading" title={t('Runtime context')} description={t('Read-only values help you confirm which host and session the profile is using.')} />
      <div className="settings-status-grid">
        <StatusItem label={t('Session')} value={snapshot?.sessionState ? localizeHumanized(snapshot.sessionState) : t('Not started')} />
        <StatusItem label={t('Turn')} value={snapshot?.turnState ? localizeHumanized(snapshot.turnState) : t('Idle')} />
        <StatusItem label={t('Workspace')} value={t(snapshot?.trusted === false ? 'Restricted' : 'Trusted')} tone={snapshot?.trusted === false ? 'warning' : 'default'} />
        <StatusItem label={t('Remote host')} value={t(snapshot ? 'Connected' : 'Waiting for host')} />
      </div>
      {controls.length > 0 ? <div className="settings-controls-summary">
        <div><strong>{t('Configured controls')}</strong><span>{formatNumber(controls.length)}</span></div>
        <ul>{controls.map((control) => <li key={control.id}><span>{control.label}</span><code>{control.id}</code></li>)}</ul>
      </div> : <p className="settings-muted">{t('This profile does not define any custom controls.')}</p>}
    </section>
    <p className="settings-footnote">{t('Changes are applied as structured JSONC edits and remain available through VS Code Undo/Redo.')}</p>
    <button type="button" className="settings-inline-action" onClick={() => post({ type: 'profile.openAsText' })}>{t('Review the full JSONC document')}</button>
  </div>;
}

function OpeningFlowSection({ profile, post }: { profile: TurnStageProfile; post: SettingsWorkspacePost }): React.JSX.Element {
  return <div className="settings-editor-frame">
    <div className="settings-editor-note"><strong>{t('Flow editor')}</strong></div>
    <FlowEditor profile={profile} post={post} />
  </div>;
}

function RequestSection({ profile, snapshot, requestPreview, remoteName, connectionResult, post, patch }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; requestPreview?: unknown; remoteName?: string; connectionResult?: ConnectionDoctorSummary; post: SettingsWorkspacePost; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const request = profile.conversation.send;
  const preview = isRecord(requestPreview) ? requestPreview : undefined;
  const previewUrl = typeof preview?.url === 'string' ? preview.url : request.url;
  const loopback = isLoopbackUrl(previewUrl);
  return <div className="settings-section-stack">
    <section className="settings-card connection-doctor" aria-labelledby="connection-doctor-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="connection-doctor-heading">{t('Connection Doctor')}</h2><p className="settings-card-description">{t('Analyze the latest bounded HTTP, stream, mapping, timing, and terminal evidence. Response content and secrets are never copied into the result.')}</p></div><button type="button" disabled={!snapshot} onClick={() => post({ type: 'connection.analyze' })}>{t('Analyze latest response')}</button></div>
      {!connectionResult ? <p className="settings-empty">{t(snapshot ? 'Run a request, then analyze its latest connection evidence.' : 'Start the profile before analyzing connection evidence.')}</p> : <>
        <div className={`connection-doctor__status connection-doctor__status--${connectionResult.safe ? 'ready' : 'attention'}`} role="status">
          <ProductIcon name={connectionResult.safe ? 'check' : 'warning'} />
          <div><strong>{t(connectionResult.safe ? 'No blocking connection issue found' : 'Connection needs attention')}</strong><span>{t('{protocol} · {confidence} confidence · HTTP {status}', { protocol: connectionResult.protocol.toUpperCase(), confidence: t(localizeHumanized(connectionResult.confidence)), status: connectionResult.status === undefined ? '—' : formatNumber(connectionResult.status) })}</span></div>
        </div>
        <dl className="connection-doctor__metrics">
          <div><dt>{t('Raw events')}</dt><dd>{formatNumber(connectionResult.rawEventCount)}</dd></div>
          <div><dt>{t('Mapped events')}</dt><dd>{formatNumber(connectionResult.mappedEventCount)}</dd></div>
          <div><dt>{t('Unmatched')}</dt><dd>{formatNumber(connectionResult.unmatchedEventCount)}</dd></div>
          <div><dt>{t('Terminal')}</dt><dd>{t(connectionResult.terminalMapped ? 'Observed and mapped' : connectionResult.terminalEventSeen ? 'Observed, not mapped' : 'Not observed')}</dd></div>
        </dl>
        <ul className="connection-doctor__findings">{connectionResult.findings.map((finding) => <li className={`is-${finding.severity}`} key={finding.id}><ProductIcon name={finding.severity === 'error' || finding.severity === 'warning' ? 'warning' : 'info'} /><div><strong>{t(localizeHumanized(finding.id))}</strong><span>{t(finding.message)}</span></div></li>)}</ul>
        {!connectionResult.safe && <button type="button" className="settings-inline-action" onClick={() => post({ type: 'copilot.profileDoctor' })}>{t('Ask Copilot to diagnose this configuration')}</button>}
      </>}
    </section>
    <section className="settings-card" aria-labelledby="request-definition-heading">
      <SectionHeading id="request-definition-heading" title={t('Conversation request')} description={t('The endpoint is shared by first-turn and continuation variants. Templates are resolved in the Extension Host.')} />
      <div className="settings-form-grid">
        <SettingField label={t('HTTP method')} id="settings-request-method">
          <select id="settings-request-method" value={request.method} onChange={(event) => patch(['conversation', 'send', 'method'], event.target.value)}>
            {['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </SettingField>
        <SettingField label={t('Request URL')} id="settings-request-url" hint={t('Use ${env.baseUrl} and other profile context values where appropriate.')} error={!request.url.trim() ? t('A request URL is required.') : undefined} wide>
          <PatchInput id="settings-request-url" value={request.url} onCommit={(value) => patch(['conversation', 'send', 'url'], value)} required spellCheck={false} autoComplete="url" />
        </SettingField>
        <NumberSettingField label={t('Request timeout')} id="settings-request-timeout" value={request.timeoutMs} placeholder="120000" min={1} max={900000} hint={t('Milliseconds before the request is aborted.')} onCommit={(value) => patch(['conversation', 'send', 'timeoutMs'], value)} />
        <NumberSettingField label={t('Idle timeout')} id="settings-request-idle-timeout" value={request.idleTimeoutMs} placeholder="30000" min={1} max={900000} hint={t('Milliseconds without a stream event.')} onCommit={(value) => patch(['conversation', 'send', 'idleTimeoutMs'], value)} />
      </div>
    </section>

    <section className="settings-card" aria-labelledby="request-resilience-heading">
      <SectionHeading id="request-resilience-heading" title={t('Network resilience')} description={t('Bound retries and redirects without replaying partial streamed output.')} />
      <div className="settings-form-grid">
        <NumberSettingField label={t('Reconnect attempts')} id="settings-reconnect-attempts" value={request.reconnect?.maxAttempts} placeholder="0" min={0} max={5} hint={t('Retries only before the first stream event.')} onCommit={(value) => patch(['conversation', 'send', 'reconnect', 'maxAttempts'], value)} />
        <NumberSettingField label={t('Reconnect base delay')} id="settings-reconnect-base-delay" value={request.reconnect?.baseDelayMs} placeholder="500" min={0} max={30000} hint={t('Initial backoff in milliseconds.')} onCommit={(value) => patch(['conversation', 'send', 'reconnect', 'baseDelayMs'], value)} />
        <NumberSettingField label={t('Reconnect maximum delay')} id="settings-reconnect-max-delay" value={request.reconnect?.maxDelayMs} placeholder="10000" min={0} max={120000} hint={t('Maximum backoff in milliseconds.')} onCommit={(value) => patch(['conversation', 'send', 'reconnect', 'maxDelayMs'], value)} />
        <SettingField label={t('Retry HTTP statuses')} id="settings-reconnect-statuses" hint={t('Comma-separated 4xx or 5xx status codes.')}>
          <PatchInput id="settings-reconnect-statuses" value={(request.reconnect?.retryOnStatuses ?? []).join(', ')} placeholder="429, 502, 503, 504" inputMode="numeric" onCommit={(value) => patch(['conversation', 'send', 'reconnect', 'retryOnStatuses'], parseStatusList(value))} />
        </SettingField>
        <SettingField label={t('Redirect policy')} id="settings-redirect-policy">
          <select id="settings-redirect-policy" value={request.redirectPolicy ?? 'same-origin'} onChange={(event) => patch(['conversation', 'send', 'redirectPolicy'], event.target.value)}>
            <option value="same-origin">{t('Same origin only')}</option><option value="follow">{t('Follow redirects')}</option><option value="error">{t('Reject redirects')}</option>
          </select>
        </SettingField>
        <NumberSettingField label={t('Maximum redirects')} id="settings-max-redirects" value={request.maxRedirects} placeholder="5" min={0} max={10} onCommit={(value) => patch(['conversation', 'send', 'maxRedirects'], value)} />
      </div>
    </section>

    <section className="settings-card" aria-labelledby="request-payload-heading">
      <SectionHeading id="request-payload-heading" title={t('Headers and payload')} description={t('Keep structured values as JSON. Nothing in this editor executes as JavaScript.')} />
      <div className="settings-form-grid">
        <JsonPatchField label={t('Headers (JSON)')} id="settings-request-headers" value={request.headers ?? {}} hint={t('Header values are redacted in previews when they are sensitive.')} onCommit={(value) => patch(['conversation', 'send', 'headers'], value)} />
        <JsonPatchField label={t('Base body (JSON)')} id="settings-request-body" value={request.body ?? {}} hint={t('A variant body overrides this value when a variant supplies one.')} onCommit={(value) => patch(['conversation', 'send', 'body'], value)} />
      </div>
    </section>

    <section className="settings-card" aria-labelledby="request-preview-heading">
      <SectionHeading id="request-preview-heading" title={t('Request preview')} description={t('This is the host-prepared, redacted request. Secrets never leave the Extension Host.')} />
      {loopback && <p className="settings-callout settings-callout-info" role="status">{t('This request targets a local host ({host}).', { host: remoteName || t('Local Extension Host') })}</p>}
      <div className="settings-request-meta">
        <StatusItem label={t('Selected variant')} value={typeof preview?.variantId === 'string' ? preview.variantId : 'first-turn'} />
        <StatusItem label={t('Preview URL')} value={previewUrl || t('Not configured')} />
      </div>
      <JsonPreview value={requestPreview ?? request} label={t('Redacted request')} />
    </section>
  </div>;
}

function StreamMappingSection({ profile, snapshot, mappingTestResult, post, patch }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; mappingTestResult?: MappingTestResult; post: SettingsWorkspacePost; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const stream = profile.stream;
  return <div className="settings-section-stack">
    <section className="settings-card" aria-labelledby="stream-settings-heading">
      <SectionHeading id="stream-settings-heading" title={t('Stream transport')} description={t('Choose the framing used by the response and the policy for an unexpected end.')} />
      <div className="settings-form-grid">
        <SettingField label={t('Transport')} id="settings-stream-transport" hint={t('Fixture is useful for deterministic replay without a network request.')}>
          <select id="settings-stream-transport" value={stream.transport} onChange={(event) => patch(['stream', 'transport'], event.target.value)}>
            {['sse', 'ndjson', 'json', 'text-stream', 'fixture'].map((transport) => <option key={transport} value={transport}>{localizeHumanized(transport)}</option>)}
          </select>
        </SettingField>
        <SettingField label={t('Data format')} id="settings-stream-data-format">
          <select id="settings-stream-data-format" value={stream.dataFormat ?? 'json'} onChange={(event) => patch(['stream', 'dataFormat'], event.target.value)}><option value="json">JSON</option><option value="text">{t('Text')}</option></select>
        </SettingField>
        <SettingField label={t('Done value')} id="settings-stream-done-value" hint={t('SSE and text transports stop mapping when this value is received.')}>
          <PatchInput id="settings-stream-done-value" value={stream.doneValue ?? '[DONE]'} onCommit={(value) => patch(['stream', 'doneValue'], value || undefined)} spellCheck={false} />
        </SettingField>
        <SettingField label={t('Unexpected stream end')} id="settings-stream-end-policy" hint={t('Whether an incomplete response should fail the turn.')}>
          <select id="settings-stream-end-policy" value={stream.unexpectedEndPolicy ?? 'fail'} onChange={(event) => patch(['stream', 'unexpectedEndPolicy'], event.target.value)}><option value="fail">{t('Fail the turn')}</option><option value="completeWithWarning">{t('Complete with warning')}</option></select>
        </SettingField>
      </div>
      <div className="settings-status-grid settings-stream-metrics">
        <StatusItem label={t('Raw events')} value={formatNumber(snapshot?.metrics.eventCount ?? 0)} />
        <StatusItem label={t('Parse errors')} value={formatNumber(snapshot?.metrics.parseErrorCount ?? 0)} tone={snapshot?.metrics.parseErrorCount ? 'warning' : 'default'} />
        <StatusItem label={t('Mapping errors')} value={formatNumber(snapshot?.metrics.mappingErrorCount ?? 0)} tone={snapshot?.metrics.mappingErrorCount ? 'warning' : 'default'} />
      </div>
    </section>
    <section className="settings-editor-frame" aria-labelledby="mapping-editor-heading">
      <div className="settings-editor-note"><strong id="mapping-editor-heading">{t('Mapping rules')}</strong></div>
      <EventsEditor profile={profile} post={post} mappingTestResult={mappingTestResult} />
    </section>
  </div>;
}

function ChatUiSection({ profile, post }: { profile: TurnStageProfile; post: SettingsWorkspacePost }): React.JSX.Element {
  return <div className="settings-editor-frame">
    <div className="settings-editor-note"><strong>{t('Chat UI editor')}</strong></div>
    <UiConfigEditor profile={profile} post={post} />
  </div>;
}

function HistoryErrorsSection({ profile, snapshot, patch }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const localRuns = profile.history?.localRuns;
  const errorPolicy = profile.errorPolicy;
  return <div className="settings-section-stack">
    <section className="settings-card" aria-labelledby="history-settings-heading">
      <SectionHeading id="history-settings-heading" title={t('Local run history')} description={t('Runs are stored by the Extension Host and can be replayed without sending another request.')} />
      <div className="settings-form-grid">
        <SettingCheckboxGroup legend={t('Capture')} hint={t('Disable individual records when a profile should stay lightweight.')}>
          <SettingCheckbox id="settings-history-enabled" label={t('Enable local run history')} checked={localRuns?.enabled ?? true} onChange={(value) => patch(['history', 'localRuns', 'enabled'], value)} />
          <SettingCheckbox id="settings-history-raw" label={t('Record raw events')} checked={localRuns?.recordRawEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordRawEvents'], value)} />
          <SettingCheckbox id="settings-history-normalized" label={t('Record normalized events')} checked={localRuns?.recordNormalizedEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordNormalizedEvents'], value)} />
          <SettingCheckbox id="settings-history-snapshot" label={t('Record chat snapshot')} checked={localRuns?.recordChatSnapshot ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordChatSnapshot'], value)} />
        </SettingCheckboxGroup>
        <NumberSettingField label={t('Maximum local runs')} id="settings-history-max-runs" value={localRuns?.maxRuns} placeholder="20" min={1} max={100} hint={t('Older runs are evicted after this count.')} onCommit={(value) => patch(['history', 'localRuns', 'maxRuns'], value)} />
        <ListPatchField label={t('Visible metrics')} id="settings-visible-metrics" value={profile.metrics?.enabled ?? []} placeholder="ttft, totalDuration, eventCount" hint={t('Leave empty to show every available metric.')} onCommit={(value) => patch(['metrics', 'enabled'], value)} wide />
        <ListPatchField label={t('Visible message metrics')} id="settings-visible-message-metrics" value={profile.metrics?.messageEnabled ?? []} placeholder="ttft, totalDuration" hint={t('Leave empty to show only TTFT and total duration. Add mapped metric IDs explicitly.')} onCommit={(value) => patch(['metrics', 'messageEnabled'], value)} wide />
      </div>
      <div className="settings-history-note"><strong>{t('Remote sessions')}</strong><span>{t(profile.history?.remoteSessions?.mode === 'referenceOnly' ? 'Reference-only history is enabled.' : 'No remote session history is configured.')}</span></div>
    </section>

    <section className="settings-card" aria-labelledby="error-policy-heading">
      <SectionHeading id="error-policy-heading" title={t('Error handling')} description={t('Keep useful partial output visible while making failures explicit.')} />
      <SettingCheckboxGroup legend={t('After an error')}>
        <SettingCheckbox id="settings-error-partial" label={t('Preserve partial content')} checked={errorPolicy?.preservePartialContent ?? true} onChange={(value) => patch(['errorPolicy', 'preservePartialContent'], value)} />
        <SettingCheckbox id="settings-error-part" label={t('Show an error part')} checked={errorPolicy?.showErrorPart ?? true} onChange={(value) => patch(['errorPolicy', 'showErrorPart'], value)} />
        <SettingCheckbox id="settings-error-conversation" label={t('Keep conversation ID')} checked={errorPolicy?.keepConversationId ?? true} onChange={(value) => patch(['errorPolicy', 'keepConversationId'], value)} />
        <SettingCheckbox id="settings-error-continuation" label={t('Allow continuation after error')} checked={errorPolicy?.allowContinuation ?? true} onChange={(value) => patch(['errorPolicy', 'allowContinuation'], value)} />
        <SettingCheckbox id="settings-error-locks" label={t('Release all locks')} checked={errorPolicy?.releaseAllLocks ?? true} onChange={(value) => patch(['errorPolicy', 'releaseAllLocks'], value)} />
      </SettingCheckboxGroup>
    </section>

    <section className="settings-card" aria-labelledby="runtime-errors-heading">
      <SectionHeading id="runtime-errors-heading" title={t('Current diagnostics')} description={t('The latest snapshot is read-only. Use Validate in the page header for profile diagnostics.')} />
      {snapshot?.errors.length ? <div className="settings-error-list" role="status">{snapshot.errors.map((error, index) => <article key={`${error.type}-${index}`}><div><strong>{error.type}</strong>{error.status ? <span>HTTP {formatNumber(error.status)}</span> : null}</div><p>{error.message}</p>{error.suggestion ? <small>{error.suggestion}</small> : null}</article>)}</div> : <p className="settings-empty">{t('No runtime errors in the current session.')}</p>}
    </section>
  </div>;
}

function SecuritySection({ profile, snapshot, remoteName, patch }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; remoteName?: string; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const security = profile.security;
  return <div className="settings-section-stack">
    <section className="settings-card" aria-labelledby="security-trust-heading">
      <SectionHeading id="security-trust-heading" title={t('Workspace trust')} description={t('Network requests and privileged actions are owned and checked by the Extension Host.')} />
      <div className={`settings-trust-card ${snapshot?.trusted === false ? 'is-restricted' : ''}`} role="status">
        <ProductIcon name={snapshot?.trusted === false ? 'warning' : 'check'} className="settings-trust-icon" />
        <div><strong>{t(snapshot?.trusted === false ? 'Restricted workspace' : 'Workspace trust is available')}</strong><p>{snapshot?.trusted === false ? t('Request-backed openings and conversation requests are disabled until this workspace is trusted.') : t('Host: {host}. URI and command policies still apply.', { host: remoteName || t('Local Extension Host') })}</p></div>
      </div>
    </section>

    <section className="settings-card" aria-labelledby="security-policy-heading">
      <SectionHeading id="security-policy-heading" title={t('Allow lists')} description={t('Use comma-separated exact values. Keep these lists as narrow as the profile needs.')} />
      <div className="settings-form-grid">
        <ListPatchField label={t('Allowed URI schemes')} id="settings-security-schemes" value={security?.allowedUriSchemes ?? []} placeholder="https" hint={t('The runtime defaults to HTTPS when this list is empty.')} onCommit={(value) => patch(['security', 'allowedUriSchemes'], value)} />
        <ListPatchField label={t('Allowed domains')} id="settings-security-domains" value={security?.allowedDomains ?? []} placeholder="api.example.com" hint={t('Domains are matched exactly when the list is non-empty.')} onCommit={(value) => patch(['security', 'allowedDomains'], value)} />
        <ListPatchField label={t('Allowed VS Code commands')} id="settings-security-commands" value={security?.allowedCommands ?? []} placeholder="workbench.action.files.openFile" hint={t('Only commands explicitly allowlisted here may be invoked by a profile action.')} onCommit={(value) => patch(['security', 'allowedCommands'], value)} wide />
      </div>
    </section>
    <p className="settings-callout settings-callout-warning">{t('Never place credentials in a profile. Use SecretStorage references; previews redact sensitive headers and body keys.')}</p>
  </div>;
}

const assertionOperators: ScenarioAssertionOperator[] = ['equals', 'notEquals', 'exists', 'notExists', 'contains', 'regex', 'oneOf', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'sequenceEquals', 'sequenceContains'];
const performanceMetricOptions: Array<{ id: ScenarioPerformanceMetric; label: string }> = [
  { id: 'scenario.durationMs', label: 'Scenario duration' },
  { id: 'metrics.headersLatency', label: 'Headers latency' },
  { id: 'metrics.firstChunkLatency', label: 'First chunk latency' },
  { id: 'metrics.firstEventLatency', label: 'First event latency' },
  { id: 'metrics.ttft', label: 'TTFT' },
  { id: 'metrics.streamDuration', label: 'Stream duration' },
  { id: 'metrics.totalDuration', label: 'Total duration' },
  { id: 'metrics.averageEventGap', label: 'Average event gap' },
  { id: 'metrics.maxEventGap', label: 'Maximum event gap' },
];

function ScenarioTestsSection({ view, adversarialSection = 'results', onAdversarialSectionChange, profile, patch, post, testResults, campaignDashboard, testOperation, activeEvidenceId, timeline, trusted = false, selectedCampaignId: controlledSelectedCampaignId, onSelectedCampaignIdChange, expandedCaseId: controlledExpandedCaseId, onExpandedCaseIdChange, linkedCaseCatalog, caseCollection = DEFAULT_ADVERSARIAL_CASE_COLLECTION, onCaseCollectionChange = () => undefined, resultCollection = DEFAULT_ADVERSARIAL_RESULT_COLLECTION, onResultCollectionChange = () => undefined }: { view: 'contracts' | 'adversarial'; adversarialSection?: RedTeamSectionId; onAdversarialSectionChange?: (section: RedTeamSectionId) => void; profile: TurnStageProfile; patch: (path: PatchPath, value: unknown) => void; post: SettingsWorkspacePost; testResults: AdversarialResultSummary[]; campaignDashboard?: CampaignDashboardV1; testOperation?: TestOperationSnapshot; activeEvidenceId?: string; timeline?: React.ReactNode; trusted?: boolean; selectedCampaignId?: string; onSelectedCampaignIdChange?: (id: string | undefined) => void; expandedCaseId?: string; onExpandedCaseIdChange?: (id: string | undefined) => void; linkedCaseCatalog?: AdversarialCaseCatalog; caseCollection?: AdversarialCaseCollectionState; onCaseCollectionChange?: (state: AdversarialCaseCollectionState) => void; resultCollection?: AdversarialResultCollectionState; onResultCollectionChange?: (state: AdversarialResultCollectionState) => void }): React.JSX.Element {
  const scenarios = profile.tests?.scenarios ?? [];
  const qualityRubrics = profile.tests?.qualityRubrics ?? [];
  const [undo, setUndo] = useState<{ label: string; path: PatchPath; value: unknown }>();
  const [uncontrolledExpandedCaseId, setUncontrolledExpandedCaseId] = useState<string>();
  const [uncontrolledSelectedCampaignId, setUncontrolledSelectedCampaignId] = useState<string>();
  const expandedCaseId = onExpandedCaseIdChange ? controlledExpandedCaseId : uncontrolledExpandedCaseId;
  const selectedCampaignId = onSelectedCampaignIdChange ? controlledSelectedCampaignId : uncontrolledSelectedCampaignId;
  const setExpandedCaseId = (id: string | undefined) => { setUncontrolledExpandedCaseId(id); onExpandedCaseIdChange?.(id); };
  const setSelectedCampaignId = (id: string | undefined) => { setUncontrolledSelectedCampaignId(id); onSelectedCampaignIdChange?.(id); };
  const adversarialEntries = scenarios.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => scenario.adversarial);
  const contractEntries = scenarios.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => !scenario.adversarial);
  useEffect(() => {
    if (expandedCaseId && !adversarialEntries.some(({ scenario }) => scenario.id === expandedCaseId)) setExpandedCaseId(undefined);
  }, [adversarialEntries, expandedCaseId]);
  const save = (next: ScenarioDefinition[]) => patch(['tests', 'scenarios'], next);
  const saveDestructive = (label: string, next: ScenarioDefinition[]) => {
    setUndo({ label, path: ['tests', 'scenarios'], value: structuredClone(scenarios) });
    save(next);
  };
  const unlinkSuite = (index: number, path: string) => {
    const suites = profile.tests?.adversarialSuites ?? [];
    setUndo({ label: t('Unlinked suite {path}.', { path: linkedSuiteLabel(path) }), path: ['tests', 'adversarialSuites'], value: structuredClone(suites) });
    patch(['tests', 'adversarialSuites'], suites.filter((_, itemIndex) => itemIndex !== index));
  };
  const setReportFormat = (format: ScenarioReportFormat, checked: boolean) => {
    const reporting = profile.tests?.reporting;
    if (!reporting) return;
    const formats = toggleValue(reporting.formats, format, checked);
    if (formats.length) patch(['tests', 'reporting'], { ...reporting, formats });
  };
  const addScenario = () => {
    const ordinal = scenarios.length + 1;
    const id = uniqueId(new Set(scenarios.map((scenario) => scenario.id)), `scenario-${ordinal}`);
    save([...scenarios, { id, name: t('Scenario {number}', { number: formatNumber(ordinal) }), steps: [{ id: 'step-1', name: t('First message'), input: '', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }] }]);
  };
  const addAdversarial = () => {
    const ordinal = adversarialEntries.length + 1;
    const id = uniqueId(new Set(scenarios.map((scenario) => scenario.id)), `adversarial-${ordinal}`);
    save([...scenarios, {
      id,
      name: t('Adversarial case {number}', { number: formatNumber(ordinal) }),
      steps: [{ id: 'turn-1', name: t('First message'), input: '' }],
      adversarial: { mode: 'singleTurn', maxTurns: 1, timeoutMs: 60_000, stopOnAttackSucceeded: true, forbid: { content: ['forbidden-marker'] } },
    }]);
    setExpandedCaseId(id);
  };
  const saveQualityRubrics = (value: QualityRubricDefinition[] | undefined) => patch(['tests', 'qualityRubrics'], value);
  const addQualityRubric = () => {
    const ordinal = qualityRubrics.length + 1;
    const id = uniqueId(new Set(qualityRubrics.map((rubric) => rubric.id)), `quality-${ordinal}`);
    saveQualityRubrics([...qualityRubrics, { id, name: t('Quality rubric {number}', { number: formatNumber(ordinal) }), criteria: [{ id: 'criterion-1', label: t('Criterion 1'), description: t('Describe the observable quality expected from the disclosed response.') }] }]);
  };
  const campaigns = profile.tests?.campaigns ?? [];
  const selectedCampaignIndex = Math.max(0, campaigns.findIndex((campaign) => campaign.id === selectedCampaignId));
  const selectedCampaign = campaigns[selectedCampaignIndex];
  const testRunActive = testOperation?.state === 'running' || testOperation?.state === 'cancelling';
  const deferredResultQuery = useDeferredValue(resultCollection.query);
  const filteredResults = useMemo(() => filterAdversarialResults(testResults, { ...resultCollection, query: deferredResultQuery }), [deferredResultQuery, resultCollection, testResults]);
  const resultPageCount = Math.max(1, Math.ceil(filteredResults.length / resultCollection.pageSize));
  const resultPage = Math.min(resultCollection.page, resultPageCount - 1);
  const visibleResults = filteredResults.slice(resultPage * resultCollection.pageSize, (resultPage + 1) * resultCollection.pageSize);
  const updateResultCollection = (patchValue: Partial<AdversarialResultCollectionState>, resetPage = true) => onResultCollectionChange({ ...resultCollection, ...patchValue, ...(resetPage ? { page: 0 } : {}) });
  const resultFilterCount = Number(Boolean(resultCollection.query.trim())) + Number(resultCollection.outcome !== 'all') + Number(resultCollection.stability !== 'all') + Number(resultCollection.attentionOnly);
  useEffect(() => {
    if (resultPage !== resultCollection.page) onResultCollectionChange({ ...resultCollection, page: resultPage });
  }, [resultCollection, resultPage]);
  const activeTimelineResult = testResults.find((result) => result.evidenceId === activeEvidenceId || result.repetitions?.attempts?.some((attempt) => attempt.evidenceId === activeEvidenceId));
  const reviewTimeline = (evidenceId: string) => {
    post({ type: 'test.timeline.open', evidenceId });
    onAdversarialSectionChange?.('timeline');
  };
  const saveCampaigns = (value: TestCampaignDefinition[] | undefined) => profile.tests ? patch(['tests', 'campaigns'], value) : patch(['tests'], { scenarios: [], ...(value ? { campaigns: value } : {}) });
  const addCampaign = () => {
    const ordinal = campaigns.length + 1;
    const id = uniqueId(new Set(campaigns.map((campaign) => campaign.id)), `campaign-${ordinal}`);
    saveCampaigns([...campaigns, { id, name: t('Campaign {number}', { number: formatNumber(ordinal) }), selectors: { tagMode: 'all' }, runPolicy: { repetitions: 1, maxConcurrency: 3, maxRequests: 1000, maxDurationMs: 3_600_000 } }]);
    setSelectedCampaignId(id);
  };
  return <div className="settings-section-stack">
    {view === 'adversarial' && adversarialSection === 'campaigns' && <section id="red-team-campaigns" className="settings-card red-team-section" role="tabpanel" aria-labelledby="red-team-campaigns-tab test-campaigns-heading" tabIndex={-1}>
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="test-campaigns-heading">{t('Test campaigns')}</h2><p className="settings-card-description">{t('Create a bounded, repeatable selection of existing cases. Campaign history stores metadata only; raw prompts and evidence remain session-scoped.')}</p></div><button type="button" disabled={campaigns.length >= 50} onClick={addCampaign}>{t('Add campaign')}</button></div>
      {!campaigns.length ? <div className="settings-empty settings-empty--action"><span>{t('No test campaigns configured.')}</span><button type="button" onClick={addCampaign}>{t('Add campaign')}</button></div> : <div className="campaign-master-detail">
        <div className="campaign-selector" role="listbox" aria-label={t('Test campaigns')}>{campaigns.map((campaign) => {
          const latest = campaignDashboard?.campaigns.find((item) => item.definition.id === campaign.id)?.latest;
          const selected = campaign.id === selectedCampaign?.id;
          return <button key={campaign.id} type="button" role="option" aria-selected={selected} className={selected ? 'is-selected' : undefined} onClick={() => setSelectedCampaignId(campaign.id)}><span><strong>{campaign.name || campaign.id}</strong><code>{campaign.id}</code></span>{latest ? <small className={`campaign-status campaign-status--${latest.status}`}>{t(localizeHumanized(latest.status))}</small> : <small className="campaign-status">{t('Not run')}</small>}</button>;
        })}</div>
        <div className="campaign-list">{selectedCampaign ? (() => {
          const campaign = selectedCampaign;
          const index = selectedCampaignIndex;
          const dashboard = campaignDashboard?.campaigns.find((item) => item.definition.id === campaign.id);
          const latest = dashboard?.latest;
          const update = (value: TestCampaignDefinition) => saveCampaigns(replaceAt(campaigns, index, value));
          return <article className="campaign-card" key={`${campaign.id}-${index}`}>
            <div className="campaign-card__heading"><div><strong>{campaign.name || campaign.id}</strong><code>{campaign.id}</code></div>{latest ? <span className={`campaign-status campaign-status--${latest.status}`}>{t(localizeHumanized(latest.status))}</span> : <span className="campaign-status">{t('Not run')}</span>}</div>
            <div className="settings-form-grid">
              <SettingField label={t('Name')} id={`campaign-${index}-name`}><PatchInput id={`campaign-${index}-name`} value={campaign.name} onCommit={(name) => update({ ...campaign, name })} /></SettingField>
              <NumberSettingField label={t('Repetitions per adversarial case')} id={`campaign-${index}-repetitions`} value={campaign.runPolicy?.repetitions} placeholder="1" min={1} max={100} hint={t('Conversation contracts run once; adversarial cases use this sample size.')} onCommit={(repetitions) => update({ ...campaign, runPolicy: { ...(campaign.runPolicy ?? {}), repetitions } })} />
              <NumberSettingField label={t('Concurrent cases')} id={`campaign-${index}-concurrency`} value={campaign.runPolicy?.maxConcurrency} placeholder="3" min={1} max={8} hint={t('Cases may run in parallel. Turns and repeated attempts within one case remain sequential.')} onCommit={(value) => update({ ...campaign, runPolicy: { ...(campaign.runPolicy ?? {}), maxConcurrency: value === undefined ? undefined : Math.round(value) } })} />
              <ListPatchField label={t('Case IDs')} id={`campaign-${index}-cases`} value={campaign.selectors?.caseIds ?? []} placeholder="jailbreak-basic, leakage-check" hint={t('Leave empty to select by suite or tags.')} onCommit={(caseIds) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), caseIds: caseIds.length ? caseIds : undefined } })} />
              <ListPatchField label={t('Suite IDs')} id={`campaign-${index}-suites`} value={campaign.selectors?.suiteIds ?? []} placeholder="security-regression" hint={t('Optional exact suite IDs.')} onCommit={(suiteIds) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), suiteIds: suiteIds.length ? suiteIds : undefined } })} />
              <ListPatchField label={t('Selector tags')} id={`campaign-${index}-tags`} value={campaign.selectors?.tags ?? []} placeholder="security, release" hint={t('All tags must match unless tag mode is changed in JSONC.')} onCommit={(tags) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), tags: tags.length ? tags : undefined } })} />
              <ListPatchField label={t('Coverage tags')} id={`campaign-${index}-coverage`} value={campaign.coverageTags ?? []} placeholder="prompt-boundary, privacy" hint={t('Missing required tags are reported before and after execution.')} onCommit={(coverageTags) => update({ ...campaign, coverageTags: coverageTags.length ? coverageTags : undefined })} />
            </div>
            {latest && <div className={`campaign-summary${latest.diff?.regressions ? ' has-regressions' : ''}`} role="status"><span>{t('{completed}/{planned} cases complete', { completed: formatNumber(latest.cases.filter((item) => item.sampleComplete).length), planned: formatNumber(latest.plan.selectedCases) })}</span><span>{t('Concurrency {limit} / 8', { limit: formatNumber(latest.plan.maxConcurrency) })}</span><span>{t('{percent}% coverage', { percent: formatNumber(latest.coverage.percent) })}</span>{latest.diff ? <span className={latest.diff.regressions ? 'is-regression' : ''}>{t(latest.diff.regressions === 1 ? '{count} regression' : '{count} regressions', { count: formatNumber(latest.diff.regressions) })}</span> : null}</div>}
            {latest?.diff?.entries.some((item) => item.transition === 'regressed') ? <ul className="campaign-regressions">{latest.diff.entries.filter((item) => item.transition === 'regressed').slice(0, 20).map((item) => <li key={item.key}><code>{item.scenarioId}</code><span>{t(localizeHumanized(item.baselineOutcome ?? 'unknown'))} → {t(localizeHumanized(item.currentOutcome ?? 'unknown'))}</span></li>)}</ul> : null}
            <div className="campaign-actions" role="group" aria-label={t('Campaign actions for {name}', { name: campaign.name })}>
              <button type="button" onClick={() => post({ type: 'campaign.preview', campaignId: campaign.id })}>{t('Preview plan')}</button>
              <button type="button" className="primary" disabled={latest?.status === 'running'} onClick={() => post({ type: 'campaign.run', campaignId: campaign.id })}>{t('Run')}</button>
              {latest?.status === 'running' ? <button type="button" className="danger" onClick={() => post({ type: 'campaign.cancel', campaignId: campaign.id })}>{t('Cancel run')}</button> : null}
              {latest?.status === 'cancelled' ? <button type="button" onClick={() => post({ type: 'campaign.resume', campaignId: campaign.id, runId: latest.id })}>{t('Resume')}</button> : null}
              {latest?.status === 'completed' && latest.cases.every((item) => item.sampleComplete) ? <button type="button" disabled={dashboard?.baseline?.runId === latest.id} onClick={() => post({ type: 'campaign.acceptBaseline', campaignId: campaign.id, runId: latest.id })}>{dashboard?.baseline?.runId === latest.id ? t('Accepted baseline') : t('Accept as baseline')}</button> : null}
              {latest ? <details><summary>{t('More')}</summary><div><button type="button" onClick={() => post({ type: 'campaign.exportResults', campaignId: campaign.id, runId: latest.id })}>{t('Export results JSONL')}</button><button type="button" onClick={() => post({ type: 'campaign.copilotSummary', campaignId: campaign.id, runId: latest.id })}>{t('Summarize with Copilot')}</button><button type="button" className="danger" onClick={() => saveCampaigns(campaigns.length === 1 ? undefined : campaigns.filter((_, itemIndex) => itemIndex !== index))}>{t('Delete campaign')}</button></div></details> : <button type="button" className="danger" onClick={() => saveCampaigns(campaigns.length === 1 ? undefined : campaigns.filter((_, itemIndex) => itemIndex !== index))}>{t('Delete campaign')}</button>}
            </div>
          </article>;
        })() : null}</div>
      </div>}
    </section>}
    {view === 'adversarial' && adversarialSection === 'cases' && <section id="red-team-cases" className="settings-card red-team-section" role="tabpanel" aria-labelledby="red-team-cases-tab adversarial-tests-heading" tabIndex={-1}>
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="adversarial-tests-heading">{t('Adversarial tests')}</h2><p className="settings-card-description">{t('Replay known attack messages and record whether observable prohibited effects occurred. Timeout and incomplete evidence never count as resistance.')}</p></div><button type="button" onClick={addAdversarial}>{t('Add case')}</button></div>
      <div className="copilot-profile-doctor"><div><strong>{t('Profile Doctor')}</strong><span>{t('Ask Copilot to explain validation, timeout, streaming, and mapping configuration evidence without exposing secrets.')}</span></div><button type="button" onClick={() => post({ type: 'copilot.profileDoctor' })}>{t('Diagnose profile with Copilot')}</button></div>
      <div className="adversarial-file-actions" role="group" aria-label={t('Bulk adversarial test files')}>
        <details><summary>{t('Import')}</summary><div>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importJsonc' })}>{t('Import JSONC copy')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importCsv' })}>{t('Import CSV')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importJsonl' })}>{t('Import JSONL')}</button>
        </div></details>
        <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'linkSuite' })}>{t('Link suite')}</button>
        <details><summary>{t('Export')}</summary><div>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportJsonc' })}>{t('Export JSONC')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportCsv' })}>{t('Export CSV')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportJsonl' })}>{t('Export JSONL')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'csvTemplate' })}>{t('CSV template')}</button>
        </div></details>
      </div>
      {undo && <div className="settings-undo" role="status"><span>{undo.label}</span><button type="button" onClick={() => { patch(undo.path, undo.value); setUndo(undefined); }}>{t('Undo')}</button><IconButton type="button" icon="clear-all" label={t('Dismiss undo')} onClick={() => setUndo(undefined)} /></div>}
      {(profile.tests?.adversarialSuites?.length ?? 0) > 0 && <div className="adversarial-linked-suites"><strong>{t('Linked suites')}</strong><ul>{profile.tests!.adversarialSuites!.map((path, index) => { const label = linkedSuiteLabel(path); return <li key={`${path}-${index}`}><code title={path}>{label}</code><div className="adversarial-linked-suite-actions"><IconButton type="button" icon="go-to-file" label={t('Open linked suite {path}', { path: label })} onClick={() => post({ type: 'adversarial.openLinkedSuite', path })} /><IconButton type="button" icon="trash" label={t('Unlink suite {path}', { path: label })} onClick={() => unlinkSuite(index, path)} /></div></li>; })}</ul></div>}
      {!adversarialEntries.length && !(linkedCaseCatalog?.entries.length) ? <div className="settings-empty settings-empty--action"><span>{t(profile.tests?.adversarialSuites?.length && !linkedCaseCatalog ? 'Loading linked adversarial cases…' : 'No adversarial cases configured.')}</span><button type="button" onClick={addAdversarial}>{t('Add case')}</button></div> : <AdversarialCaseTable entries={adversarialEntries} linkedEntries={linkedCaseCatalog?.entries ?? []} catalog={linkedCaseCatalog} collection={caseCollection} onCollectionChange={onCaseCollectionChange} onRefresh={() => post({ type: 'adversarial.catalog.request', force: true })} expandedCaseId={expandedCaseId} onToggle={(id) => setExpandedCaseId(expandedCaseId === id ? undefined : id)} onChange={(index, value) => save(replaceAt(scenarios, index, value))} onDestructiveChange={(index, value, label) => saveDestructive(label, replaceAt(scenarios, index, value))} onDelete={(index, scenario) => { if (expandedCaseId === scenario.id) setExpandedCaseId(undefined); saveDestructive(t('Deleted case {name}.', { name: scenario.name || scenario.id }), scenarios.filter((_, itemIndex) => itemIndex !== index)); }} onOpenSource={(path) => post({ type: 'adversarial.openLinkedSuite', path })} />}
      <p className="settings-footnote">{t('Linked CSV stays the source of truth and uses one row per turn. JSONC remains the lossless format for suite-level defaults and metadata.')}</p>
    </section>}
    {view === 'adversarial' && adversarialSection === 'results' && <section id="red-team-results" className="settings-card red-team-section" role="tabpanel" aria-labelledby="red-team-results-tab adversarial-results-heading" tabIndex={-1}>
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="adversarial-results-heading">{t('Latest adversarial results')}</h2><p className="settings-card-description">{t('Run from Test Explorer, then open the exact Chat, Network, or Events evidence for a result.')}</p></div><div className="adversarial-rerun-actions" role="group" aria-label={t('Run adversarial tests')}><button type="button" className="primary" disabled={testRunActive} aria-busy={testOperation?.action === 'runAll' && testRunActive} onClick={() => post({ type: 'test.runAll' })}>{t(testOperation?.action === 'runAll' && testRunActive ? 'Running all…' : 'Run all')}</button><button type="button" className="adversarial-rerun-secondary" disabled={testRunActive || !testResults.some((result) => result.outcome !== 'resisted')} onClick={() => post({ type: 'test.rerun', status: 'failed' })}>{t(testOperation?.action === 'rerunFailed' && testRunActive ? 'Rerunning failures…' : 'Rerun failures')}</button><details className="adversarial-rerun-more"><summary aria-label={t('More reruns')} title={t('More reruns')}><ProductIcon name="debug-restart" /></summary><div><button type="button" disabled={testRunActive || !testResults.some((result) => result.repetitions?.stability === 'unstable')} onClick={() => post({ type: 'test.rerun', status: 'unstable' })}>{t('Unstable')}</button><button type="button" disabled={testRunActive || !testResults.some((result) => result.repetitions?.sampleComplete === false)} onClick={() => post({ type: 'test.rerun', status: 'incomplete' })}>{t('Incomplete')}</button></div></details><details className="adversarial-export-actions"><summary aria-label={t('Export adversarial results')} title={t('Export adversarial results')}><ProductIcon name="export" /></summary><div><button type="button" disabled={!testResults.length} onClick={() => post({ type: 'test.report.export', format: 'html' })}>{t('HTML report')}</button><button type="button" disabled={!testResults.length || !trusted} onClick={() => post({ type: 'test.evidenceBundle.export' })}>{t('Evidence Bundle')}</button><button type="button" disabled={!testResults.length} onClick={() => post({ type: 'test.report.export', format: 'json' })}>{t('JSON report')}</button><button type="button" disabled={!testResults.length} onClick={() => post({ type: 'test.report.export', format: 'junit' })}>{t('JUnit XML')}</button></div></details>{testRunActive && <IconButton type="button" className="danger-subtle" icon="stop" label={t(testOperation?.state === 'cancelling' ? 'Stopping test run…' : 'Stop test run')} disabled={testOperation?.state === 'cancelling'} onClick={() => post({ type: 'test.cancel' })} />}</div></div>
      <TestOperationStatus operation={testOperation} />
      {testResults.length > 0 && <div className="adversarial-result-toolbar" role="group" aria-label={t('Filter adversarial results')}>
        <label className="adversarial-result-search"><span>{t('Search results')}</span><input type="search" value={resultCollection.query} placeholder={t('Case name or ID')} onChange={(event) => updateResultCollection({ query: event.target.value })} /></label>
        <label><span>{t('Outcome')}</span><select value={resultCollection.outcome} onChange={(event) => updateResultCollection({ outcome: event.target.value as AdversarialResultOutcomeFilter })}><option value="all">{t('All outcomes')}</option><option value="resisted">{t('Resisted')}</option><option value="attackSucceeded">{t('Attack succeeded')}</option><option value="indeterminate">{t('Indeterminate')}</option><option value="infrastructureError">{t('Infrastructure error')}</option></select></label>
        <label><span>{t('Stability')}</span><select value={resultCollection.stability} onChange={(event) => updateResultCollection({ stability: event.target.value as AdversarialResultStabilityFilter })}><option value="all">{t('All samples')}</option><option value="stable-pass">{t('Stable pass')}</option><option value="stable-fail">{t('Stable fail')}</option><option value="unstable">{t('Unstable')}</option><option value="inconclusive">{t('Inconclusive')}</option><option value="single-run">{t('Single run')}</option></select></label>
        <div className="collection-filter-actions"><button type="button" aria-pressed={resultCollection.attentionOnly} onClick={() => updateResultCollection({ attentionOnly: !resultCollection.attentionOnly })}>{t('Needs attention')}</button><button type="button" disabled={!resultFilterCount} onClick={() => onResultCollectionChange({ ...DEFAULT_ADVERSARIAL_RESULT_COLLECTION, pageSize: resultCollection.pageSize })}>{t('Clear filters')}{resultFilterCount ? ` (${formatNumber(resultFilterCount)})` : ''}</button></div>
      </div>}
      {!testResults.length ? <div className="settings-empty settings-empty--action"><span>{t('No adversarial results in this Extension Host session.')}</span><button type="button" className="primary" disabled={testRunActive} onClick={() => post({ type: 'test.runAll' })}>{t('Run all')}</button><button type="button" onClick={() => post({ type: 'testExplorer.open' })}>{t('Open Test Explorer')}</button></div> : !filteredResults.length ? <div className="settings-empty settings-empty--action"><span>{t('No results match the current filters.')}</span><button type="button" onClick={() => onResultCollectionChange({ ...DEFAULT_ADVERSARIAL_RESULT_COLLECTION, pageSize: resultCollection.pageSize })}>{t('Clear filters')}</button></div> : <>
        <div className="adversarial-result-table-wrap"><table className="adversarial-result-table"><thead><tr><th scope="col">{t('Case')}</th><th scope="col">{t('Outcome')}</th><th scope="col">{t('Repeatability')}</th><th scope="col">{t('Duration')}</th><th scope="col" className="adversarial-result-table__actions-heading">{t('Actions')}</th></tr></thead><tbody>{visibleResults.map((result) => <tr className={activeTimelineResult === result ? 'is-timeline-selected' : undefined} key={`${result.scenarioId}-${result.evidenceId}`}>
          <td><div className="adversarial-result-cell-stack"><strong>{highlightMatch(result.scenarioName, deferredResultQuery)}</strong><code>{highlightMatch(result.scenarioId, deferredResultQuery)}</code></div></td>
          <td><span className={`adversarial-outcome adversarial-outcome--${result.outcome}`}><ProductIcon name={result.outcome === 'resisted' ? 'check' : result.outcome === 'attackSucceeded' ? 'target' : 'warning'} />{t(adversarialOutcomeText(result.outcome))}</span></td>
          <td><div className="adversarial-result-cell-stack">{result.repetitions ? <><span>{t('{resisted}/{requested} resisted · {completed} attempts', { resisted: formatNumber(result.repetitions.counts.resisted), requested: formatNumber(result.repetitions.requestedAttempts), completed: formatNumber(result.repetitions.completedAttempts) })}</span><small>{t(adversarialStabilityText(result.repetitions.stability))}{result.repetitions.sampleComplete ? '' : ` · ${t('Incomplete sample')}`}</small></> : <span>{t('{completed}/{planned} turns', { completed: formatNumber(result.completedTurns), planned: formatNumber(result.plannedTurns) })}</span>}{result.reliability && <ReliabilitySummary summary={result.reliability} />}</div></td>
          <td className="adversarial-result-table__duration">{formatNumber(result.durationMs)} ms</td>
          <td><div className="adversarial-result-actions"><button type="button" className="primary" onClick={() => post({ type: 'test.evidence.open', evidenceId: result.evidenceId, location: result.primaryLocation })}>{t('Open evidence')}</button><IconButton type="button" icon="list-tree" label={activeTimelineResult === result ? t('Timeline selected') : t('Review timeline')} aria-pressed={activeTimelineResult === result} onClick={() => reviewTimeline(result.evidenceId)} /><details><summary aria-label={t('More actions')} title={t('More actions')}><ProductIcon name="ellipsis" /></summary><div><button type="button" onClick={() => post({ type: 'copilot.diagnose', evidenceId: result.evidenceId, mode: result.repetitions ? 'stability' : 'failure' })}>{t('Diagnose with Copilot')}</button><ClipboardButton text={safeResultSummary(result)} label={t('Copy safe summary')} />{(result.availableLocations.length ? result.availableLocations : [result.primaryLocation]).map((location) => <button key={`${result.evidenceId}-${location.kind}`} type="button" onClick={() => post({ type: 'test.evidence.open', evidenceId: result.evidenceId, location })}>{t(evidenceLocationText(location.kind))}</button>)}<button type="button" onClick={() => post({ type: 'copilot.qualityReview', evidenceIds: [result.evidenceId] })}>{t('Advisory quality review')}</button></div></details></div></td>
        </tr>)}</tbody></table></div>
        <div className="adversarial-result-pagination"><span>{t('Showing {start}–{end} of {total}', { start: formatNumber(resultPage * resultCollection.pageSize + 1), end: formatNumber(Math.min(filteredResults.length, (resultPage + 1) * resultCollection.pageSize)), total: formatNumber(filteredResults.length) })}</span><label><span>{t('Rows')}</span><select value={resultCollection.pageSize} onChange={(event) => updateResultCollection({ pageSize: Number(event.target.value) as 25 | 50 | 100 })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><IconButton type="button" icon="arrow-left" label={t('Previous page')} disabled={resultPage === 0} onClick={() => updateResultCollection({ page: resultPage - 1 }, false)} /><span>{t('Page {current} of {total}', { current: formatNumber(resultPage + 1), total: formatNumber(resultPageCount) })}</span><IconButton type="button" icon="arrow-right" label={t('Next page')} disabled={resultPage >= resultPageCount - 1} onClick={() => updateResultCollection({ page: resultPage + 1 }, false)} /></div>
      </>}
    </section>}
    {view === 'adversarial' && adversarialSection === 'timeline' && <section id="red-team-timeline" className="settings-card red-team-section adversarial-timeline-card" role="tabpanel" aria-labelledby="red-team-timeline-tab adversarial-timeline-heading" tabIndex={-1}>
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="adversarial-timeline-heading">{t('Causal timeline')}</h2><p className="settings-card-description">{t('Select Review timeline on a result to load its bounded request, stream, finding, and terminal evidence.')}</p></div>{activeTimelineResult && <div className="adversarial-timeline-context"><span className={`adversarial-outcome adversarial-outcome--${activeTimelineResult.outcome}`}>{t(adversarialOutcomeText(activeTimelineResult.outcome))}</span><strong>{activeTimelineResult.scenarioName}</strong><small>{formatNumber(activeTimelineResult.durationMs)} ms</small></div>}</div>
      {timeline ?? <p className="settings-empty">{activeEvidenceId ? t('Causal evidence is unavailable for the selected result.') : t('Select a result to review its causal timeline.')}</p>}
    </section>}
    {view === 'contracts' && <>
    <section className="settings-card" aria-labelledby="scenario-reporting-heading">
      <SectionHeading id="scenario-reporting-heading" title={t('CI reports')} description={t('Write sanitized contract summaries after Test Explorer runs.')} />
      <SettingCheckbox id="settings-test-reporting-enabled" label={t('Write reports to the workspace')} checked={Boolean(profile.tests?.reporting)} onChange={(enabled) => patch(['tests', 'reporting'], enabled ? { formats: ['json'], outputDirectory: '.turnstage/reports' } : undefined)} />
      {profile.tests?.reporting ? <div className="settings-form-grid scenario-reporting-fields">
        <SettingCheckboxGroup legend={t('Report formats')}>
          <SettingCheckbox id="settings-test-reporting-json" label="JSON" checked={profile.tests.reporting.formats.includes('json')} onChange={(checked) => setReportFormat('json', checked)} />
          <SettingCheckbox id="settings-test-reporting-junit" label={t('JUnit XML')} checked={profile.tests.reporting.formats.includes('junit')} onChange={(checked) => setReportFormat('junit', checked)} />
          <SettingCheckbox id="settings-test-reporting-html" label="HTML" checked={profile.tests.reporting.formats.includes('html')} onChange={(checked) => setReportFormat('html', checked)} />
        </SettingCheckboxGroup>
        <SettingField label={t('Output directory')} id="settings-test-reporting-directory" hint={t('Workspace-relative; traversal and absolute paths are rejected.')}><PatchInput id="settings-test-reporting-directory" value={profile.tests.reporting.outputDirectory} onCommit={(value) => patch(['tests', 'reporting'], { ...profile.tests!.reporting!, outputDirectory: value })} spellCheck={false} /></SettingField>
      </div> : null}
    </section>
    <section className="settings-card" aria-labelledby="quality-rubrics-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="quality-rubrics-heading">{t('Advisory AI review')}</h2><p className="settings-card-description">{t('Optional rubrics guide Copilot after you explicitly select and approve response disclosure. Findings never change formal test outcomes.')}</p></div>{qualityRubrics.length ? <button type="button" onClick={addQualityRubric}>{t('Add rubric')}</button> : null}</div>
      <SettingCheckbox id="settings-quality-rubrics-enabled" label={t('Use custom quality rubrics')} checked={qualityRubrics.length > 0} onChange={(enabled) => enabled ? addQualityRubric() : saveQualityRubrics(undefined)} />
      {qualityRubrics.length ? <div className="quality-rubric-list">{qualityRubrics.map((rubric, rubricIndex) => <QualityRubricEditor key={`${rubric.id}-${rubricIndex}`} rubric={rubric} index={rubricIndex} onChange={(value) => saveQualityRubrics(replaceAt(qualityRubrics, rubricIndex, value))} onDelete={() => saveQualityRubrics(qualityRubrics.length === 1 ? undefined : qualityRubrics.filter((_, index) => index !== rubricIndex))} />)}</div> : <p className="settings-footnote">{t('TurnStage uses its built-in relevance, clarity, completeness, and grounding rubric when no custom rubric is configured.')}</p>}
    </section>
    <section className="settings-card" aria-labelledby="scenario-visual-heading">
      <SectionHeading id="scenario-visual-heading" title={t('Visual regression')} description={t('Compare the rendered Chat viewport with a workspace baseline.')} />
      <SettingCheckbox id="settings-visual-enabled" label={t('Enable visual baselines')} checked={Boolean(profile.tests?.visual)} onChange={(enabled) => patch(['tests', 'visual'], enabled ? { baselineDirectory: '.turnstage/baselines', maxDifferencePercent: 0.1, channelTolerance: 16 } : undefined)} />
      {profile.tests?.visual ? <div className="settings-form-grid">
        <SettingField label={t('Baseline directory')} id="settings-visual-directory" hint={t('Workspace-relative; one PNG is stored per viewport.')}><PatchInput id="settings-visual-directory" value={profile.tests.visual.baselineDirectory} onCommit={(value) => patch(['tests', 'visual'], { ...profile.tests!.visual!, baselineDirectory: value })} spellCheck={false} /></SettingField>
        <NumberSettingField label={t('Maximum difference (%)')} id="settings-visual-difference" value={profile.tests.visual.maxDifferencePercent} placeholder="0.1" min={0} max={100} step={0.1} onCommit={(value) => patch(['tests', 'visual'], { ...profile.tests!.visual!, maxDifferencePercent: value })} />
        <NumberSettingField label={t('Channel tolerance')} id="settings-visual-tolerance" value={profile.tests.visual.channelTolerance} placeholder="16" min={0} max={255} onCommit={(value) => patch(['tests', 'visual'], { ...profile.tests!.visual!, channelTolerance: value })} />
      </div> : null}
    </section>
    <section className="settings-card" aria-labelledby="scenario-contract-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="scenario-contract-heading">{t('Conversation contracts')}</h2><p className="settings-card-description">{t('Each scenario runs in an isolated host session. Assertions inspect bounded runtime evidence and never execute JavaScript.')}</p></div><IconButton type="button" icon="add" label={t('Add scenario')} onClick={addScenario} /></div>
      {!contractEntries.length ? <div className="settings-empty settings-empty--action"><span>{t('No scenarios configured.')}</span><button type="button" onClick={addScenario}>{t('Add scenario')}</button></div> : <div className="scenario-list">
        {contractEntries.map(({ scenario, index }) => <ScenarioEditor key={`${scenario.id}-${index}`} scenario={scenario} index={index} onChange={(value) => save(replaceAt(scenarios, index, value))} onDestructiveChange={(value, label) => saveDestructive(label, replaceAt(scenarios, index, value))} onDelete={() => saveDestructive(t('Deleted scenario {name}.', { name: scenario.name || scenario.id }), scenarios.filter((_, itemIndex) => itemIndex !== index))} />)}
      </div>}
    </section>
    <p className="settings-footnote">{t('Run these scenarios from VS Code Test Explorer. Every completed step also receives TurnStage state-invariant checks.')}</p>
    </>}
  </div>;
}

function TestOperationStatus({ operation }: { operation?: TestOperationSnapshot }): React.JSX.Element | null {
  if (!operation) return null;
  const active = operation.state === 'running' || operation.state === 'cancelling';
  const icon = operation.state === 'completed' ? 'check' : operation.state === 'failed' ? 'error' : operation.state === 'cancelled' ? 'stop' : 'refresh';
  const title = operation.state === 'running'
    ? operation.action === 'runAll' ? 'Running all TurnStage tests…' : operation.action === 'rerunFailed' ? 'Rerunning failed tests…' : operation.action === 'rerunUnstable' ? 'Rerunning unstable tests…' : 'Rerunning incomplete tests…'
    : operation.state === 'cancelling' ? 'Stopping test run…'
      : operation.state === 'completed' ? 'Test run completed'
        : operation.state === 'cancelled' ? 'Test run cancelled'
          : 'Test run failed';
  const progress = operation.progress;
  const progressDetail = progress ? t('{completed} / {total} cases · {completedAttempts} / {totalAttempts} attempts', {
    completed: formatNumber(progress.completedCases),
    total: formatNumber(progress.totalCases),
    completedAttempts: formatNumber(progress.completedAttempts),
    totalAttempts: formatNumber(progress.totalAttempts),
  }) : undefined;
  const detail = active ? progressDetail ?? 'Preparing the bounded test plan…'
    : operation.state === 'completed' ? 'The latest results and evidence links are ready.'
      : operation.state === 'cancelled' ? 'Completed attempts remain available; unfinished work is not treated as passed.'
        : 'Open TurnStage Output for diagnostic details.';
  const activeCaseDetail = active && progress?.activeCaseNames?.length ? t('Active: {cases}', { cases: progress.activeCaseNames.join(', ') }) : undefined;
  const concurrencyDetail = progress ? active
    ? t('Concurrency: {active} active · limit {limit} / 8', { active: formatNumber(progress.activeCaseNames?.length ?? 0), limit: formatNumber(progress.maxConcurrency) })
    : t('Concurrency limit: {limit} / 8', { limit: formatNumber(progress.maxConcurrency) })
    : undefined;
  const percentage = progress?.totalCases ? Math.round((progress.completedCases / progress.totalCases) * 100) : undefined;
  return <div className={`test-operation-status test-operation-status--${operation.state}`} role="status" aria-live="polite" aria-atomic="true">
    <ProductIcon name={icon} className={active ? 'test-operation-status__active-icon' : ''} />
    <div><strong>{t(title)}</strong><span>{t(detail)}</span>{concurrencyDetail && <small>{concurrencyDetail}</small>}{activeCaseDetail && <small>{activeCaseDetail}</small>}{operation.detail && <small>{operation.detail}</small>}</div>
    {active && (percentage === undefined
      ? <progress aria-label={t('Test run progress')} />
      : <progress value={progress!.completedCases} max={progress!.totalCases} aria-label={t('Test run progress')} aria-valuetext={progressDetail}>{percentage}%</progress>)}
  </div>;
}

interface AdversarialCaseRow {
  key: string;
  source: 'inline' | 'linked';
  sourceKey: string;
  sourceLabel: string;
  scenarioId: string;
  scenarioName: string;
  tags: string[];
  mode: 'singleTurn' | 'multiTurn';
  turns: number;
  maxTurns: number;
  repetitions: number;
  timeoutMs: number;
  rules: string;
  scenario?: ScenarioDefinition;
  index?: number;
  sourcePath?: string;
}

function AdversarialCaseTable({ entries, linkedEntries, catalog, collection, onCollectionChange, onRefresh, expandedCaseId, onToggle, onChange, onDestructiveChange, onDelete, onOpenSource }: {
  entries: Array<{ scenario: ScenarioDefinition; index: number }>;
  linkedEntries: LinkedAdversarialCaseSummary[];
  catalog?: AdversarialCaseCatalog;
  collection: AdversarialCaseCollectionState;
  onCollectionChange: (state: AdversarialCaseCollectionState) => void;
  onRefresh: () => void;
  expandedCaseId?: string;
  onToggle: (id: string) => void;
  onChange: (index: number, value: ScenarioDefinition) => void;
  onDestructiveChange: (index: number, value: ScenarioDefinition, label: string) => void;
  onDelete: (index: number, scenario: ScenarioDefinition) => void;
  onOpenSource: (path: string) => void;
}): React.JSX.Element {
  const rows = useMemo<AdversarialCaseRow[]>(() => [
    ...entries.map(({ scenario, index }) => {
      const definition = scenario.adversarial!;
      return {
        key: `inline:${scenario.id}:${index}`,
        source: 'inline' as const,
        sourceKey: 'inline',
        sourceLabel: t('Inline'),
        scenarioId: scenario.id,
        scenarioName: scenario.name || scenario.id,
        tags: scenario.tags ?? [],
        mode: definition.mode ?? (scenario.steps.length > 1 ? 'multiTurn' : 'singleTurn'),
        turns: scenario.steps.length,
        maxTurns: definition.maxTurns ?? Math.max(1, scenario.steps.length),
        repetitions: definition.repetitions ?? 1,
        timeoutMs: definition.timeoutMs ?? 60_000,
        rules: adversarialRuleSummary(definition.forbid),
        scenario,
        index,
      };
    }),
    ...linkedEntries.map((entry) => ({
      key: `linked:${entry.sourcePath}:${entry.scenarioId}`,
      source: 'linked' as const,
      sourceKey: `linked:${entry.sourcePath}`,
      sourceLabel: entry.suiteName || linkedSuiteLabel(entry.sourcePath),
      scenarioId: entry.scenarioId,
      scenarioName: entry.scenarioName || entry.scenarioId,
      tags: entry.tags,
      mode: entry.mode,
      turns: entry.turns,
      maxTurns: entry.maxTurns,
      repetitions: entry.repetitions,
      timeoutMs: entry.timeoutMs,
      rules: linkedAdversarialRuleSummary(entry),
      sourcePath: entry.sourcePath,
    })),
  ], [entries, linkedEntries]);
  const sourceOptions = useMemo(() => [...new Map(rows.filter((row) => row.source === 'linked').map((row) => [row.sourceKey, row.sourceLabel])).entries()], [rows]);
  const tagOptions = useMemo(() => [...new Set(rows.flatMap((row) => row.tags))].sort((left, right) => left.localeCompare(right)).slice(0, 100), [rows]);
  const deferredQuery = useDeferredValue(collection.query);
  const filtered = useMemo(() => {
    const query = deferredQuery.trim().toLocaleLowerCase();
    const selected = rows.filter((row) => {
      if (collection.mode !== 'all' && row.mode !== collection.mode) return false;
      if (collection.source !== 'all' && row.sourceKey !== collection.source) return false;
      if (collection.tag !== 'all' && !row.tags.includes(collection.tag)) return false;
      return !query || `${row.scenarioName} ${row.scenarioId} ${row.tags.join(' ')} ${row.rules} ${row.sourceLabel}`.toLocaleLowerCase().includes(query);
    });
    if (collection.sort === 'name') selected.sort((left, right) => left.scenarioName.localeCompare(right.scenarioName) || left.scenarioId.localeCompare(right.scenarioId));
    else if (collection.sort === 'mode') selected.sort((left, right) => left.mode.localeCompare(right.mode) || left.scenarioName.localeCompare(right.scenarioName));
    return selected;
  }, [collection.mode, collection.sort, collection.source, collection.tag, deferredQuery, rows]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / collection.pageSize));
  const page = Math.min(collection.page, pageCount - 1);
  const visible = filtered.slice(page * collection.pageSize, (page + 1) * collection.pageSize);
  const updateCollection = (patch: Partial<AdversarialCaseCollectionState>, resetPage = true) => onCollectionChange(normalizeAdversarialCaseCollectionState({ ...collection, ...patch, ...(resetPage ? { page: 0 } : {}) }));
  const filterCount = Number(Boolean(collection.query.trim())) + Number(collection.mode !== 'all') + Number(collection.source !== 'all') + Number(collection.tag !== 'all') + Number(collection.sort !== 'sourceOrder');
  return <div className="adversarial-case-collection">
    <div className="adversarial-case-toolbar">
      <label className="adversarial-case-search"><span className="sr-only">{t('Search adversarial cases')}</span><input type="search" value={collection.query} placeholder={t('Search cases by name, ID, tag, or rule')} aria-label={t('Search adversarial cases')} onChange={(event) => updateCollection({ query: event.target.value })} /></label>
      <label><span className="sr-only">{t('Case mode')}</span><select aria-label={t('Case mode')} value={collection.mode} onChange={(event) => updateCollection({ mode: event.target.value as AdversarialCaseModeFilter })}><option value="all">{t('All modes')}</option><option value="singleTurn">{t('Single turn')}</option><option value="multiTurn">{t('Multi-turn')}</option></select></label>
      <label><span className="sr-only">{t('Case source')}</span><select aria-label={t('Case source')} value={rows.some((row) => row.sourceKey === collection.source) ? collection.source : 'all'} onChange={(event) => updateCollection({ source: event.target.value })}><option value="all">{t('All sources')}</option><option value="inline">{t('Inline')}</option>{sourceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <details className="adversarial-case-more-filters"><summary>{t(collection.tag !== 'all' || collection.sort !== 'sourceOrder' ? 'Filters active' : 'More filters')}</summary><div>
        <label><span>{t('Tag')}</span><select aria-label={t('Case tag')} value={tagOptions.includes(collection.tag) ? collection.tag : 'all'} onChange={(event) => updateCollection({ tag: event.target.value })}><option value="all">{t('All tags')}</option>{tagOptions.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
        <label><span>{t('Sort')}</span><select aria-label={t('Case sort order')} value={collection.sort} onChange={(event) => updateCollection({ sort: event.target.value as AdversarialCaseSort })}><option value="sourceOrder">{t('Source order')}</option><option value="name">{t('Name')}</option><option value="mode">{t('Mode')}</option></select></label>
      </div></details>
      <IconButton type="button" icon="refresh" label={t('Refresh linked cases')} onClick={onRefresh} />
      <button type="button" className="adversarial-case-clear" disabled={!filterCount} onClick={() => onCollectionChange({ ...DEFAULT_ADVERSARIAL_CASE_COLLECTION, pageSize: collection.pageSize })}>{t('Clear')}{filterCount ? ` (${formatNumber(filterCount)})` : ''}</button>
    </div>
    <div className="adversarial-case-collection-status"><span>{t('{filtered} of {total} cases', { filtered: formatNumber(filtered.length), total: formatNumber(rows.length) })}</span>{catalog?.truncated && <span className="is-warning">{t('Only the first {count} linked cases are shown to protect performance.', { count: formatNumber(catalog.entries.length) })}</span>}</div>
    {catalog?.issues.length ? <details className="adversarial-catalog-issues"><summary>{t('{count} linked source issues', { count: formatNumber(catalog.issues.length) })}</summary><ul>{catalog.issues.map((issue) => <li key={`${issue.sourcePath}:${issue.message}`}><code>{linkedSuiteLabel(issue.sourcePath)}</code><span>{issue.message}</span></li>)}</ul></details> : null}
    <div className="adversarial-case-table-wrap" tabIndex={0} aria-label={t('Adversarial case settings table')}><table className="adversarial-case-table">
      <caption className="sr-only">{t('Adversarial case settings')}</caption>
      <thead><tr><th scope="col">{t('Case')}</th><th scope="col">{t('Source')}</th><th scope="col">{t('Mode')}</th><th scope="col">{t('Turns')}</th><th scope="col">{t('Repetitions')}</th><th scope="col">{t('Timeout')}</th><th scope="col">{t('Prohibitions')}</th><th scope="col">{t('Actions')}</th></tr></thead>
      <tbody>{visible.map((row) => {
        const scenario = row.scenario;
        const index = row.index;
        const expanded = row.source === 'inline' && expandedCaseId === row.scenarioId;
        const editorId = `adversarial-case-detail-${row.key.replace(/[^a-z0-9-]/giu, '-')}`;
        return <React.Fragment key={row.key}>
          <tr className={expanded ? 'is-expanded' : undefined}>
            <th scope="row"><span>{row.scenarioName}</span><code>{row.scenarioId}</code>{row.tags.length ? <small>{row.tags.join(', ')}</small> : null}</th>
            <td><span className={`adversarial-case-source adversarial-case-source--${row.source}`} title={row.sourcePath ? linkedSuiteLabel(row.sourcePath) : undefined}>{row.sourceLabel}</span></td>
            <td>{t(row.mode === 'multiTurn' ? 'Multi-turn' : 'Single turn')}</td>
            <td>{t('{current} / {maximum}', { current: formatNumber(row.turns), maximum: formatNumber(row.maxTurns) })}</td>
            <td>{formatNumber(row.repetitions)}</td>
            <td>{formatDuration(row.timeoutMs)}</td>
            <td><span className="adversarial-case-table__rules">{row.rules}</span></td>
            <td><div className="adversarial-case-table__actions">{scenario && index !== undefined ? <><button type="button" aria-expanded={expanded} aria-controls={editorId} onClick={() => onToggle(scenario.id)}>{t(expanded ? 'Close editor' : 'Edit')}</button><IconButton type="button" icon="trash" label={t('Delete scenario {name}', { name: scenario.name || scenario.id })} onClick={() => onDelete(index, scenario)} /></> : row.sourcePath ? <button type="button" onClick={() => onOpenSource(row.sourcePath!)}>{t('Open source')}</button> : null}</div></td>
          </tr>
          {expanded && scenario && index !== undefined && <tr className="adversarial-case-table__editor-row"><td colSpan={8}><div id={editorId}><ScenarioEditor scenario={scenario} index={index} onChange={(value) => onChange(index, value)} onDestructiveChange={(value, label) => onDestructiveChange(index, value, label)} onDelete={() => onDelete(index, scenario)} /></div></td></tr>}
        </React.Fragment>;
      })}</tbody>
    </table></div>
    {!visible.length && <div className="settings-empty settings-empty--action"><span>{t('No cases match the current filters.')}</span><button type="button" onClick={() => onCollectionChange({ ...DEFAULT_ADVERSARIAL_CASE_COLLECTION, pageSize: collection.pageSize })}>{t('Clear filters')}</button></div>}
    <div className="adversarial-case-pagination" aria-label={t('Case pages')}><label>{t('Rows per page')}<select value={collection.pageSize} onChange={(event) => updateCollection({ pageSize: Number(event.target.value) as 25 | 50 | 100 })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><span>{t('Page {current} of {total}', { current: formatNumber(page + 1), total: formatNumber(pageCount) })}</span><div><IconButton type="button" icon="arrow-left" label={t('Previous page')} disabled={page === 0} onClick={() => updateCollection({ page: page - 1 }, false)} /><IconButton type="button" icon="arrow-right" label={t('Next page')} disabled={page >= pageCount - 1} onClick={() => updateCollection({ page: page + 1 }, false)} /></div></div>
  </div>;
}

function linkedAdversarialRuleSummary(entry: LinkedAdversarialCaseSummary): string {
  const rules: string[] = [];
  if (entry.prohibit.content) rules.push(t('{count} content', { count: formatNumber(entry.prohibit.content) }));
  if (entry.prohibit.urls) rules.push(t('URLs'));
  if (entry.prohibit.ctas) rules.push(t('CTAs'));
  if (entry.prohibit.tools) rules.push(t('Tools'));
  if (entry.prohibit.events) rules.push(t('{count} events', { count: formatNumber(entry.prohibit.events) }));
  return rules.join(' · ') || t('No rules');
}

function highlightMatch(value: string, query: string): React.ReactNode {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return value;
  const index = value.toLocaleLowerCase().indexOf(normalized);
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + normalized.length)}</mark>{value.slice(index + normalized.length)}</>;
}

/** Deliberately excludes prompts, assistant content, URLs, headers, payloads, and event bodies. */
export function safeResultSummary(result: AdversarialResultSummary): string {
  const fields = [
    `case: ${result.scenarioName}`,
    `caseId: ${result.scenarioId}`,
    `outcome: ${result.outcome}`,
    `durationMs: ${result.durationMs}`,
    `turns: ${result.completedTurns}/${result.plannedTurns}`,
    `evidenceId: ${result.evidenceId}`,
  ];
  if (result.repetitions) {
    fields.push(`attempts: ${result.repetitions.completedAttempts}/${result.repetitions.requestedAttempts}`);
    fields.push(`stability: ${result.repetitions.stability}`);
    fields.push(`sampleComplete: ${String(result.repetitions.sampleComplete)}`);
  }
  return fields.join('\n');
}

function adversarialRuleSummary(forbid: AdversarialForbidDefinition): string {
  const rules: string[] = [];
  if (forbid.content?.length) rules.push(t('{count} content', { count: formatNumber(forbid.content.length) }));
  if (forbid.urls) rules.push(t('URLs'));
  if (forbid.ctas) rules.push(t('CTAs'));
  if (forbid.tools) rules.push(t('Tools'));
  if (forbid.events?.length) rules.push(t('{count} events', { count: formatNumber(forbid.events.length) }));
  return rules.length ? rules.join(' · ') : t('None');
}

function ReliabilitySummary({ summary }: { summary: NonNullable<AdversarialResultSummary['reliability']> }): React.JSX.Element {
  const percent = summary.resistanceRate === undefined ? t('Unavailable') : `${formatNumber(summary.resistanceRate * 100)}%`;
  const interval = summary.resistanceInterval?.lower === undefined || summary.resistanceInterval.upper === undefined
    ? t('Confidence interval unavailable')
    : t('{confidence}% CI {lower}–{upper}%', {
      confidence: formatNumber(summary.resistanceInterval.confidenceLevel * 100),
      lower: formatNumber(summary.resistanceInterval.lower * 100),
      upper: formatNumber(summary.resistanceInterval.upper * 100),
    });
  return <details className="adversarial-reliability">
    <summary><span>{t('Reliability')} · {percent} · {t(reliabilityVerdictText(summary.verdict))}</span></summary>
    <dl>
      <div><dt>{t('Coverage')}</dt><dd>{formatNumber(summary.coveragePercent)}%</dd></div>
      <div><dt>{t('Resistance')}</dt><dd>{percent}</dd></div>
      <div><dt>{t('Confidence')}</dt><dd>{interval}</dd></div>
      <div><dt>{t('TTFT p95')}</dt><dd>{summary.ttftP95Ms === undefined ? '—' : `${formatNumber(summary.ttftP95Ms)} ms`}</dd></div>
      <div><dt>{t('Duration p95')}</dt><dd>{summary.durationP95Ms === undefined ? '—' : `${formatNumber(summary.durationP95Ms)} ms`}</dd></div>
    </dl>
    {summary.reasons[0] && <p>{t(summary.reasons[0])}</p>}
  </details>;
}

function reliabilityVerdictText(verdict: NonNullable<AdversarialResultSummary['reliability']>['verdict']): string {
  if (verdict === 'meetsTarget') return 'Meets target';
  if (verdict === 'doesNotMeetTarget') return 'Does not meet target';
  return 'Insufficient evidence';
}

function QualityRubricEditor({ rubric, index, onChange, onDelete }: { rubric: QualityRubricDefinition; index: number; onChange: (value: QualityRubricDefinition) => void; onDelete: () => void }): React.JSX.Element {
  const addCriterion = () => {
    const ordinal = rubric.criteria.length + 1;
    const id = uniqueId(new Set(rubric.criteria.map((criterion) => criterion.id)), `criterion-${ordinal}`);
    onChange({ ...rubric, criteria: [...rubric.criteria, { id, label: t('Criterion {number}', { number: formatNumber(ordinal) }), description: t('Describe the observable quality expected from the disclosed response.') }] });
  };
  return <article className="quality-rubric-editor" aria-labelledby={`quality-rubric-title-${index}`}>
    <header><div><strong id={`quality-rubric-title-${index}`}>{rubric.name}</strong><code>{rubric.id}</code></div><button type="button" onClick={onDelete}>{t('Delete rubric')}</button></header>
    <div className="settings-form-grid">
      <SettingField label={t('Rubric name')} id={`quality-rubric-name-${index}`}><PatchInput id={`quality-rubric-name-${index}`} value={rubric.name} onCommit={(name) => onChange({ ...rubric, name })} required /></SettingField>
      <SettingField label={t('Rubric ID')} id={`quality-rubric-id-${index}`} hint={t('Letters, numbers, dots, colons, underscores, and hyphens.')}><PatchInput id={`quality-rubric-id-${index}`} value={rubric.id} onCommit={(id) => onChange({ ...rubric, id })} required spellCheck={false} /></SettingField>
      <SettingField label={t('Description')} id={`quality-rubric-description-${index}`} wide><PatchInput id={`quality-rubric-description-${index}`} value={rubric.description ?? ''} onCommit={(description) => onChange({ ...rubric, description: description || undefined })} multiline rows={2} /></SettingField>
    </div>
    <div className="quality-criterion-heading"><strong>{t('Criteria')}</strong><button type="button" onClick={addCriterion}>{t('Add criterion')}</button></div>
    <div className="quality-criterion-list">{rubric.criteria.map((criterion, criterionIndex) => <article key={`${criterion.id}-${criterionIndex}`}>
      <div className="settings-form-grid">
        <SettingField label={t('Label')} id={`quality-criterion-label-${index}-${criterionIndex}`}><PatchInput id={`quality-criterion-label-${index}-${criterionIndex}`} value={criterion.label} onCommit={(label) => onChange({ ...rubric, criteria: replaceAt(rubric.criteria, criterionIndex, { ...criterion, label }) })} required /></SettingField>
        <SettingField label={t('Criterion ID')} id={`quality-criterion-id-${index}-${criterionIndex}`}><PatchInput id={`quality-criterion-id-${index}-${criterionIndex}`} value={criterion.id} onCommit={(id) => onChange({ ...rubric, criteria: replaceAt(rubric.criteria, criterionIndex, { ...criterion, id }) })} required spellCheck={false} /></SettingField>
        <SettingField label={t('Evaluation guidance')} id={`quality-criterion-description-${index}-${criterionIndex}`} wide><PatchInput id={`quality-criterion-description-${index}-${criterionIndex}`} value={criterion.description} onCommit={(description) => onChange({ ...rubric, criteria: replaceAt(rubric.criteria, criterionIndex, { ...criterion, description }) })} multiline rows={2} required /></SettingField>
      </div>
      <button type="button" disabled={rubric.criteria.length === 1} onClick={() => onChange({ ...rubric, criteria: rubric.criteria.filter((_, index) => index !== criterionIndex) })}>{t('Delete criterion')}</button>
    </article>)}</div>
  </article>;
}

function ScenarioEditor({ scenario, index, onChange, onDestructiveChange, onDelete }: { scenario: ScenarioDefinition; index: number; onChange: (value: ScenarioDefinition) => void; onDestructiveChange: (value: ScenarioDefinition, label: string) => void; onDelete: () => void }): React.JSX.Element {
  const addStep = () => {
    const ordinal = scenario.steps.length + 1;
    const id = uniqueId(new Set(scenario.steps.map((step) => step.id)), `step-${ordinal}`);
    onChange({ ...scenario, steps: [...scenario.steps, { id, name: t('Message {number}', { number: formatNumber(ordinal) }), input: '', ...(scenario.adversarial ? {} : { assertions: [{ path: 'turn.state', operator: 'equals' as const, value: 'completed' }] }) }], ...(scenario.adversarial ? { adversarial: { ...scenario.adversarial, mode: 'multiTurn', maxTurns: Math.max(scenario.adversarial.maxTurns ?? 1, ordinal) } } : {}) });
  };
  return <article className="scenario-editor" aria-labelledby={`scenario-editor-title-${index}`}>
    <header className="scenario-editor__header"><div><strong id={`scenario-editor-title-${index}`}>{scenario.name || scenario.id}</strong><code>{scenario.id}</code></div><div><IconButton type="button" icon="add" label={t('Add step to {name}', { name: scenario.name || scenario.id })} onClick={addStep} /><IconButton type="button" icon="trash" label={t('Delete scenario {name}', { name: scenario.name || scenario.id })} onClick={onDelete} /></div></header>
    <div className="settings-form-grid scenario-editor__identity">
      <SettingField label={t('Scenario name')} id={`scenario-name-${index}`}><PatchInput id={`scenario-name-${index}`} value={scenario.name} onCommit={(value) => onChange({ ...scenario, name: value })} required /></SettingField>
      <SettingField label={t('Scenario ID')} id={`scenario-id-${index}`} hint={t('Lowercase letters, numbers, and hyphens.')}><PatchInput id={`scenario-id-${index}`} value={scenario.id} onCommit={(value) => onChange({ ...scenario, id: value })} required spellCheck={false} /></SettingField>
      <SettingField label={t('Description')} id={`scenario-description-${index}`} wide><PatchInput id={`scenario-description-${index}`} value={scenario.description ?? ''} onCommit={(value) => onChange({ ...scenario, description: value || undefined })} multiline rows={2} /></SettingField>
      {scenario.adversarial && <ListPatchField label={t('Tags')} id={`scenario-tags-${index}`} value={scenario.tags ?? []} placeholder={t('One tag per line')} onCommit={(tags) => onChange({ ...scenario, tags: tags.length ? tags : undefined })} wide />}
      <JsonPatchField label={t('Scenario controls (JSON)')} id={`scenario-controls-${index}`} value={scenario.controls ?? {}} hint={t('Applied only to this test run. Secret controls are not accepted.')} onCommit={(value) => onChange({ ...scenario, controls: isRecord(value) && Object.keys(value).length ? value : undefined })} />
    </div>
    {scenario.adversarial ? <AdversarialCaseEditor scenario={scenario} index={index} onChange={onChange} /> : <><ScenarioComparisonEditor scenario={scenario} index={index} onChange={onChange} /><ScenarioFaultEditor scenario={scenario} index={index} onChange={onChange} /></>}
    <div className="scenario-steps">
      {scenario.steps.map((step, stepIndex) => <ScenarioStepEditor key={`${step.id}-${stepIndex}`} step={step} scenarioIndex={index} stepIndex={stepIndex} adversarial={Boolean(scenario.adversarial)} onChange={(value) => onChange({ ...scenario, steps: replaceAt(scenario.steps, stepIndex, value) })} onDestructiveChange={(value, label) => onDestructiveChange({ ...scenario, steps: replaceAt(scenario.steps, stepIndex, value) }, label)} onDelete={() => onDestructiveChange({ ...scenario, steps: scenario.steps.filter((_, itemIndex) => itemIndex !== stepIndex) }, t('Deleted step {name}.', { name: step.name?.trim() || step.id }))} canDelete={scenario.steps.length > 1} />)}
    </div>
    {!scenario.adversarial && <AssertionsEditor idPrefix={`scenario-${index}-final`} title={t('Final assertions')} assertions={scenario.assertions ?? []} onChange={(value) => onChange({ ...scenario, assertions: value.length ? value : undefined })} onDeleteAt={(assertionIndex) => onDestructiveChange({ ...scenario, assertions: scenario.assertions?.filter((_, itemIndex) => itemIndex !== assertionIndex) }, t('Deleted assertion.'))} />}
  </article>;
}

function AdversarialCaseEditor({ scenario, index, onChange }: { scenario: ScenarioDefinition; index: number; onChange: (value: ScenarioDefinition) => void }): React.JSX.Element {
  const definition = scenario.adversarial!;
  const update = (value: Partial<typeof definition>) => onChange({ ...scenario, adversarial: { ...definition, ...value } });
  return <div className="adversarial-case-editor">
    <div className="settings-form-grid">
      <SettingField label={t('Conversation mode')} id={`adversarial-mode-${index}`} hint={t('Turns run in order in one isolated conversation.')}><select id={`adversarial-mode-${index}`} value={definition.mode ?? (scenario.steps.length > 1 ? 'multiTurn' : 'singleTurn')} onChange={(event) => update({ mode: event.target.value as 'singleTurn' | 'multiTurn' })}><option value="singleTurn">{t('Single turn')}</option><option value="multiTurn">{t('Multi-turn')}</option></select></SettingField>
      <NumberSettingField label={t('Maximum turns')} id={`adversarial-max-turns-${index}`} value={definition.maxTurns} placeholder={String(Math.max(1, scenario.steps.length))} min={1} max={10} onCommit={(value) => update({ maxTurns: value })} />
      <NumberSettingField label={t('Case timeout (ms)')} id={`adversarial-timeout-${index}`} value={definition.timeoutMs} placeholder="60000" min={1000} max={300000} onCommit={(value) => update({ timeoutMs: value })} />
      <NumberSettingField label={t('Repetitions')} id={`adversarial-repetitions-${index}`} value={definition.repetitions} placeholder="1" min={1} max={50} hint={t('Run this case in fresh isolated conversations, from 1 to 50 times.')} onCommit={(value) => update({ repetitions: value })} />
      <SettingCheckbox id={`adversarial-stop-${index}`} label={t('Stop remaining turns after an attack succeeds')} checked={definition.stopOnAttackSucceeded !== false} onChange={(checked) => update({ stopOnAttackSucceeded: checked })} />
      <SettingCheckbox id={`adversarial-fail-fast-${index}`} label={t('Stop remaining repetitions after an attack succeeds (incomplete sample)')} checked={definition.failFast === true} onChange={(checked) => update({ failFast: checked || undefined })} />
    </div>
    <AdversarialForbidEditor idPrefix={`adversarial-${index}`} value={definition.forbid} onChange={(forbid) => update({ forbid })} />
  </div>;
}

function adversarialStabilityText(stability: NonNullable<AdversarialResultSummary['repetitions']>['stability']): string {
  if (stability === 'stable-pass') return 'Stable resistance';
  if (stability === 'stable-fail') return 'Stable attack success';
  if (stability === 'unstable') return 'Unstable result';
  return 'Inconclusive';
}

function AdversarialForbidEditor({ idPrefix, value, onChange, additional = false }: { idPrefix: string; value: AdversarialForbidDefinition; onChange: (value: AdversarialForbidDefinition) => void; additional?: boolean }): React.JSX.Element {
  return <fieldset className="adversarial-forbid"><legend>{t(additional ? 'Additional prohibitions for this turn' : 'Prohibited observable effects')}</legend>
    <ListPatchField label={t('Forbidden content')} id={`${idPrefix}-content`} value={(value.content ?? []).flatMap((rule) => typeof rule === 'string' ? [rule] : [])} placeholder={t('One phrase per line')} hint={t('Literal phrase matching. Regex rules remain available in JSONC.')} onCommit={(content) => onChange({ ...value, content: content.length ? content : undefined })} wide />
    <ListPatchField label={t('Forbidden normalized events')} id={`${idPrefix}-events`} value={value.events ?? []} placeholder="tool.started" hint={t('Exact normalized event types, one per line.')} onCommit={(events) => onChange({ ...value, events: events.length ? events : undefined })} wide />
    <div className="adversarial-forbid__checks">
      <SettingCheckbox id={`${idPrefix}-urls`} label={t('Forbid URLs')} checked={Boolean(value.urls)} onChange={(urls) => onChange({ ...value, urls: urls || undefined })} />
      <SettingCheckbox id={`${idPrefix}-ctas`} label={t('Forbid calls to action')} checked={Boolean(value.ctas)} onChange={(ctas) => onChange({ ...value, ctas: ctas || undefined })} />
      <SettingCheckbox id={`${idPrefix}-tools`} label={t('Forbid tool interactions')} checked={Boolean(value.tools)} onChange={(tools) => onChange({ ...value, tools: tools || undefined })} />
    </div>
  </fieldset>;
}

function ScenarioFaultEditor({ scenario, index, onChange }: { scenario: ScenarioDefinition; index: number; onChange: (value: ScenarioDefinition) => void }): React.JSX.Element {
  const enabled = Boolean(scenario.faults);
  const update = (field: keyof NonNullable<ScenarioDefinition['faults']>, value: number | undefined) => {
    const faults = { ...(scenario.faults ?? {}) };
    if (value === undefined) delete faults[field]; else faults[field] = value;
    onChange({ ...scenario, faults: Object.keys(faults).length ? faults : undefined });
  };
  return <details className="scenario-advanced" open={enabled}>
    <summary>{t('Fault Lab')}</summary>
    <div className="scenario-advanced__content">
      <SettingCheckbox id={`scenario-faults-enabled-${index}`} label={t('Inject deterministic transport faults')} checked={enabled} onChange={(checked) => onChange({ ...scenario, faults: checked ? { disconnectAfterEvents: 1 } : undefined })} />
      {scenario.faults ? <div className="settings-form-grid">
        <NumberSettingField label={t('Request delay (ms)')} id={`scenario-fault-request-delay-${index}`} value={scenario.faults.delayBeforeRequestMs} placeholder="0" min={0} max={30000} onCommit={(value) => update('delayBeforeRequestMs', value)} />
        <NumberSettingField label={t('Chunk delay (ms)')} id={`scenario-fault-chunk-delay-${index}`} value={scenario.faults.delayPerChunkMs} placeholder="0" min={0} max={30000} onCommit={(value) => update('delayPerChunkMs', value)} />
        <NumberSettingField label={t('Synthetic HTTP status')} id={`scenario-fault-http-${index}`} value={scenario.faults.httpStatus} placeholder="503" min={400} max={599} onCommit={(value) => update('httpStatus', value)} />
        <NumberSettingField label={t('Disconnect after event')} id={`scenario-fault-disconnect-${index}`} value={scenario.faults.disconnectAfterEvents} placeholder="3" min={1} max={10000} onCommit={(value) => update('disconnectAfterEvents', value)} />
        <NumberSettingField label={t('Corrupt event')} id={`scenario-fault-corrupt-${index}`} value={scenario.faults.corruptEventAt} placeholder="2" min={1} max={10000} onCommit={(value) => update('corruptEventAt', value)} />
      </div> : null}
    </div>
  </details>;
}

function ScenarioComparisonEditor({ scenario, index, onChange }: { scenario: ScenarioDefinition; index: number; onChange: (value: ScenarioDefinition) => void }): React.JSX.Element {
  const enabled = Boolean(scenario.comparison);
  const updatePerformance = (metric: ScenarioPerformanceMetric, field: 'threshold' | 'maxIncreaseMs' | 'maxIncreasePercent', value: number | undefined) => {
    const thresholds = { ...(scenario.performance?.thresholds ?? {}) };
    const regression = { ...(scenario.performance?.regression ?? {}) };
    if (field === 'threshold') {
      if (value === undefined) delete thresholds[metric]; else thresholds[metric] = value;
    } else {
      const limit = { ...(regression[metric] ?? {}) };
      if (value === undefined) delete limit[field]; else limit[field] = value;
      if (Object.keys(limit).length) regression[metric] = limit; else delete regression[metric];
    }
    const performance = compactPerformance(thresholds, regression);
    onChange({ ...scenario, performance });
  };
  const setComparisonEnabled = (checked: boolean) => {
    if (checked) { onChange({ ...scenario, comparison: { baseline: { label: t('Baseline') }, candidate: { label: t('Candidate') } } }); return; }
    const performance = compactPerformance({ ...(scenario.performance?.thresholds ?? {}) }, {});
    onChange({ ...scenario, comparison: undefined, performance });
  };
  return <details className="scenario-advanced" open={enabled || Boolean(scenario.performance)}>
    <summary>{t('Compare & performance')}</summary>
    <div className="scenario-advanced__content">
      <SettingCheckbox id={`scenario-comparison-enabled-${index}`} label={t('Run baseline and candidate')} checked={enabled} onChange={setComparisonEnabled} />
      {scenario.comparison ? <>
        <div className="scenario-target-grid">
          <fieldset><legend>{t('Baseline')}</legend>
            <SettingField label={t('Label')} id={`scenario-baseline-label-${index}`}><PatchInput id={`scenario-baseline-label-${index}`} value={scenario.comparison.baseline.label ?? ''} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, baseline: { ...scenario.comparison!.baseline, label: value || undefined } } })} /></SettingField>
            <SettingField label={t('Environment ID')} id={`scenario-baseline-environment-${index}`}><PatchInput id={`scenario-baseline-environment-${index}`} value={scenario.comparison.baseline.environment ?? ''} placeholder={t('Profile default')} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, baseline: { ...scenario.comparison!.baseline, environment: value || undefined } } })} spellCheck={false} /></SettingField>
            <JsonPatchField label={t('Control overrides (JSON)')} id={`scenario-baseline-controls-${index}`} value={scenario.comparison.baseline.controls ?? {}} rows={4} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, baseline: { ...scenario.comparison!.baseline, controls: isRecord(value) && Object.keys(value).length ? value : undefined } } })} />
          </fieldset>
          <fieldset><legend>{t('Candidate')}</legend>
            <SettingField label={t('Label')} id={`scenario-candidate-label-${index}`}><PatchInput id={`scenario-candidate-label-${index}`} value={scenario.comparison.candidate.label ?? ''} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, candidate: { ...scenario.comparison!.candidate, label: value || undefined } } })} /></SettingField>
            <SettingField label={t('Environment ID')} id={`scenario-candidate-environment-${index}`}><PatchInput id={`scenario-candidate-environment-${index}`} value={scenario.comparison.candidate.environment ?? ''} placeholder={t('Profile default')} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, candidate: { ...scenario.comparison!.candidate, environment: value || undefined } } })} spellCheck={false} /></SettingField>
            <JsonPatchField label={t('Control overrides (JSON)')} id={`scenario-candidate-controls-${index}`} value={scenario.comparison.candidate.controls ?? {}} rows={4} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, candidate: { ...scenario.comparison!.candidate, controls: isRecord(value) && Object.keys(value).length ? value : undefined } } })} />
          </fieldset>
        </div>
        <ListPatchField label={t('Ignore dynamic paths')} id={`scenario-comparison-ignore-${index}`} value={scenario.comparison.ignorePaths ?? []} placeholder="messages[*].metadata.requestId" hint={t('Removed from both semantic snapshots before comparison.')} onCommit={(value) => onChange({ ...scenario, comparison: { ...scenario.comparison!, ignorePaths: value.length ? value : undefined } })} wide />
      </> : null}
      <div className="scenario-budget" role="group" aria-label={t('Performance budgets')}>
        <div className="scenario-budget__header" aria-hidden="true"><span>{t('Metric')}</span><span>{t('Maximum (ms)')}</span><span>{t('Increase (ms)')}</span><span>{t('Increase (%)')}</span></div>
        {performanceMetricOptions.map((metric) => <div className="scenario-budget__row" key={metric.id}>
          <span title={metric.id}>{t(metric.label)}</span>
          <OptionalNumberInput id={`scenario-${index}-${metric.id}-threshold`} label={t('{metric} maximum milliseconds', { metric: t(metric.label) })} shortLabel={t('Maximum (ms)')} value={scenario.performance?.thresholds?.[metric.id]} max={900000} onCommit={(value) => updatePerformance(metric.id, 'threshold', value)} />
          <OptionalNumberInput id={`scenario-${index}-${metric.id}-increase-ms`} label={t('{metric} maximum increase milliseconds', { metric: t(metric.label) })} shortLabel={t('Increase (ms)')} value={scenario.performance?.regression?.[metric.id]?.maxIncreaseMs} max={900000} disabled={!enabled} onCommit={(value) => updatePerformance(metric.id, 'maxIncreaseMs', value)} />
          <OptionalNumberInput id={`scenario-${index}-${metric.id}-increase-percent`} label={t('{metric} maximum increase percent', { metric: t(metric.label) })} shortLabel={t('Increase (%)')} value={scenario.performance?.regression?.[metric.id]?.maxIncreasePercent} max={10000} disabled={!enabled} onCommit={(value) => updatePerformance(metric.id, 'maxIncreasePercent', value)} />
        </div>)}
      </div>
    </div>
  </details>;
}

function ScenarioStepEditor({ step, scenarioIndex, stepIndex, adversarial, onChange, onDestructiveChange, onDelete, canDelete }: { step: ScenarioStepDefinition; scenarioIndex: number; stepIndex: number; adversarial: boolean; onChange: (value: ScenarioStepDefinition) => void; onDestructiveChange: (value: ScenarioStepDefinition, label: string) => void; onDelete: () => void; canDelete: boolean }): React.JSX.Element {
  const prefix = `scenario-${scenarioIndex}-step-${stepIndex}`;
  return <section className="scenario-step" aria-labelledby={`${prefix}-title`}>
    <header><div><span className="scenario-step__index">{formatNumber(stepIndex + 1)}</span><strong id={`${prefix}-title`}>{step.name?.trim() || step.id}</strong></div><IconButton type="button" icon="trash" label={t('Delete step {name}', { name: step.name?.trim() || step.id })} onClick={onDelete} disabled={!canDelete} /></header>
    <div className="settings-form-grid">
      <SettingField label={t('Step name')} id={`${prefix}-name`}><PatchInput id={`${prefix}-name`} value={step.name ?? ''} onCommit={(value) => onChange({ ...step, name: value || undefined })} /></SettingField>
      <SettingField label={t('Step ID')} id={`${prefix}-id`}><PatchInput id={`${prefix}-id`} value={step.id} onCommit={(value) => onChange({ ...step, id: value })} required spellCheck={false} /></SettingField>
      <SettingField label={t('User message')} id={`${prefix}-input`} wide><PatchInput id={`${prefix}-input`} value={step.input} onCommit={(value) => onChange({ ...step, input: value })} multiline rows={3} required /></SettingField>
    </div>
    {adversarial ? <AdversarialForbidEditor idPrefix={`${prefix}-additional`} value={step.additionalForbid ?? {}} additional onChange={(additionalForbid) => onChange({ ...step, additionalForbid: hasAdversarialForbid(additionalForbid) ? additionalForbid : undefined })} /> : <AssertionsEditor idPrefix={prefix} title={t('Step assertions')} assertions={step.assertions ?? []} onChange={(value) => onChange({ ...step, assertions: value.length ? value : undefined })} onDeleteAt={(assertionIndex) => onDestructiveChange({ ...step, assertions: step.assertions?.filter((_, itemIndex) => itemIndex !== assertionIndex) }, t('Deleted assertion.'))} />}
  </section>;
}

function AssertionsEditor({ idPrefix, title, assertions, onChange, onDeleteAt }: { idPrefix: string; title: string; assertions: ScenarioAssertionDefinition[]; onChange: (value: ScenarioAssertionDefinition[]) => void; onDeleteAt?: (index: number) => void }): React.JSX.Element {
  const add = () => onChange([...assertions, { path: 'assistant.text', operator: 'exists' }]);
  return <div className="assertion-editor"><div className="assertion-editor__heading"><strong>{title}</strong><IconButton type="button" icon="add" label={t('Add assertion')} onClick={add} /></div>
    {!assertions.length ? <p className="settings-muted">{t('No explicit assertions. Built-in state invariants still run.')}</p> : <div className="assertion-list">{assertions.map((assertion, index) => <AssertionRow key={`${assertion.id ?? assertion.path}-${index}`} assertion={assertion} idPrefix={`${idPrefix}-assertion-${index}`} onChange={(value) => onChange(replaceAt(assertions, index, value))} onDelete={() => onDeleteAt ? onDeleteAt(index) : onChange(assertions.filter((_, itemIndex) => itemIndex !== index))} />)}</div>}
  </div>;
}

function AssertionRow({ assertion, idPrefix, onChange, onDelete }: { assertion: ScenarioAssertionDefinition; idPrefix: string; onChange: (value: ScenarioAssertionDefinition) => void; onDelete: () => void }): React.JSX.Element {
  const expectsValue = assertion.operator !== 'exists' && assertion.operator !== 'notExists';
  return <div className="assertion-row">
    <label><span>{t('Path')}</span><PatchInput id={`${idPrefix}-path`} value={assertion.path} onCommit={(value) => onChange({ ...assertion, path: value })} spellCheck={false} placeholder="assistant.text" /></label>
    <label><span>{t('Operator')}</span><select id={`${idPrefix}-operator`} value={assertion.operator} onChange={(event) => { const operator = event.target.value as ScenarioAssertionOperator; if (operator === 'exists' || operator === 'notExists') { const withoutValue = { ...assertion }; delete withoutValue.value; onChange({ ...withoutValue, operator }); } else { onChange({ ...assertion, operator }); } }}>{assertionOperators.map((operator) => <option key={operator} value={operator}>{localizeHumanized(operator)}</option>)}</select></label>
    <JsonValuePatchInput id={`${idPrefix}-value`} value={assertion.value} disabled={!expectsValue} onCommit={(value) => onChange({ ...assertion, value })} />
    <IconButton type="button" icon="trash" label={t('Delete assertion')} onClick={onDelete} />
  </div>;
}

function JsonValuePatchInput({ id, value, disabled, onCommit }: { id: string; value: unknown; disabled?: boolean; onCommit: (value: unknown) => void }): React.JSX.Element {
  const source = value === undefined ? '' : JSON.stringify(value);
  const [draft, setDraft] = useState(source);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(source); setInvalid(false); }, [source]);
  const commit = () => {
    if (disabled) return;
    try { onCommit(JSON.parse(draft || 'null') as unknown); setInvalid(false); } catch { setInvalid(true); }
  };
  return <label className="assertion-value"><span>{t('Expected value')}</span><input id={id} value={draft} disabled={disabled} aria-invalid={invalid || undefined} spellCheck={false} placeholder={disabled ? '—' : '"completed"'} onChange={(event) => { setDraft(event.target.value); setInvalid(false); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(source); setInvalid(false); event.currentTarget.blur(); } }} /></label>;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] { return values.map((item, itemIndex) => itemIndex === index ? value : item); }
function hasAdversarialForbid(value: AdversarialForbidDefinition): boolean { return Boolean(value.content?.length || value.events?.length || value.urls || value.ctas || value.tools); }
function adversarialOutcomeText(outcome: AdversarialResultSummary['outcome']): string { if (outcome === 'attackSucceeded') return 'Attack succeeded'; if (outcome === 'infrastructureError') return 'Infrastructure error'; return outcome === 'resisted' ? 'Resisted' : 'Indeterminate'; }
function evidenceLocationText(kind: AdversarialResultSummary['primaryLocation']['kind']): string { if (kind === 'message') return 'Chat'; if (kind === 'network') return 'Network'; if (kind === 'normalizedEvent') return 'Normalized events'; if (kind === 'rawEvent') return 'Raw events'; return 'Profile'; }
function uniqueId(values: ReadonlySet<string>, preferred: string): string { if (!values.has(preferred)) return preferred; for (let index = 2; index < 10_000; index++) if (!values.has(`${preferred}-${index}`)) return `${preferred}-${index}`; return `${preferred}-${Date.now()}`; }

function SectionHeading({ id, title, description }: { id: string; title: string; description: string }): React.JSX.Element {
  return <div className="settings-card-heading"><div><h2 id={id}>{title}</h2><p className="settings-card-description">{description}</p></div></div>;
}

function SettingField({ label, id, hint, error, wide, children }: { label: string; id: string; hint?: string; error?: string; wide?: boolean; children: React.ReactNode }): React.JSX.Element {
  const descriptionId = useId();
  const describedBy = hint || error ? descriptionId : undefined;
  return <div className={`settings-field ${wide ? 'settings-field-wide' : ''}`}><label htmlFor={id}>{label}</label>{React.isValidElement(children) ? React.cloneElement(children, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined } as Record<string, unknown>) : children}{(hint || error) && <p id={descriptionId} className={error ? 'settings-field-error' : 'settings-field-hint'}>{error || hint}</p>}</div>;
}

function NumberSettingField({ label, id, value, placeholder, min, max, step = 1, hint, onCommit }: { label: string; id: string; value?: number; placeholder: string; min: number; max: number; step?: number; hint?: string; onCommit: (value: number | undefined) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (!draft.trim()) { if (value !== undefined) onCommit(undefined); return; }
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
  };
  return <SettingField label={label} id={id} hint={hint}><input id={id} type="number" min={min} max={max} step={step} value={draft} placeholder={placeholder} inputMode="decimal" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(value === undefined ? '' : String(value)); event.currentTarget.blur(); } }} /></SettingField>;
}

function OptionalNumberInput({ id, label, shortLabel, value, max, disabled, onCommit }: { id: string; label: string; shortLabel: string; value?: number; max: number; disabled?: boolean; onCommit: (value: number | undefined) => void }): React.JSX.Element {
  const source = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const commit = () => {
    if (!draft.trim()) { if (value !== undefined) onCommit(undefined); return; }
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(0, parsed)));
  };
  return <label className="scenario-budget__cell" htmlFor={id}><span className="scenario-budget__cell-label">{shortLabel}</span><input id={id} type="number" min={0} max={max} value={draft} disabled={disabled} inputMode="decimal" aria-label={label} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(source); event.currentTarget.blur(); } }} /></label>;
}

function SettingCheckboxGroup({ legend, hint, children }: { legend: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  const hintId = useId();
  return <fieldset className="settings-checkbox-group" aria-describedby={hint ? hintId : undefined}><legend>{legend}</legend>{hint && <p id={hintId}>{hint}</p>}<div>{children}</div></fieldset>;
}

function SettingCheckbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return <label className="settings-checkbox" htmlFor={id}><input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function PatchInput({ id, value, onCommit, multiline = false, rows = 3, ...props }: { id: string; value: string; onCommit: (value: string) => void; multiline?: boolean; rows?: number; disabled?: boolean; placeholder?: string; required?: boolean; spellCheck?: boolean; autoComplete?: string; type?: React.HTMLInputTypeAttribute; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
    if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); event.currentTarget.blur(); }
  };
  return multiline
    ? <textarea id={id} {...props} rows={rows} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
    : <input id={id} {...props} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />;
}

function JsonPatchField({ label, id, value, hint, rows = 8, onCommit }: { label: string; id: string; value: unknown; hint?: string; rows?: number; onCommit: (value: unknown) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(() => stringifyJson(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(stringifyJson(value)); setError(''); }, [value]);
  const commit = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      setError('');
      onCommit(parsed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Enter valid JSON.'));
    }
  };
  const description = error || hint;
  const descriptionId = useId();
  return <div className="settings-field settings-field-wide"><label htmlFor={id}>{label}</label><div className="settings-field-control"><textarea id={id} className="settings-code-input" rows={rows} value={draft} spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={description ? descriptionId : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(stringifyJson(value)); setError(''); event.currentTarget.blur(); } if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); event.currentTarget.blur(); } }} /><button type="button" className="settings-apply-action" onClick={commit}>{t('Apply JSON')}</button>{description && <p id={descriptionId} className={error ? 'settings-field-error' : 'settings-field-hint'}>{description}</p>}</div></div>;
}

function ListPatchField({ label, id, value, placeholder, hint, wide, onCommit }: { label: string; id: string; value: string[]; placeholder: string; hint?: string; wide?: boolean; onCommit: (value: string[]) => void }): React.JSX.Element {
  return <SettingField label={label} id={id} hint={hint} wide={wide}><ListPatchInput id={id} value={value} placeholder={placeholder} onCommit={onCommit} /></SettingField>;
}

function ListPatchInput({ id, value, placeholder, onCommit }: { id: string; value: string[]; placeholder: string; onCommit: (value: string[]) => void }): React.JSX.Element {
  const source = value.join(', ');
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const commit = () => { const next = parseList(draft); if (next.join(', ') !== source) onCommit(next); };
  return <input id={id} value={draft} placeholder={placeholder} autoComplete="off" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(source); event.currentTarget.blur(); } }} />;
}

function JsonPreview({ value, label }: { value: unknown; label: string }): React.JSX.Element {
  const text = stringifyJson(value);
  return <div className="settings-preview"><div className="settings-preview-heading"><span>{label}</span><ClipboardButton text={text} label={t('Copy')} /></div><pre><code>{text}</code></pre></div>;
}

function StatusItem({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }): React.JSX.Element {
  return <div className={`settings-status-item is-${tone}`}><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function stringifyJson(value: unknown): string {
  const result = JSON.stringify(value ?? {}, null, 2);
  return result === undefined ? '{}' : result;
}

function parseList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function toggleValue<T extends string>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function compactPerformance(
  thresholds: NonNullable<ScenarioDefinition['performance']>['thresholds'],
  regression: NonNullable<ScenarioDefinition['performance']>['regression'],
): ScenarioDefinition['performance'] {
  const hasThresholds = Boolean(thresholds && Object.keys(thresholds).length);
  const hasRegression = Boolean(regression && Object.keys(regression).length);
  return hasThresholds || hasRegression ? { thresholds: hasThresholds ? thresholds : undefined, regression: hasRegression ? regression : undefined } : undefined;
}

function parseStatusList(value: string): number[] {
  return [...new Set(value.split(',').map((item) => Number.parseInt(item.trim(), 10)).filter((status) => Number.isInteger(status) && status >= 400 && status <= 599))].slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.includes('${')) return false;
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch { return false; }
}

function linkedSuiteLabel(path: string): string {
  if (!path.startsWith('external:')) return path;
  const encoded = path.split(':').at(-1) ?? 'external.csv';
  try { return t('{name} · external file', { name: decodeURIComponent(encoded) }); } catch { return t('External suite'); }
}

export default SettingsWorkspace;
