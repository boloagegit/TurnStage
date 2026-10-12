import React, { useEffect, useState } from 'react';
import { IconButton } from './Icon';
import { t } from './i18n';
import { copyText } from './clipboardText';

export function ClipboardButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timeout = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timeout);
  }, [state]);
  const copy = async (): Promise<void> => {
    try {
      await copyText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  const status = state === 'copied' ? t('Copied') : state === 'failed' ? t('Copy failed. Try again.') : '';
  return <span className={`clipboard-action clipboard-action--${state}`}>
    <IconButton icon={state === 'copied' ? 'check' : state === 'failed' ? 'warning' : 'copy'} label={state === 'copied' ? t('Copied') : label} type="button" onClick={() => { void copy(); }} />
    <span className={state === 'failed' ? 'clipboard-feedback clipboard-feedback--error' : 'sr-status'} role="status" aria-live="polite" aria-atomic="true">{status}</span>
  </span>;
}
