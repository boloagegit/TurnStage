import React, { useEffect, useId, useState } from 'react';
import type { MappingTestResult, WebviewPayload } from '../shared/protocol';
import type { AdversarialForbidDefinition, AdversarialResultSummary, CampaignDashboardV1, ConnectionDoctorSummary, QualityRubricDefinition, ScenarioAssertionDefinition, ScenarioAssertionOperator, ScenarioDefinition, ScenarioPerformanceMetric, ScenarioReportFormat, ScenarioStepDefinition, SessionSnapshot, TestCampaignDefinition, TurnStageProfile } from '../shared/types';
import { EventsEditor, FlowEditor, UiConfigEditor } from './configEditors';
import { IconButton, ProductIcon } from './Icon';
import { ClipboardButton } from './ClipboardButton';
import { formatNumber, localizeHumanized, t } from './i18n';
import './settingsWorkspace.css';

/**
 * Keep this callback local to the workspace so it can also be used by hosts
 * that add the protocol envelope outside of the React tree.
 */
export type SettingsWorkspacePost = (message: WebviewPayload) => void;

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
  /** The section selected by the host tree/editor. */
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  /** Use the compact, single-pane layout beside the Chat preview. */
  embedded?: boolean;
}

type PatchPath = Array<string | number>;

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
  section,
  onSectionChange,
  embedded = false
}: SettingsWorkspaceProps): React.JSX.Element {
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
        <IconButton icon="file-code" label={t('Open JSONC')} type="button" onClick={() => post({ type: 'profile.openAsText' })} />
        <IconButton icon="check" label={t('Validate')} type="button" className="settings-primary-action" onClick={() => post({ type: 'profile.validate' })} />
      </div>
    </header>

    <div className="settings-main" id="settings-content">
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
          {active.id === 'scenario-tests' && <ScenarioTestsSection profile={profile} patch={patch} post={post} testResults={testResults} campaignDashboard={campaignDashboard} />}
          {active.id === 'history-errors' && <HistoryErrorsSection profile={profile} snapshot={snapshot} patch={patch} />}
          {active.id === 'security' && <SecuritySection profile={profile} snapshot={snapshot} remoteName={remoteName} patch={patch} />}
        </section>
      </div>
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

function ScenarioTestsSection({ profile, patch, post, testResults, campaignDashboard }: { profile: TurnStageProfile; patch: (path: PatchPath, value: unknown) => void; post: SettingsWorkspacePost; testResults: AdversarialResultSummary[]; campaignDashboard?: CampaignDashboardV1 }): React.JSX.Element {
  const scenarios = profile.tests?.scenarios ?? [];
  const qualityRubrics = profile.tests?.qualityRubrics ?? [];
  const [undo, setUndo] = useState<{ label: string; scenarios: ScenarioDefinition[] }>();
  const adversarialEntries = scenarios.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => scenario.adversarial);
  const contractEntries = scenarios.map((scenario, index) => ({ scenario, index })).filter(({ scenario }) => !scenario.adversarial);
  const save = (next: ScenarioDefinition[]) => patch(['tests', 'scenarios'], next);
  const saveDestructive = (label: string, next: ScenarioDefinition[]) => {
    setUndo({ label, scenarios: structuredClone(scenarios) });
    save(next);
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
  };
  const saveQualityRubrics = (value: QualityRubricDefinition[] | undefined) => patch(['tests', 'qualityRubrics'], value);
  const addQualityRubric = () => {
    const ordinal = qualityRubrics.length + 1;
    const id = uniqueId(new Set(qualityRubrics.map((rubric) => rubric.id)), `quality-${ordinal}`);
    saveQualityRubrics([...qualityRubrics, { id, name: t('Quality rubric {number}', { number: formatNumber(ordinal) }), criteria: [{ id: 'criterion-1', label: t('Criterion 1'), description: t('Describe the observable quality expected from the disclosed response.') }] }]);
  };
  const campaigns = profile.tests?.campaigns ?? [];
  const saveCampaigns = (value: TestCampaignDefinition[] | undefined) => profile.tests ? patch(['tests', 'campaigns'], value) : patch(['tests'], { scenarios: [], ...(value ? { campaigns: value } : {}) });
  const addCampaign = () => {
    const ordinal = campaigns.length + 1;
    const id = uniqueId(new Set(campaigns.map((campaign) => campaign.id)), `campaign-${ordinal}`);
    saveCampaigns([...campaigns, { id, name: t('Campaign {number}', { number: formatNumber(ordinal) }), selectors: { tagMode: 'all' }, runPolicy: { repetitions: 1, maxConcurrency: 3, maxRequests: 1000, maxDurationMs: 3_600_000 } }]);
  };
  return <div className="settings-section-stack">
    <section className="settings-card" aria-labelledby="test-campaigns-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="test-campaigns-heading">{t('Test campaigns')}</h2><p className="settings-card-description">{t('Create a bounded, repeatable selection of existing cases. Campaign history stores metadata only; raw prompts and evidence remain session-scoped.')}</p></div><button type="button" disabled={campaigns.length >= 50} onClick={addCampaign}>{t('Add campaign')}</button></div>
      {!campaigns.length ? <div className="settings-empty settings-empty--action"><span>{t('No test campaigns configured.')}</span><button type="button" onClick={addCampaign}>{t('Add campaign')}</button></div> : <div className="campaign-list">
        {campaigns.map((campaign, index) => {
          const dashboard = campaignDashboard?.campaigns.find((item) => item.definition.id === campaign.id);
          const latest = dashboard?.latest;
          const update = (value: TestCampaignDefinition) => saveCampaigns(replaceAt(campaigns, index, value));
          return <article className="campaign-card" key={`${campaign.id}-${index}`}>
            <div className="campaign-card__heading"><div><strong>{campaign.name || campaign.id}</strong><code>{campaign.id}</code></div>{latest ? <span className={`campaign-status campaign-status--${latest.status}`}>{t(localizeHumanized(latest.status))}</span> : <span className="campaign-status">{t('Not run')}</span>}</div>
            <div className="settings-form-grid">
              <SettingField label={t('Name')} id={`campaign-${index}-name`}><PatchInput id={`campaign-${index}-name`} value={campaign.name} onCommit={(name) => update({ ...campaign, name })} /></SettingField>
              <NumberSettingField label={t('Repetitions per adversarial case')} id={`campaign-${index}-repetitions`} value={campaign.runPolicy?.repetitions} placeholder="1" min={1} max={100} hint={t('Conversation contracts run once; adversarial cases use this sample size.')} onCommit={(repetitions) => update({ ...campaign, runPolicy: { ...(campaign.runPolicy ?? {}), repetitions } })} />
              <ListPatchField label={t('Case IDs')} id={`campaign-${index}-cases`} value={campaign.selectors?.caseIds ?? []} placeholder="jailbreak-basic, leakage-check" hint={t('Leave empty to select by suite or tags.')} onCommit={(caseIds) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), caseIds: caseIds.length ? caseIds : undefined } })} />
              <ListPatchField label={t('Suite IDs')} id={`campaign-${index}-suites`} value={campaign.selectors?.suiteIds ?? []} placeholder="security-regression" hint={t('Optional exact suite IDs.')} onCommit={(suiteIds) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), suiteIds: suiteIds.length ? suiteIds : undefined } })} />
              <ListPatchField label={t('Selector tags')} id={`campaign-${index}-tags`} value={campaign.selectors?.tags ?? []} placeholder="security, release" hint={t('All tags must match unless tag mode is changed in JSONC.')} onCommit={(tags) => update({ ...campaign, selectors: { ...(campaign.selectors ?? {}), tags: tags.length ? tags : undefined } })} />
              <ListPatchField label={t('Coverage tags')} id={`campaign-${index}-coverage`} value={campaign.coverageTags ?? []} placeholder="prompt-boundary, privacy" hint={t('Missing required tags are reported before and after execution.')} onCommit={(coverageTags) => update({ ...campaign, coverageTags: coverageTags.length ? coverageTags : undefined })} />
            </div>
            {latest && <div className={`campaign-summary${latest.diff?.regressions ? ' has-regressions' : ''}`} role="status"><span>{t('{completed}/{planned} cases complete', { completed: formatNumber(latest.cases.filter((item) => item.sampleComplete).length), planned: formatNumber(latest.plan.selectedCases) })}</span><span>{t('{percent}% coverage', { percent: formatNumber(latest.coverage.percent) })}</span>{latest.diff ? <span className={latest.diff.regressions ? 'is-regression' : ''}>{t(latest.diff.regressions === 1 ? '{count} regression' : '{count} regressions', { count: formatNumber(latest.diff.regressions) })}</span> : null}</div>}
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
        })}
      </div>}
    </section>
    <section className="settings-card" aria-labelledby="adversarial-tests-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="adversarial-tests-heading">{t('Adversarial tests')}</h2><p className="settings-card-description">{t('Replay known attack messages and record whether observable prohibited effects occurred. Timeout and incomplete evidence never count as resistance.')}</p></div><button type="button" onClick={addAdversarial}>{t('Add case')}</button></div>
      <div className="copilot-profile-doctor"><div><strong>{t('Profile Doctor')}</strong><span>{t('Ask Copilot to explain validation, timeout, streaming, and mapping configuration evidence without exposing secrets.')}</span></div><button type="button" onClick={() => post({ type: 'copilot.profileDoctor' })}>{t('Diagnose profile with Copilot')}</button></div>
      <div className="adversarial-file-actions" role="group" aria-label={t('Bulk adversarial test files')}>
        <details><summary>{t('Import')}</summary><div>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importJsonc' })}>{t('Import JSONC copy')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importCsv' })}>{t('Import CSV')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'importJsonl' })}>{t('Import JSONL')}</button>
        </div></details>
        <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'linkJsonc' })}>{t('Link JSONC suite')}</button>
        <details><summary>{t('Export')}</summary><div>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportJsonc' })}>{t('Export JSONC')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportCsv' })}>{t('Export CSV')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'exportJsonl' })}>{t('Export JSONL')}</button>
          <button type="button" onClick={() => post({ type: 'adversarial.file', action: 'csvTemplate' })}>{t('CSV template')}</button>
        </div></details>
      </div>
      {undo && <div className="settings-undo" role="status"><span>{undo.label}</span><button type="button" onClick={() => { save(undo.scenarios); setUndo(undefined); }}>{t('Undo')}</button><IconButton type="button" icon="clear-all" label={t('Dismiss undo')} onClick={() => setUndo(undefined)} /></div>}
      {(profile.tests?.adversarialSuites?.length ?? 0) > 0 && <div className="adversarial-linked-suites"><strong>{t('Linked suites')}</strong><ul>{profile.tests!.adversarialSuites!.map((path, index) => <li key={`${path}-${index}`}><code>{path}</code><IconButton type="button" icon="trash" label={t('Unlink suite {path}', { path })} onClick={() => patch(['tests', 'adversarialSuites'], profile.tests!.adversarialSuites!.filter((_, itemIndex) => itemIndex !== index))} /></li>)}</ul></div>}
      {!adversarialEntries.length ? <div className="settings-empty settings-empty--action"><span>{t('No inline adversarial cases configured.')}</span><button type="button" onClick={addAdversarial}>{t('Add case')}</button></div> : <div className="scenario-list adversarial-case-list">
        {adversarialEntries.map(({ scenario, index }) => <ScenarioEditor key={`${scenario.id}-${index}`} scenario={scenario} index={index} onChange={(value) => save(replaceAt(scenarios, index, value))} onDestructiveChange={(value, label) => saveDestructive(label, replaceAt(scenarios, index, value))} onDelete={() => saveDestructive(t('Deleted case {name}.', { name: scenario.name || scenario.id }), scenarios.filter((_, itemIndex) => itemIndex !== index))} />)}
      </div>}
      <p className="settings-footnote">{t('CSV uses one row per turn. JSONC suites preserve the full multi-turn structure and are the recommended Git-managed format.')}</p>
    </section>
    <section className="settings-card" aria-labelledby="adversarial-results-heading">
      <div className="settings-card-heading settings-card-heading--actions"><div><h2 id="adversarial-results-heading">{t('Latest adversarial results')}</h2><p className="settings-card-description">{t('Run from Test Explorer, then open the exact Chat, Network, or Events evidence for a result.')}</p></div><div className="adversarial-rerun-actions" role="group" aria-label={t('Run adversarial tests')}><button type="button" onClick={() => post({ type: 'test.runAll' })}>{t('Run all')}</button><button type="button" disabled={!testResults.some((result) => result.outcome !== 'resisted')} onClick={() => post({ type: 'test.rerun', status: 'failed' })}>{t('Rerun failures')}</button><details><summary>{t('More reruns')}</summary><div><button type="button" disabled={!testResults.some((result) => result.repetitions?.stability === 'unstable')} onClick={() => post({ type: 'test.rerun', status: 'unstable' })}>{t('Unstable')}</button><button type="button" disabled={!testResults.some((result) => result.repetitions?.sampleComplete === false)} onClick={() => post({ type: 'test.rerun', status: 'incomplete' })}>{t('Incomplete')}</button></div></details></div></div>
      {!testResults.length ? <p className="settings-empty">{t('No adversarial results in this Extension Host session.')}</p> : <ul className="adversarial-result-list">{testResults.map((result) => <li key={`${result.scenarioId}-${result.evidenceId}`}>
        <div className="adversarial-result-identity"><strong>{result.scenarioName}</strong><code>{result.scenarioId}</code></div>
        <span className={`adversarial-outcome adversarial-outcome--${result.outcome}`}><ProductIcon name={result.outcome === 'resisted' ? 'check' : result.outcome === 'attackSucceeded' ? 'target' : 'warning'} />{t(adversarialOutcomeText(result.outcome))}</span>
        <span className="adversarial-result-sample">{result.repetitions ? <>
          <span>{t('{resisted}/{requested} resisted · {completed} attempts', { resisted: formatNumber(result.repetitions.counts.resisted), requested: formatNumber(result.repetitions.requestedAttempts), completed: formatNumber(result.repetitions.completedAttempts) })}</span>
          <small>{t(adversarialStabilityText(result.repetitions.stability))}{result.repetitions.sampleComplete ? '' : ` · ${t('Incomplete sample')}`}</small>
        </> : t('{completed}/{planned} turns', { completed: formatNumber(result.completedTurns), planned: formatNumber(result.plannedTurns) })}</span>
        <span>{formatNumber(result.durationMs)} ms</span>
        <div className="adversarial-result-actions">
          <button type="button" onClick={() => post({ type: 'test.evidence.open', evidenceId: result.evidenceId, location: result.primaryLocation })}>{t('Open evidence')}</button>
          <button type="button" onClick={() => post({ type: 'copilot.diagnose', evidenceId: result.evidenceId, mode: result.repetitions ? 'stability' : 'failure' })}>{t('Diagnose with Copilot')}</button>
          <details><summary>{t('More')}</summary><div>{(result.availableLocations.length ? result.availableLocations : [result.primaryLocation]).map((location) => <button key={`${result.evidenceId}-${location.kind}`} type="button" onClick={() => post({ type: 'test.evidence.open', evidenceId: result.evidenceId, location })}>{t(evidenceLocationText(location.kind))}</button>)}<button type="button" onClick={() => post({ type: 'copilot.qualityReview', evidenceIds: [result.evidenceId] })}>{t('Advisory quality review')}</button></div></details>
        </div>
        {result.reliability && <ReliabilitySummary summary={result.reliability} />}
      </li>)}</ul>}
    </section>
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
  </div>;
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
    <summary>{t('Reliability')} · {percent} · {t(reliabilityVerdictText(summary.verdict))}</summary>
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

export default SettingsWorkspace;
