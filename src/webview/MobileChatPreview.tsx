import React, { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import type { WebviewPayload } from '../shared/protocol';
import type {
  ChatMessage,
  Citation,
  FormDefinition,
  FormField,
  InteractionContext,
  MessagePart,
  SessionSnapshot,
  Starter,
  TurnStageProfile
} from '../shared/types';
import { formatNumber, t } from './i18n';
import { IconButton, ProductIcon } from './Icon';
import './mobileChatPreview.css';

/** The viewport presets used by the preview device. */
export const MOBILE_CHAT_VIEWPORTS = [
  { id: '390x844', label: '390 × 844', width: 390, height: 844 },
  { id: '375x812', label: '375 × 812', width: 375, height: 812 },
  { id: '430x932', label: '430 × 932', width: 430, height: 932 }
] as const;

export type MobileChatViewport = (typeof MOBILE_CHAT_VIEWPORTS)[number]['id'];
/** Short alias for consumers that only need the available viewport presets. */
export const MOBILE_VIEWPORTS = MOBILE_CHAT_VIEWPORTS;
export type MobileViewport = MobileChatViewport;

type SendMessage = (text?: string, interaction?: InteractionContext) => void;
type SetDraft = (value: string) => void;
type PostMessage = (message: WebviewPayload) => void;

export interface MobileChatPreviewProps {
  profile: TurnStageProfile;
  snapshot?: SessionSnapshot;
  active: boolean;
  continuationBlocked: boolean;
  draft: string;
  setDraft: SetDraft;
  send: SendMessage;
  post: PostMessage;
  /** Message selected by the debug inspector, if the host keeps selection state. */
  selectedMessageId?: string;
  onSelectMessage?: (messageId: string) => void;
  /** A controlled viewport. When omitted, the preview starts at 390 × 844. */
  viewport?: MobileChatViewport;
  /** Used when the parent wants to observe or persist the size picker. */
  onViewportChange?: (viewport: MobileChatViewport) => void;
  className?: string;
}

/**
 * An isolated, dependency-free mobile rendering of the existing TurnStage
 * conversation. It deliberately receives host callbacks instead of importing
 * the webview singleton, so it can be embedded in the Chat tab or in a design
 * review surface without changing the current message transport.
 */
export function MobileChatPreview({
  profile,
  snapshot,
  active,
  continuationBlocked,
  draft,
  setDraft,
  send,
  post,
  selectedMessageId,
  onSelectMessage,
  viewport: controlledViewport,
  onViewportChange,
  className
}: MobileChatPreviewProps): React.JSX.Element {
  const [uncontrolledViewport, setUncontrolledViewport] = useState<MobileChatViewport>(controlledViewport ?? '390x844');
  const viewport = controlledViewport ?? uncontrolledViewport;
  const viewportDefinition = MOBILE_CHAT_VIEWPORTS.find((item) => item.id === viewport) ?? MOBILE_CHAT_VIEWPORTS[0];
  const stageRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const snapshotMessages = snapshot?.messages ?? [];
  const opening = snapshot?.opening ?? staticOpening(profile);
  const statusText = previewStatus(snapshot, active, continuationBlocked);
  const previewId = useId();
  const viewportId = `${previewId}-viewport`;
  const viewportStyle = {
    '--mcp-viewport-width': `${viewportDefinition.width}px`,
    '--mcp-viewport-height': `${viewportDefinition.height}px`,
    '--mcp-preview-scale': previewScale
  } as CSSProperties;

  useEffect(() => {
    if (controlledViewport) setUncontrolledViewport(controlledViewport);
  }, [controlledViewport]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateScale = () => {
      const rect = stage.getBoundingClientRect();
      const inset = 16;
      const widthScale = Math.max(0, rect.width - inset) / viewportDefinition.width;
      const heightScale = Math.max(0, rect.height - inset) / viewportDefinition.height;
      setPreviewScale(Math.max(0.25, Math.min(1, widthScale, heightScale)));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [viewportDefinition.height, viewportDefinition.width]);

  const selectViewport = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as MobileChatViewport;
    setUncontrolledViewport(next);
    onViewportChange?.(next);
  };

  const rootClassName = ['mobile-chat-preview', className].filter(Boolean).join(' ');

  return <section className={rootClassName} aria-label={t('Mobile chat preview')}>
    <header className="mobile-chat-preview__toolbar">
      <span className="mobile-chat-preview__toolbar-icon" title={t('Mobile preview')} aria-label={t('Mobile preview')}><ProductIcon name="device-mobile" /></span>
      <label className="mobile-chat-preview__viewport-control" htmlFor={viewportId}>
        <span className="mobile-chat-preview__sr-only">{t('Viewport')}</span>
        <select id={viewportId} value={viewport} onChange={selectViewport} aria-label={t('Viewport')} title={t('Viewport')}>
          {MOBILE_CHAT_VIEWPORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
    </header>

    <div ref={stageRef} className="mobile-chat-preview__stage">
      <div className="mobile-chat-preview__device-fit" style={viewportStyle}>
        <div className="mobile-chat-preview__device" data-viewport={viewport}>
        <div className="mobile-chat-preview__safe-area" role="group" aria-label={t('Safe area and status bar')}>
          <span className="mobile-chat-preview__time" aria-label={t('Status bar time')}>9:41</span>
          <span className="mobile-chat-preview__status-icons" aria-hidden="true"><span className="mobile-chat-preview__signal"><span /><span /><span /></span><span className="mobile-chat-preview__battery"><span /></span></span>
        </div>
        <MobileAppHeader profile={profile} snapshot={snapshot} active={active} />

        <div className="mobile-chat-preview__content">
          {profile.controls && profile.controls.length > 0 && <MobileControls profile={profile} snapshot={snapshot} active={active} post={post} />}
          <div className="mobile-chat-preview__messages" role="log" aria-label={t('Conversation messages')} aria-live="polite" aria-relevant="additions text">
            {snapshot?.sessionState === 'notStarted' && profile.opening?.mode === 'request' && <StartSessionCard post={post} headingId={`${previewId}-start-heading`} />}
            {snapshot?.sessionState === 'failed' && profile.opening?.mode === 'request' && <OpeningError profile={profile} snapshot={snapshot} post={post} headingId={`${previewId}-opening-error-heading`} />}
            {opening && componentVisible(profile, 'opening') && <OpeningCard profile={profile} opening={opening} active={active} setDraft={setDraft} send={send} post={post} headingId={`${previewId}-opening-heading`} />}
            {snapshotMessages.map((message) => <MobileMessage key={message.id} profile={profile} message={message} post={post} send={send} setDraft={setDraft} selected={selectedMessageId === message.id} onSelectMessage={onSelectMessage} />)}
            {!snapshot && <p className="mobile-chat-preview__empty" role="status">{t('Loading conversation…')}</p>}
            {snapshot && snapshotMessages.length === 0 && !opening && snapshot.sessionState !== 'notStarted' && <p className="mobile-chat-preview__empty">{t('No messages yet. Send a message to begin.')}</p>}
            {continuationBlocked && <p className="mobile-chat-preview__continuation" role="status">{t('Continuation is disabled after this error. Start a new conversation to send another message.')}</p>}
          </div>
        </div>

          <MobileComposer profile={profile} active={active} stopping={snapshot?.turnState === 'stopping'} continuationBlocked={continuationBlocked} draft={draft} setDraft={setDraft} send={send} post={post} />
        </div>
      </div>
    </div>
    <p className="mobile-chat-preview__status" role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
  </section>;
}

/** Default export makes the component convenient to consume from a preview host. */
export default MobileChatPreview;

function MobileAppHeader({ profile, snapshot, active }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; active: boolean }): React.JSX.Element {
  const state = active ? snapshot?.turnState ?? 'streaming' : snapshot?.turnState ?? snapshot?.sessionState ?? 'notStarted';
  return <header className="mobile-chat-preview__app-header">
    <div className="mobile-chat-preview__app-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</div>
    <div className="mobile-chat-preview__app-heading">
      <strong>{profile.name}</strong>
      <span>{profile.environment ?? t('No environment')} · {humanize(state)}</span>
    </div>
    <span className={`mobile-chat-preview__state mobile-chat-preview__state--${state}`} aria-label={t('Conversation status: {status}', { status: humanize(state) })}><span aria-hidden="true">●</span></span>
  </header>;
}

function MobileControls({ profile, snapshot, active, post }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; active: boolean; post: PostMessage }): React.JSX.Element {
  return <details className="mobile-chat-preview__controls">
    <summary>{t('Session controls')}</summary>
    <div className="mobile-chat-preview__controls-grid">
      {profile.controls?.map((control) => {
        const id = `mobile-chat-preview-control-${slug(control.id)}`;
        const locked = interactionLocked(profile, control.id, active);
        const value = snapshot?.controls[control.id] ?? control.default;
        return <div className="mobile-chat-preview__control" key={control.id}>
          <label htmlFor={id}>{control.label}</label>
          {control.type === 'select' ? <select id={id} value={String(value ?? '')} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.value })}>
            {control.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select> : control.type === 'boolean' ? <input id={id} type="checkbox" checked={Boolean(value)} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.checked })} /> : <input id={id} type="text" value={String(value ?? '')} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.value })} />}
        </div>;
      })}
    </div>
  </details>;
}

function StartSessionCard({ post, headingId }: { post: PostMessage; headingId: string }): React.JSX.Element {
  return <section className="mobile-chat-preview__session-start" aria-labelledby={headingId}>
    <h3 id={headingId}>{t('Start session')}</h3>
    <button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="button" onClick={() => post({ type: 'session.start' })}>{t('Start session')}</button>
  </section>;
}

function OpeningError({ profile, snapshot, post, headingId }: { profile: TurnStageProfile; snapshot: SessionSnapshot; post: PostMessage; headingId: string }): React.JSX.Element {
  const error = snapshot.errors.at(-1)?.message ?? t('The opening content could not be loaded.');
  return <section className="mobile-chat-preview__opening-error" role="alert" aria-labelledby={headingId}>
    <h3 id={headingId}>{t('Opening request failed')}</h3>
    <p>{error}</p>
    <div className="mobile-chat-preview__action-row">
      <button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="button" onClick={() => post({ type: 'opening.retry' })}>{t('Retry opening')}</button>
      {profile.opening?.fallbacks?.length ? <button className="mobile-chat-preview__button" type="button" onClick={() => post({ type: 'opening.useFallback' })}>{t('Use fallback')}</button> : null}
    </div>
  </section>;
}

function OpeningCard({ profile, opening, active, setDraft, send, post, headingId }: { profile: TurnStageProfile; opening: NonNullable<SessionSnapshot['opening']>; active: boolean; setDraft: SetDraft; send: SendMessage; post: PostMessage; headingId: string }): React.JSX.Element {
  return <section className="mobile-chat-preview__opening" aria-labelledby={headingId}>
    <span className="mobile-chat-preview__opening-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</span>
    <div className="mobile-chat-preview__opening-content"><h3 id={headingId}>{opening.message}</h3>
      {componentVisible(profile, 'starters') && opening.starters.length > 0 && <div className="mobile-chat-preview__starter-list" aria-label={t('Starter prompts')}>
        {opening.starters.map((starter) => <StarterButton key={starter.id} starter={starter} active={active} setDraft={setDraft} send={send} post={post} />)}
      </div>}
    </div>
  </section>;
}

function StarterButton({ starter, active, setDraft, send, post }: { starter: Starter; active: boolean; setDraft: SetDraft; send: SendMessage; post: PostMessage }): React.JSX.Element {
  const invoke = () => {
    if (starter.behavior === 'fill') setDraft(starter.prompt);
    else if (starter.behavior === 'action' && starter.actionId) {
      post({ type: 'action.invoke', actionId: starter.actionId });
    } else send(starter.prompt, { kind: 'starter', starterId: starter.id });
  };
  return <button className="mobile-chat-preview__chip" type="button" disabled={active} onClick={invoke}>{starter.label}</button>;
}

function MobileComposer({ profile, active, stopping, continuationBlocked, draft, setDraft, send, post }: { profile: TurnStageProfile; active: boolean; stopping: boolean; continuationBlocked: boolean; draft: string; setDraft: SetDraft; send: SendMessage; post: PostMessage }): React.JSX.Element {
  const composing = useRef(false);
  const inputId = useId();
  const placeholder = profile.ui?.composer?.placeholder ?? t('Message TurnStage…');
  const composerLocked = interactionLocked(profile, 'composer', active);
  const canSend = !active && !continuationBlocked && !composerLocked;
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (active) {
      if (!stopping) post({ type: 'request.abort' });
    } else if (canSend && draft.trim()) send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current) return;
    const behavior = event.shiftKey ? profile.ui?.composer?.shiftEnterBehavior ?? 'newline' : profile.ui?.composer?.enterBehavior ?? 'send';
    if (behavior === 'send' && (active || canSend) && (active || draft.trim())) {
      event.preventDefault();
      submit();
    }
  };
  const inputDisabled = continuationBlocked || (active && composerLocked);
  return <form className="mobile-chat-preview__composer" onSubmit={submit}>
    <label className="mobile-chat-preview__sr-only" htmlFor={inputId}>{t('Message')}</label>
    <textarea id={inputId} rows={1} value={draft} placeholder={placeholder} disabled={inputDisabled} aria-describedby={continuationBlocked ? `${inputId}-blocked` : undefined} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={onKeyDown} />
    <button className={`mobile-chat-preview__send mobile-chat-preview__button ${active ? 'mobile-chat-preview__button--danger' : 'mobile-chat-preview__button--primary'}`} type="submit" disabled={active ? stopping : !draft.trim() || !canSend} aria-label={active ? (stopping ? t('Stopping…') : t('Stop response')) : t('Send message')} title={active ? (stopping ? t('Stopping…') : t('Stop response')) : t('Send message')}><ProductIcon name={active ? 'stop' : 'send'} /></button>
    {continuationBlocked && <span id={`${inputId}-blocked`} className="mobile-chat-preview__composer-hint">{t('Start a new conversation to continue.')}</span>}
  </form>;
}

function MobileMessage({ profile, message, post, send, setDraft, selected, onSelectMessage }: { profile: TurnStageProfile; message: ChatMessage; post: PostMessage; send: SendMessage; setDraft: SetDraft; selected: boolean; onSelectMessage?: (messageId: string) => void }): React.JSX.Element {
  const parts = message.parts ?? [];
  const text = parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text ?? '').join('');
  const citations = message.citations ?? [];
  const actions = message.actions ?? [];
  const followups = message.followups ?? [];
  const roleLabel = humanizeRole(message.role);
  const statusLabel = humanize(message.status);
  const messageLabelValues = { role: roleLabel, status: statusLabel };
  const onMessageClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!onSelectMessage) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button, a, input, select, textarea, summary, form')) return;
    onSelectMessage(message.id);
  };
  const onMessageKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelectMessage || event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    onSelectMessage(message.id);
  };
  return <article className={`mobile-chat-preview__message mobile-chat-preview__message--${message.role} ${selected ? 'mobile-chat-preview__message--selected' : ''}`} data-message-id={message.id} data-status={message.status} data-selected={selected ? 'true' : 'false'} aria-label={t('{role} message, {status}', messageLabelValues)} tabIndex={onSelectMessage ? 0 : undefined} onClick={onMessageClick} onKeyDown={onMessageKeyDown}>
    {message.role !== 'user' && <span className="mobile-chat-preview__message-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</span>}
    <span className="mobile-chat-preview__message-heading"><strong>{roleLabel}</strong><MessageStatus state={message.status} /></span>
    <div className="mobile-chat-preview__message-body">
      {parts.map((part, index) => <MobileMessagePart key={`${part.type}-${index}`} profile={profile} part={part} messageId={message.id} citations={citations} post={post} />)}
      {componentVisible(profile, 'citations') && citations.length > 0 && <CitationList profile={profile} citations={citations} post={post} />}
      {componentVisible(profile, 'responseActions') && message.status === 'completed' && actions.length > 0 && <div className="mobile-chat-preview__action-row" aria-label={t('Response actions')}>{actions.map((action) => <button className={`mobile-chat-preview__button ${action.appearance === 'primary' ? 'mobile-chat-preview__button--primary' : ''}`} type="button" title={action.tooltip} key={action.id} onClick={() => post({ type: 'action.invoke', actionId: action.actionId, sourceMessageId: message.id })}>{action.label}</button>)}</div>}
      {componentVisible(profile, 'followups') && message.status === 'completed' && followups.length > 0 && <div className="mobile-chat-preview__followups" aria-label={t('Follow-up questions')}>{followups.slice(0, 3).map((followup) => <button className="mobile-chat-preview__chip" type="button" title={followup.tooltip} key={followup.id} onClick={() => invokeFollowup(followup, message.id, setDraft, send, post)}>{followup.label}</button>)}</div>}
      <footer className="mobile-chat-preview__message-toolbar">
        <IconButton icon="copy" label={t('Copy')} type="button" onClick={() => post({ type: 'action.invoke', actionId: 'message.copy', sourceMessageId: message.id })} />
        {message.role === 'assistant' && <><IconButton icon="refresh" label={t('Retry')} type="button" onClick={() => post({ type: 'action.invoke', actionId: 'message.retry', sourceMessageId: message.id })} /><IconButton icon="edit" label={t('Edit & resend')} type="button" onClick={() => setDraft(text)} /></>}
      </footer>
    </div>
  </article>;
}

function MobileMessagePart({ profile, part, messageId, citations, post }: { profile: TurnStageProfile; part: MessagePart; messageId: string; citations: Citation[]; post: PostMessage }): React.JSX.Element | null {
  if (part.type === 'text' || part.type === 'markdown') return <MobileText text={part.text ?? ''} />;
  if (part.type === 'citation-reference') {
    if (!componentVisible(profile, 'citations')) return null;
    const citationId = typeof part.citationId === 'string' ? part.citationId : '';
    const index = citations.findIndex((citation) => citation.id === citationId);
    const citationNumber = index >= 0 ? formatNumber(index + 1) : '?';
    const citationLabel = index >= 0 ? citationNumber : t('unknown');
    return <sup><button className="mobile-chat-preview__inline-citation" type="button" aria-label={t('Open citation {index}', { index: citationLabel })} onClick={() => citationId && post({ type: 'citation.open', citationId })}>[{citationNumber}]</button></sup>;
  }
  if (part.type === 'progress') {
    if (!componentVisible(profile, 'progress')) return null;
    const status = String(part.status ?? 'pending');
    return <details className="mobile-chat-preview__part mobile-chat-preview__part--progress" data-status={status} open={status === 'running'}><summary>{profile.ui?.components?.progress?.label ?? t('Progress')} · {humanize(status)}</summary>{part.text && <p>{part.text}</p>}</details>;
  }
  if (part.type === 'tool-call') {
    if (!componentVisible(profile, 'toolCalls')) return null;
    const status = String(part.status ?? 'completed');
    return <details className="mobile-chat-preview__part"><summary>{t('Tool')} · {String(part.name ?? part.toolCallId ?? t('call'))} · {humanize(status)}</summary><JsonPreview value={{ arguments: part.arguments, result: part.result, error: part.error }} /></details>;
  }
  if (part.type === 'diagnostic') {
    if (!componentVisible(profile, 'diagnostics')) return null;
    return <details className="mobile-chat-preview__part"><summary>{t('Diagnostics')}</summary><JsonPreview value={part.diagnostic} /></details>;
  }
  if (part.type === 'usage') return <details className="mobile-chat-preview__part"><summary>{t('Usage')}</summary><JsonPreview value={part.usage} /></details>;
  if (part.type === 'error') return <div className="mobile-chat-preview__error-part" role="alert"><strong>{t('Response failed')}</strong>{part.text && <p>{part.text}</p>}</div>;
  if (part.type === 'form' && isFormDefinition(part.form)) return componentVisible(profile, 'forms') ? <MobileForm form={part.form} messageId={messageId} post={post} /> : null;
  return null;
}

function MobileText({ text }: { text: string }): React.JSX.Element {
  const blocks = text.split(/```/);
  return <div className="mobile-chat-preview__text">{blocks.map((block, index) => index % 2 ? <pre key={index}><code>{block.replace(/^\w+\n/, '')}</code></pre> : block ? <p key={index}>{block}</p> : null)}</div>;
}

function JsonPreview({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="mobile-chat-preview__json"><code>{safeJson(value)}</code></pre>;
}

function CitationList({ profile, citations, post }: { profile: TurnStageProfile; citations: Citation[]; post: PostMessage }): React.JSX.Element {
  return <details className="mobile-chat-preview__citations"><summary>{profile.ui?.components?.citations?.label ?? t('Sources ({count})', { count: formatNumber(citations.length) })}</summary><ol>{citations.map((citation) => <li key={citation.id}><button className="mobile-chat-preview__source" type="button" onClick={() => post({ type: 'citation.open', citationId: citation.id })}>{citation.title ?? citation.sourceName ?? citation.id}</button>{citation.description && <p>{citation.description}</p>}</li>)}</ol></details>;
}

function MobileForm({ form, messageId, post }: { form: FormDefinition; messageId: string; post: PostMessage }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cancelled, setCancelled] = useState(false);
  const formId = `mobile-chat-preview-form-${slug(form.id)}-${slug(messageId)}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = validateForm(form.fields, values);
    setErrors(next);
    const firstError = Object.keys(next)[0];
    if (firstError) {
      document.getElementById(`${formId}-${slug(firstError)}`)?.focus();
      return;
    }
    post({ type: 'form.submit', formId: form.id, values, sourceMessageId: messageId });
  };
  if (cancelled) return <p className="mobile-chat-preview__muted">{t('Form cancelled.')}</p>;
  return <form className="mobile-chat-preview__form" onSubmit={submit} noValidate>
    <h4>{form.title}</h4>
    {form.fields.map((field) => <MobileFormControl key={field.id} field={field} formId={formId} value={values[field.id]} error={errors[field.id]} update={(value) => setValues((current) => ({ ...current, [field.id]: value }))} />)}
    <div className="mobile-chat-preview__action-row"><button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="submit">{t('Submit')}</button><button className="mobile-chat-preview__button" type="button" onClick={() => { setValues({}); setCancelled(true); post({ type: 'form.cancel', formId: form.id, }); }}>{t('Cancel')}</button></div>
  </form>;
}

function MobileFormControl({ field, formId, value, error, update }: { field: FormField; formId: string; value: unknown; error?: string; update: (value: unknown) => void }): React.JSX.Element {
  const id = `${formId}-${slug(field.id)}`;
  const describedBy = error ? `${id}-error` : undefined;
  return <div className="mobile-chat-preview__field">
    <label htmlFor={id}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
    {field.type === 'textarea' ? <textarea id={id} value={String(value ?? '')} maxLength={field.maxLength} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)} /> : field.type === 'select' ? <select id={id} value={String(value ?? '')} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)}><option value="">{t('Select…')}</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === 'checkbox' ? <input id={id} type="checkbox" checked={Boolean(value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.checked)} /> : <input id={id} type={field.type} value={String(value ?? '')} maxLength={field.maxLength} pattern={field.pattern} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)} />}
    {error && <p className="mobile-chat-preview__field-error" id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}

function validateForm(fields: FormField[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (field.required && (value === undefined || value === '' || value === false)) errors[field.id] = t('{field} is required.', { field: field.label });
    else if (field.maxLength && String(value ?? '').length > field.maxLength) errors[field.id] = t('Use no more than {count} characters.', { count: formatNumber(field.maxLength) });
    else if (field.pattern) {
      try {
        if (value && !new RegExp(field.pattern).test(String(value))) errors[field.id] = t('{field} has an invalid format.', { field: field.label });
      } catch {
        errors[field.id] = t('The profile contains an invalid validation pattern.');
      }
    }
  }
  return errors;
}

function invokeFollowup(followup: NonNullable<ChatMessage['followups']>[number], messageId: string, setDraft: SetDraft, send: SendMessage, post: PostMessage): void {
  if (followup.behavior === 'fill') setDraft(followup.prompt);
  else if (followup.behavior === 'action' && followup.actionId) post({ type: 'action.invoke', actionId: followup.actionId, sourceMessageId: messageId });
  else send(followup.prompt, { kind: 'followup', followupId: followup.id, sourceMessageId: messageId });
}

function MessageStatus({ state }: { state: string }): React.JSX.Element {
  return <span className={`mobile-chat-preview__message-status mobile-chat-preview__message-status--${state}`}><span aria-hidden="true">●</span> {humanize(state)}</span>;
}

function componentVisible(profile: TurnStageProfile, name: string): boolean {
  return profile.ui?.components?.[name]?.visible !== false;
}

function staticOpening(profile: TurnStageProfile): NonNullable<SessionSnapshot['opening']> | undefined {
  if (profile.opening?.mode !== 'static' || !profile.opening.message) return undefined;
  return { message: profile.opening.message, starters: profile.opening.starters ?? [] };
}

function interactionLocked(profile: TurnStageProfile, id: string, active: boolean): boolean {
  if (!active) return false;
  const policy = profile.ui?.locks?.whileTurnActive;
  if (policy?.allow?.includes(id)) return false;
  if (policy?.disable?.includes(id)) return true;
  return !['stop', 'message.copy', 'inspector.open', 'history.open', 'configuration.open'].includes(id);
}

function previewStatus(snapshot: SessionSnapshot | undefined, active: boolean, continuationBlocked: boolean): string {
  if (continuationBlocked) return t('Continuation is disabled. Start a new conversation.');
  if (active) return snapshot?.turnState === 'stopping' ? t('Stopping response') : t('Response streaming');
  if (snapshot?.turnState === 'completed') return t('Response completed');
  if (snapshot?.turnState === 'failed') return t('Response failed');
  if (snapshot?.turnState === 'aborted') return t('Response stopped');
  return '';
}

function isFormDefinition(value: unknown): value is FormDefinition {
  if (!value || typeof value !== 'object') return false;
  const form = value as Partial<FormDefinition>;
  return form.type === 'form' && typeof form.id === 'string' && typeof form.title === 'string' && Array.isArray(form.fields);
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? '' : result;
  } catch {
    return t('Unable to display this value.');
  }
}

function humanize(value: string): string {
  const fallback = humanizeFallback(value);
  const stateKey = 'state.' + value;
  const translated = t(stateKey);
  return translated && translated !== stateKey ? translated : t(fallback);
}

function humanizeRole(value: ChatMessage['role']): string {
  const fallback = humanizeFallback(value);
  const roleKey = `role.${value}`;
  const translated = t(roleKey);
  return translated && translated !== roleKey ? translated : t(fallback);
}

function humanizeFallback(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/^./, (char) => char.toUpperCase());
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}
