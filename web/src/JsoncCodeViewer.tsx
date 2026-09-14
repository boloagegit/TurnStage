import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createScanner, parseTree, SyntaxKind } from 'jsonc-parser';

type Segment = { text: string; kind: 'plain' | 'key' | 'string' | 'number' | 'comment' | 'keyword' | 'punctuation' };
type Section = { name: string; line: number };

function tokenize(raw: string): Segment[][] {
  const scanner = createScanner(raw, false);
  const tokens: Array<{ offset: number; length: number; kind: SyntaxKind }> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    tokens.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), kind });
  }
  const lines: Segment[][] = [[]];
  const append = (text: string, kind: Segment['kind']) => {
    for (const [index, piece] of text.split('\n').entries()) {
      if (index > 0) lines.push([]);
      if (piece) lines[lines.length - 1]!.push({ text: piece, kind });
    }
  };
  let cursor = 0;
  tokens.forEach((token, index) => {
    if (token.offset > cursor) append(raw.slice(cursor, token.offset), 'plain');
    const next = tokens.slice(index + 1).find((item) => item.kind !== SyntaxKind.Trivia && item.kind !== SyntaxKind.LineBreakTrivia);
    let kind: Segment['kind'] = 'plain';
    if (token.kind === SyntaxKind.StringLiteral) kind = next?.kind === SyntaxKind.ColonToken ? 'key' : 'string';
    else if (token.kind === SyntaxKind.NumericLiteral) kind = 'number';
    else if (token.kind === SyntaxKind.LineCommentTrivia || token.kind === SyntaxKind.BlockCommentTrivia) kind = 'comment';
    else if (token.kind === SyntaxKind.TrueKeyword || token.kind === SyntaxKind.FalseKeyword || token.kind === SyntaxKind.NullKeyword) kind = 'keyword';
    else if ([SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken, SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken, SyntaxKind.ColonToken, SyntaxKind.CommaToken].includes(token.kind)) kind = 'punctuation';
    append(raw.slice(token.offset, token.offset + token.length), kind);
    cursor = token.offset + token.length;
  });
  if (cursor < raw.length) append(raw.slice(cursor), 'plain');
  return lines;
}

function sections(raw: string): Section[] {
  const root = parseTree(raw);
  if (!root || root.type !== 'object') return [];
  const lineStarts = [0];
  for (let index = 0; index < raw.length; index++) if (raw[index] === '\n') lineStarts.push(index + 1);
  return (root.children ?? []).flatMap((property) => {
    const key = property.children?.[0];
    if (key?.type !== 'string' || typeof key.value !== 'string') return [];
    if (['version', 'id', 'name', 'description', 'environment'].includes(key.value)) return [];
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= key.offset) low = middle; else high = middle; }
    return [{ name: key.value, line: low + 1 }];
  });
}

function highlight(segments: Segment[], query: string): React.ReactNode {
  if (!query) return segments.map((segment, index) => <span key={index} className={`jsonc-${segment.kind}`}>{segment.text}</span>);
  const needle = query.toLocaleLowerCase();
  return segments.flatMap((segment, index) => {
    const pieces: React.ReactNode[] = [];
    let start = 0;
    const lower = segment.text.toLocaleLowerCase();
    for (let found = lower.indexOf(needle); found >= 0; found = lower.indexOf(needle, start)) {
      if (found > start) pieces.push(<span key={`${index}-${start}`} className={`jsonc-${segment.kind}`}>{segment.text.slice(start, found)}</span>);
      pieces.push(<mark key={`${index}-${found}`}>{segment.text.slice(found, found + query.length)}</mark>);
      start = found + query.length;
    }
    if (start < segment.text.length) pieces.push(<span key={`${index}-${start}`} className={`jsonc-${segment.kind}`}>{segment.text.slice(start)}</span>);
    return pieces;
  });
}

export function JsoncCodeViewer({ raw, labels }: { raw: string; labels: { search: string; previous: string; next: string; noMatches: string; matchCount: string; wrap: string; sections: string; overview: string; lines: string } }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [wrap, setWrap] = useState(true);
  const codeRef = useRef<HTMLDivElement>(null);
  const renderedLines = useMemo(() => tokenize(raw), [raw]);
  const outline = useMemo(() => sections(raw), [raw]);
  const matches = useMemo(() => {
    if (!query) return [];
    const needle = query.toLocaleLowerCase();
    return raw.split('\n').flatMap((line, index) => {
      const found: number[] = [];
      const lower = line.toLocaleLowerCase();
      for (let position = lower.indexOf(needle); position >= 0; position = lower.indexOf(needle, position + needle.length)) found.push(index + 1);
      return found;
    });
  }, [raw, query]);
  useEffect(() => {
    if (query && matches.length) codeRef.current?.querySelector<HTMLElement>(`[data-line="${matches[0]}"]`)?.scrollIntoView?.({ block: 'start', inline: 'nearest' });
  }, [matches, query]);
  const jumpToLine = (line: number) => codeRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)?.scrollIntoView?.({ block: 'start', inline: 'nearest' });
  const moveMatch = (step: number) => {
    if (!matches.length) return;
    const next = (matchIndex + step + matches.length) % matches.length;
    setMatchIndex(next);
    jumpToLine(matches[next]!);
  };
  const selectSection = (line: number) => jumpToLine(line);
  return <div className="jsonc-reader">
    <div className="jsonc-reader-controls">
      <label className="jsonc-search"><span className="visually-hidden">{labels.search}</span><input type="search" value={query} placeholder={labels.search} onChange={(event) => { setQuery(event.target.value); setMatchIndex(0); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} /></label>
      <span className="jsonc-match-count" role="status">{query ? matches.length ? labels.matchCount.replace('{current}', String(matchIndex + 1)).replace('{total}', String(matches.length)) : labels.noMatches : labels.lines.replace('{count}', String(renderedLines.length))}</span>
      <button type="button" className="jsonc-nav-button" disabled={!matches.length} aria-label={labels.previous} title={labels.previous} onClick={() => moveMatch(-1)}>↑</button>
      <button type="button" className="jsonc-nav-button" disabled={!matches.length} aria-label={labels.next} title={labels.next} onClick={() => moveMatch(1)}>↓</button>
      <label className="jsonc-wrap"><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />{labels.wrap}</label>
    </div>
    <div className="jsonc-reader-body">
      <nav className="jsonc-outline" aria-label={labels.sections}><span>{labels.sections}</span><button type="button" onClick={() => selectSection(1)}>{labels.overview}</button>{outline.map((section) => <button type="button" key={`${section.name}-${section.line}`} onClick={() => selectSection(section.line)} title={section.name}><span>{section.name}</span><small>{section.line}</small></button>)}</nav>
      <label className="jsonc-outline-picker"><span className="visually-hidden">{labels.sections}</span><select defaultValue="1" onChange={(event) => selectSection(Number(event.target.value))}><option value="1">{labels.overview}</option>{outline.map((section) => <option key={`${section.name}-${section.line}`} value={section.line}>{section.name}</option>)}</select></label>
      <div ref={codeRef} className={`jsonc-code-scroll${wrap ? ' is-wrapped' : ''}`} tabIndex={0} aria-label="JSONC">
        <div className="jsonc-lines" role="presentation">{renderedLines.map((segments, index) => <div className={`jsonc-line${matches[matchIndex] === index + 1 ? ' is-current-match' : ''}`} data-line={index + 1} key={index}><span className="jsonc-line-number" aria-hidden="true">{index + 1}</span><code>{highlight(segments, query)}</code></div>)}</div>
      </div>
    </div>
  </div>;
}
