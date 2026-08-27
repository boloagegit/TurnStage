import React from 'react';
import '@vscode/codicons/dist/codicon.css';

export type ProductIconName =
  | 'add'
  | 'arrow-down'
  | 'arrow-up'
  | 'check'
  | 'circle-filled'
  | 'copy'
  | 'device-mobile'
  | 'edit'
  | 'file-code'
  | 'info'
  | 'refresh'
  | 'send'
  | 'stop'
  | 'target'
  | 'warning';

const codicons: Record<ProductIconName, string> = {
  add: 'add',
  'arrow-down': 'arrow-down',
  'arrow-up': 'arrow-up',
  check: 'check',
  'circle-filled': 'circle-filled',
  copy: 'copy',
  'device-mobile': 'device-mobile',
  edit: 'edit',
  'file-code': 'file-code',
  info: 'info',
  refresh: 'refresh',
  send: 'send',
  stop: 'debug-stop',
  target: 'target',
  warning: 'warning'
};

export function ProductIcon({ name, className = '' }: { name: ProductIconName; className?: string }): React.JSX.Element {
  if (name === 'send') {
    return <svg className={`product-icon product-icon--svg ${className}`.trim()} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M1 1.91 1.78 1.5 15 7.449v.951L1.78 14.33 1 13.91 2.583 8 1 1.91Zm2.612 6.59L2.33 13.13 13.5 7.9 2.33 2.839l1.282 4.6L9 7.5v1H3.612Z" /></svg>;
  }
  if (name === 'stop') {
    return <svg className={`product-icon product-icon--svg ${className}`.trim()} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path fillRule="evenodd" clipRule="evenodd" d="m13 2 1 1v10l-1 1H3l-1-1V3l1-1h10Zm-.254 1.251H3.255v9.499h9.491V3.251Z" /></svg>;
  }
  return <span className={`codicon codicon-${codicons[name]} product-icon ${className}`.trim()} aria-hidden="true" />;
}

export function IconButton({ icon, label, className = '', ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> & { icon: ProductIconName; label: string }): React.JSX.Element {
  return <button {...props} className={`icon-button ${className}`.trim()} aria-label={label} title={label}><ProductIcon name={icon} /></button>;
}
