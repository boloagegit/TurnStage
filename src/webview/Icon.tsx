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
  | 'debug-restart'
  | 'device-camera'
  | 'device-desktop'
  | 'device-mobile'
  | 'edit'
  | 'diff'
  | 'file-code'
  | 'info'
  | 'refresh'
  | 'save'
  | 'send'
  | 'screen-full'
  | 'settings-gear'
  | 'stop'
  | 'target'
  | 'trash'
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
  'debug-restart': 'debug-restart',
  'device-camera': 'device-camera',
  'device-desktop': 'device-desktop',
  'device-mobile': 'device-mobile',
  edit: 'edit',
  diff: 'diff',
  'file-code': 'file-code',
  info: 'info',
  refresh: 'refresh',
  save: 'save',
  send: 'send',
  'screen-full': 'screen-full',
  'settings-gear': 'settings-gear',
  stop: 'debug-stop',
  target: 'target',
  trash: 'trash',
  warning: 'warning'
};

export function ProductIcon({ name, className = '' }: { name: ProductIconName; className?: string }): React.JSX.Element {
  return <span className={`codicon codicon-${codicons[name]} product-icon ${className}`.trim()} aria-hidden="true" />;
}

export function IconButton({ icon, label, className = '', ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> & { icon: ProductIconName; label: string }): React.JSX.Element {
  return <button {...props} className={`icon-button ${className}`.trim()} aria-label={label} title={label}><ProductIcon name={icon} /></button>;
}
