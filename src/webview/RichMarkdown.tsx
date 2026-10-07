import React, { memo, useId, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MAX_MARKDOWN_CHARS, MAX_MARKDOWN_LINES, SafeCodeBlock, sanitizeMarkdownHref, type SafeMarkdownProps } from './SafeMarkdown';
import { normalizeResponseClassStyles, normalizeResponseStyleRules, responseStyleRuleClassNames, scopedResponseStyleSheet, type ResponseClassStyles, type ResponseStyleRules } from '../shared/responseClassStyles';
import { useStableCallback } from './useStableCallback';
import './safeMarkdown.css';

interface RichMarkdownProps extends SafeMarkdownProps {
  markdown?: boolean;
  html?: boolean;
  classStyles?: ResponseClassStyles;
  styleRules?: ResponseStyleRules;
  /** The source is still growing; completed top-level blocks may be parsed independently. */
  streaming?: boolean;
}

/** Keep the source as one HTML fragment so Markdown syntax remains literal. */
function htmlOnly() {
  return (tree: { children: unknown[] }, file: { value: unknown }): void => {
    tree.children = [{ type: 'html', value: String(file.value) }];
  };
}

/** Static HTML only: never allow scripts, handlers, forms, embedded documents, CSS or SVG. */
const richSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((name) => !['input', 'picture', 'source', 'details', 'summary'].includes(name)),
  strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'form', 'object', 'embed', 'svg', 'math', 'template'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*']?.filter((name) => typeof name === 'string' && !['id', 'name', 'tabIndex', 'align', 'width', 'height'].includes(name)) ?? []), 'className'],
    a: allowResponseClassName(defaultSchema.attributes?.a),
    code: allowResponseClassName(defaultSchema.attributes?.code),
    h2: allowResponseClassName(defaultSchema.attributes?.h2),
    img: ['src', 'alt', 'title', 'width', 'height', 'className'],
    li: allowResponseClassName(defaultSchema.attributes?.li),
    ol: allowResponseClassName(defaultSchema.attributes?.ol),
    section: allowResponseClassName(defaultSchema.attributes?.section),
    ul: allowResponseClassName(defaultSchema.attributes?.ul),
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

function allowResponseClassName(attributes: readonly unknown[] | undefined): unknown[] {
  return [...(attributes ?? []).filter((entry) => entry !== 'className' && !(Array.isArray(entry) && entry[0] === 'className')), 'className'];
}

function safeImageSrc(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const transformed = defaultUrlTransform(value);
  if (!transformed || /^(?:data|javascript|vbscript|file|command):/iu.test(transformed)) return undefined;
  return /^(?:https?:\/\/|\/\/|\/|\.\.?\/)/iu.test(transformed) || !/^[a-z][a-z0-9+.-]*:/iu.test(transformed) ? transformed : undefined;
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const HTML_ONLY_REMARK_PLUGINS = [htmlOnly];
const RAW_HTML_REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, richSchema]] as NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;
// Without raw HTML in the source, rehype-raw only re-parses the tree; sanitizing still applies.
const SANITIZE_ONLY_REHYPE_PLUGINS = [[rehypeSanitize, richSchema]] as NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;
const NO_REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [];

interface MarkdownChunkProps {
  text: string;
  markdown: boolean;
  html: boolean;
  components: Components;
}

/** One independently parsed Markdown fragment. Memoized by source text. */
const MarkdownChunk = memo(function MarkdownChunk({ text, markdown, html, components }: MarkdownChunkProps): React.JSX.Element {
  const rehypePlugins = !html ? NO_REHYPE_PLUGINS : text.includes('<') ? RAW_HTML_REHYPE_PLUGINS : SANITIZE_ONLY_REHYPE_PLUGINS;
  return <ReactMarkdown remarkPlugins={markdown ? MARKDOWN_REMARK_PLUGINS : HTML_ONLY_REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components}>{text}</ReactMarkdown>;
});

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const CONTINUATION_PATTERN = /^(?:[ \t]|[*+-][ \t]|\d{1,9}[.)][ \t]|>|\|)/u;

/**
 * Splits a streaming Markdown source into top-level blocks separated by blank
 * lines so already completed blocks keep their parsed output while only the
 * growing tail is parsed again. Sources whose meaning can span blank lines
 * (raw HTML, link reference definitions, footnotes) stay as one fragment.
 * Completed responses are always parsed as a single document.
 */
export function splitStreamingMarkdown(text: string, html: boolean): string[] {
  if ((html && text.includes('<')) || text.includes('[^') || /^ {0,3}\[[^\]]+\]:/mu.test(text)) return [text];
  const lines = text.split('\n');
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: string | undefined;
  let previousBlank = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    }
    const blank = !fence && line.trim() === '';
    if (!fence && previousBlank && !blank && offset > start && !CONTINUATION_PATTERN.test(line)) {
      chunks.push(text.slice(start, offset));
      start = offset;
    }
    previousBlank = blank;
    offset += line.length + 1;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/**
 * Rich response renderer. Memoized and built from stable plugin/component
 * references so React keeps code blocks, links and images mounted across
 * unrelated parent renders. While `streaming`, completed blocks are parsed once.
 */
export const RichMarkdown = memo(function RichMarkdown({ text, className = '', onCopyCode, onOpenLink, copyLabel = 'Copy code', markdown = true, html = true, classStyles, styleRules, streaming = false }: RichMarkdownProps): React.JSX.Element {
  const bounded = useMemo(() => text.slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/gu, '\n').split('\n').slice(0, MAX_MARKDOWN_LINES).join('\n'), [text]);
  const safeClassStyles = useMemo(() => normalizeResponseClassStyles(classStyles), [classStyles]);
  const safeStyleRules = useMemo(() => normalizeResponseStyleRules(styleRules), [styleRules]);
  const allowedClasses = useMemo(() => new Set([...Object.keys(safeClassStyles), ...responseStyleRuleClassNames(safeStyleRules)]), [safeClassStyles, safeStyleRules]);
  const scope = `response-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const styleSheet = useMemo(() => scopedResponseStyleSheet(scope, safeStyleRules, safeClassStyles), [safeClassStyles, safeStyleRules, scope]);
  const styledComponents = useMemo(() => responseStyleComponents(allowedClasses), [allowedClasses]);
  const openLink = useStableCallback((href: string) => onOpenLink?.(href));
  const copyCode = useStableCallback((code: string, language?: string) => onCopyCode?.(code, language));
  const hasOpenLink = Boolean(onOpenLink);
  const hasCopyCode = Boolean(onCopyCode);
  const components = useMemo<Components>(() => ({
    ...styledComponents,
    a: ({ href, children, title, className: sourceClassName }) => {
      const safeHref = href ? sanitizeMarkdownHref(href) : undefined;
      const safeClassName = responseClassName(sourceClassName, allowedClasses);
      return safeHref ? <a className={['safe-markdown__link', safeClassName].filter(Boolean).join(' ')} href={safeHref} title={title} onClick={hasOpenLink ? (event) => { event.preventDefault(); openLink(safeHref); } : undefined}>{children}</a> : <span className={['safe-markdown__blocked-link', safeClassName].filter(Boolean).join(' ')}>{children}</span>;
    },
    img: ({ src, alt, title, width, height, className: sourceClassName }) => {
      const safeSrc = safeImageSrc(src);
      const safeClassName = responseClassName(sourceClassName, allowedClasses);
      return safeSrc ? <img className={safeClassName} src={safeSrc} alt={alt ?? ''} title={title} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span>{alt}</span>;
    },
    pre: ({ children, className: sourceClassName }) => {
      const child = React.Children.toArray(children).find(React.isValidElement);
      const value = child && React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) ? child.props : undefined;
      const code = typeof value?.children === 'string' ? value.children.replace(/\n$/u, '') : '';
      const language = /^language-([a-z0-9_+-]{1,32})$/iu.exec(value?.className ?? '')?.[1];
      const safeClassName = responseClassName(sourceClassName, allowedClasses);
      return <div className={safeClassName}><SafeCodeBlock code={code} language={language} onCopyCode={hasCopyCode ? copyCode : undefined} copyLabel={copyLabel} /></div>;
    },
    code: ({ className: sourceClassName, children }) => {
      const languageClass = /(?:^|\s)(language-[a-z0-9_+-]{1,32})(?:\s|$)/iu.exec(sourceClassName ?? '')?.[1];
      const safeClassName = responseClassName(sourceClassName, allowedClasses);
      return <code className={[languageClass, safeClassName].filter(Boolean).join(' ') || undefined}>{children}</code>;
    },
  }), [allowedClasses, copyCode, copyLabel, hasCopyCode, hasOpenLink, openLink, styledComponents]);
  const chunks = useMemo(() => streaming && markdown ? splitStreamingMarkdown(bounded, html) : [bounded], [bounded, html, markdown, streaming]);
  if (!markdown && !html) return <div className={['safe-markdown', 'safe-markdown--literal', className].filter(Boolean).join(' ')}>{bounded}</div>;
  return <div className={['safe-markdown', 'safe-markdown--rich', !markdown && 'safe-markdown--html-only', className].filter(Boolean).join(' ')} data-response-style-scope={scope}>
    {styleSheet && <style>{styleSheet}</style>}
    {chunks.map((chunk, index) => <MarkdownChunk key={index} text={chunk} markdown={markdown} html={html} components={components} />)}
  </div>;
});

function responseStyleComponents(allowedClasses: ReadonlySet<string>): Components {
  const entries = (richSchema.tagNames ?? []).filter((tag) => !['a', 'code', 'img', 'pre'].includes(tag)).map((tag) => {
    const component = (props: Record<string, unknown>): React.ReactNode => {
      const sourceClassName = responseClassName(typeof props.className === 'string' ? props.className : undefined, allowedClasses);
      const rest = { ...props };
      delete rest.node;
      delete rest.className;
      delete rest.style;
      return React.createElement(tag, { ...rest, className: sourceClassName } as React.HTMLAttributes<HTMLElement>);
    };
    return [tag, component] as const;
  });
  return Object.fromEntries(entries) as Components;
}

function responseClassName(className: string | undefined, allowedClasses: ReadonlySet<string>): string | undefined {
  const safe = className?.split(/\s+/u).filter((token) => allowedClasses.has(token));
  return safe?.length ? safe.join(' ') : undefined;
}
