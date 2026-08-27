import React, { useEffect, useId, useState } from 'react';
import type { MappingTestResult, WebviewPayload } from '../shared/protocol';
import type { SessionSnapshot, TurnStageProfile } from '../shared/types';
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
  { id: 'chat-ui', label: 'Chat UI', description: 'Layout, composer, visibility, and interaction locks.' },
  { id: 'history-errors', label: 'History & Errors', description: 'Local run retention and failure behavior.' },
  { id: 'security', label: 'Security', description: 'Trust, URI schemes, domains, and commands.' }
] as const;

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id'];

export interface SettingsWorkspaceProps {
  profile: TurnStageProfile;
  post: SettingsWorkspacePost;
  mappingTestResult?: MappingTestResult;
  snapshot?: SessionSnapshot;
  requestPreview?: unknown;
  remoteName?: string;
  /** The section selected by the host tree/editor. */
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
}

type PatchPath = Array<string | number>;

/** A profile-scoped, single-section settings editor. */
export function SettingsWorkspace({
  profile,
  post,
  mappingTestResult,
  snapshot,
  requestPreview,
  remoteName,
  section,
  onSectionChange
}: SettingsWorkspaceProps): React.JSX.Element {
  const patch = (path: PatchPath, value: unknown) => post({ type: 'profile.patch', path, value });

  const active = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0];
  const sectionTitleId = `profile-configuration-section-title-${active.id}`;
  const sectionDescriptionId = `profile-configuration-section-description-${active.id}`;
  return <div className="settings-workspace">
    <header className="settings-header" aria-label={t('Profile configuration toolbar')}>
      <div className="settings-title-block">
        <p id="profile-configuration-title" className="settings-surface-title">{t('Profile Configuration')}</p>
        <p className="settings-subtitle"><span>{profile.name || t('Untitled profile')}</span><span aria-hidden="true">·</span><code>{profile.id}</code><span aria-hidden="true">·</span><span>{profile.environment || t('No environment selected')}</span></p>
      </div>
      <div className="settings-header-actions" aria-label={t('Profile configuration actions')}>
        <IconButton icon="file-code" label={t('Open JSONC')} type="button" onClick={() => post({ type: 'profile.openAsText' })} />
        <IconButton icon="check" label={t('Validate')} type="button" className="settings-primary-action" onClick={() => post({ type: 'profile.validate' })} />
      </div>
    </header>

    <div className="settings-main" id="settings-content">
      <div className="settings-content-layout">
        <nav className="settings-section-nav" aria-label={t('Profile configuration sections')}>
          <div className="settings-section-nav-list">
            {SETTINGS_SECTIONS.map((item) => <button key={item.id} type="button" className={active.id === item.id ? 'is-active' : ''} aria-current={active.id === item.id ? 'page' : undefined} onClick={() => onSectionChange(item.id)}>{t(item.label)}</button>)}
          </div>
        </nav>
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
          {active.id === 'request' && <RequestSection profile={profile} requestPreview={requestPreview} remoteName={remoteName} patch={patch} />}
          {active.id === 'stream-mapping' && <StreamMappingSection profile={profile} snapshot={snapshot} mappingTestResult={mappingTestResult} post={post} patch={patch} />}
          {active.id === 'chat-ui' && <ChatUiSection profile={profile} post={post} />}
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

function RequestSection({ profile, requestPreview, remoteName, patch }: { profile: TurnStageProfile; requestPreview?: unknown; remoteName?: string; patch: (path: PatchPath, value: unknown) => void }): React.JSX.Element {
  const request = profile.conversation.send;
  const preview = isRecord(requestPreview) ? requestPreview : undefined;
  const previewUrl = typeof preview?.url === 'string' ? preview.url : request.url;
  const loopback = isLoopbackUrl(previewUrl);
  return <div className="settings-section-stack">
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

function SectionHeading({ id, title, description }: { id: string; title: string; description: string }): React.JSX.Element {
  return <div className="settings-card-heading"><div><h2 id={id}>{title}</h2><p className="settings-card-description">{description}</p></div></div>;
}

function SettingField({ label, id, hint, error, wide, children }: { label: string; id: string; hint?: string; error?: string; wide?: boolean; children: React.ReactNode }): React.JSX.Element {
  const descriptionId = useId();
  const describedBy = hint || error ? descriptionId : undefined;
  return <div className={`settings-field ${wide ? 'settings-field-wide' : ''}`}><label htmlFor={id}>{label}</label>{React.isValidElement(children) ? React.cloneElement(children, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined } as Record<string, unknown>) : children}{(hint || error) && <p id={descriptionId} className={error ? 'settings-field-error' : 'settings-field-hint'}>{error || hint}</p>}</div>;
}

function NumberSettingField({ label, id, value, placeholder, min, max, hint, onCommit }: { label: string; id: string; value?: number; placeholder: string; min: number; max: number; hint?: string; onCommit: (value: number | undefined) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (!draft.trim()) { if (value !== undefined) onCommit(undefined); return; }
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
  };
  return <SettingField label={label} id={id} hint={hint}><input id={id} type="number" min={min} max={max} value={draft} placeholder={placeholder} inputMode="numeric" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(value === undefined ? '' : String(value)); event.currentTarget.blur(); } }} /></SettingField>;
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

function JsonPatchField({ label, id, value, hint, onCommit }: { label: string; id: string; value: unknown; hint?: string; onCommit: (value: unknown) => void }): React.JSX.Element {
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
  return <div className="settings-field settings-field-wide"><label htmlFor={id}>{label}</label><div className="settings-field-control"><textarea id={id} className="settings-code-input" rows={8} value={draft} spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={description ? descriptionId : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(stringifyJson(value)); setError(''); event.currentTarget.blur(); } if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); event.currentTarget.blur(); } }} /><button type="button" className="settings-apply-action" onClick={commit}>{t('Apply JSON')}</button>{description && <p id={descriptionId} className={error ? 'settings-field-error' : 'settings-field-hint'}>{description}</p>}</div></div>;
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
