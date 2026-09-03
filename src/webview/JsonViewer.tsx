import React, { useMemo, useState } from 'react';
import { ClipboardButton } from './ClipboardButton';
import { formatNumber, t } from './i18n';

type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';
interface JsonToken { start: number; text: string; kind?: JsonTokenKind }

export function JsonViewer({ value, className = '', copyLabel }: { value: unknown; className?: string; copyLabel?: string }): React.JSX.Element {
  const text = safeJson(value);
  const [query, setQuery] = useState('');
  const matches = useMemo(() => countTextMatches(text, query), [query, text]);
  return <div className={`json-view ${className}`.trim()}>
    <div className="json-toolbar">
      <label><span className="sr-only">{t('Search JSON')}</span><input type="search" value={query} placeholder={t('Search JSON')} aria-label={t('Search JSON')} onChange={(event) => setQuery(event.target.value)} /></label>
      <span role="status" aria-live="polite">{query ? matches ? t('{count} matches', { count: formatNumber(matches) }) : t('No matches') : t('JSON data')}</span>
    </div>
    <pre className="json"><code><JsonSyntax text={text} query={query} /></code><ClipboardButton text={text} label={copyLabel ?? t('Copy JSON')} /></pre>
  </div>;
}

export function JsonSyntax({ value, text = value === undefined ? undefined : safeJson(value), query = '' }: { value?: unknown; text?: string; query?: string }): React.JSX.Element {
  const source = text ?? '';
  const tokens = useMemo(() => tokenizeJson(source), [source]);
  return <>{tokens.map((token, index) => <span className={token.kind ? `json-token json-token--${token.kind}` : undefined} key={`${token.start}-${index}`}>{highlightText(token.text, query, token.start)}</span>)}</>;
}

export function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? '' : result;
  } catch {
    return t('Unable to display this value.');
  }
}

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) tokens.push({ start: cursor, text: text.slice(cursor, start) });
    const token = match[0];
    let kind: JsonTokenKind;
    if (token.startsWith('"')) kind = /^\s*:/u.test(text.slice(start + token.length)) ? 'key' : 'string';
    else if (/^-?\d/u.test(token)) kind = 'number';
    else if (token === 'true' || token === 'false') kind = 'boolean';
    else if (token === 'null') kind = 'null';
    else kind = 'punctuation';
    tokens.push({ start, text: token, kind });
    cursor = start + token.length;
  }
  if (cursor < text.length) tokens.push({ start: cursor, text: text.slice(cursor) });
  return tokens;
}

function highlightText(text: string, query: string, offset: number): React.ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return text;
  const lower = text.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let match = lower.indexOf(needle); match >= 0; match = lower.indexOf(needle, cursor)) {
    if (match > cursor) parts.push(text.slice(cursor, match));
    parts.push(<mark key={`${offset + match}-${parts.length}`}>{text.slice(match, match + needle.length)}</mark>);
    cursor = match + needle.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function countTextMatches(text: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const lower = text.toLocaleLowerCase();
  let count = 0;
  for (let cursor = lower.indexOf(needle); cursor >= 0; cursor = lower.indexOf(needle, cursor + needle.length)) count += 1;
  return count;
}
