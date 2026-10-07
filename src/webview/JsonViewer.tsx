import React, { memo, useDeferredValue, useMemo, useState } from 'react';
import { ClipboardButton } from './ClipboardButton';
import { formatNumber, t } from './i18n';

type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';
interface JsonToken { start: number; text: string; kind?: JsonTokenKind }

/** Above this size the payload is shown as plain text: per-token spans would cost more than they help. */
export const MAX_HIGHLIGHTED_JSON_CHARS = 256 * 1024;

export const JsonViewer = memo(function JsonViewer({ value, className = '', copyLabel }: { value: unknown; className?: string; copyLabel?: string }): React.JSX.Element {
  const text = useMemo(() => safeJson(value), [value]);
  const [query, setQuery] = useState('');
  // Typing stays responsive while large payloads are searched and re-highlighted.
  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(() => countTextMatches(text, deferredQuery), [deferredQuery, text]);
  return <div className={`json-view ${className}`.trim()}>
    <div className="json-toolbar">
      <label><span className="sr-only">{t('Search JSON')}</span><input type="search" value={query} placeholder={t('Search JSON')} aria-label={t('Search JSON')} onChange={(event) => setQuery(event.target.value)} /></label>
      <span role="status" aria-live="polite">{deferredQuery ? matches ? t('{count} matches', { count: formatNumber(matches) }) : t('No matches') : t('JSON data')}</span>
    </div>
    <pre className="json"><code><JsonSyntax text={text} query={deferredQuery} /></code><ClipboardButton text={text} label={copyLabel ?? t('Copy JSON')} /></pre>
  </div>;
});

export const JsonSyntax = memo(function JsonSyntax({ value, text, query = '' }: { value?: unknown; text?: string; query?: string }): React.JSX.Element {
  const source = useMemo(() => text ?? (value === undefined ? '' : safeJson(value)), [text, value]);
  const tokens = useMemo(() => source.length > MAX_HIGHLIGHTED_JSON_CHARS ? [{ start: 0, text: source }] : tokenizeJson(source), [source]);
  const nodes = useMemo(() => tokens.map((token, index) => <span className={token.kind ? `json-token json-token--${token.kind}` : undefined} key={`${token.start}-${index}`}>{highlightText(token.text, query, token.start)}</span>), [query, tokens]);
  return <>{nodes}</>;
});

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
  // Sticky lookahead for "is this string an object key?" without copying the remaining text.
  const keySuffix = /\s*:/uy;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) tokens.push({ start: cursor, text: text.slice(cursor, start) });
    const token = match[0];
    let kind: JsonTokenKind;
    if (token.startsWith('"')) { keySuffix.lastIndex = start + token.length; kind = keySuffix.test(text) ? 'key' : 'string'; }
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
