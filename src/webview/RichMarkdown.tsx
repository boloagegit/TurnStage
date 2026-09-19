import React, { useId, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MAX_MARKDOWN_CHARS, MAX_MARKDOWN_LINES, SafeCodeBlock, sanitizeMarkdownHref, type SafeMarkdownProps } from './SafeMarkdown';
import { normalizeResponseClassStyles, normalizeResponseStyleRules, responseStyleRuleClassNames, scopedResponseStyleSheet, type ResponseClassStyles, type ResponseStyleRules } from '../shared/responseClassStyles';
import './safeMarkdown.css';

interface RichMarkdownProps extends SafeMarkdownProps {
  markdown?: boolean;
  html?: boolean;
  classStyles?: ResponseClassStyles;
  styleRules?: ResponseStyleRules;
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

export function RichMarkdown({ text, className = '', onCopyCode, onOpenLink, copyLabel = 'Copy code', markdown = true, html = true, classStyles, styleRules }: RichMarkdownProps): React.JSX.Element {
  const bounded = text.slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/gu, '\n').split('\n').slice(0, MAX_MARKDOWN_LINES).join('\n');
  const safeClassStyles = useMemo(() => normalizeResponseClassStyles(classStyles), [classStyles]);
  const safeStyleRules = useMemo(() => normalizeResponseStyleRules(styleRules), [styleRules]);
  const allowedClasses = useMemo(() => new Set([...Object.keys(safeClassStyles), ...responseStyleRuleClassNames(safeStyleRules)]), [safeClassStyles, safeStyleRules]);
  const scope = `response-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const styleSheet = useMemo(() => scopedResponseStyleSheet(scope, safeStyleRules, safeClassStyles), [safeClassStyles, safeStyleRules, scope]);
  const styledComponents = useMemo(() => responseStyleComponents(allowedClasses), [allowedClasses]);
  if (!markdown && !html) return <div className={['safe-markdown', 'safe-markdown--literal', className].filter(Boolean).join(' ')}>{bounded}</div>;
  return <div className={['safe-markdown', 'safe-markdown--rich', !markdown && 'safe-markdown--html-only', className].filter(Boolean).join(' ')} data-response-style-scope={scope}>
    {styleSheet && <style>{styleSheet}</style>}
    <ReactMarkdown remarkPlugins={markdown ? [remarkGfm, remarkBreaks] : [htmlOnly]} rehypePlugins={html ? [rehypeRaw, [rehypeSanitize, richSchema]] : []} components={{
      ...styledComponents,
      a: ({ href, children, title, className: sourceClassName }) => {
        const safeHref = href ? sanitizeMarkdownHref(href) : undefined;
        const safeClassName = responseClassName(sourceClassName, allowedClasses);
        return safeHref ? <a className={['safe-markdown__link', safeClassName].filter(Boolean).join(' ')} href={safeHref} title={title} onClick={onOpenLink ? (event) => { event.preventDefault(); onOpenLink(safeHref); } : undefined}>{children}</a> : <span className={['safe-markdown__blocked-link', safeClassName].filter(Boolean).join(' ')}>{children}</span>;
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
        return <div className={safeClassName}><SafeCodeBlock code={code} language={language} onCopyCode={onCopyCode} copyLabel={copyLabel} /></div>;
      },
      code: ({ className: sourceClassName, children }) => {
        const languageClass = /(?:^|\s)(language-[a-z0-9_+-]{1,32})(?:\s|$)/iu.exec(sourceClassName ?? '')?.[1];
        const safeClassName = responseClassName(sourceClassName, allowedClasses);
        return <code className={[languageClass, safeClassName].filter(Boolean).join(' ') || undefined}>{children}</code>;
      },
    }}>{bounded}</ReactMarkdown>
  </div>;
}

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
