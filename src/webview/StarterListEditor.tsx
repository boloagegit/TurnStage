import React, { useEffect, useId, useRef, useState } from 'react';
import type { Starter } from '../shared/types';
import { IconButton } from './Icon';
import { formatNumber, t } from './i18n';

export interface StarterRow { id: string; label: string; prompt: string; behavior: Starter['behavior']; actionId: string }

/** The editable shape of each configured starter; a plain string is a sendable prompt, as at runtime. */
export function starterRows(value: unknown): StarterRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): StarterRow[] => {
    if (typeof item === 'string') return [{ id: `starter-${index + 1}`, label: item, prompt: item, behavior: 'send', actionId: '' }];
    if (!item || typeof item !== 'object') return [];
    const record = item as Partial<Starter>;
    const behavior = record.behavior === 'fill' || record.behavior === 'action' ? record.behavior : 'send';
    return [{ id: typeof record.id === 'string' ? record.id : `starter-${index + 1}`, label: typeof record.label === 'string' ? record.label : '', prompt: typeof record.prompt === 'string' ? record.prompt : '', behavior, actionId: typeof record.actionId === 'string' ? record.actionId : '' }];
  });
}

function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40);
}

/** Rows back to starters. Blank rows are dropped; an action starter needs its action ID; IDs stay unique. */
export function startersFromRows(rows: readonly StarterRow[]): { starters: Starter[]; error?: undefined } | { starters?: undefined; error: string } {
  const starters: Starter[] = [];
  const used = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const label = row.label.trim();
    const prompt = row.prompt.trim();
    if (!label && !prompt) continue;
    if (row.behavior === 'action' && !row.actionId.trim()) return { error: t('Starter {number} runs an action; enter its action ID.', { number: formatNumber(index + 1) }) };
    let id = row.id.trim() || slug(label || prompt) || `starter-${index + 1}`;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${row.id.trim() || slug(label || prompt) || `starter-${index + 1}`}-${suffix}`;
    used.add(id);
    starters.push({ id, label: label || prompt, prompt: prompt || label, behavior: row.behavior, ...(row.behavior === 'action' ? { actionId: row.actionId.trim() } : {}) });
  }
  return { starters };
}

/**
 * Opening starter prompts as cards: label, the text it sends or fills, and what clicking it does.
 * Like the header rows, edits commit when focus leaves the list (selects and reordering commit at once),
 * Escape restores the saved list, and the JSON stays under "Edit as JSON".
 */
export function StarterListEditor({ value, onCommit, jsonEditor }: { value: unknown; onCommit: (starters: Starter[]) => void; jsonEditor: React.ReactNode }): React.JSX.Element {
  const source = JSON.stringify(value ?? []);
  const [rows, setRows] = useState<StarterRow[]>(() => starterRows(value));
  const [error, setError] = useState('');
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const listRef = useRef<HTMLOListElement>(null);
  const focusRow = useRef<number | undefined>(undefined);
  const errorId = useId();
  useEffect(() => {
    if (listRef.current?.contains(document.activeElement)) return;
    setRows(starterRows(value));
    setError('');
  }, [source]);
  useEffect(() => {
    if (focusRow.current === undefined) return;
    listRef.current?.querySelector<HTMLInputElement>(`[data-starter-row="${focusRow.current}"] input`)?.focus();
    focusRow.current = undefined;
  });
  const commit = (next: readonly StarterRow[]) => {
    const result = startersFromRows(next);
    if (result.error !== undefined) { setError(result.error); return; }
    setError('');
    if (JSON.stringify(result.starters) !== source) onCommit(result.starters);
  };
  const change = (next: StarterRow[], commitNow = false) => { latestRows.current = next; setRows(next); if (commitNow) commit(next); };
  const update = (index: number, patch: Partial<StarterRow>, commitNow = false) => change(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row), commitNow);
  const move = (index: number, direction: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + direction, 0, row!);
    change(next, true);
  };
  const keys = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.currentTarget.tagName === 'INPUT') { event.preventDefault(); commit(latestRows.current); }
    if (event.key === 'Escape') { event.preventDefault(); latestRows.current = starterRows(value); setRows(latestRows.current); setError(''); event.currentTarget.blur(); }
  };
  return <div className="starter-editor" aria-describedby={error ? errorId : undefined}>
    {rows.length === 0 && <p className="header-editor__empty">{t('No starter prompts. People start by typing their own message.')}</p>}
    <ol ref={listRef} className="starter-editor__list" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(latestRows.current); }}>
      {rows.map((row, index) => {
        const number = formatNumber(index + 1);
        const name = row.label.trim() || t('starter {number}', { number });
        return <li key={index} className="starter-editor__item" data-starter-row={index}>
          <div className="starter-editor__heading">
            <strong>{t('Starter {number}', { number })}</strong>
            <span className="starter-editor__tools">
              <IconButton type="button" icon="arrow-up" label={t('Move {name} up', { name })} disabled={index === 0} onClick={() => move(index, -1)} />
              <IconButton type="button" icon="arrow-down" label={t('Move {name} down', { name })} disabled={index === rows.length - 1} onClick={() => move(index, 1)} />
              <IconButton type="button" icon="trash" label={t('Remove {name}', { name })} onClick={() => change(rows.filter((_, rowIndex) => rowIndex !== index), true)} />
            </span>
          </div>
          <label className="starter-editor__field"><span>{t('Button label')}</span><input value={row.label} autoComplete="off" onChange={(event) => update(index, { label: event.target.value })} onKeyDown={keys} /></label>
          <label className="starter-editor__field"><span>{t('Message')}</span><textarea rows={2} value={row.prompt} onChange={(event) => update(index, { prompt: event.target.value })} onKeyDown={keys} /></label>
          <label className="starter-editor__field"><span>{t('When clicked')}</span>
            <select value={row.behavior} onChange={(event) => update(index, { behavior: event.target.value as Starter['behavior'] }, true)}>
              <option value="send">{t('Send the message')}</option>
              <option value="fill">{t('Put the message in the composer')}</option>
              <option value="action">{t('Run a response action')}</option>
            </select>
          </label>
          {row.behavior === 'action' && <label className="starter-editor__field"><span>{t('Action ID')}</span><input value={row.actionId} spellCheck={false} autoComplete="off" onChange={(event) => update(index, { actionId: event.target.value })} onKeyDown={keys} /></label>}
        </li>;
      })}
    </ol>
    <div className="header-editor__actions"><button type="button" onClick={() => { focusRow.current = rows.length; change([...rows, { id: '', label: '', prompt: '', behavior: 'send', actionId: '' }]); }}>{t('Add starter')}</button></div>
    {error && <p id={errorId} className="settings-field-error field-error" role="alert">{error}</p>}
    <details className="header-editor__json">
      <summary>{t('Edit as JSON')}</summary>
      {jsonEditor}
    </details>
  </div>;
}
