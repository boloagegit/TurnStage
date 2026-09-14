import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MAX_MARKDOWN_CHARS, MAX_MARKDOWN_LINES, SafeCodeBlock, sanitizeMarkdownHref, type SafeMarkdownProps } from './SafeMarkdown';
import './safeMarkdown.css';

interface RichMarkdownProps extends SafeMarkdownProps {
  markdown?: boolean;
  html?: boolean;
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
    '*': defaultSchema.attributes?.['*']?.filter((name) => typeof name === 'string' && !['id', 'name', 'tabIndex', 'align', 'width', 'height'].includes(name)),
    img: ['src', 'alt', 'title', 'width', 'height'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

function safeImageSrc(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const transformed = defaultUrlTransform(value);
  if (!transformed || /^(?:data|javascript|vbscript|file|command):/iu.test(transformed)) return undefined;
  return /^(?:https?:\/\/|\/\/|\/|\.\.?\/)/iu.test(transformed) || !/^[a-z][a-z0-9+.-]*:/iu.test(transformed) ? transformed : undefined;
}

export function RichMarkdown({ text, className = '', onCopyCode, onOpenLink, copyLabel = 'Copy code', markdown = true, html = true }: RichMarkdownProps): React.JSX.Element {
  const bounded = text.slice(0, MAX_MARKDOWN_CHARS).replace(/\r\n?/gu, '\n').split('\n').slice(0, MAX_MARKDOWN_LINES).join('\n');
  if (!markdown && !html) return <div className={['safe-markdown', 'safe-markdown--literal', className].filter(Boolean).join(' ')}>{bounded}</div>;
  return <div className={['safe-markdown', 'safe-markdown--rich', !markdown && 'safe-markdown--html-only', className].filter(Boolean).join(' ')}>
    <ReactMarkdown remarkPlugins={markdown ? [remarkGfm, remarkBreaks] : [htmlOnly]} rehypePlugins={html ? [rehypeRaw, [rehypeSanitize, richSchema]] : []} components={{
      a: ({ href, children, title }) => {
        const safeHref = href ? sanitizeMarkdownHref(href) : undefined;
        return safeHref ? <a className="safe-markdown__link" href={safeHref} title={title} onClick={onOpenLink ? (event) => { event.preventDefault(); onOpenLink(safeHref); } : undefined}>{children}</a> : <span className="safe-markdown__blocked-link">{children}</span>;
      },
      img: ({ src, alt, title, width, height }) => {
        const safeSrc = safeImageSrc(src);
        return safeSrc ? <img src={safeSrc} alt={alt ?? ''} title={title} width={width} height={height} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span>{alt}</span>;
      },
      pre: ({ children }) => {
        const child = React.Children.toArray(children).find(React.isValidElement);
        const value = child && React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) ? child.props : undefined;
        const code = typeof value?.children === 'string' ? value.children.replace(/\n$/u, '') : '';
        const language = /^language-([a-z0-9_+-]{1,32})$/iu.exec(value?.className ?? '')?.[1];
        return <SafeCodeBlock code={code} language={language} onCopyCode={onCopyCode} copyLabel={copyLabel} />;
      },
    }}>{bounded}</ReactMarkdown>
  </div>;
}
