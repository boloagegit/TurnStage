import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import { Annotation, EditorState, RangeSetBuilder, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { createScanner, format, getLocation, parseTree, SyntaxKind } from 'jsonc-parser';
import type { ProfileSourceDiagnostic } from './profileSourceDiagnostics';

export interface CodeMirrorJsoncEditorHandle {
  focus(): void;
  jumpToOffset(offset: number): void;
  format(): void;
}

const externalUpdate = Annotation.define<boolean>();

const topLevel: Completion[] = [
  property('description', '"description": ""', 'Profile description'),
  property('environment', '"environment": ""', 'Environment ID'),
  property('controls', '"controls": []', 'Controls shown above the conversation'),
  property('opening', '"opening": {\n  "mode": "static",\n  "message": ""\n}', 'Opening message or request'),
  property('history', '"history": {\n  "localRuns": { "enabled": true, "maxRuns": 20 }\n}', 'Run retention'),
  property('errorPolicy', '"errorPolicy": {}', 'Failed-turn behavior'),
  property('metrics', '"metrics": { "enabled": ["ttft", "totalDuration"] }', 'Visible metrics'),
  property('tests', '"tests": { "scenarios": [] }', 'Automated and Red Team cases'),
  property('ui', '"ui": {}', 'Layout and response rendering'),
];

const pathCompletions: Record<string, Completion[]> = {
  'conversation.send': [
    property('timeoutMs', '"timeoutMs": 120000', 'Whole request timeout in milliseconds'),
    property('idleTimeoutMs', '"idleTimeoutMs": 30000', 'Maximum time without a stream event'),
    property('headers', '"headers": {\n  "Content-Type": "application/json"\n}', 'HTTP headers'),
    property('body', '"body": {}', 'Default request body'),
    property('variants', '"variants": []', 'Conditional request bodies and headers'),
  ],
  opening: [
    property('trigger', '"trigger": "sessionStart"', 'Run the opening behavior when the session starts'),
    property('fallbacks', '"fallbacks": []', 'Fallback opening messages'),
    property('failurePolicy', '"failurePolicy": { "allowRetry": true, "useFallbackOnNetworkError": false }', 'Opening failure behavior'),
  ],
  'conversation.stop': [
    property('onMissingContext', '"onMissingContext": "localAbortWithWarning"', 'Fallback when stop context is missing'),
    property('preservePartialContent', '"preservePartialContent": true', 'Keep partial assistant content'),
    property('appendSystemNotice', '"appendSystemNotice": true', 'Show a system notice after stopping'),
  ],
  'tests.visual': [
    property('maxDifferencePercent', '"maxDifferencePercent": 0.1', 'Maximum accepted visual difference'),
    property('channelTolerance', '"channelTolerance": 16', 'Ignored per-channel color difference'),
  ],
};

export const CodeMirrorJsoncEditor = forwardRef<CodeMirrorJsoncEditorHandle, {
  value: string;
  onChange(value: string): void;
  diagnostics: readonly ProfileSourceDiagnostic[];
  readOnly?: boolean;
  labels?: { sections: string; overview: string };
}>(({ value, onChange, diagnostics, readOnly = false, labels = { sections: 'Sections', overview: 'Top' } }, ref) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const outline = useMemo(() => topLevelSections(value), [value]);

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
          highlightActiveLine(), highlightSelectionMatches(), lintGutter(), tokenDecorations,
          EditorState.languageData.of(() => [{ commentTokens: { line: '//', block: { open: '/*', close: '*/' } }, closeBrackets: { brackets: ['(', '[', '{', "'", '"'] } }]),
          autocompletion({ override: [completeJsonc], activateOnTyping: true }),
          keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'JSONC', spellcheck: 'false' }),
          EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalUpdate))) onChangeRef.current(update.state.doc.toString());
          }),
          editorTheme,
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, diagnostics.map(toCodeMirrorDiagnostic)));
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    jumpToOffset: (offset) => {
      const editor = view.current;
      if (!editor) return;
      const anchor = Math.max(0, Math.min(editor.state.doc.length, offset));
      editor.dispatch({ selection: { anchor }, scrollIntoView: true });
      editor.focus();
    },
    format: () => {
      const editor = view.current;
      if (!editor || readOnly) return;
      const source = editor.state.doc.toString();
      const edits = format(source, undefined, { insertSpaces: true, tabSize: 2, eol: '\n' });
      if (!edits.length) return;
      const changes = edits.map((edit) => ({ from: edit.offset, to: edit.offset + edit.length, insert: edit.content }));
      editor.dispatch({ changes, userEvent: 'input.format' });
    },
  }), [readOnly]);

  return <div className="jsonc-editor-layout" data-source={value}>
    <nav className="jsonc-outline" aria-label={labels.sections}><span>{labels.sections}</span><button type="button" onClick={() => jump(view.current, 0)}>{labels.overview}</button>{outline.map((section) => <button type="button" key={`${section.name}-${section.offset}`} onClick={() => jump(view.current, section.offset)} title={section.name}><span>{section.name}</span><small>{section.line}</small></button>)}</nav>
    <label className="jsonc-outline-picker"><span className="visually-hidden">{labels.sections}</span><select defaultValue="0" onChange={(event) => jump(view.current, Number(event.target.value))}><option value="0">{labels.overview}</option>{outline.map((section) => <option key={`${section.name}-${section.offset}`} value={section.offset}>{section.name}</option>)}</select></label>
    <div className="jsonc-codemirror" ref={host} />
  </div>;
});
CodeMirrorJsoncEditor.displayName = 'CodeMirrorJsoncEditor';

function property(label: string, source: string, info: string): Completion {
  return {
    label,
    apply: (editor, _completion, from, to) => {
      const end = editor.state.sliceDoc(to, to + 1) === '"' ? to + 1 : to;
      editor.dispatch({ changes: { from, to: end, insert: source }, selection: { anchor: from + source.length }, userEvent: 'input.complete' });
    },
    type: 'property', detail: 'TurnStage', info,
  };
}

function completeJsonc(context: CompletionContext) {
  const source = context.state.doc.toString();
  const location = getLocation(source, context.pos);
  if (!location.isAtPropertyKey && !context.explicit) return null;
  const parentPath = location.path.slice(0, -1).filter((part): part is string | number => typeof part === 'string' || typeof part === 'number').join('.');
  const options = parentPath ? pathCompletions[parentPath] ?? [] : topLevel;
  if (!options.length) return null;
  const word = context.matchBefore(/"?[A-Za-z0-9_-]*/u);
  return { from: word?.from ?? context.pos, options, validFor: /^"?[A-Za-z0-9_-]*$/u };
}

function toCodeMirrorDiagnostic(issue: ProfileSourceDiagnostic): Diagnostic {
  return { from: issue.offset, to: issue.offset + Math.max(1, issue.length), severity: issue.severity, message: issue.message, source: issue.supportedHosts ? `TurnStage · ${issue.supportedHosts.join(', ')}` : 'TurnStage' };
}

function jump(editor: EditorView | null, offset: number): void {
  if (!editor) return;
  const anchor = Math.max(0, Math.min(editor.state.doc.length, offset));
  editor.dispatch({ selection: { anchor }, scrollIntoView: true });
  editor.focus();
}

function topLevelSections(source: string): Array<{ name: string; offset: number; line: number }> {
  const root = parseTree(source);
  if (!root || root.type !== 'object') return [];
  return (root.children ?? []).flatMap((property) => {
    const key = property.children?.[0];
    if (key?.type !== 'string' || typeof key.value !== 'string' || ['version', 'id', 'name', 'description', 'environment'].includes(key.value)) return [];
    return [{ name: key.value, offset: key.offset, line: source.slice(0, key.offset).split('\n').length }];
  });
}

const tokenDecorations = StateField.define<DecorationSet>({
  create: (state) => decorate(state.doc.toString()),
  update: (decorations, transaction) => transaction.docChanged ? decorate(transaction.newDoc.toString()) : decorations.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
});

function decorate(source: string): DecorationSet {
  const scanner = createScanner(source, false);
  const tokens: Array<{ from: number; to: number; kind: SyntaxKind }> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) tokens.push({ from: scanner.getTokenOffset(), to: scanner.getTokenOffset() + scanner.getTokenLength(), kind });
  const builder = new RangeSetBuilder<Decoration>();
  for (const [index, token] of tokens.entries()) {
    const className = tokenClass(token.kind, tokens.slice(index + 1).find((item) => item.kind !== SyntaxKind.Trivia && item.kind !== SyntaxKind.LineBreakTrivia)?.kind);
    if (className && token.to > token.from) builder.add(token.from, token.to, Decoration.mark({ class: className }));
  }
  return builder.finish();
}

function tokenClass(kind: SyntaxKind, next?: SyntaxKind): string | undefined {
  if (kind === SyntaxKind.StringLiteral) return next === SyntaxKind.ColonToken ? 'cm-jsonc-key' : 'cm-jsonc-string';
  if (kind === SyntaxKind.NumericLiteral) return 'cm-jsonc-number';
  if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) return 'cm-jsonc-comment';
  if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword || kind === SyntaxKind.NullKeyword) return 'cm-jsonc-keyword';
  if ([SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken, SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken, SyntaxKind.ColonToken, SyntaxKind.CommaToken].includes(kind)) return 'cm-jsonc-punctuation';
  return undefined;
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-textCodeBlock-background)', fontSize: 'var(--vscode-editor-font-size, 13px)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vscode-editor-font-family, monospace)', lineHeight: '1.55' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground))' },
  '.cm-line': { padding: '0 18px' },
  '.cm-gutters': { color: 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))', backgroundColor: 'var(--vscode-textCodeBlock-background)', border: '0' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-tooltip': { color: 'var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))', backgroundColor: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))', border: '1px solid var(--vscode-editorWidget-border)' },
  '.cm-panels': { color: 'var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))', backgroundColor: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))' },
});
