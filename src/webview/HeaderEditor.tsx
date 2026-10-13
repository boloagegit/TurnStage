import React, { useEffect, useId, useRef, useState } from 'react';
import { isSensitiveHeaderName } from '../shared/curlCommand';
import { IconButton } from './Icon';
import { formatNumber, t } from './i18n';

export interface HeaderRow { name: string; value: string }

export function headerRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

/** Rows back to a header object. Blank rows are ignored; a value without a name or a repeated name is an error. */
export function headersFromRows(rows: readonly HeaderRow[]): { headers: Record<string, string>; error?: undefined } | { headers?: undefined; error: string } {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      if (row.value.trim()) return { error: t('Every header needs a name.') };
      continue;
    }
    if (seen.has(name.toLowerCase())) return { error: t('Header {name} appears more than once.', { name }) };
    seen.add(name.toLowerCase());
    headers[name] = row.value;
  }
  return { headers };
}

/**
 * A credential-like header with any of its value typed in as plain text: what is left after removing
 * ${secret.name} references and an auth scheme word such as Bearer is a literal credential.
 */
export function literalCredential(row: HeaderRow): boolean {
  if (!isSensitiveHeaderName(row.name.trim())) return false;
  const literal = row.value.replace(/\$\{secret\.[A-Za-z0-9_.-]+\}/gu, '').replace(/^\s*(?:Bearer|Basic|Token|Digest|ApiKey|Api-Key)\b/iu, '');
  return literal.trim() !== '';
}

/**
 * Request headers as name/value rows. Edits commit when focus leaves the rows or on Enter, Escape restores
 * the saved rows, and the raw JSON stays one disclosure away for values the rows cannot express.
 */
export function HeaderEditor({ id, label, hint, value, disabled = false, onCommit, jsonEditor }: {
  id: string;
  label: string;
  hint?: string;
  value: Record<string, string> | undefined;
  disabled?: boolean;
  onCommit: (headers: Record<string, string>) => void;
  /** The JSON editor for the same value, shown under "Edit as JSON". */
  jsonEditor: React.ReactNode;
}): React.JSX.Element {
  const source = JSON.stringify(value ?? {});
  const [rows, setRows] = useState<HeaderRow[]>(() => headerRows(value));
  const [error, setError] = useState('');
  // The rows the next commit reads; Escape resets it before blurring, which commits in the same tick.
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const focusRow = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Follow saved changes (JSON edits, undo, other editors) unless someone is typing in the rows: the
  // saved copy of a half-typed row would otherwise overwrite what is still being entered.
  useEffect(() => {
    if (listRef.current?.contains(document.activeElement)) return;
    setRows(headerRows(value));
    setError('');
  }, [source]);
  useEffect(() => {
    if (focusRow.current === undefined) return;
    listRef.current?.querySelector<HTMLInputElement>(`[data-header-row="${focusRow.current}"] input`)?.focus();
    focusRow.current = undefined;
  });
  const commit = (next: readonly HeaderRow[]) => {
    const result = headersFromRows(next);
    if (result.error !== undefined) { setError(result.error); return; }
    setError('');
    if (JSON.stringify(result.headers) !== source) onCommit(result.headers);
  };
  const update = (index: number, patch: Partial<HeaderRow>) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const remove = (index: number) => { const next = rows.filter((_, rowIndex) => rowIndex !== index); setRows(next); commit(next); };
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(latestRows.current); }
    if (event.key === 'Escape') { event.preventDefault(); latestRows.current = headerRows(value); setRows(latestRows.current); setError(''); event.currentTarget.blur(); }
  };
  const description = error || hint;
  return <fieldset className="settings-field settings-field-wide field-wide header-editor" aria-describedby={description ? hintId : undefined}>
    <legend>{label}</legend>
    {/* Rows commit together when focus leaves them, so moving from a name to its value sends nothing half-typed. */}
    <div ref={listRef} className="header-editor__rows" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(latestRows.current); }}>
      {rows.length === 0 && <p className="header-editor__empty">{t('No headers.')}</p>}
      {rows.map((row, index) => {
        const name = row.name.trim() || t('header {number}', { number: formatNumber(index + 1) });
        return <div key={index} className="header-editor__row" data-header-row={index}>
          <input id={index === 0 ? id : undefined} value={row.name} disabled={disabled} spellCheck={false} autoComplete="off" placeholder={t('Name')} aria-label={t('Header {number} name', { number: formatNumber(index + 1) })} onChange={(event) => update(index, { name: event.target.value })} onKeyDown={keys} />
          <input value={row.value} disabled={disabled} spellCheck={false} autoComplete="off" placeholder={t('Value')} aria-label={t('Header {number} value', { number: formatNumber(index + 1) })} onChange={(event) => update(index, { value: event.target.value })} onKeyDown={keys} />
          <IconButton type="button" icon="trash" label={t('Remove {name}', { name })} disabled={disabled} onClick={() => remove(index)} />
          {literalCredential(row) && <p className="header-editor__warning" role="note">{t('This looks like a credential. Use a secret reference such as ${secret.apiKey} so the value stays out of the Profile.')}</p>}
        </div>;
      })}
    </div>
    <div className="header-editor__actions">
      <button type="button" disabled={disabled} onClick={() => { focusRow.current = rows.length; setRows([...rows, { name: '', value: '' }]); }}>{t('Add header')}</button>
    </div>
    {description && <p id={hintId} className={error ? 'settings-field-error' : 'settings-field-hint'} role={error ? 'alert' : undefined}>{description}</p>}
    <details className="header-editor__json">
      <summary>{t('Edit as JSON')}</summary>
      {jsonEditor}
    </details>
  </fieldset>;
}
