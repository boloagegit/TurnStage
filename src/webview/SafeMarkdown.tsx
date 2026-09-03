import React, { useMemo, useState } from 'react';
import { IconButton } from './Icon';
import { JsonSyntax } from './JsonViewer';
import './safeMarkdown.css';

/**
 * The renderer intentionally supports a small, predictable Markdown subset.
 * It is used for model output, so parsing is done into React elements instead
 * of HTML strings. React then escapes all text and attribute values for us.
 */

export const MAX_MARKDOWN_CHARS = 200_000;
export const MAX_MARKDOWN_LINES = 5_000;
export const MAX_MARKDOWN_NESTING = 8;

const MAX_INLINE_NESTING = 8;
const MAX_LANGUAGE_LENGTH = 32;

export interface SafeMarkdownProps {
  text: string;
  className?: string;
  /**
   * Called after a code block is copied. When omitted, the renderer uses the
   * browser clipboard API when it is available.
   */
  onCopyCode?: (code: string, language?: string) => void | Promise<void>;
  /** Route links through the Extension Host instead of navigating the Webview. */
  onOpenLink?: (href: string) => void;
  copyLabel?: string;
}

export type SafeMarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'blockquote'; blocks: SafeMarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start?: number; items: string[] }
  | { type: 'code'; code: string; language?: string }
  | { type: 'thematicBreak' };

type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'emphasis'; children: InlineNode[] }
  | { type: 'link'; label: InlineNode[]; href?: string; title?: string };

interface Fence {
  character: '`' | '~';
  length: number;
  language?: string;
}

interface ListMarker {
  ordered: boolean;
  start?: number;
  indent: number;
  content: string;
}

/**
 * Parse the supported block subset. The returned tree contains only data and
 * can be inspected independently of React, which also makes it useful for
 * tests and alternate renderers.
 */
export function parseSafeMarkdown(source: string): SafeMarkdownBlock[] {
  const bounded = boundSource(source);
  const lines = bounded.split('\n');
  const blocks: SafeMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFenceStart(line);
    if (fence) {
      const result = readFence(lines, index, fence);
      blocks.push({ type: 'code', code: result.code, ...(fence.language ? { language: fence.language } : {}) });
      index = result.nextIndex;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, text: heading.text });
      index += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ type: 'thematicBreak' });
      index += 1;
      continue;
    }

    const listMarker = parseListMarker(line);
    if (listMarker) {
      const result = readList(lines, index, listMarker);
      blocks.push({
        type: 'list',
        ordered: listMarker.ordered,
        ...(listMarker.ordered && listMarker.start !== undefined ? { start: listMarker.start } : {}),
        items: result.items,
      });
      index = result.nextIndex;
      continue;
    }

    if (isBlockquoteLine(line)) {
      const result = readBlockquote(lines, index);
      const nestedSource = result.lines.join('\n');
      const nested = result.depth >= MAX_MARKDOWN_NESTING
        ? [{ type: 'paragraph' as const, text: nestedSource }]
        : parseSafeMarkdown(nestedSource);
      blocks.push({ type: 'blockquote', blocks: nested });
      index = result.nextIndex;
      continue;
    }

    const paragraph = readParagraph(lines, index);
    blocks.push({ type: 'paragraph', text: paragraph.text });
    index = paragraph.nextIndex;
  }

  return blocks;
}

/**
 * Return a link only when its scheme is safe for a webview. Invalid links are
 * represented by `undefined` and are rendered as their label text instead of
 * as a clickable element.
 */
export function sanitizeMarkdownHref(value: string): string | undefined {
  const href = value.trim();
  if (!href || hasUnsafeControlCharacter(href)) return undefined;

  // Hashes and relative paths are useful for local documentation. A leading
  // double slash is treated as an HTTPS URL by the browser and is safe here.
  if (href.startsWith('#') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.startsWith('?')) {
    return href;
  }
  if (/^\/\//u.test(href)) return `https:${href}`;

  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
  if (!scheme) return href;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? href : undefined;
}

/** Parse the supported inline subset into a safe, data-only tree. */
export function parseSafeMarkdownInline(source: string, depth = 0): InlineNode[] {
  if (!source) return [];
  if (depth > MAX_INLINE_NESTING) return [{ type: 'text', value: source }];

  const nodes: InlineNode[] = [];
  let textStart = 0;
  let index = 0;
  const flushText = (end: number): void => {
    if (end > textStart) nodes.push({ type: 'text', value: source.slice(textStart, end) });
  };
  const consume = (end: number, node: InlineNode): void => {
    flushText(index);
    nodes.push(node);
    index = end;
    textStart = end;
  };

  while (index < source.length) {
    const character = source[index];
    if (character === '\\' && index + 1 < source.length && isMarkdownPunctuation(source[index + 1] ?? '')) {
      flushText(index);
      nodes.push({ type: 'text', value: source[index + 1] ?? '' });
      index += 2;
      textStart = index;
      continue;
    }

    if (character === '`') {
      const runLength = delimiterRunLength(source, index, '`');
      const closing = findClosingDelimiter(source, index + runLength, '`', runLength);
      if (closing >= 0 && closing > index + runLength) {
        const value = source.slice(index + runLength, closing).replace(/\s+/gu, ' ').trim();
        consume(closing + runLength, { type: 'code', value });
        continue;
      }
    }

    const link = parseInlineLink(source, index, depth);
    if (link) {
      consume(link.end, { type: 'link', label: link.label, ...(link.href ? { href: link.href } : {}), ...(link.title ? { title: link.title } : {}) });
      continue;
    }

    const strong = parseDelimitedInline(source, index, '**', depth) ?? parseDelimitedInline(source, index, '__', depth);
    if (strong) {
      consume(strong.end, { type: 'strong', children: strong.children });
      continue;
    }

    const emphasis = parseDelimitedInline(source, index, '*', depth) ?? parseDelimitedInline(source, index, '_', depth);
    if (emphasis) {
      consume(emphasis.end, { type: 'emphasis', children: emphasis.children });
      continue;
    }

    index += 1;
  }

  flushText(source.length);
  return nodes;
}

/** Render a bounded Markdown subset without ever constructing HTML strings. */
export function SafeMarkdown({ text, className = '', onCopyCode, onOpenLink, copyLabel = 'Copy code' }: SafeMarkdownProps): React.JSX.Element {
  const blocks = useMemo(() => parseSafeMarkdown(text), [text]);
  const classes = ['safe-markdown', className].filter(Boolean).join(' ');
  return <div className={classes}>{blocks.map((block, index) => <SafeMarkdownBlockView key={`${block.type}-${index}`} block={block} onCopyCode={onCopyCode} onOpenLink={onOpenLink} copyLabel={copyLabel} />)}</div>;
}

function SafeMarkdownBlockView({ block, onCopyCode, onOpenLink, copyLabel }: { block: SafeMarkdownBlock; onCopyCode?: SafeMarkdownProps['onCopyCode']; onOpenLink?: SafeMarkdownProps['onOpenLink']; copyLabel: string }): React.JSX.Element {
  switch (block.type) {
    case 'heading': {
      const Heading = `h${block.level}` as keyof React.JSX.IntrinsicElements;
      return <Heading className="safe-markdown__heading">{renderInline(block.text, onOpenLink)}</Heading>;
    }
    case 'paragraph':
      return <p className="safe-markdown__paragraph">{renderInline(block.text, onOpenLink)}</p>;
    case 'blockquote':
      return <blockquote className="safe-markdown__blockquote">{block.blocks.map((nested, index) => <SafeMarkdownBlockView key={`${nested.type}-${index}`} block={nested} onCopyCode={onCopyCode} onOpenLink={onOpenLink} copyLabel={copyLabel} />)}</blockquote>;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      const listProps = block.ordered && block.start !== undefined ? { start: block.start } : {};
      return <List className="safe-markdown__list" {...listProps}>{block.items.map((item, index) => <li key={`${index}-${item.slice(0, 20)}`}>{renderInline(item, onOpenLink)}</li>)}</List>;
    }
    case 'code':
      return <SafeCodeBlock code={block.code} language={block.language} onCopyCode={onCopyCode} copyLabel={copyLabel} />;
    case 'thematicBreak':
      return <hr className="safe-markdown__rule" />;
  }
}

function SafeCodeBlock({ code, language, onCopyCode, copyLabel }: { code: string; language?: string; onCopyCode?: SafeMarkdownProps['onCopyCode']; copyLabel: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (): Promise<void> => {
    try {
      if (onCopyCode) {
        await onCopyCode(code, language);
      } else if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(code);
      } else {
        throw new Error('Clipboard unavailable');
      }
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  const languageClass = language ? ` language-${language}` : '';
  const jsonLanguage = language?.toLocaleLowerCase() === 'json' || language?.toLocaleLowerCase() === 'jsonc';
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Try again.' : copyLabel;
  return <div className="safe-markdown__code-block">
    <div className="safe-markdown__code-toolbar">
      {language && <span className="safe-markdown__language">{language}</span>}
      <IconButton icon={state === 'copied' ? 'check' : state === 'failed' ? 'warning' : 'copy'} label={label} type="button" onClick={() => { void copy(); }} />
    </div>
    <pre className={jsonLanguage ? 'json' : undefined}><code className={languageClass.trim() || undefined}>{jsonLanguage ? <JsonSyntax text={code} /> : code}</code></pre>
    <span className={state === 'failed' ? 'safe-markdown__copy-feedback' : 'safe-markdown__copy-status'} role="status" aria-live="polite" aria-atomic="true">{state === 'idle' ? '' : label}</span>
  </div>;
}

function renderInline(source: string, onOpenLink?: SafeMarkdownProps['onOpenLink']): React.ReactNode {
  return parseSafeMarkdownInline(source).map((node, index) => renderInlineNode(node, `${index}`, onOpenLink));
}

function renderInlineNode(node: InlineNode, key: string, onOpenLink?: SafeMarkdownProps['onOpenLink']): React.JSX.Element | string {
  switch (node.type) {
    case 'text':
      return <React.Fragment key={key}>{node.value}</React.Fragment>;
    case 'code':
      return <code key={key} className="safe-markdown__inline-code">{node.value}</code>;
    case 'strong':
      return <strong key={key}>{node.children.map((child, index) => renderInlineNode(child, `${key}-strong-${index}`, onOpenLink))}</strong>;
    case 'emphasis':
      return <em key={key}>{node.children.map((child, index) => renderInlineNode(child, `${key}-em-${index}`, onOpenLink))}</em>;
    case 'link':
      return node.href
        ? <a key={key} className="safe-markdown__link" href={node.href} title={node.title} onClick={onOpenLink ? (event) => { event.preventDefault(); onOpenLink(node.href!); } : undefined}>{node.label.map((child, index) => renderInlineNode(child, `${key}-link-${index}`, onOpenLink))}</a>
        : <span key={key} className="safe-markdown__blocked-link">{node.label.map((child, index) => renderInlineNode(child, `${key}-blocked-${index}`, onOpenLink))}</span>;
  }
}

function boundSource(source: string): string {
  if (source.length <= MAX_MARKDOWN_CHARS) {
    const lines = source.replace(/\r\n?/gu, '\n').split('\n');
    return lines.length <= MAX_MARKDOWN_LINES ? lines.join('\n') : lines.slice(0, MAX_MARKDOWN_LINES).join('\n');
  }
  return source.slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/gu, '\n').split('\n').slice(0, MAX_MARKDOWN_LINES).join('\n');
}

function parseFenceStart(line: string): Fence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^`~\r\n]*)?$/u);
  if (!match) return undefined;
  const marker = match[1] ?? '';
  const language = normalizeLanguage(match[2]);
  return { character: marker[0] === '~' ? '~' : '`', length: marker.length, ...(language ? { language } : {}) };
}

function readFence(lines: string[], startIndex: number, fence: Fence): { code: string; nextIndex: number } {
  const code: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const closing = new RegExp(`^ {0,3}${escapeRegExp(fence.character)}{${fence.length},}[ \\t]*$`, 'u').test(line);
    if (closing) return { code: code.join('\n'), nextIndex: index + 1 };
    code.push(line);
    index += 1;
  }
  return { code: code.join('\n'), nextIndex: index };
}

function parseHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | undefined {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u);
  if (!match) return undefined;
  const level = Math.min(6, match[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
  return { level, text: (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim() };
}

function parseListMarker(line: string): ListMarker | undefined {
  const match = line.match(/^( *)(?:(\d{1,9})[.)]|([-+*]))[ \t]+(.*)$/u);
  if (!match) return undefined;
  const ordered = Boolean(match[2]);
  const start = ordered ? Number(match[2]) : undefined;
  return { ordered, ...(start !== undefined && Number.isSafeInteger(start) ? { start } : {}), indent: match[1]?.length ?? 0, content: match[4] ?? '' };
}

function readList(lines: string[], startIndex: number, first: ListMarker): { items: string[]; nextIndex: number } {
  const items = [first.content];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const marker = parseListMarker(line);
    if (marker && marker.ordered === first.ordered && marker.indent === first.indent) {
      items.push(marker.content);
      index += 1;
      continue;
    }
    if (line.trim() && leadingSpaces(line) > first.indent) {
      const previous = items.length - 1;
      if (previous >= 0) items[previous] = `${items[previous]}\n${line.trim()}`;
      index += 1;
      continue;
    }
    break;
  }
  return { items, nextIndex: index };
}

function readBlockquote(lines: string[], startIndex: number): { lines: string[]; nextIndex: number; depth: number } {
  const result: string[] = [];
  let index = startIndex;
  let depth = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const match = line.match(/^(?: {0,3}>[ \t]?)+/u);
    if (!match) {
      if (line.trim() === '') {
        result.push('');
        index += 1;
        continue;
      }
      break;
    }
    const prefix = match[0];
    depth = Math.max(depth, (prefix.match(/>/gu) ?? []).length);
    result.push(line.slice(prefix.length));
    index += 1;
  }
  while (result.at(-1) === '') result.pop();
  return { lines: result, nextIndex: index, depth };
}

function readParagraph(lines: string[], startIndex: number): { text: string; nextIndex: number } {
  const paragraph: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim() || (index > startIndex && isBlockStart(line))) break;
    paragraph.push(line);
    index += 1;
  }
  return { text: paragraph.join('\n'), nextIndex: index };
}

function isBlockStart(line: string): boolean {
  return Boolean(parseFenceStart(line) || parseHeading(line) || parseListMarker(line) || isBlockquoteLine(line) || isThematicBreak(line));
}

function isBlockquoteLine(line: string): boolean { return /^ {0,3}>/u.test(line); }

function isThematicBreak(line: string): boolean { return /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/u.test(line); }

function leadingSpaces(value: string): number { return value.match(/^ */u)?.[0].length ?? 0; }

function normalizeLanguage(value: string | undefined): string | undefined {
  const language = value?.trim().split(/[ \t]/u)[0]?.slice(0, MAX_LANGUAGE_LENGTH).toLowerCase();
  return language && /^[a-z0-9_+-]+$/u.test(language) ? language : undefined;
}

function parseInlineLink(source: string, start: number, depth: number): { end: number; label: InlineNode[]; href?: string; title?: string } | undefined {
  if (source[start] !== '[') return undefined;
  const closeLabel = findClosingBracket(source, start + 1);
  if (closeLabel < 0 || source[closeLabel + 1] !== '(') return undefined;
  const closeDestination = findLinkClose(source, closeLabel + 2);
  if (closeDestination < 0) return undefined;
  const destination = source.slice(closeLabel + 2, closeDestination).trim();
  const parsed = parseLinkDestination(destination);
  const href = sanitizeMarkdownHref(parsed.href);
  return { end: closeDestination + 1, label: parseSafeMarkdownInline(source.slice(start + 1, closeLabel), depth + 1), ...(href ? { href } : {}), ...(parsed.title ? { title: parsed.title } : {}) };
}

function parseLinkDestination(value: string): { href: string; title?: string } {
  if (!value) return { href: '' };
  const titleMatch = value.match(/^(.*?)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))$/u);
  if (!titleMatch) return { href: value };
  return { href: titleMatch[1]?.trim() ?? '', title: titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] };
}

function parseDelimitedInline(source: string, start: number, delimiter: string, depth: number): { end: number; children: InlineNode[] } | undefined {
  if (!source.startsWith(delimiter, start)) return undefined;
  const closing = findClosingDelimiter(source, start + delimiter.length, delimiter[0] as '*' | '_', delimiter.length);
  if (closing < 0 || closing === start + delimiter.length) return undefined;
  return { end: closing + delimiter.length, children: parseSafeMarkdownInline(source.slice(start + delimiter.length, closing), depth + 1) };
}

function findClosingBracket(source: string, start: number): number {
  let nesting = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') nesting += 1;
    if (character === ']' && nesting-- === 0) return index;
  }
  return -1;
}

function findLinkClose(source: string, start: number): number {
  let nesting = 0;
  let quote: '"' | "'" | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') nesting += 1;
    if (character === ')' && nesting-- === 0) return index;
  }
  return -1;
}

function findClosingDelimiter(source: string, start: number, character: '*' | '_' | '`', length: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source.startsWith(character.repeat(length), index)) return index;
  }
  return -1;
}

function delimiterRunLength(source: string, start: number, character: '`' | '*' | '_'): number {
  let length = 0;
  while (source[start + length] === character) length += 1;
  return length;
}

function isMarkdownPunctuation(value: string): boolean { return /[\\`*_[\]{}()#+.!<>\-|]/u.test(value); }

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
