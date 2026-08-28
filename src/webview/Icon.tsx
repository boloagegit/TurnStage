import React from 'react';
import '@vscode/codicons/dist/codicon.css';

export type ProductIconName =
  | 'add'
  | 'arrow-down'
  | 'arrow-up'
  | 'arrow-swap'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'circle-filled'
  | 'clear-all'
  | 'copy'
  | 'desktop-download'
  | 'device-desktop'
  | 'device-mobile'
  | 'edit'
  | 'file-code'
  | 'info'
  | 'refresh'
  | 'send'
  | 'screen-full'
  | 'settings-gear'
  | 'stop'
  | 'target'
  | 'warning';

const codicons: Record<ProductIconName, string> = {
  add: 'add',
  'arrow-down': 'arrow-down',
  'arrow-up': 'arrow-up',
  'arrow-swap': 'arrow-swap',
  check: 'check',
  'chevron-down': 'chevron-down',
  'chevron-right': 'chevron-right',
  'circle-filled': 'circle-filled',
  'clear-all': 'clear-all',
  copy: 'copy',
  'desktop-download': 'desktop-download',
  'device-desktop': 'device-desktop',
  'device-mobile': 'device-mobile',
  edit: 'edit',
  'file-code': 'file-code',
  info: 'info',
  refresh: 'refresh',
  send: 'send',
  'screen-full': 'screen-full',
  'settings-gear': 'settings-gear',
  stop: 'debug-stop',
  target: 'target',
  warning: 'warning'
};

export function ProductIcon({ name, className = '' }: { name: ProductIconName; className?: string }): React.JSX.Element {
  return <span className={`codicon codicon-${codicons[name]} product-icon ${className}`.trim()} aria-hidden="true" />;
}

export function IconButton({ icon, label, className = '', ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> & { icon: ProductIconName; label: string }): React.JSX.Element {
  return <button {...props} className={`icon-button ${className}`.trim()} aria-label={label} title={label}><ProductIcon name={icon} /></button>;
}
