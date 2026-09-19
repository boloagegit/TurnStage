import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Icon';
import { t } from './i18n';

export function CaseEditorOverlay({ title, context, children, footer, className, closeLabel, onRequestClose }: {
  title: string;
  context?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  closeLabel?: string;
  onRequestClose: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const oldOverflow = document.body.style.overflow;
    const background = [...document.body.children].filter((item): item is HTMLElement => item instanceof HTMLElement && !item.classList.contains('case-editor-overlay')).map((item) => ({ item, inert: item.inert }));
    for (const { item } of background) item.inert = true;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('.case-editor-dialog__header button')?.focus({ preventScroll: true });
    return () => { for (const { item, inert } of background) item.inert = inert; document.body.style.overflow = oldOverflow; previous?.focus({ preventScroll: true }); };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onRequestClose(); return; }
    if (event.key !== 'Tab' || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((item) => item.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return createPortal(<div className="case-editor-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onRequestClose(); }}>
    <section ref={dialog} className={['case-editor-dialog', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
      <header className="case-editor-dialog__header"><div><strong>{title}</strong>{context && <small>{context}</small>}</div><IconButton type="button" icon="close" label={closeLabel ?? t('Close editor')} onClick={onRequestClose} /></header>
      <div className="case-editor-dialog__body">{children}</div>
      {footer && <footer className="case-editor-dialog__footer">{footer}</footer>}
    </section>
  </div>, document.body);
}
