import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import './confirmAction.css';

interface Confirmation {
  title: string;
  actionLabel: string;
  detail?: string;
  onConfirm: () => void;
  tone?: 'default' | 'danger';
}

/** Confirmation stays in the Webview so Web and VSIX profile edits share one safeguard. */
export function useConfirmAction(): [(confirmation: Confirmation) => void, React.ReactNode] {
  const [pending, setPending] = useState<Confirmation>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const oldOverflow = document.body.style.overflow;
    const background = [...document.body.children]
      .filter((item): item is HTMLElement => item instanceof HTMLElement && !item.classList.contains('confirm-action-overlay'))
      .map((item) => ({ item, inert: item.inert }));
    for (const { item } of background) item.inert = true;
    document.body.style.overflow = 'hidden';
    cancelButton.current?.focus({ preventScroll: true });
    return () => {
      for (const { item, inert } of background) item.inert = inert;
      document.body.style.overflow = oldOverflow;
      previous?.focus({ preventScroll: true });
    };
  }, [pending]);
  const close = () => setPending(undefined);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab' || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const node = pending ? createPortal(<div className="confirm-action-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="confirm-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-action-title" aria-describedby="confirm-action-detail" onKeyDown={onKeyDown}>
      <h2 id="confirm-action-title">{pending.title}</h2>
      <p id="confirm-action-detail">{pending.detail ?? t('This change will be applied immediately. Cancel to keep the item.')}</p>
      <div className="confirm-action-dialog__actions">
        <button ref={cancelButton} type="button" onClick={close}>{t('Cancel')}</button>
        <button type="button" className={pending.tone === 'default' ? 'primary' : 'danger'} onClick={() => { const action = pending.onConfirm; close(); action(); }}>{pending.actionLabel}</button>
      </div>
    </section>
  </div>, document.body) : null;
  return [setPending, node];
}
