import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { WebviewPayload } from '../shared/protocol';
import type {
  ChatMessage,
  Citation,
  FormDefinition,
  FormField,
  InteractionContext,
  MessageMetric,
  MessagePart,
  MessageTagRule,
  OpeningInfoBlock,
  SessionSnapshot,
  Starter,
  TurnState,
  TurnStageProfile
} from '../shared/types';
import { formatDateTime, formatDuration, formatNumber, t } from './i18n';
import { IconButton, ProductIcon } from './Icon';
import { JsonSyntax } from './JsonViewer';
import { ClipboardButton } from './ClipboardButton';
import { SafeMarkdown } from './SafeMarkdown';
import { captureChatScreenshot, copyChatScreenshotToClipboard } from './chatScreenshot';
import { resolveComposer, resolveMessageActions, resolveMessageActionVisibility, resolveStreaming, type ResolvedStreaming } from './uiConfig';
import { advanceGraphemeBoundary, calculateRevealStep, resolveRevealPacing } from './streamingReveal';
import { isSafeRegexPattern } from '../shared/regexSafety';
import './mobileChatPreview.css';

export const CHAT_SCROLL_BOTTOM_THRESHOLD = 48;
export const DEFAULT_VISIBLE_CHAT_MESSAGES = 200;

export const CHAT_VIEWPORT_PRESETS = [
  { id: 'mobile-s', label: 'Mobile S', width: 320, height: 568 },
  { id: 'mobile-m', label: 'Mobile M', width: 375, height: 667 },
  { id: 'mobile-l', label: 'Mobile L', width: 425, height: 812 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 768 },
  { id: 'laptop-l', label: 'Laptop L', width: 1440, height: 900 }
] as const;

export type ChatViewportPreset = 'responsive' | 'custom' | (typeof CHAT_VIEWPORT_PRESETS)[number]['id'];
export type ChatViewportZoom = 'fit' | '100' | '75' | '50';
export interface ChatViewportState { preset: ChatViewportPreset; width: number; height: number; zoom: ChatViewportZoom }
export const DEFAULT_CHAT_VIEWPORT: ChatViewportState = { preset: 'responsive', width: 390, height: 844, zoom: 'fit' };

const MIN_VIEWPORT_WIDTH = 280;
const MAX_VIEWPORT_WIDTH = 2560;
const MIN_VIEWPORT_HEIGHT = 320;
const MAX_VIEWPORT_HEIGHT = 2160;

type MessageScrollSnapshot = {
  contentKey: string;
  firstMessageId?: string;
  messageCount: number;
  nearBottom: boolean;
  scrollHeight: number;
  scrollTop: number;
};

const EMPTY_MESSAGES: ChatMessage[] = [];

type SendMessage = (text?: string, interaction?: InteractionContext) => void;
type SetDraft = (value: string) => void;
type PostMessage = (message: WebviewPayload) => void;
export interface MessageActionFeedback { actionId: string; sourceMessageId: string; status: 'pending' | 'success' | 'info' | 'error'; message: string }
export interface VisualFeedback { operation: 'baseline' | 'compare'; status: 'saved' | 'passed' | 'failed'; differencePercent?: number; baselinePath: string; diffPath?: string }

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
  viewport?: ChatViewportState;
  onViewportChange?: (viewport: ChatViewportState) => void;
  onConfigure?: () => void;
  /** Form instances acknowledged by the Extension Host for this editor lifetime. */
  acceptedForms?: ReadonlySet<string>;
  messageActionFeedback?: MessageActionFeedback;
  visualFeedback?: VisualFeedback;
  onMessageActionFeedback?: (feedback: MessageActionFeedback | undefined) => void;
  /** Scroll checkpoint restored after VS Code recreates a hidden Webview DOM. */
  initialMessageScrollTop?: number;
  onMessageScrollTopChange?: (value: number) => void;
  className?: string;
}

/**
 * An isolated, dependency-free responsive rendering of the TurnStage
 * conversation. It receives host callbacks instead of importing
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
  onConfigure,
  acceptedForms,
  messageActionFeedback,
  visualFeedback,
  onMessageActionFeedback,
  initialMessageScrollTop,
  onMessageScrollTopChange,
  className
}: MobileChatPreviewProps): React.JSX.Element {
  const [uncontrolledViewport, setUncontrolledViewport] = useState<ChatViewportState>(controlledViewport ?? DEFAULT_CHAT_VIEWPORT);
  const viewport = controlledViewport ?? uncontrolledViewport;
  const stageRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<MessageScrollSnapshot | undefined>(undefined);
  const restoredMessageScroll = useRef(false);
  const onMessageScrollTopChangeRef = useRef(onMessageScrollTopChange);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [responsiveSize, setResponsiveSize] = useState({ width: viewport.width, height: viewport.height });
  const [fitScale, setFitScale] = useState(1);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [capturingVisual, setCapturingVisual] = useState<'baseline' | 'compare'>();
  const [screenshotStatus, setScreenshotStatus] = useState('');
  const allSnapshotMessages = snapshot?.messages ?? EMPTY_MESSAGES;
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(DEFAULT_VISIBLE_CHAT_MESSAGES);
  const hiddenMessageCount = Math.max(0, allSnapshotMessages.length - visibleMessageLimit);
  const snapshotMessages = useMemo(() => hiddenMessageCount ? allSnapshotMessages.slice(hiddenMessageCount) : allSnapshotMessages, [allSnapshotMessages, hiddenMessageCount]);
  const messageTagEventIndex = useMemo(() => createMessageTagEventIndex(snapshot), [snapshot?.rawEvents, snapshot?.normalizedEvents]);
  const messageContentKey = useMemo(() => getMessageContentKey(snapshotMessages), [snapshotMessages]);
  const trusted = snapshot?.trusted === true;
  const opening = snapshot?.opening ?? staticOpening(profile);
  const statusText = previewStatus(snapshot, active, continuationBlocked);
  const sessionState = active ? snapshot?.turnState ?? 'streaming' : snapshot?.sessionState ?? 'notStarted';
  const previewId = useId();
  const presetId = CHAT_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.preset) ? viewport.preset : viewport.preset === 'responsive' ? 'responsive' : 'custom';
  const responsive = presetId === 'responsive';
  const logicalWidth = responsive ? responsiveSize.width : viewport.width;
  const logicalHeight = responsive ? responsiveSize.height : viewport.height;
  const selectedZoom = responsive ? 1 : viewport.zoom === 'fit' ? fitScale : Number(viewport.zoom) / 100;
  const previewScale = Math.max(0.1, Math.min(1, selectedZoom));
  const viewportStyle = responsive ? undefined : {
    '--mcp-logical-width': `${logicalWidth}px`,
    '--mcp-logical-height': `${logicalHeight}px`,
    '--mcp-preview-scale': previewScale,
    width: `${Math.round(logicalWidth * previewScale)}px`,
    height: `${Math.round(logicalHeight * previewScale)}px`
  } as CSSProperties;

  useEffect(() => { setVisibleMessageLimit(DEFAULT_VISIBLE_CHAT_MESSAGES); }, [snapshot?.sessionId]);
  useEffect(() => {
    if (!selectedMessageId || hiddenMessageCount === 0) return;
    const index = allSnapshotMessages.findIndex((message) => message.id === selectedMessageId);
    if (index >= 0 && index < hiddenMessageCount) setVisibleMessageLimit(Math.min(1_000, allSnapshotMessages.length - index));
  }, [allSnapshotMessages, hiddenMessageCount, selectedMessageId]);

  const updateViewport = (next: ChatViewportState) => {
    setUncontrolledViewport(next);
    onViewportChange?.(next);
  };

  useEffect(() => { onMessageScrollTopChangeRef.current = onMessageScrollTopChange; }, [onMessageScrollTopChange]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      const width = Math.max(MIN_VIEWPORT_WIDTH, Math.floor(rect.width - 16));
      const height = Math.max(MIN_VIEWPORT_HEIGHT, Math.floor(rect.height - 16));
      setResponsiveSize((current) => current.width === width && current.height === height ? current : { width, height });
      if (!responsive && viewport.zoom === 'fit') {
        setFitScale(Math.max(0.1, Math.min(1, width / viewport.width, height / viewport.height)));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [responsive, viewport.height, viewport.width, viewport.zoom]);

  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    const handleScroll = (persist = true) => {
      const nearBottom = isNearBottom(messages);
      const current = messageScrollRef.current;
      if (current) {
        messageScrollRef.current = { ...current, nearBottom, scrollHeight: messages.scrollHeight, scrollTop: messages.scrollTop };
      }
      if (persist) onMessageScrollTopChangeRef.current?.(messages.scrollTop);
      if (nearBottom) setShowJumpToLatest(false);
    };
    handleScroll(false);
    const listener = () => handleScroll(true);
    messages.addEventListener('scroll', listener, { passive: true });
    return () => messages.removeEventListener('scroll', listener);
  }, []);

  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    if (!restoredMessageScroll.current && snapshotMessages.length > 0 && typeof initialMessageScrollTop === 'number' && Number.isFinite(initialMessageScrollTop)) {
      restoredMessageScroll.current = true;
      messages.scrollTop = Math.max(0, initialMessageScrollTop);
    }
    const previous = messageScrollRef.current;
    const firstMessageId = snapshotMessages[0]?.id;
    const changed = previous !== undefined && previous.contentKey !== messageContentKey;
    if (previous && changed) {
      const wasNearBottom = previous.nearBottom;
      const prepended = previous.firstMessageId !== undefined && firstMessageId !== undefined && previous.firstMessageId !== firstMessageId && snapshotMessages.length > previous.messageCount;
      if (snapshotMessages.length === 0) {
        setShowJumpToLatest(false);
      } else if (prepended && !wasNearBottom) {
        const heightDelta = messages.scrollHeight - previous.scrollHeight;
        if (heightDelta > 0) messages.scrollTop = previous.scrollTop + heightDelta;
      } else if (wasNearBottom) {
        scrollToLatest(messages);
      } else {
        setShowJumpToLatest(true);
      }
    }
    messageScrollRef.current = {
      contentKey: messageContentKey,
      firstMessageId,
      messageCount: snapshotMessages.length,
      nearBottom: isNearBottom(messages),
      scrollHeight: messages.scrollHeight,
      scrollTop: messages.scrollTop
    };
  }, [initialMessageScrollTop, messageContentKey, snapshotMessages]);

  const selectPreset = (preset: ChatViewportPreset) => {
    if (preset === 'responsive') { updateViewport({ ...viewport, preset }); return; }
    if (preset === 'custom') { updateViewport({ ...viewport, preset, width: logicalWidth, height: logicalHeight }); return; }
    const definition = CHAT_VIEWPORT_PRESETS.find((item) => item.id === preset);
    if (definition) updateViewport({ ...viewport, preset, width: definition.width, height: definition.height });
  };

  const setViewportDimension = (dimension: 'width' | 'height', value: number) => {
    if (!Number.isFinite(value)) return;
    const minimum = dimension === 'width' ? MIN_VIEWPORT_WIDTH : MIN_VIEWPORT_HEIGHT;
    const maximum = dimension === 'width' ? MAX_VIEWPORT_WIDTH : MAX_VIEWPORT_HEIGHT;
    updateViewport({ ...viewport, preset: 'custom', width: dimension === 'width' ? clamp(value, minimum, maximum) : logicalWidth, height: dimension === 'height' ? clamp(value, minimum, maximum) : logicalHeight });
  };

  const rotateViewport = () => updateViewport({ ...viewport, preset: 'custom', width: clamp(logicalHeight, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH), height: clamp(logicalWidth, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT) });

  const jumpToLatest = () => {
    const messages = messagesRef.current;
    if (!messages) return;
    scrollToLatest(messages);
    const current = messageScrollRef.current;
    if (current) messageScrollRef.current = { ...current, nearBottom: true, scrollHeight: messages.scrollHeight, scrollTop: messages.scrollTop };
    setShowJumpToLatest(false);
  };

  const takeScreenshot = async () => {
    const device = deviceRef.current;
    if (!device || capturingScreenshot) return;
    setCapturingScreenshot(true);
    setScreenshotStatus(t('Copying chat screenshot…'));
    try {
      const screenshot = captureChatScreenshot(device);
      await copyChatScreenshotToClipboard(screenshot.then((result) => result.dataUrl));
      setScreenshotStatus(t('Chat screenshot copied to clipboard.'));
    } catch {
      setScreenshotStatus(t('Unable to copy chat screenshot.'));
    } finally {
      setCapturingScreenshot(false);
    }
  };

  const runVisual = async (operation: 'baseline' | 'compare') => {
    const device = deviceRef.current;
    if (!device || capturingVisual) return;
    setCapturingVisual(operation);
    setScreenshotStatus(t(operation === 'baseline' ? 'Capturing visual baseline…' : 'Comparing visual baseline…'));
    try {
      const screenshot = await captureChatScreenshot(device);
      post({ type: operation === 'baseline' ? 'visual.baseline.save' : 'visual.compare', dataUrl: screenshot.dataUrl, viewport: { id: String(presetId), width: logicalWidth, height: logicalHeight } });
    } catch {
      setScreenshotStatus(t('Unable to capture visual snapshot.'));
      setCapturingVisual(undefined);
    }
  };

  useEffect(() => {
    if (!visualFeedback) return;
    setCapturingVisual(undefined);
    if (visualFeedback.operation === 'baseline') setScreenshotStatus(t('Visual baseline saved.'));
    else setScreenshotStatus(visualFeedback.status === 'passed' ? t('Visual comparison passed ({difference}%).', { difference: formatNumber(visualFeedback.differencePercent ?? 0) }) : t('Visual comparison failed ({difference}%).', { difference: formatNumber(visualFeedback.differencePercent ?? 0) }));
  }, [visualFeedback]);
  useEffect(() => {
    if (!capturingVisual) return;
    const timeout = window.setTimeout(() => { setCapturingVisual(undefined); setScreenshotStatus(t('Visual comparison timed out.')); }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [capturingVisual]);

  const rootClassName = ['mobile-chat-preview', className].filter(Boolean).join(' ');

  return <section className={rootClassName} aria-label={t('Responsive chat preview')}>
    <header className="mobile-chat-preview__viewport-toolbar" aria-label={t('Chat preview controls')}>
      <details className="mobile-chat-preview__viewport-settings">
        <summary aria-label={t('Preview size settings')}><ProductIcon name={responsive ? 'screen-full' : logicalWidth >= 900 ? 'device-desktop' : 'device-mobile'} /><span>{t('Preview size')}</span><small>{responsive ? t('Responsive') : `${formatNumber(logicalWidth)} × ${formatNumber(logicalHeight)}`}</small></summary>
        <div className="mobile-chat-preview__viewport-settings-panel">
          <label className="mobile-chat-preview__preset-control"><span>{t('Viewport preset')}</span><select value={presetId} aria-label={t('Viewport preset')} onChange={(event) => selectPreset(event.target.value as ChatViewportPreset)}><option value="responsive">{t('Responsive')}</option><optgroup label={t('Devices')}>{CHAT_VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{t(preset.label)} — {preset.width} × {preset.height}</option>)}</optgroup><option value="custom">{t('Custom')}</option></select></label>
          <div className="mobile-chat-preview__dimensions" role="group" aria-label={t('Viewport dimensions')}><label><span>{t('Width')}</span><ViewportDimensionInput value={logicalWidth} minimum={MIN_VIEWPORT_WIDTH} maximum={MAX_VIEWPORT_WIDTH} label={t('Viewport width')} onCommit={(value) => setViewportDimension('width', value)} /></label><span aria-hidden="true">×</span><label><span>{t('Height')}</span><ViewportDimensionInput value={logicalHeight} minimum={MIN_VIEWPORT_HEIGHT} maximum={MAX_VIEWPORT_HEIGHT} label={t('Viewport height')} onCommit={(value) => setViewportDimension('height', value)} /></label><IconButton className="mobile-chat-preview__rotate" icon="arrow-swap" label={t('Rotate viewport')} type="button" onClick={rotateViewport} /></div>
          <label className="mobile-chat-preview__zoom-control"><span>{t('Viewport zoom')}</span><select value={responsive ? '100' : viewport.zoom} disabled={responsive} aria-label={t('Viewport zoom')} onChange={(event) => updateViewport({ ...viewport, zoom: event.target.value as ChatViewportZoom })}><option value="fit">{t('Fit')}</option><option value="100">100%</option><option value="75">75%</option><option value="50">50%</option></select>{!responsive && viewport.zoom === 'fit' && <small className="mobile-chat-preview__fit-scale" aria-label={t('Preview scale')}>{formatNumber(Math.round(previewScale * 100))}% {t('actual preview')}</small>}</label>
        </div>
      </details>
      <div className="mobile-chat-preview__session-tools" role="group" aria-label={t('Session status and actions')}>
        <span className="mobile-chat-preview__environment">{profile.environment ?? t('No environment')}</span>
        <span aria-hidden="true">·</span>
        <span className={`mobile-chat-preview__session-state mobile-chat-preview__session-state--${sessionState}`} aria-label={t('Conversation status: {status}', { status: humanize(sessionState) })}>
          <ProductIcon name="circle-filled" />
          <span>{humanize(sessionState)}</span>
        </span>
        {snapshot && snapshot.sessionState !== 'notStarted' && <IconButton className="mobile-chat-preview__restart" icon="debug-restart" label={t('Restart session')} type="button" disabled={!trusted || active || snapshot.sessionState === 'loadingOpening'} onClick={() => post({ type: 'conversation.new' })} />}
      </div>
      <IconButton className="mobile-chat-preview__screenshot" icon="device-camera" label={t(capturingScreenshot ? 'Copying chat screenshot…' : 'Copy chat screenshot')} type="button" disabled={capturingScreenshot} aria-busy={capturingScreenshot} onClick={() => void takeScreenshot()} />
      {onConfigure && <IconButton icon="settings-gear" label={t('Configure profile')} type="button" onClick={onConfigure} />}
      <ToolbarOverflow>
        <button role="menuitem" type="button" disabled={!trusted || active || !snapshot?.messages.some((message) => message.role === 'user')} onClick={() => post({ type: 'adversarial.capture' })}><ProductIcon name="beaker" /><span>{t('Save conversation as adversarial test')}</span></button>
        <button role="menuitem" type="button" disabled={!trusted || Boolean(capturingVisual)} aria-busy={capturingVisual === 'baseline'} onClick={() => void runVisual('baseline')}><ProductIcon name="save" /><span>{t(capturingVisual === 'baseline' ? 'Capturing visual baseline…' : 'Save visual baseline')}</span></button>
        <button role="menuitem" type="button" disabled={!trusted || Boolean(capturingVisual)} aria-busy={capturingVisual === 'compare'} onClick={() => void runVisual('compare')}><ProductIcon name="diff" /><span>{t(capturingVisual === 'compare' ? 'Comparing visual baseline…' : 'Compare visual baseline')}</span></button>
      </ToolbarOverflow>
    </header>
    <div ref={stageRef} className="mobile-chat-preview__stage">
      <div className={`mobile-chat-preview__viewport-shell mobile-chat-preview__viewport-shell--${responsive ? 'responsive' : 'fixed'}`} data-viewport-mode={responsive ? 'responsive' : 'fixed'} style={viewportStyle}>
      <div ref={deviceRef} className="mobile-chat-preview__device" data-layout="responsive" data-viewport-width={logicalWidth}>
        <MobileAppHeader profile={profile} />

        <div className="mobile-chat-preview__content">
          {profile.controls && profile.controls.length > 0 && <MobileControls profile={profile} snapshot={snapshot} active={active} trusted={trusted} post={post} />}
          <div ref={messagesRef} className="mobile-chat-preview__messages" role="log" aria-label={t('Conversation messages')} aria-live="polite" aria-relevant="additions text">
            {hiddenMessageCount > 0 && <button className="mobile-chat-preview__load-history" type="button" onClick={() => setVisibleMessageLimit((current) => Math.min(1_000, current + DEFAULT_VISIBLE_CHAT_MESSAGES))}>{t('Show {count} earlier messages', { count: formatNumber(Math.min(DEFAULT_VISIBLE_CHAT_MESSAGES, hiddenMessageCount)) })}</button>}
            {snapshot?.sessionState === 'notStarted' && profile.opening?.mode === 'request' && <StartSessionCard post={post} trusted={trusted} headingId={`${previewId}-start-heading`} />}
            {snapshot?.sessionState === 'loadingOpening' && profile.opening?.mode === 'request' && <OpeningLoading headingId={`${previewId}-opening-loading-heading`} />}
            {snapshot?.sessionState === 'failed' && profile.opening?.mode === 'request' && <OpeningError profile={profile} snapshot={snapshot} post={post} trusted={trusted} headingId={`${previewId}-opening-error-heading`} />}
            {opening && componentVisible(profile, 'opening') && <OpeningCard profile={profile} opening={opening} active={active} trusted={trusted} setDraft={setDraft} send={send} post={post} headingId={`${previewId}-opening-heading`} />}
      {snapshotMessages.map((message) => <MobileMessage key={message.id} profile={profile} message={message} snapshot={snapshot} messageTagEventIndex={messageTagEventIndex} post={post} send={send} setDraft={setDraft} trusted={trusted} selected={selectedMessageId === message.id} onSelectMessage={onSelectMessage} acceptedForms={acceptedForms} actionFeedback={messageActionFeedback} onActionFeedback={onMessageActionFeedback} />)}
            {!snapshot && <p className="mobile-chat-preview__empty" role="status">{t('Loading conversation…')}</p>}
            {snapshot && snapshotMessages.length === 0 && !opening && snapshot.sessionState === 'ready' && <p className="mobile-chat-preview__empty">{t('No messages yet. Send a message to begin.')}</p>}
            {continuationBlocked && <p className="mobile-chat-preview__continuation" role="status">{t('Continuation is disabled after this error. Start a new conversation to send another message.')}</p>}
            {showJumpToLatest && <button className="mobile-chat-preview__jump-to-latest" type="button" onClick={jumpToLatest} aria-label={t('Jump to latest')}><ProductIcon name="arrow-down" />{t('Jump to latest')}</button>}
          </div>
        </div>

        <MobileComposer profile={profile} active={active} sessionReady={snapshot?.sessionState === 'ready'} turnState={snapshot?.turnState} continuationBlocked={continuationBlocked} trusted={trusted} draft={draft} setDraft={setDraft} send={send} post={post} />
      </div>
      </div>
    </div>
    <p className="mobile-chat-preview__status" role="status" aria-live="polite" aria-atomic="true">{screenshotStatus || statusText}</p>
  </section>;
}

function ToolbarOverflow({ children }: { children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current?.querySelector('button');
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(288, Math.max(200, window.innerWidth - 16));
      const height = menu.offsetHeight;
      const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
      const below = rect.bottom + 2;
      const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 2);
      setPosition({ left, top, width });
    };
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.querySelector('button')?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('keydown', onKeyDown); };
  }, [open]);

  return <>
    <span ref={triggerRef} className="mobile-chat-preview__toolbar-overflow-trigger"><IconButton icon="ellipsis" label={t('More actions')} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)} /></span>
    {open && typeof document !== 'undefined' && createPortal(<div ref={menuRef} className="webview-toolbar-menu" role="menu" aria-label={t('More actions')} style={position} onClick={(event) => { if ((event.target as Element).closest('button')) setOpen(false); }}>{children}</div>, document.body)}
  </>;
}

/** Default export makes the component convenient to consume from a preview host. */
export default MobileChatPreview;

function ViewportDimensionInput({ value, minimum, maximum, label, onCommit }: { value: number; minimum: number; maximum: number; label: string; onCommit: (value: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = clamp(parsed, minimum, maximum);
    setDraft(String(next));
    onCommit(next);
  };
  return <input type="number" min={minimum} max={maximum} value={draft} aria-label={label} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

function MobileAppHeader({ profile }: { profile: TurnStageProfile }): React.JSX.Element {
  return <header className="mobile-chat-preview__app-header">
    <div className="mobile-chat-preview__app-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</div>
    <div className="mobile-chat-preview__app-heading">
      <strong>{profile.name}</strong>
    </div>
  </header>;
}

function MobileControls({ profile, snapshot, active, trusted, post }: { profile: TurnStageProfile; snapshot?: SessionSnapshot; active: boolean; trusted: boolean; post: PostMessage }): React.JSX.Element {
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const submitSecret = (event: FormEvent<HTMLFormElement>, controlId: string) => {
    event.preventDefault();
    const value = secretDrafts[controlId] ?? '';
    post({ type: 'control.set', controlId, value });
    setSecretDrafts((current) => {
      const next = { ...current };
      delete next[controlId];
      return next;
    });
  };
  return <details className="mobile-chat-preview__controls">
    <summary>{t('Session controls')}</summary>
    <div className="mobile-chat-preview__controls-grid">
      {profile.controls?.map((control) => {
        const id = `mobile-chat-preview-control-${slug(control.id)}`;
        const locked = interactionLocked(profile, control.id, active) || (!trusted && control.persist === 'secret');
        const value = control.persist === 'secret' ? control.default : snapshot?.controls[control.id] ?? control.default;
        return <div className="mobile-chat-preview__control" key={control.id}>
          <label htmlFor={id}>{control.label}</label>
          {control.type === 'text' && control.persist === 'secret' ? <form className="mobile-chat-preview__secret-control" onSubmit={(event) => submitSecret(event, control.id)}>
            <div className="mobile-chat-preview__secret-control-row">
              <input id={id} type="password" value={secretDrafts[control.id] ?? ''} autoComplete="new-password" disabled={locked} onChange={(event) => setSecretDrafts((current) => ({ ...current, [control.id]: event.target.value }))} />
              <button className="mobile-chat-preview__button" type="submit" disabled={locked}>{t('Apply')}</button>
            </div>
          </form> : control.type === 'select' ? <select id={id} value={String(value ?? '')} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.value })}>
            {control.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select> : control.type === 'boolean' ? <input id={id} type="checkbox" checked={Boolean(value)} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.checked })} /> : <input id={id} type="text" value={String(value ?? '')} disabled={locked} onChange={(event) => post({ type: 'control.set', controlId: control.id, value: event.target.value })} />}
        </div>;
      })}
    </div>
  </details>;
}

function StartSessionCard({ post, trusted, headingId }: { post: PostMessage; trusted: boolean; headingId: string }): React.JSX.Element {
  return <section className="mobile-chat-preview__session-start" aria-labelledby={headingId}>
    <ProductIcon name="debug-start" />
    <div className="mobile-chat-preview__session-start-copy">
      <h3 id={headingId}>{t('Not started')}</h3>
      <p>{t('This profile loads its opening message when a session starts.')}</p>
    </div>
    <button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="button" disabled={!trusted} onClick={() => post({ type: 'session.start' })}>{t('Start session')}</button>
  </section>;
}

function OpeningLoading({ headingId }: { headingId: string }): React.JSX.Element {
  return <section className="mobile-chat-preview__session-start mobile-chat-preview__session-start--loading" role="status" aria-labelledby={headingId}>
    <ProductIcon name="loading" />
    <div className="mobile-chat-preview__session-start-copy">
      <h3 id={headingId}>{t('Loading opening…')}</h3>
      <p>{t('TurnStage is starting this session automatically.')}</p>
    </div>
  </section>;
}

function OpeningError({ profile, snapshot, post, trusted, headingId }: { profile: TurnStageProfile; snapshot: SessionSnapshot; post: PostMessage; trusted: boolean; headingId: string }): React.JSX.Element {
  const error = snapshot.errors.at(-1)?.message ?? t('The opening content could not be loaded.');
  return <section className="mobile-chat-preview__opening-error" role="alert" aria-labelledby={headingId}>
    <h3 id={headingId}>{t('Opening request failed')}</h3>
    <p>{error}</p>
    <div className="mobile-chat-preview__action-row">
      <button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="button" disabled={!trusted} onClick={() => post({ type: 'opening.retry' })}>{t('Retry opening')}</button>
      {profile.opening?.fallbacks?.length ? <button className="mobile-chat-preview__button" type="button" onClick={() => post({ type: 'opening.useFallback' })}>{t('Use fallback')}</button> : null}
    </div>
  </section>;
}

function OpeningCard({ profile, opening, active, trusted, setDraft, send, post, headingId }: { profile: TurnStageProfile; opening: NonNullable<SessionSnapshot['opening']>; active: boolean; trusted: boolean; setDraft: SetDraft; send: SendMessage; post: PostMessage; headingId: string }): React.JSX.Element {
  return <section className="mobile-chat-preview__opening" aria-labelledby={headingId}>
    <span className="mobile-chat-preview__opening-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</span>
    <div className="mobile-chat-preview__opening-content"><h3 className="mobile-chat-preview__opening-label" id={headingId}>{t('Opening')}</h3><p className="mobile-chat-preview__opening-message">{opening.message}</p>
      {opening.blocks?.length ? <OpeningBlocks blocks={opening.blocks} active={active} trusted={trusted} setDraft={setDraft} send={send} /> : null}
      {componentVisible(profile, 'starters') && opening.starters.length > 0 && <div className="mobile-chat-preview__starter-list" aria-label={t('Starter prompts')}>
        {opening.starters.map((starter) => <StarterButton key={starter.id} starter={starter} active={active} trusted={trusted} setDraft={setDraft} send={send} post={post} />)}
      </div>}
    </div>
  </section>;
}

function OpeningBlocks({ blocks, active, trusted, setDraft, send }: { blocks: OpeningInfoBlock[]; active: boolean; trusted: boolean; setDraft: SetDraft; send: SendMessage }): React.JSX.Element {
  return <div className="mobile-chat-preview__opening-blocks">{blocks.map((block) => <section className={`mobile-chat-preview__opening-block mobile-chat-preview__opening-block--${block.kind}`} key={block.id} aria-label={block.label || t('Opening information')}>
    {block.label ? <h4>{block.label}</h4> : null}
    {block.empty ? <span className="mobile-chat-preview__opening-block-empty">{t('No information available')}</span> : block.kind === 'choices' ? <div className="mobile-chat-preview__starter-list" aria-label={block.label || t('Suggested choices')}>{block.items.map((item) => <StarterButton key={item.id} starter={item} active={active} trusted={trusted} setDraft={setDraft} send={send} post={() => undefined} />)}</div> : block.kind === 'fields' ? <dl>{block.items.map((item) => <div key={item.id}><dt>{item.label}</dt><dd>{formatOpeningField(item.value, item.format)}</dd></div>)}</dl> : block.kind === 'meter' ? <div className="mobile-chat-preview__opening-meter"><div><strong>{formatNumber(block.value ?? 0)}</strong><span> / {formatNumber(block.max ?? 0)}{block.unit ? ` ${block.unit}` : ''}</span></div><progress aria-label={block.label || t('Usage')} value={Math.max(0, Math.min(block.value ?? 0, block.max ?? 0))} max={block.max || 1} />{block.resetAt ? <span>{t('Resets {time}', { time: formatOpeningDate(block.resetAt) })}</span> : null}</div> : block.kind === 'status' ? <span className={`mobile-chat-preview__opening-status is-${block.tone}`}>{block.value}</span> : <details open={!block.defaultCollapsed}><summary>{block.label ? t('View details') : t('Opening information')}</summary><pre className="json"><code><JsonSyntax value={block.value} /></code><ClipboardButton text={safeJson(block.value)} label={t('Copy JSON')} /></pre></details>}
  </section>)}</div>;
}

function formatOpeningField(value: string, format: 'text' | 'number' | 'datetime' | 'percent'): string {
  if (format === 'number') { const number = Number(value); return Number.isFinite(number) ? formatNumber(number) : value; }
  if (format === 'percent') { const number = Number(value); return Number.isFinite(number) ? `${formatNumber(number)}%` : value; }
  if (format === 'datetime') return formatOpeningDate(value);
  return value;
}

function formatOpeningDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date);
}

function StarterButton({ starter, active, trusted, setDraft, send, post }: { starter: Starter; active: boolean; trusted: boolean; setDraft: SetDraft; send: SendMessage; post: PostMessage }): React.JSX.Element {
  const invoke = () => {
    if (starter.behavior === 'fill') setDraft(starter.prompt);
    else if (starter.behavior === 'action' && starter.actionId) {
      post({ type: 'action.invoke', actionId: starter.actionId });
    } else send(starter.prompt, { kind: 'starter', starterId: starter.id });
  };
  return <button className="mobile-chat-preview__chip" type="button" disabled={active || !trusted} onClick={invoke}>{starter.label}</button>;
}

function MobileComposer({ profile, active, sessionReady, turnState, continuationBlocked, trusted, draft, setDraft, send, post }: { profile: TurnStageProfile; active: boolean; sessionReady: boolean; turnState?: TurnState; continuationBlocked: boolean; trusted: boolean; draft: string; setDraft: SetDraft; send: SendMessage; post: PostMessage }): React.JSX.Element {
  const composing = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const composer = resolveComposer(profile.ui);
  const placeholder = composer.placeholder || t('Message TurnStage…');
  const composerLocked = interactionLocked(profile, 'composer', active);
  const stopping = turnState === 'stopping';
  const actionLabel = active ? stopActionLabel(turnState) : t('Send message');
  const canSend = trusted && sessionReady && !active && !continuationBlocked && !composerLocked;
  const showAction = !active || composer.showStopWhileStreaming;
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (active) {
      if (composer.showStopWhileStreaming && !stopping) post({ type: 'request.abort' });
    } else if (canSend && draft.trim()) {
      const text = draft;
      setDraft('');
      send(text);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current) return;
    const behavior = composer.multiline ? (event.shiftKey ? composer.shiftEnterBehavior : composer.enterBehavior) : 'send';
    const canSubmit = active ? composer.showStopWhileStreaming && !stopping : canSend && Boolean(draft.trim());
    if (behavior === 'send' && canSubmit) {
      event.preventDefault();
      submit();
    }
  };
  const inputDisabled = !trusted || !sessionReady || continuationBlocked || (active && composerLocked);
  useLayoutEffect(() => resizeComposerTextarea(textareaRef.current), [draft, composer.multiline]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    let observedWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? textarea.getBoundingClientRect().width;
      if (Math.abs(width - observedWidth) < 0.5) return;
      observedWidth = width;
      resizeComposerTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [composer.multiline]);
  return <form className="mobile-chat-preview__composer" onSubmit={submit}>
    <div className={`mobile-chat-preview__composer-control ${showAction ? '' : 'mobile-chat-preview__composer-control--without-action'}`.trim()}>
      <label className="mobile-chat-preview__sr-only" htmlFor={inputId}>{t('Message')}</label>
      {composer.multiline
        ? <textarea ref={textareaRef} id={inputId} rows={1} value={draft} placeholder={placeholder} disabled={inputDisabled} aria-describedby={continuationBlocked ? `${inputId}-blocked` : undefined} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={onKeyDown} />
        : <input id={inputId} type="text" value={draft} placeholder={placeholder} disabled={inputDisabled} aria-describedby={continuationBlocked ? `${inputId}-blocked` : undefined} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={onKeyDown} />}
      {showAction && <button className={`mobile-chat-preview__send mobile-chat-preview__button ${active ? 'mobile-chat-preview__button--danger' : 'mobile-chat-preview__button--primary'}`} type="submit" disabled={active ? stopping : !draft.trim() || !canSend} aria-label={actionLabel} title={actionLabel}><ProductIcon name={active ? 'stop' : 'send'} /></button>}
    </div>
    {continuationBlocked && <span id={`${inputId}-blocked`} className="mobile-chat-preview__composer-hint">{t('Start a new conversation to continue.')}</span>}
  </form>;
}

function stopActionLabel(turnState?: TurnState): string {
  if (turnState === 'stopping') return t('Stopping…');
  if (turnState === 'submitting' || turnState === 'waitingStart') return t('Waiting for conversation…');
  return t('Stop conversation');
}

function MobileMessage({ profile, message, snapshot, messageTagEventIndex, post, send, setDraft, trusted, selected, onSelectMessage, acceptedForms, actionFeedback, onActionFeedback }: { profile: TurnStageProfile; message: ChatMessage; snapshot?: SessionSnapshot; messageTagEventIndex: MessageTagEventIndex; post: PostMessage; send: SendMessage; setDraft: SetDraft; trusted: boolean; selected: boolean; onSelectMessage?: (messageId: string) => void; acceptedForms?: ReadonlySet<string>; actionFeedback?: MessageActionFeedback; onActionFeedback?: (feedback: MessageActionFeedback | undefined) => void }): React.JSX.Element {
  const parts = message.parts ?? [];
  const text = parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text ?? '').join('');
  const citations = message.citations ?? [];
  const actions = message.actions ?? [];
  const followups = message.followups ?? [];
  const followupLimit = boundedVisibleCount(profile.ui?.components?.followups?.maxVisible, 3);
  const primaryFollowups = followups.slice(0, followupLimit);
  const overflowFollowups = followups.slice(followupLimit);
  const responseActionLimit = boundedVisibleCount(profile.ui?.components?.responseActions?.maxPrimary, 3);
  const primaryActions = actions.slice(0, responseActionLimit);
  const overflowActions = actions.slice(responseActionLimit);
  const roleLabel = humanizeRole(message.role);
  const statusLabel = humanize(message.status);
  const messageLabelValues = { role: roleLabel, status: statusLabel };
  const messageActions = resolveMessageActions(profile, message.role, Boolean(onSelectMessage));
  const messageActionVisibility = resolveMessageActionVisibility(profile.ui);
  const messageTags = useMemo(() => resolveMessageTags(profile.ui?.messageTags, message, snapshot, messageTagEventIndex), [message, messageTagEventIndex, profile.ui?.messageTags, snapshot]);
  const feedback = actionFeedback?.sourceMessageId === message.id ? actionFeedback : undefined;
  const reportFeedback = (actionId: string, status: MessageActionFeedback['status'], feedbackMessage: string) => onActionFeedback?.({ actionId, sourceMessageId: message.id, status, message: feedbackMessage });
  const enabledMessageMetrics = new Set(profile.metrics?.messageEnabled?.length ? profile.metrics.messageEnabled : ['ttft', 'totalDuration']);
  const showTtft = message.role === 'assistant' && message.timing !== undefined && enabledMessageMetrics.has('ttft');
  const showTotalDuration = message.role === 'assistant' && message.timing !== undefined && enabledMessageMetrics.has('totalDuration');
  const messageMetrics = (message.metrics ?? []).filter((metric) => enabledMessageMetrics.has(metric.id));
  const streaming = resolveStreaming(profile.ui);
  const streamingAssistant = message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming');
  const trailingTextPartIndex = parts.map((part) => part.type === 'text' || part.type === 'markdown').lastIndexOf(true);
  const streamingStyle = {
    '--mcp-stream-duration': `${streaming.speedMs}ms`,
    '--mcp-stream-intensity': streaming.intensityPercent / 100,
  } as CSSProperties;
  const onMessageClick = (event: React.MouseEvent<HTMLElement>) => {
    if (!onSelectMessage) return;
    if (isMessageInteractiveTarget(event.target)) return;
    onSelectMessage(message.id);
  };
  const onMessageKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelectMessage || isMessageInteractiveTarget(event.target) || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onSelectMessage(message.id);
  };
  return <article className={`mobile-chat-preview__message mobile-chat-preview__message--${message.role} ${selected ? 'mobile-chat-preview__message--selected' : ''}`} data-message-id={message.id} data-status={message.status} data-selected={selected ? 'true' : 'false'} aria-label={t('{role} message, {status}', messageLabelValues)} style={streamingStyle} tabIndex={onSelectMessage ? 0 : undefined} onClick={onMessageClick} onKeyDown={onMessageKeyDown}>
    {message.role !== 'user' && <span className="mobile-chat-preview__message-avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase() || 'T'}</span>}
    <span className="mobile-chat-preview__message-heading"><strong>{roleLabel}</strong><MessageStatus state={message.status} />{messageTags.length > 0 && <span className="mobile-chat-preview__message-tags" aria-label={t('Message tags')}>{messageTags.map((tag) => <span className={`mobile-chat-preview__message-tag mobile-chat-preview__message-tag--${tag.tone}`} key={tag.id}>{tag.label}</span>)}</span>}</span>
    <div className="mobile-chat-preview__message-body">
      {parts.map((part, index) => <MobileMessagePart key={`${part.type}-${index}`} profile={profile} part={part} messageId={message.id} citations={citations} post={post} trusted={trusted} accepted={acceptedForms?.has(formInstanceKey(message.id, part) ?? '')} streaming={message.role === 'assistant' ? streaming : undefined} streamingActive={streamingAssistant && index === trailingTextPartIndex} />)}
      {streamingAssistant && trailingTextPartIndex < 0 && <StreamingIndicator streaming={streaming} />}
      {componentVisible(profile, 'citations') && citations.length > 0 && <CitationList profile={profile} citations={citations} post={post} trusted={trusted} />}
      {componentVisible(profile, 'responseActions') && message.status === 'completed' && actions.length > 0 && <div className="mobile-chat-preview__action-row" role="group" aria-label={t('Response actions')}>{primaryActions.map((action) => <ResponseActionButton key={action.id} action={action} messageId={message.id} trusted={trusted} setDraft={setDraft} post={post} onSelectMessage={onSelectMessage} />)}{overflowActions.length > 0 && <details className="mobile-chat-preview__overflow"><summary>{t('More actions')}</summary><div>{overflowActions.map((action) => <ResponseActionButton key={action.id} action={action} messageId={message.id} trusted={trusted} setDraft={setDraft} post={post} onSelectMessage={onSelectMessage} />)}</div></details>}</div>}
      {componentVisible(profile, 'followups') && message.status === 'completed' && followups.length > 0 && <div className="mobile-chat-preview__followups" role="group" aria-label={t('Follow-up questions')}>{primaryFollowups.map((followup) => <button className="mobile-chat-preview__chip" type="button" title={followup.tooltip} key={followup.id} disabled={!trusted} onClick={() => invokeFollowup(followup, message.id, setDraft, send, post)}>{followup.label}</button>)}{overflowFollowups.length > 0 && <details className="mobile-chat-preview__overflow"><summary>{t('More suggestions')}</summary><div>{overflowFollowups.map((followup) => <button className="mobile-chat-preview__chip" type="button" title={followup.tooltip} key={followup.id} disabled={!trusted} onClick={() => invokeFollowup(followup, message.id, setDraft, send, post)}>{followup.label}</button>)}</div></details>}</div>}
      {componentVisible(profile, 'messageMetrics') && (showTtft || showTotalDuration || messageMetrics.length > 0) && <MessageMetrics message={message} metrics={messageMetrics} showTtft={showTtft} showTotalDuration={showTotalDuration} />}
      {messageActions.length > 0 && <footer className={`mobile-chat-preview__message-toolbar mobile-chat-preview__message-toolbar--${messageActionVisibility}`} role="group" aria-label={t('Message actions')}>
        {messageActions.map((actionId) => actionId === 'message.inspectRaw'
          ? <IconButton key={actionId} icon="target" label={feedback?.actionId === actionId ? feedback.message : t('Inspect message')} type="button" aria-pressed={selected} onClick={() => onSelectMessage?.(message.id)} />
          : actionId === 'message.copy'
            ? <IconButton key={actionId} icon={feedback?.actionId === actionId ? feedback.status === 'success' ? 'check' : feedback.status === 'error' ? 'warning' : 'copy' : 'copy'} label={feedback?.actionId === actionId ? feedback.message : t('Copy')} type="button" onClick={() => { reportFeedback(actionId, 'pending', t('Copying message…')); post({ type: 'action.invoke', actionId, sourceMessageId: message.id }); }} />
            : actionId === 'message.retry'
              ? <IconButton key={actionId} icon="refresh" label={feedback?.actionId === actionId ? feedback.message : t('Retry')} type="button" disabled={!trusted} onClick={() => { reportFeedback(actionId, 'info', t('Retry requested.')); post({ type: 'action.invoke', actionId, sourceMessageId: message.id }); }} />
              : <IconButton key={actionId} icon={feedback?.actionId === actionId ? 'check' : 'edit'} label={feedback?.actionId === actionId ? feedback.message : t('Edit & resend')} type="button" disabled={!trusted} onClick={() => { setDraft(text); reportFeedback(actionId, 'success', t('Message moved to the composer.')); }} />)}
        {feedback && <span className={`mobile-chat-preview__message-action-feedback mobile-chat-preview__message-action-feedback--${feedback.status}`} role="status" aria-live="polite" aria-atomic="true">{feedback.message}</span>}
      </footer>}
    </div>
  </article>;
}

export interface ResolvedMessageTag { id: string; label: string; tone: NonNullable<MessageTagRule['tone']> }
interface MessageTagEventIndex { raw: Map<number, unknown[]>; normalized: Map<number, unknown[]> }

export function resolveMessageTags(rules: readonly MessageTagRule[] | undefined, message: ChatMessage, snapshot?: SessionSnapshot, index = createMessageTagEventIndex(snapshot)): ResolvedMessageTag[] {
  if (!rules?.length) return [];
  const rawSequences = Array.isArray(message.metadata?.rawSequences) ? message.metadata.rawSequences : [];
  const sequences = new Set(rawSequences.filter((value): value is number => typeof value === 'number'));
  const sources = {
    message: [message] as unknown[],
    rawEvent: [...sequences].flatMap((sequence) => index.raw.get(sequence) ?? []),
    normalizedEvent: [...sequences].flatMap((sequence) => index.normalized.get(sequence) ?? []),
  };
  const tags: ResolvedMessageTag[] = [];
  const seen = new Set<string>();
  for (const rule of rules.slice(0, 20)) {
    if (seen.has(rule.id) || !isSafeTagPath(rule.path)) continue;
    const values = sources[rule.source].flatMap((source) => readTagPath(source, rule.path));
    if (!messageTagMatches(values, rule)) continue;
    tags.push({ id: rule.id, label: rule.label.slice(0, 48), tone: rule.tone ?? 'neutral' });
    seen.add(rule.id);
  }
  return tags;
}

function createMessageTagEventIndex(snapshot?: SessionSnapshot): MessageTagEventIndex {
  const index: MessageTagEventIndex = { raw: new Map(), normalized: new Map() };
  for (const event of snapshot?.rawEvents ?? []) appendIndexedEvent(index.raw, event.sequence, event);
  for (const event of snapshot?.normalizedEvents ?? []) appendIndexedEvent(index.normalized, event.rawSequence ?? event.sequence, event);
  return index;
}

function appendIndexedEvent(index: Map<number, unknown[]>, sequence: number, event: unknown): void {
  const current = index.get(sequence);
  if (current) { if (current.length < 100) current.push(event); }
  else index.set(sequence, [event]);
}

function isSafeTagPath(path: string): boolean {
  return path.length <= 256 && /^(?!.*(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$))[A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_-]+|\*)){0,7}$/u.test(path);
}

function readTagPath(source: unknown, path: string): unknown[] {
  let current: unknown[] = [source];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current.slice(0, 100)) {
      if (!value || typeof value !== 'object') continue;
      if (segment === '*') {
        const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
        next.push(...children.slice(0, 100 - next.length));
      } else if (Object.prototype.hasOwnProperty.call(value, segment)) next.push((value as Record<string, unknown>)[segment]);
      if (next.length >= 100) break;
    }
    current = next;
    if (!current.length) break;
  }
  return current;
}

function messageTagMatches(values: unknown[], rule: MessageTagRule): boolean {
  if (rule.operator === 'exists') return values.some((value) => value !== undefined && value !== null);
  if (rule.operator === 'equals') return values.some((value) => value === rule.value);
  const expected = String(rule.value ?? '');
  if (!expected) return false;
  if (rule.operator === 'startsWith') return values.some((value) => typeof value === 'string' && value.startsWith(expected));
  return values.some((value) => typeof value === 'string' && value.includes(expected));
}

function MessageMetrics({ message, metrics, showTtft, showTotalDuration }: { message: ChatMessage; metrics: MessageMetric[]; showTtft: boolean; showTotalDuration: boolean }): React.JSX.Element {
  const terminal = ['completed', 'failed', 'aborted'].includes(message.status);
  return <dl className="mobile-chat-preview__message-metrics" aria-label={t('Message metrics')}>
    {showTtft && <div title={t('Time to first token')}><dt>TTFT</dt><dd>{message.timing?.ttft === undefined ? t(terminal ? 'Not available' : 'Waiting') : formatDuration(message.timing.ttft)}</dd></div>}
    {showTotalDuration && <div title={t('Total duration')}><dt>{t('Total')}</dt><dd>{message.timing?.totalDuration === undefined ? t(terminal ? 'Not available' : 'Streaming') : formatDuration(message.timing.totalDuration)}</dd></div>}
    {metrics.map((metric) => <div key={metric.id} title={metric.id}><dt>{metric.label?.trim() || metric.id}</dt><dd>{formatMessageMetric(metric)}</dd></div>)}
  </dl>;
}

function formatMessageMetric(metric: MessageMetric): string {
  const value = metric.value;
  if (typeof value !== 'number') return String(value);
  if (metric.format === 'duration' || (!metric.format && metric.unit === 'ms')) return formatDuration(value);
  if (metric.format === 'bytes' || (!metric.format && metric.unit === 'bytes')) return formatByteCount(value);
  if (metric.format === 'percent') return `${formatNumber(value)}%`;
  const formatted = formatNumber(value);
  return metric.unit ? `${formatted} ${metric.unit}` : formatted;
}

function formatByteCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_024) return `${formatNumber(value)} B`;
  if (absolute < 1_048_576) return `${formatNumber(value / 1_024)} KiB`;
  return `${formatNumber(value / 1_048_576)} MiB`;
}

function StreamingIndicator({ streaming }: { streaming: ResolvedStreaming }): React.JSX.Element | null {
  if (streaming.effect === 'none') return null;
  return <span className={`mobile-chat-preview__stream-indicator mobile-chat-preview__stream-indicator--${streaming.effect}`} data-effect={streaming.effect} aria-hidden="true">
    {streaming.effect === 'dots' && <><span /><span /><span /></>}
  </span>;
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const computed = getComputedStyle(textarea);
  const minimum = Number.parseFloat(computed.minHeight) || 0;
  const configuredMaximum = Number.parseFloat(computed.maxHeight);
  const maximum = Number.isFinite(configuredMaximum) ? configuredMaximum : Number.POSITIVE_INFINITY;
  const contentHeight = Math.max(minimum, textarea.scrollHeight);
  textarea.style.height = `${Math.min(contentHeight, maximum)}px`;
  textarea.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
}

function MobileMessagePart({ profile, part, messageId, citations, post, trusted, accepted, streaming, streamingActive }: { profile: TurnStageProfile; part: MessagePart; messageId: string; citations: Citation[]; post: PostMessage; trusted: boolean; accepted?: boolean; streaming?: ResolvedStreaming; streamingActive: boolean }): React.JSX.Element | null {
  if (part.type === 'text') return <MobileText text={part.text ?? ''} streaming={streaming} streamingActive={streamingActive} />;
  if (part.type === 'markdown') return <MobileMarkdown text={part.text ?? ''} post={post} streaming={streaming} streamingActive={streamingActive} />;
  if (part.type === 'citation-reference') {
    if (!componentVisible(profile, 'citations')) return null;
    const citationId = typeof part.citationId === 'string' ? part.citationId : '';
    const index = citations.findIndex((citation) => citation.id === citationId);
    const citationNumber = index >= 0 ? formatNumber(index + 1) : '?';
    const citationLabel = index >= 0 ? citationNumber : t('unknown');
    const citation = index >= 0 ? citations[index] : undefined;
    return <sup><button className="mobile-chat-preview__inline-citation" type="button" disabled={!trusted} title={citation?.snippet ?? citation?.description ?? citation?.title} aria-label={t('Open citation {index}', { index: citationLabel })} onClick={() => citationId && post({ type: 'citation.open', citationId })}>[{citationNumber}]</button></sup>;
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
  if (part.type === 'usage') return componentVisible(profile, 'usage') ? <details className="mobile-chat-preview__part"><summary>{t('Usage')}</summary><JsonPreview value={part.usage} /></details> : null;
  if (part.type === 'error') return <div className="mobile-chat-preview__error-part" role="alert"><strong>{t('Response failed')}</strong>{part.text && <p>{part.text}</p>}</div>;
  if (part.type === 'form' && isFormDefinition(part.form)) return componentVisible(profile, 'forms') ? <MobileForm form={part.form} messageId={messageId} post={post} trusted={trusted} accepted={accepted === true} /> : null;
  return null;
}

function MobileMarkdown({ text, post, streaming, streamingActive }: { text: string; post: PostMessage; streaming?: ResolvedStreaming; streamingActive: boolean }): React.JSX.Element {
  const visibleText = useStreamingRevealText(text, streamingActive, streaming);
  return <div className="mobile-chat-preview__text" data-reveal-mode={streaming?.reveal ?? 'instant'}><SafeMarkdown text={visibleText} copyLabel={t('Copy code')} onOpenLink={(uri) => post({ type: 'uri.open', uri })} />{streamingActive && streaming ? <StreamingIndicator streaming={streaming} /> : null}</div>;
}

function MobileText({ text, streaming, streamingActive }: { text: string; streaming?: ResolvedStreaming; streamingActive: boolean }): React.JSX.Element {
  const visibleText = useStreamingRevealText(text, streamingActive, streaming);
  const blocks = visibleText.split(/```/);
  const trailingBlock = blocks.map((block, index) => index % 2 === 0 && Boolean(block)).lastIndexOf(true);
  return <div className="mobile-chat-preview__text" data-reveal-mode={streaming?.reveal ?? 'instant'}>{blocks.map((block, index) => index % 2
    ? <LegacyCodeBlock key={index} source={block} />
    : block ? <p key={index}>{block}{index === trailingBlock && streamingActive && streaming ? <StreamingIndicator streaming={streaming} /> : null}</p> : null)}
    {streamingActive && streaming && trailingBlock < 0 ? <StreamingIndicator streaming={streaming} /> : null}
  </div>;
}

function LegacyCodeBlock({ source }: { source: string }): React.JSX.Element {
  const match = /^(\w+)\n/u.exec(source);
  const language = match?.[1]?.toLocaleLowerCase();
  const code = match ? source.slice(match[0].length) : source;
  return <pre className={language === 'json' || language === 'jsonc' ? 'json' : undefined}><code>{language === 'json' || language === 'jsonc' ? <JsonSyntax text={code} /> : code}</code></pre>;
}

function useStreamingRevealText(text: string, active: boolean, streaming?: ResolvedStreaming): string {
  const configured = streaming !== undefined;
  const adaptive = Boolean(streaming && streaming.reveal === 'adaptive');
  const maxVisualLagMs = streaming?.maxVisualLagMs ?? 600;
  const [presentationBypass, setPresentationBypass] = useState(() => shouldBypassStreamingReveal());
  const pacing = resolveRevealPacing(streaming?.pace ?? 'balanced');
  const [visibleLength, setVisibleLength] = useState(() => adaptive && active && !presentationBypass
    ? advanceGraphemeBoundary(text, 0, pacing.initialGraphemes)
    : text.length);
  const targetRef = useRef(text);
  const deadlineRef = useRef(nowMs() + maxVisualLagMs);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const sync = () => setPresentationBypass(shouldBypassStreamingReveal());
    document.addEventListener('visibilitychange', sync);
    media?.addEventListener?.('change', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      media?.removeEventListener?.('change', sync);
    };
  }, []);

  useLayoutEffect(() => {
    const previousTarget = targetRef.current;
    const appendOnly = text.startsWith(previousTarget);
    targetRef.current = text;
    if (!adaptive || !active || presentationBypass || !configured) {
      setVisibleLength(text.length);
      return;
    }
    if (!appendOnly) {
      deadlineRef.current = nowMs() + maxVisualLagMs;
      setVisibleLength(advanceGraphemeBoundary(text, 0, pacing.initialGraphemes));
      return;
    }
    setVisibleLength((current) => {
      const boundedCurrent = Math.min(current, text.length);
      if (text.length > boundedCurrent && boundedCurrent >= previousTarget.length) {
        deadlineRef.current = nowMs() + maxVisualLagMs;
        return advanceGraphemeBoundary(text, boundedCurrent, pacing.initialGraphemes);
      }
      return boundedCurrent;
    });
  }, [active, adaptive, configured, maxVisualLagMs, pacing.initialGraphemes, presentationBypass, text]);

  useEffect(() => {
    if (!adaptive || !active || presentationBypass || !configured) return undefined;
    const timer = window.setInterval(() => {
      setVisibleLength((current) => {
        const target = targetRef.current;
        const backlog = Math.max(0, target.length - current);
        if (backlog === 0) return current;
        const elapsed = Math.max(0, maxVisualLagMs - Math.max(0, deadlineRef.current - nowMs()));
        const step = Math.max(pacing.minimumGraphemes, calculateRevealStep(backlog, maxVisualLagMs, pacing.intervalMs, elapsed));
        return advanceGraphemeBoundary(target, current, step);
      });
    }, pacing.intervalMs);
    return () => window.clearInterval(timer);
  }, [active, adaptive, configured, maxVisualLagMs, pacing.intervalMs, pacing.minimumGraphemes, presentationBypass]);

  return text.slice(0, Math.min(visibleLength, text.length));
}

function shouldBypassStreamingReveal(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.hidden || document.body.classList.contains('vscode-using-screen-reader') || document.body.classList.contains('vscode-reduce-motion')) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function JsonPreview({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="mobile-chat-preview__json json"><code><JsonSyntax text={safeJson(value)} /></code></pre>;
}

function CitationList({ profile, citations, post, trusted }: { profile: TurnStageProfile; citations: Citation[]; post: PostMessage; trusted: boolean }): React.JSX.Element {
  return <details className="mobile-chat-preview__citations"><summary>{profile.ui?.components?.citations?.label ?? t('Sources ({count})', { count: formatNumber(citations.length) })}</summary><ol>{citations.map((citation) => <li key={citation.id}><button className="mobile-chat-preview__source" type="button" disabled={!trusted} title={citation.snippet ?? citation.description} onClick={() => post({ type: 'citation.open', citationId: citation.id })}>{citation.title ?? citation.sourceName ?? citation.id}</button>{(citation.snippet ?? citation.description) && <p>{citation.snippet ?? citation.description}</p>}</li>)}</ol></details>;
}

function MobileForm({ form, messageId, post, trusted, accepted }: { form: FormDefinition; messageId: string; post: PostMessage; trusted: boolean; accepted: boolean }): React.JSX.Element {
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
  if (accepted) return <p className="mobile-chat-preview__muted" role="status">{t('Form submitted.')}</p>;
  if (cancelled) return <p className="mobile-chat-preview__muted">{t('Form cancelled.')}</p>;
  return <form className="mobile-chat-preview__form" data-form-id={form.id} data-source-message-id={messageId} onSubmit={submit} noValidate>
    <h4>{form.title}</h4>
    <fieldset disabled={!trusted}>
      {form.fields.map((field) => <MobileFormControl key={field.id} field={field} formId={formId} value={values[field.id]} error={errors[field.id]} update={(value) => setValues((current) => ({ ...current, [field.id]: value }))} />)}
      <div className="mobile-chat-preview__action-row"><button className="mobile-chat-preview__button mobile-chat-preview__button--primary" type="submit">{t('Submit')}</button><button className="mobile-chat-preview__button" data-form-cancel="true" type="button" onClick={() => { setValues({}); setCancelled(true); post({ type: 'form.cancel', formId: form.id, }); }}>{t('Cancel')}</button></div>
    </fieldset>
  </form>;
}

function ResponseActionButton({ action, messageId, trusted, setDraft, post, onSelectMessage }: { action: NonNullable<ChatMessage['actions']>[number]; messageId: string; trusted: boolean; setDraft: SetDraft; post: PostMessage; onSelectMessage?: (messageId: string) => void }): React.JSX.Element {
  const invoke = () => {
    if (action.actionId === 'input.fill') {
      const text = action.payload?.text ?? action.payload?.prompt ?? action.payload?.value;
      if (typeof text === 'string') setDraft(text);
      return;
    }
    if (action.actionId === 'event.inspect') { onSelectMessage?.(messageId); return; }
    if (action.actionId === 'form.open' || action.actionId === 'form.submit' || action.actionId === 'form.cancel') {
      const requestedFormId = typeof action.payload?.formId === 'string' ? action.payload.formId : undefined;
      const form = findMessageForm(messageId, requestedFormId);
      if (action.actionId === 'form.open') { form?.scrollIntoView({ block: 'nearest' }); (form?.querySelector('input, textarea, select, button') as HTMLElement | null)?.focus(); }
      else if (action.actionId === 'form.submit') form?.requestSubmit();
      else (form?.querySelector('[data-form-cancel="true"]') as HTMLButtonElement | null)?.click();
      return;
    }
    post({ type: 'action.invoke', actionId: action.id, sourceMessageId: messageId });
  };
  return <button className={`mobile-chat-preview__button ${action.appearance === 'primary' ? 'mobile-chat-preview__button--primary' : ''}`} type="button" title={action.tooltip} disabled={!trusted} onClick={invoke}>{action.label}</button>;
}

function findMessageForm(messageId: string, formId?: string): HTMLFormElement | undefined {
  return [...document.querySelectorAll<HTMLFormElement>('.mobile-chat-preview__form')].find((form) => form.dataset.sourceMessageId === messageId && (!formId || form.dataset.formId === formId));
}

function MobileFormControl({ field, formId, value, error, update }: { field: FormField; formId: string; value: unknown; error?: string; update: (value: unknown) => void }): React.JSX.Element {
  const id = `${formId}-${slug(field.id)}`;
  const describedBy = error ? `${id}-error` : undefined;
  return <div className="mobile-chat-preview__field">
    <label htmlFor={id}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>
    {field.type === 'textarea' ? <textarea id={id} value={String(value ?? '')} maxLength={field.maxLength} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)} /> : field.type === 'select' ? <select id={id} value={String(value ?? '')} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)}><option value="">{t('Select…')}</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === 'checkbox' ? <input id={id} type="checkbox" checked={Boolean(value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.checked)} /> : <input id={id} type={field.type} value={String(value ?? '')} maxLength={field.maxLength} pattern={isSafeRegexPattern(field.pattern) ? field.pattern : undefined} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => update(event.target.value)} />}
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
      if (!isSafeRegexPattern(field.pattern)) errors[field.id] = t('The profile contains an invalid validation pattern.');
      else if (value && !new RegExp(field.pattern, 'u').test(String(value).slice(0, 4096))) errors[field.id] = t('{field} has an invalid format.', { field: field.label });
    }
  }
  return errors;
}

function invokeFollowup(followup: NonNullable<ChatMessage['followups']>[number], messageId: string, setDraft: SetDraft, send: SendMessage, post: PostMessage): void {
  if (followup.behavior === 'fill') setDraft(followup.prompt);
  else if (followup.behavior === 'action' && followup.actionId) post({ type: 'action.invoke', actionId: followup.actionId, sourceMessageId: messageId });
  else send(followup.prompt, { kind: 'followup', followupId: followup.id, sourceMessageId: messageId });
}

function boundedVisibleCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(12, Math.max(1, Math.round(value))) : fallback;
}

function formInstanceKey(messageId: string, part: MessagePart): string | undefined {
  if (part.type !== 'form' || !isFormDefinition(part.form)) return undefined;
  return `${messageId}:${part.form.id}`;
}

function MessageStatus({ state }: { state: string }): React.JSX.Element {
  return <span className={`mobile-chat-preview__message-status mobile-chat-preview__message-status--${state}`}><ProductIcon name="circle-filled" /> {humanize(state)}</span>;
}

function isMessageInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, input, select, textarea, summary, form'));
}

function componentVisible(profile: TurnStageProfile, name: string): boolean {
  const configured = profile.ui?.components?.[name]?.visible;
  if (configured !== undefined) return configured;
  return name !== 'usage';
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

/** A chat viewport is considered caught up when only a small bottom inset remains. */
export function isNearBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, threshold = CHAT_SCROLL_BOTTOM_THRESHOLD): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function scrollToLatest(element: HTMLElement): void {
  const top = Math.max(0, element.scrollHeight - element.clientHeight);
  if (typeof element.scrollTo === 'function') element.scrollTo({ top, behavior: 'auto' });
  element.scrollTop = top;
}

function getMessageContentKey(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.id}\u001e${message.status}\u001e${(message.parts ?? []).map((part) => `${part.type}:${String(part.text ?? '')}`).join('\u001f')}`).join('\u001d');
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
