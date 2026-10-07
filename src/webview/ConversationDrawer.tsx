import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { WebviewPayload } from '../shared/protocol';
import type { ChatMessage, ConversationDirectory, ConversationSummary, HistoryConsistencyResult } from '../shared/types';
import { diffText, messageText } from '../shared/conversationHistory';
import { formatNumber, formatShortDateTime, t } from './i18n';
import { IconButton, ProductIcon } from './Icon';

export type ConversationDrawerView = 'conversations' | 'check';

export interface HistoryCheckSummary { status: 'checking' | 'match' | 'mismatch' | 'failed'; differences: number }

/** One-glance state of the latest server history comparison, or undefined when nothing was checked. */
export function historyCheckSummary(directory: ConversationDirectory | undefined): HistoryCheckSummary | undefined {
  const check = directory?.check;
  if (!check) return undefined;
  if (check.status === 'checking') return { status: 'checking', differences: 0 };
  if (check.status === 'failed') return { status: 'failed', differences: 0 };
  const differences = check.results.filter((result) => result.status !== 'match').length;
  return { status: differences ? 'mismatch' : 'match', differences };
}

type DayGroup = 'today' | 'yesterday' | 'earlier';
function dayGroup(timestamp: number, now = new Date()): DayGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return 'today';
  if (timestamp >= startOfToday - 86_400_000) return 'yesterday';
  return 'earlier';
}
const GROUP_LABELS: Record<DayGroup, string> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' };

export function groupConversations(items: readonly ConversationSummary[], query: string, now = new Date()): Array<{ group: DayGroup; items: ConversationSummary[] }> {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? items.filter((item) => `${item.title}\n${item.preview ?? ''}\n${item.conversationId ?? ''}`.toLocaleLowerCase().includes(needle)) : items;
  const groups = new Map<DayGroup, ConversationSummary[]>();
  for (const item of filtered) {
    const group = item.updatedAt ? dayGroup(item.updatedAt, now) : 'earlier';
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return (['today', 'yesterday', 'earlier'] as const).flatMap((group) => groups.has(group) ? [{ group, items: groups.get(group)! }] : []);
}

export const ConversationDrawer = memo(function ConversationDrawer({ id, directory, messages, view, onViewChange, onClose, post, busy, onRevealMessage }: {
  id: string;
  directory: ConversationDirectory;
  messages: readonly ChatMessage[];
  view: ConversationDrawerView;
  onViewChange: (view: ConversationDrawerView) => void;
  onClose: () => void;
  post: (message: WebviewPayload) => void;
  busy: boolean;
  onRevealMessage?: (messageId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string>();
  const panelRef = useRef<HTMLElement>(null);
  const groups = useMemo(() => groupConversations(directory.items, query), [directory.items, query]);
  const checkAvailable = directory.history.configured;
  const activeView = checkAvailable ? view : 'conversations';
  const remoteRequested = useRef(false);

  useEffect(() => {
    // Load the server list once per open drawer; the archive is already local.
    if (directory.remote.configured && directory.remote.status === 'idle' && !remoteRequested.current) {
      remoteRequested.current = true;
      post({ type: 'conversation.list.refresh' });
    }
  }, [directory.remote.configured, directory.remote.status, post]);

  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); }, []);

  return <section ref={panelRef} id={id} className="conversation-drawer" aria-label={t('Conversations')} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <header className="conversation-drawer__header">
      {checkAvailable
        ? <div className="conversation-drawer__views" role="tablist" aria-label={t('Conversation panel views')}>
            <button type="button" role="tab" aria-selected={activeView === 'conversations'} tabIndex={activeView === 'conversations' ? 0 : -1} data-autofocus={activeView === 'conversations' ? '' : undefined} onClick={() => onViewChange('conversations')}>{t('Conversations')}</button>
            <button type="button" role="tab" aria-selected={activeView === 'check'} tabIndex={activeView === 'check' ? 0 : -1} data-autofocus={activeView === 'check' ? '' : undefined} onClick={() => onViewChange('check')}>{t('History check')}<HistoryCheckMark directory={directory} /></button>
          </div>
        : <strong className="conversation-drawer__title">{t('Conversations')}</strong>}
      <IconButton icon="close" label={t('Close conversations')} type="button" onClick={onClose} />
    </header>

    {activeView === 'conversations' ? <>
      <div className="conversation-drawer__tools">
        <label className="conversation-drawer__search"><ProductIcon name="search" /><span className="sr-only">{t('Search conversations')}</span><input type="search" value={query} placeholder={t('Search conversations')} onChange={(event) => setQuery(event.target.value)} data-autofocus={checkAvailable ? undefined : ''} /></label>
        <IconButton className="conversation-drawer__new" icon="add" label={t('New conversation')} type="button" disabled={busy} onClick={() => post({ type: 'conversation.new' })} />
      </div>
      {directory.openError && <p className="conversation-drawer__notice" role="alert"><ProductIcon name="warning" />{t('Could not load the conversation: {error}', { error: directory.openError })}</p>}
      <div className="conversation-drawer__list">
        {!directory.enabled && !directory.remote.configured && <p className="conversation-drawer__empty">{t('The conversation archive is turned off for this Profile.')}</p>}
        {(directory.enabled || directory.remote.configured) && groups.length === 0 && directory.remote.status !== 'loading' && <p className="conversation-drawer__empty">{query ? t('No conversations match this search.') : t('Conversations appear here after the first reply.')}</p>}
        {groups.map(({ group, items }) => <div key={group} className="conversation-drawer__group" role="group" aria-labelledby={`${id}-${group}`}>
          <h3 id={`${id}-${group}`}>{t(GROUP_LABELS[group])}</h3>
          <ul>{items.map((item) => <ConversationRow key={item.key} item={item} current={item.key === directory.currentKey} opening={directory.opening === item.key} disabled={busy || Boolean(directory.opening)} pendingDelete={pendingDelete === item.key} onOpen={() => post({ type: 'conversation.open', key: item.key })} onRequestDelete={() => setPendingDelete(item.key)} onCancelDelete={() => setPendingDelete(undefined)} onDelete={() => { setPendingDelete(undefined); post({ type: 'conversation.delete', key: item.key }); }} />)}</ul>
        </div>)}
        {directory.remote.status === 'loading' && <ul className="conversation-drawer__skeleton" aria-hidden="true"><li /><li /><li /></ul>}
      </div>
      <footer className="conversation-drawer__footer">
        {directory.remote.configured
          ? <><span>{directory.remote.status === 'failed' ? t('Server list unavailable: {error}', { error: directory.remote.error ?? '' }) : directory.remote.status === 'loading' ? t('Loading server conversations…') : t('Includes conversations from the server list.')}</span><IconButton icon="refresh" label={t('Refresh server conversations')} type="button" disabled={directory.remote.status === 'loading'} onClick={() => post({ type: 'conversation.list.refresh' })} /></>
          : <span>{directory.enabled ? t('Saved on this device. Configure conversations.list to include server conversations.') : t('Configure conversations.list to show server conversations.')}</span>}
      </footer>
    </> : <HistoryCheckView directory={directory} messages={messages} post={post} busy={busy} onRevealMessage={onRevealMessage} />}
  </section>;
});

function ConversationRow({ item, current, opening, disabled, pendingDelete, onOpen, onRequestDelete, onCancelDelete, onDelete }: { item: ConversationSummary; current: boolean; opening: boolean; disabled: boolean; pendingDelete: boolean; onOpen: () => void; onRequestDelete: () => void; onCancelDelete: () => void; onDelete: () => void }): React.JSX.Element {
  const title = item.title || t('Untitled conversation');
  return <li className={`conversation-row${current ? ' conversation-row--current' : ''}`}>
    <button type="button" className="conversation-row__open" aria-current={current ? 'true' : undefined} aria-busy={opening || undefined} disabled={!current && disabled} onClick={current ? undefined : onOpen}>
      <span className="conversation-row__title">{title}</span>
      {item.preview && <span className="conversation-row__preview">{item.preview}</span>}
      <span className="conversation-row__meta">
        {item.source === 'remote' && <span className="conversation-row__source">{t('Server')}</span>}
        {current && <span className="conversation-row__source">{t('Current')}</span>}
        {opening && <span className="conversation-row__source"><ProductIcon name="loading" className="codicon-modifier-spin" />{t('Loading…')}</span>}
        <span className="conversation-row__time">{item.updatedAt ? formatShortDateTime(item.updatedAt) : ''}{item.messageCount ? ` · ${formatNumber(item.messageCount)}` : ''}</span>
      </span>
    </button>
    {item.source === 'local' && !current && (pendingDelete
      ? <span className="conversation-row__confirm" role="group" aria-label={t('Delete {title}?', { title })}><button type="button" className="danger-subtle" onClick={onDelete}>{t('Delete')}</button><button type="button" onClick={onCancelDelete}>{t('Cancel')}</button></span>
      : <IconButton className="conversation-row__delete" icon="trash" label={t('Delete {title}', { title })} type="button" disabled={disabled} onClick={onRequestDelete} />)}
  </li>;
}

function HistoryCheckMark({ directory }: { directory: ConversationDirectory }): React.JSX.Element | null {
  const summary = historyCheckSummary(directory);
  if (!summary || summary.status === 'match') return null;
  if (summary.status === 'checking') return <ProductIcon name="loading" className="codicon-modifier-spin history-check-mark" />;
  return <span className={`history-check-mark history-check-mark--${summary.status}`} aria-hidden="true">{summary.status === 'mismatch' ? formatNumber(summary.differences) : '!'}</span>;
}

function HistoryCheckView({ directory, messages, post, busy, onRevealMessage }: { directory: ConversationDirectory; messages: readonly ChatMessage[]; post: (message: WebviewPayload) => void; busy: boolean; onRevealMessage?: (messageId: string) => void }): React.JSX.Element {
  const check = directory.check;
  const messageById = useMemo(() => new Map(messages.map((message, index) => [message.id, { message, index }])), [messages]);
  // Newest message first, in conversation order rather than grouped by role.
  const results = useMemo(() => [...(check?.results ?? [])].sort((left, right) => (messageById.get(right.messageId)?.index ?? -1) - (messageById.get(left.messageId)?.index ?? -1)), [check?.results, messageById]);
  const differences = results.filter((result) => result.status !== 'match');
  return <div className="history-check" aria-busy={check?.status === 'checking' || undefined}>
    <div className="history-check__summary">
      <div>
        <strong>{t('Streamed vs. saved on the server')}</strong>
        <span>{!check ? t('Not checked yet.') : check.status === 'checking' ? t('Reading server history…') : check.status === 'failed' ? t('Check failed: {error}', { error: check.error ?? '' }) : differences.length ? t('{count} of {total} messages differ', { count: formatNumber(differences.length), total: formatNumber(results.length) }) : t('All {total} checked messages match', { total: formatNumber(results.length) })}</span>
      </div>
      <button type="button" disabled={busy || check?.status === 'checking'} onClick={() => post({ type: 'conversation.history.verify' })}>{check ? t('Check again') : t('Check now')}</button>
    </div>
    <p className="history-check__hint">{t('After a reply, TurnStage reads conversations.history and compares it with what was streamed. The next turn uses the server copy as context.')}</p>
    {results.length > 0 && <ul className="history-check__results">{results.map((result) => <HistoryCheckRow key={result.messageId} result={result} message={messageById.get(result.messageId)?.message} onReveal={onRevealMessage} />)}</ul>}
  </div>;
}

function HistoryCheckRow({ result, message, onReveal }: { result: HistoryConsistencyResult; message?: ChatMessage; onReveal?: (messageId: string) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(result.status === 'mismatch');
  const roleLabel = result.role === 'user' ? t('User') : t('Assistant');
  const excerpt = message ? messageText(message).replace(/\s+/gu, ' ').trim().slice(0, 80) : '';
  const statusLabel = result.status === 'match' ? t('Matches') : result.status === 'missing' ? t('Not in server history') : t('Text differs');
  const segments = useMemo(() => result.status === 'mismatch' && expanded ? diffText(result.streamedText ?? '', result.persistedText ?? '') : [], [expanded, result]);
  return <li className={`history-check-row history-check-row--${result.status}`}>
    <div className="history-check-row__head">
      <span className={`history-check-row__mark history-check-row__mark--${result.status}`} aria-hidden="true" />
      <span className="history-check-row__label"><strong>{roleLabel}</strong>{excerpt && <span> · {excerpt}</span>}</span>
      <span className="history-check-row__status">{statusLabel}</span>
    </div>
    <div className="history-check-row__actions">
      {result.status === 'mismatch' && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? t('Hide differences') : t('Show differences')}</button>}
      {onReveal && message && <button type="button" onClick={() => onReveal(result.messageId)}>{t('Show in conversation')}</button>}
    </div>
    {segments.length > 0 && <div className="history-check-row__diff">
      <p>{segments.map((segment, index) => segment.kind === 'same' ? <span key={index}>{segment.text}</span> : segment.kind === 'removed' ? <del key={index}>{segment.text}</del> : <ins key={index}>{segment.text}</ins>)}</p>
      <p className="history-check-row__legend"><del>{t('Streamed')}</del> <ins>{t('Saved on server')}</ins></p>
    </div>}
  </li>;
}
