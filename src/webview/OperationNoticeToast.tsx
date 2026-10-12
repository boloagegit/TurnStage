import React, { useEffect, useState } from 'react';
import type { WebviewPayload } from '../shared/protocol';
import { IconButton, ProductIcon } from './Icon';
import { t } from './i18n';

export type OperationNotice = string | { message: string; artifactId?: string; severity?: 'error' };

export const errorNotice = (message: string): OperationNotice => ({ message, severity: 'error' });

const NOTICE_MS = 3200;
const ARTIFACT_NOTICE_MS = 8000;

/** A floating operation notice. Errors stay until dismissed; other notices wait while the pointer or keyboard focus is on them. */
export function OperationNoticeToast({ notice, onDismiss, post }: { notice: OperationNotice; onDismiss: () => void; post: (message: WebviewPayload) => void }): React.JSX.Element | null {
  const [held, setHeld] = useState(false);
  const isError = typeof notice !== 'string' && notice.severity === 'error';
  const artifactId = typeof notice !== 'string' ? notice.artifactId : undefined;
  useEffect(() => setHeld(false), [notice]);
  useEffect(() => {
    if (!notice || held || isError) return;
    const timeout = window.setTimeout(onDismiss, artifactId ? ARTIFACT_NOTICE_MS : NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [notice, held, isError, artifactId, onDismiss]);
  if (!notice) return null;
  return <div className={`operation-status${isError ? ' operation-status--error' : ''}`} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'} aria-atomic="true" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false); }}>
    <ProductIcon name={isError ? 'error' : 'info'} />
    <span>{typeof notice === 'string' ? notice : notice.message}</span>
    {artifactId && <div className="operation-status__actions">
      <button type="button" onClick={() => post({ type: 'artifact.action', artifactId, action: 'open' })}>{t('Open')}</button>
      <IconButton icon="folder-opened" label={t('Reveal in file explorer')} type="button" onClick={() => post({ type: 'artifact.action', artifactId, action: 'reveal' })} />
      <IconButton icon="copy" label={t('Copy path')} type="button" onClick={() => post({ type: 'artifact.action', artifactId, action: 'copyPath' })} />
    </div>}
    <IconButton icon="close" label={t('Dismiss notification')} type="button" onClick={onDismiss} />
  </div>;
}
