import React, { useEffect, useId, useRef, useState } from 'react';
import { formatNumber, t } from './i18n';
import './tokenListInput.css';

/**
 * A list setting edited as removable chips. Enter (or a comma, unless `splitOnComma` is off for values
 * that may contain one) adds what was typed, pasting several lines or comma-separated values adds them
 * all, Backspace in an empty box takes the last chip back for editing, and Escape restores the saved list.
 * Changes commit when a chip is added or removed and when focus leaves the box.
 */
export function TokenListInput({ id, value, placeholder, disabled = false, splitOnComma = true, maxItems, validate, onCommit, ...aria }: {
  id?: string;
  value: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  splitOnComma?: boolean;
  maxItems?: number;
  /** Returns the stored form of a typed value, or an error message to show instead of adding it. */
  validate?: (token: string) => { token: string } | { error: string };
  onCommit: (value: string[]) => void;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}): React.JSX.Element {
  const source = JSON.stringify(value);
  const [tokens, setTokens] = useState<string[]>(() => [...value]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reverting = useRef(false);
  const instructionsId = useId();
  const errorId = useId();
  // Follow saved changes unless someone is typing here, as the header and starter editors do.
  useEffect(() => {
    if (rootRef.current?.contains(document.activeElement)) return;
    setTokens([...value]);
    setDraft('');
    setError('');
  }, [source]);
  const commit = (next: readonly string[]) => { if (JSON.stringify(next) !== source) onCommit([...next]); };
  /** Adds typed values to `base`; returns the new list, or undefined when one was rejected. */
  const add = (base: readonly string[], typed: readonly string[]): string[] | undefined => {
    const next = [...base];
    for (const raw of typed) {
      const text = raw.trim();
      if (!text) continue;
      const checked = validate ? validate(text) : { token: text };
      if ('error' in checked) { setError(checked.error); return undefined; }
      if (next.includes(checked.token)) continue;
      if (maxItems !== undefined && next.length >= maxItems) { setError(t('Up to {count} values.', { count: formatNumber(maxItems) })); return undefined; }
      next.push(checked.token);
    }
    setError('');
    return next;
  };
  const split = (text: string) => text.split(splitOnComma ? /[,\n]/u : /\n/u);
  const addAndCommit = (typed: readonly string[], keepDraft = '') => {
    const next = add(tokens, typed);
    if (!next) return false;
    setTokens(next);
    setDraft(keepDraft);
    commit(next);
    return true;
  };
  const remove = (index: number) => {
    const next = tokens.filter((_, tokenIndex) => tokenIndex !== index);
    setTokens(next);
    setError('');
    commit(next);
    inputRef.current?.focus();
  };
  const describedBy = [aria['aria-describedby'], instructionsId, error ? errorId : undefined].filter(Boolean).join(' ');
  return <><div ref={rootRef} className={`token-input${disabled ? ' is-disabled' : ''}${error || aria['aria-invalid'] ? ' is-invalid' : ''}`}
    onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}
    onBlur={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (reverting.current) { reverting.current = false; return; }
      if (draft.trim()) addAndCommit(split(draft));
      else commit(tokens);
    }}>
    {tokens.length > 0 && <ul className="token-input__chips">
      {tokens.map((token, index) => <li key={`${index}:${token}`} className="token-input__chip">
        <span>{token}</span>
        <button type="button" disabled={disabled} aria-label={t('Remove {name}', { name: token })} onClick={() => remove(index)}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </li>)}
    </ul>}
    <input ref={inputRef} id={id} value={draft} disabled={disabled} spellCheck={false} autoComplete="off"
      placeholder={tokens.length ? undefined : placeholder} aria-label={aria['aria-label']}
      aria-describedby={describedBy} aria-invalid={error || aria['aria-invalid'] ? true : undefined}
      onChange={(event) => {
        const text = event.target.value;
        const parts = splitOnComma ? text.split(',') : [text];
        if (parts.length > 1) addAndCommit(parts.slice(0, -1), parts.at(-1));
        else { setDraft(text); if (error) setError(''); }
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text');
        const parts = split(text);
        if (parts.length < 2) return;
        event.preventDefault();
        addAndCommit([draft + parts[0], ...parts.slice(1)]);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (draft.trim()) addAndCommit([draft]);
        } else if (event.key === 'Backspace' && draft === '' && tokens.length > 0) {
          // Take the last chip back into the box to edit it; it is saved again on Enter or when focus leaves.
          event.preventDefault();
          setDraft(tokens.at(-1)!);
          setTokens(tokens.slice(0, -1));
          setError('');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          reverting.current = true;
          setTokens([...value]);
          setDraft('');
          setError('');
          event.currentTarget.blur();
        }
      }} />
  </div>
    <span id={instructionsId} className="sr-only">{t(splitOnComma ? 'Press Enter or type a comma to add each value.' : 'Press Enter to add each value.')}</span>
    {error && <p id={errorId} className="settings-field-error field-error token-input__error" role="alert">{error}</p>}
  </>;
}
