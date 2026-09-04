import React, { useEffect, useId, useState } from 'react';
import type { MappingTestInput, MappingTestResult, WebviewPayload } from '../shared/protocol';
import { responseActionIcons, type MappingRule, type MessageTagRule, type OpeningResponseBlockDefinition, type OpeningResponseBlockKind, type OpeningResponseFieldDefinition, type RawStreamEvent, type RequestVariant, type TurnStageProfile } from '../shared/types';
import { formatNumber, localizeHumanized, t } from './i18n';
import { IconButton, ProductIcon } from './Icon';
import { ClipboardButton } from './ClipboardButton';
import { JsonSyntax } from './JsonViewer';
import { DEFAULT_MESSAGE_ACTIONS, resolveMessageActionVisibility, resolveStreaming, type MessageActionId } from './uiConfig';

type Post = (message: WebviewPayload) => void;

const methods = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] as const;
const operators = ['equals', 'notEquals', 'exists', 'notExists', 'oneOf', 'contains', 'startsWith', 'endsWith', 'regex'] as const;
const componentNames = ['opening', 'starters', 'progress', 'toolCalls', 'citations', 'followups', 'responseActions', 'forms', 'diagnostics', 'metrics', 'usage'] as const;
const messageActionOptions: Array<{ id: MessageActionId; label: string }> = [
  { id: 'message.copy', label: 'Copy' },
  { id: 'message.retry', label: 'Retry' },
  { id: 'message.editAndResend', label: 'Edit & resend' },
  { id: 'message.inspectRaw', label: 'Inspect message' },
];
const sampleProtocols = ['sse', 'ndjson', 'json', 'text-stream'] as const;

type VariantKey = 'first-turn' | 'continuation' | 'other';

/**
 * The Flow tab intentionally edits the profile through small JSONC patches. It
 * keeps the text document authoritative while making the most important
 * runtime branches visible to a person debugging a backend.
 */
export function FlowEditor({ profile, post }: { profile: TurnStageProfile; post: Post }): React.JSX.Element {
  const openingMode = profile.opening?.mode ?? 'disabled';
  const variants = profile.conversation.send.variants ?? [];
  const stop = profile.conversation.stop;
  const stopRequest = stop?.request;
  const localRuns = profile.history?.localRuns;
  const errorPolicy = profile.errorPolicy;

  const patch = (path: Array<string | number>, value: unknown) => post({ type: 'profile.patch', path, value });
  const updateVariants = (next: RequestVariant[]) => patch(['conversation', 'send', 'variants'], next);
  const addVariant = (kind: VariantKey) => {
    const base = kind === 'continuation' ? 'continuation' : kind === 'first-turn' ? 'first-turn' : 'variant';
    const id = uniqueId(variants.map((variant) => variant.id), base);
    const next: RequestVariant = {
      id,
      when: kind === 'continuation'
        ? { path: 'conversation.id', operator: 'exists' }
        : kind === 'first-turn'
          ? { path: 'conversation.id', operator: 'notExists' }
          : undefined,
      body: { message: { $value: 'input.text' } }
    };
    updateVariants([...variants, next]);
  };
  const removeVariant = (index: number) => updateVariants(variants.filter((_, itemIndex) => itemIndex !== index));

  return <div className="content-page config-page">
    <header className="page-heading"><div><h2>{t('Conversation flow')}</h2><p>{t('Configure opening, request variants, stop behavior, recovery, and local run retention.')}</p></div><button onClick={() => post({ type: 'profile.validate' })}>{t('Validate profile')}</button></header>

    <section className="config-section" aria-labelledby="opening-heading">
      <div className="section-heading"><div><h3 id="opening-heading">{t('Opening')}</h3><p>{t('Static content never makes a network request. Request mode starts once when the Profile opens, then requires an explicit retry after a failure.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('Opening mode')} hint={t('The same mode is used when New Conversation resets the session.')}>
          <select aria-label={t('Opening mode')} value={openingMode} onChange={(event) => patch(['opening', 'mode'], event.target.value)}>
            <option value="static">{t('Static message')}</option><option value="request">{t('Opening request')}</option><option value="disabled">{t('Disabled')}</option>
          </select>
        </Field>
        <Field label={t('Opening message')} hint={t(openingMode === 'static' ? 'Shown before the first turn.' : 'Used by static opening and configured fallbacks.')} wide>
          <PatchText aria-label={t('Opening message')} value={profile.opening?.message ?? ''} multiline rows={3} disabled={openingMode !== 'static'} onCommit={(value) => patch(['opening', 'message'], value)} />
        </Field>
        <Field label={t('Starter prompts (JSON)')} hint={t('Configure starter labels, prompts, and send, fill, or action behavior.')} wide>
          <JsonPatchEditor ariaLabel={t('Starter prompts JSON')} value={profile.opening?.starters ?? []} onCommit={(value) => patch(['opening', 'starters'], value)} />
        </Field>
        {openingMode === 'request' && <>
          <Field label={t('Opening request (JSON)')} hint={t('Uses the same request contract as conversation requests, without variants.')} wide>
            <JsonPatchEditor ariaLabel={t('Opening request JSON')} value={profile.opening?.request ?? { method: 'POST', url: '' }} onCommit={(value) => patch(['opening', 'request'], value)} />
          </Field>
          <Field label={t('Opening message path')} hint={t('Required text shown before the first turn.')}><PatchText aria-label={t('Opening message path')} value={profile.opening?.response?.messagePath ?? '$.message'} spellCheck={false} onCommit={(value) => patch(['opening', 'response', 'messagePath'], value)} /></Field>
          <Field label={t('Legacy starter path')} hint={t('Existing starter mappings remain supported. Do not map the same choices through both the legacy path and a response block.')}><PatchText aria-label={t('Legacy starter path')} value={profile.opening?.response?.startersPath ?? '$.options'} spellCheck={false} onCommit={(value) => patch(['opening', 'response', 'startersPath'], value)} /></Field>
          <Field label={t('Additional response blocks')} hint={t('Map provider-specific choices, fields, quota, status, or JSON into bounded opening UI.')} wide>
            <OpeningResponseBlocksEditor blocks={profile.opening?.response?.blocks ?? []} onChange={(blocks) => patch(['opening', 'response', 'blocks'], blocks)} />
          </Field>
          <Field label={t('Opening fallbacks (JSON)')} hint={t('Fallback entries are evaluated in declaration order.')} wide>
            <JsonPatchEditor ariaLabel={t('Opening fallbacks JSON')} value={profile.opening?.fallbacks ?? []} onCommit={(value) => patch(['opening', 'fallbacks'], value)} />
          </Field>
          <Field label={t('Opening failure policy (JSON)')} hint={t('Control retry availability and network-error fallback behavior.')} wide>
            <JsonPatchEditor ariaLabel={t('Opening failure policy JSON')} value={profile.opening?.failurePolicy ?? { allowRetry: true, useFallbackOnNetworkError: false }} onCommit={(value) => patch(['opening', 'failurePolicy'], value)} />
          </Field>
        </>}
      </div>
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('then')}</span></div>

    <section className="config-section" aria-labelledby="request-heading">
      <div className="section-heading"><div><h3 id="request-heading">{t('Conversation request')}</h3><p>{t('The base endpoint is shared by first-turn and continuation variants.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('HTTP method')}><select aria-label={t('Conversation request method')} value={profile.conversation.send.method} onChange={(event) => patch(['conversation', 'send', 'method'], event.target.value)}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
        <Field label={t('Request URL')} hint={t('Template values such as ${env.baseUrl} are resolved in the Extension Host.')} wide error={!profile.conversation.send.url.trim() ? t('A request URL is required.') : undefined}><PatchText aria-label={t('Conversation request URL')} value={profile.conversation.send.url} required spellCheck={false} onCommit={(value) => patch(['conversation', 'send', 'url'], value)} /></Field>
      </div>
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('choose a variant')}</span></div>

    <section className="config-section variant-section" aria-labelledby="variants-heading">
      <div className="section-heading"><div><h3 id="variants-heading">{t('First turn & continuation')}</h3><p>{t('Variants are selected in declaration order using structured conditions. Bodies accept JSON and template references such as')} <code>{'{$value: "input.text"}'}</code>.</p></div></div>
      <div className="variant-toolbar"><span>{variants.length === 1 ? t('{count} configured variant', { count: formatNumber(variants.length) }) : t('{count} configured variants', { count: formatNumber(variants.length) })}</span><div className="actions"><button onClick={() => addVariant('first-turn')}>{t('Add first turn')}</button><button onClick={() => addVariant('continuation')}>{t('Add continuation')}</button></div></div>
      {variants.length ? <div className="variant-list">{variants.map((variant, index) => <VariantCard key={`${variant.id}-${index}`} index={index} variant={variant} post={post} onDelete={removeVariant} />)}</div> : <div className="empty-state"><strong>{t('No request variants')}</strong><p>{t('Add a first-turn or continuation variant before sending a request.')}</p><div className="actions"><button className="primary" onClick={() => addVariant('first-turn')}>{t('Add first turn')}</button><button onClick={() => addVariant('continuation')}>{t('Add continuation')}</button></div></div>}
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('while streaming')}</span></div>

    <section className="config-section" aria-labelledby="stop-heading">
      <div className="section-heading"><div><h3 id="stop-heading">{t('Stop')}</h3><p>{t('Stop always aborts locally. An optional request can notify the remote service when context is available.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('Stop mode')}><select aria-label={t('Stop mode')} value={stop?.strategy ?? 'abortOnly'} onChange={(event) => {
          const strategy = event.target.value;
          patch(['conversation', 'stop', 'strategy'], strategy);
          if (strategy === 'abortThenRequest' && !stopRequest) patch(['conversation', 'stop', 'request'], { method: 'POST', url: '', body: {} });
        }}><option value="abortOnly">{t('Local abort only')}</option><option value="abortThenRequest">{t('Abort then request')}</option></select></Field>
        <Field label={t('Stop request method')} hint={t('Required when Stop mode is Abort then request.')}><select aria-label={t('Stop request method')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.method ?? 'POST'} onChange={(event) => patch(['conversation', 'stop', 'request', 'method'], event.target.value)}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
        <Field label={t('Stop request URL')} hint={t('Secrets and template values are resolved only in the Extension Host.')} wide error={stop?.strategy === 'abortThenRequest' && !stopRequest?.url?.trim() ? t('A stop request URL is required for this mode.') : undefined}><PatchText aria-label={t('Stop request URL')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.url ?? ''} spellCheck={false} onCommit={(value) => patch(['conversation', 'stop', 'request', 'url'], value)} /></Field>
        <Field label={t('Stop request headers (JSON)')} wide><JsonPatchEditor ariaLabel={t('Stop request headers JSON')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.headers ?? {}} onCommit={(value) => patch(['conversation', 'stop', 'request', 'headers'], value)} /></Field>
        <Field label={t('Stop request body (JSON)')} wide><JsonPatchEditor ariaLabel={t('Stop request body JSON')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.body ?? {}} onCommit={(value) => patch(['conversation', 'stop', 'request', 'body'], value)} /></Field>
        <Field label={t('Stop context')} hint={t('Comma-separated paths required before sending a remote stop request.')} wide><PatchText aria-label={t('Required stop context')} value={(stop?.requiredContext ?? []).join(', ')} disabled={stop?.strategy !== 'abortThenRequest'} onCommit={(value) => patch(['conversation', 'stop', 'requiredContext'], parseList(value))} /></Field>
        <Field label={t('Partial response')}><div className="stacked-checks"><Checkbox label={t('Preserve partial content')} checked={stop?.preservePartialContent ?? true} onChange={(value) => patch(['conversation', 'stop', 'preservePartialContent'], value)} /><Checkbox label={t('Append a system notice')} checked={stop?.appendSystemNotice ?? true} onChange={(value) => patch(['conversation', 'stop', 'appendSystemNotice'], value)} /></div></Field>
      </div>
    </section>

    <section className="config-section" aria-labelledby="error-policy-heading">
      <div className="section-heading"><div><h3 id="error-policy-heading">{t('Error policy')}</h3><p>{t('Choose whether an unexpected end is a failure and how partial/error content remains visible.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('Unexpected stream end')}><select aria-label={t('Unexpected stream end policy')} value={profile.stream.unexpectedEndPolicy ?? 'fail'} onChange={(event) => patch(['stream', 'unexpectedEndPolicy'], event.target.value)}><option value="fail">{t('Fail the turn')}</option><option value="completeWithWarning">{t('Complete with warning')}</option></select></Field>
        <Field label={t('Error handling')}><div className="stacked-checks"><Checkbox label={t('Preserve partial content')} checked={errorPolicy?.preservePartialContent ?? true} onChange={(value) => patch(['errorPolicy', 'preservePartialContent'], value)} /><Checkbox label={t('Show an error part')} checked={errorPolicy?.showErrorPart ?? true} onChange={(value) => patch(['errorPolicy', 'showErrorPart'], value)} /><Checkbox label={t('Keep conversation ID')} checked={errorPolicy?.keepConversationId ?? true} onChange={(value) => patch(['errorPolicy', 'keepConversationId'], value)} /><Checkbox label={t('Allow continuation after error')} checked={errorPolicy?.allowContinuation ?? true} onChange={(value) => patch(['errorPolicy', 'allowContinuation'], value)} /><Checkbox label={t('Release all locks')} checked={errorPolicy?.releaseAllLocks ?? true} onChange={(value) => patch(['errorPolicy', 'releaseAllLocks'], value)} /></div></Field>
      </div>
    </section>

    <section className="config-section" aria-labelledby="new-conversation-heading">
      <div className="section-heading"><div><h3 id="new-conversation-heading">{t('New Conversation')}</h3><p>{t('Reset clears messages, IDs, turn metrics, and interaction context, preserves configured controls, then runs this opening behavior.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('Opening behavior after reset')} hint={t("This maps to the profile's opening.mode so the text editor and Visual Editor stay in sync.")}><select aria-label={t('New conversation opening behavior')} value={openingMode} onChange={(event) => patch(['opening', 'mode'], event.target.value)}><option value="static">{t('Show static opening')}</option><option value="request">{t('Run opening request')}</option><option value="disabled">{t('No opening')}</option></select></Field>
        <div className="flow-note"><strong>{t('Preserved controls')}</strong><p>{t('Actor, model, and environment values remain selected; New Conversation is unavailable while a turn is active.')}</p></div>
      </div>
    </section>

    <section className="config-section" aria-labelledby="history-heading">
      <div className="section-heading"><div><h3 id="history-heading">{t('History')}</h3><p>{t('Local runs are stored by the Extension Host and can be replayed without sending another network request.')}</p></div></div>
      <div className="form-grid">
        <Field label={t('Local runs')}><div className="stacked-checks"><Checkbox label={t('Enable local run history')} checked={localRuns?.enabled ?? true} onChange={(value) => patch(['history', 'localRuns', 'enabled'], value)} /><Checkbox label={t('Record raw events')} checked={localRuns?.recordRawEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordRawEvents'], value)} /><Checkbox label={t('Record normalized events')} checked={localRuns?.recordNormalizedEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordNormalizedEvents'], value)} /><Checkbox label={t('Record chat snapshot')} checked={localRuns?.recordChatSnapshot ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordChatSnapshot'], value)} /></div></Field>
        <Field label={t('Maximum local runs')} hint={t('Older runs are evicted after this count.')}><input aria-label={t('Maximum local runs')} type="number" min={1} max={100} value={localRuns?.maxRuns ?? 20} onChange={(event) => patch(['history', 'localRuns', 'maxRuns'], clampInteger(event.target.value, 1, 100, 20))} /></Field>
        <Field label={t('Remote session scope')} hint={t('Choose which profile values identify a reusable remote conversation reference.')} wide>
          <div className="stacked-checks">
            {(['profile', 'actor', 'environment'] as const).map((scope) => <Checkbox key={scope} label={localizeHumanized(scope)} checked={(profile.history?.remoteSessions?.scope ?? ['profile']).includes(scope)} onChange={(checked) => {
              const current = profile.history?.remoteSessions?.scope ?? ['profile'];
              const next = checked ? [...new Set([...current, scope])] : current.filter((item) => item !== scope);
              patch(['history', 'remoteSessions'], { mode: 'referenceOnly', scope: next });
            }} />)}
          </div>
        </Field>
      </div>
    </section>

    <p className="muted">{t('All changes use WorkspaceEdit and participate in VS Code Undo/Redo. Comments and surrounding JSONC formatting are preserved where the parser can make a local edit.')}</p>
  </div>;
}

function OpeningResponseBlocksEditor({ blocks, onChange }: { blocks: OpeningResponseBlockDefinition[]; onChange: (blocks: OpeningResponseBlockDefinition[]) => void }): React.JSX.Element {
  const [newKind, setNewKind] = useState<OpeningResponseBlockKind>('choices');
  const replace = (index: number, block: OpeningResponseBlockDefinition) => onChange(blocks.map((item, itemIndex) => itemIndex === index ? block : item));
  const remove = (index: number) => onChange(blocks.filter((_, itemIndex) => itemIndex !== index));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks]; [next[index], next[target]] = [next[target]!, next[index]!]; onChange(next);
  };
  const add = () => {
    const id = uniqueId(blocks.map((block) => block.id), newKind === 'meter' ? 'usage' : newKind);
    onChange([...blocks, createOpeningBlock(newKind, id)]);
  };
  return <div className="opening-response-blocks">
    <div className="opening-response-blocks__toolbar"><span>{blocks.length === 1 ? t('{count} response block', { count: formatNumber(blocks.length) }) : t('{count} response blocks', { count: formatNumber(blocks.length) })}</span><div><select aria-label={t('New response block type')} value={newKind} onChange={(event) => setNewKind(event.target.value as OpeningResponseBlockKind)}>{openingBlockKinds.map((kind) => <option value={kind} key={kind}>{openingBlockKindLabel(kind)}</option>)}</select><button type="button" disabled={blocks.length >= 8} onClick={add}>{t('Add block')}</button></div></div>
    {blocks.length ? <ol className="opening-response-blocks__list">{blocks.map((block, index) => <li key={`${block.id}-${index}`}><OpeningResponseBlockCard block={block} index={index} count={blocks.length} onChange={(value) => replace(index, value)} onMove={(direction) => move(index, direction)} onDelete={() => remove(index)} /></li>)}</ol> : <div className="empty-state compact"><strong>{t('No additional response blocks')}</strong><p>{t('The opening message and legacy starter path still work normally.')}</p></div>}
    {blocks.length >= 8 ? <p className="field-hint">{t('Opening responses are limited to 8 blocks.')}</p> : null}
  </div>;
}

const openingBlockKinds: OpeningResponseBlockKind[] = ['choices', 'fields', 'meter', 'status', 'json'];
function openingBlockKindLabel(kind: OpeningResponseBlockKind): string {
  return t(kind === 'choices' ? 'Choices' : kind === 'fields' ? 'Fields' : kind === 'meter' ? 'Meter' : kind === 'status' ? 'Status' : 'JSON details');
}

function createOpeningBlock(kind: OpeningResponseBlockKind, id: string): OpeningResponseBlockDefinition {
  const base = { id, label: '', path: '$', emptyPolicy: 'hide' as const };
  if (kind === 'choices') return { ...base, kind, itemLabelPath: '$.label', itemPromptPath: '$.prompt', behavior: 'send' };
  if (kind === 'fields') return { ...base, kind, fields: [{ id: 'value', label: t('Value'), path: '$.value', format: 'text' }] };
  if (kind === 'meter') return { ...base, kind, valuePath: '$.used', maxPath: '$.limit', resetAtPath: '$.resetAt' };
  if (kind === 'status') return { ...base, kind, valuePath: '$', tone: 'neutral' };
  return { ...base, kind, defaultCollapsed: true };
}

function OpeningResponseBlockCard({ block, index, count, onChange, onMove, onDelete }: { block: OpeningResponseBlockDefinition; index: number; count: number; onChange: (block: OpeningResponseBlockDefinition) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(index === 0);
  const changeKind = (kind: OpeningResponseBlockKind) => onChange({ ...createOpeningBlock(kind, block.id), label: block.label, path: block.path, emptyPolicy: block.emptyPolicy });
  const update = (value: Partial<OpeningResponseBlockDefinition>) => onChange({ ...block, ...value } as OpeningResponseBlockDefinition);
  return <article className="opening-response-block">
    <header><button type="button" className="opening-response-block__toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><ProductIcon name={expanded ? 'chevron-down' : 'chevron-right'} /><span><strong>{block.label || openingBlockKindLabel(block.kind)}</strong><code>{block.id} · {openingBlockKindLabel(block.kind)}</code></span></button><div><IconButton type="button" icon="arrow-up" label={t('Move block up')} disabled={index === 0} onClick={() => onMove(-1)} /><IconButton type="button" icon="arrow-down" label={t('Move block down')} disabled={index === count - 1} onClick={() => onMove(1)} /><IconButton type="button" icon="trash" label={t('Delete response block')} onClick={onDelete} /></div></header>
    {expanded && <div className="form-grid opening-response-block__fields">
      <Field label={t('Block type')}><select aria-label={t('Block type')} value={block.kind} onChange={(event) => changeKind(event.target.value as OpeningResponseBlockKind)}>{openingBlockKinds.map((kind) => <option value={kind} key={kind}>{openingBlockKindLabel(kind)}</option>)}</select></Field>
      <Field label={t('Block ID')}><PatchText aria-label={t('Block ID')} value={block.id} spellCheck={false} onCommit={(id) => update({ id })} /></Field>
      <Field label={t('Label')} hint={t('Optional heading shown above the block.')}><PatchText aria-label={t('Response block label')} value={block.label ?? ''} onCommit={(label) => update({ label: label || undefined })} /></Field>
      <Field label={t('Data path')} hint={t('Dotted path in the opening response; use $ for its root.')}><PatchText aria-label={t('Response block data path')} value={block.path} spellCheck={false} onCommit={(path) => update({ path })} /></Field>
      <Field label={t('When data is empty')}><select aria-label={t('Empty response block behavior')} value={block.emptyPolicy ?? 'hide'} onChange={(event) => update({ emptyPolicy: event.target.value as 'hide' | 'show' })}><option value="hide">{t('Hide block')}</option><option value="show">{t('Show empty state')}</option></select></Field>
      {block.kind === 'choices' && <>
        <Field label={t('Choice label path')}><PatchText aria-label={t('Choice label path')} value={block.itemLabelPath ?? '$.label'} spellCheck={false} onCommit={(itemLabelPath) => onChange({ ...block, itemLabelPath })} /></Field>
        <Field label={t('Choice prompt path')}><PatchText aria-label={t('Choice prompt path')} value={block.itemPromptPath ?? '$.prompt'} spellCheck={false} onCommit={(itemPromptPath) => onChange({ ...block, itemPromptPath })} /></Field>
        <Field label={t('Choice behavior')}><select aria-label={t('Choice behavior')} value={block.behavior ?? 'send'} onChange={(event) => onChange({ ...block, behavior: event.target.value as 'send' | 'fill' })}><option value="send">{t('Send immediately')}</option><option value="fill">{t('Fill composer')}</option></select></Field>
      </>}
      {block.kind === 'fields' && <Field label={t('Displayed fields')} hint={t('Each field reads a path relative to the block data path.')} wide><OpeningResponseFieldsEditor fields={block.fields} onChange={(fields) => onChange({ ...block, fields })} /></Field>}
      {block.kind === 'meter' && <>
        <Field label={t('Current value path')}><PatchText aria-label={t('Current value path')} value={block.valuePath} spellCheck={false} onCommit={(valuePath) => onChange({ ...block, valuePath })} /></Field>
        <Field label={t('Maximum value path')}><PatchText aria-label={t('Maximum value path')} value={block.maxPath} spellCheck={false} onCommit={(maxPath) => onChange({ ...block, maxPath })} /></Field>
        <Field label={t('Reset time path')}><PatchText aria-label={t('Reset time path')} value={block.resetAtPath ?? ''} spellCheck={false} onCommit={(resetAtPath) => onChange({ ...block, resetAtPath: resetAtPath || undefined })} /></Field>
        <Field label={t('Unit')}><PatchText aria-label={t('Meter unit')} value={block.unit ?? ''} onCommit={(unit) => onChange({ ...block, unit: unit || undefined })} /></Field>
      </>}
      {block.kind === 'status' && <>
        <Field label={t('Status value path')}><PatchText aria-label={t('Status value path')} value={block.valuePath ?? '$'} spellCheck={false} onCommit={(valuePath) => onChange({ ...block, valuePath })} /></Field>
        <Field label={t('Status tone')}><select aria-label={t('Status tone')} value={block.tone ?? 'neutral'} onChange={(event) => onChange({ ...block, tone: event.target.value as NonNullable<typeof block.tone> })}>{(['neutral', 'info', 'success', 'warning', 'error'] as const).map((tone) => <option key={tone} value={tone}>{localizeHumanized(tone)}</option>)}</select></Field>
      </>}
      {block.kind === 'json' && <Field label={t('JSON details')}><Checkbox label={t('Collapsed by default')} checked={block.defaultCollapsed ?? true} onChange={(defaultCollapsed) => onChange({ ...block, defaultCollapsed })} /></Field>}
    </div>}
  </article>;
}

function OpeningResponseFieldsEditor({ fields, onChange }: { fields: OpeningResponseFieldDefinition[]; onChange: (fields: OpeningResponseFieldDefinition[]) => void }): React.JSX.Element {
  const replace = (index: number, field: OpeningResponseFieldDefinition) => onChange(fields.map((item, itemIndex) => itemIndex === index ? field : item));
  const add = () => { const id = uniqueId(fields.map((field) => field.id), 'field'); onChange([...fields, { id, label: t('Field'), path: '$.value', format: 'text' }]); };
  return <div className="opening-response-fields"><div className="opening-response-fields__heading"><span>{fields.length === 1 ? t('{count} field', { count: formatNumber(fields.length) }) : t('{count} fields', { count: formatNumber(fields.length) })}</span><button type="button" disabled={fields.length >= 20} onClick={add}>{t('Add field')}</button></div>{fields.map((field, index) => <div className="opening-response-field" key={`${field.id}-${index}`}><PatchText aria-label={t('Field ID')} value={field.id} spellCheck={false} onCommit={(id) => replace(index, { ...field, id })} /><PatchText aria-label={t('Field label')} value={field.label} onCommit={(label) => replace(index, { ...field, label })} /><PatchText aria-label={t('Field path')} value={field.path} spellCheck={false} onCommit={(path) => replace(index, { ...field, path })} /><select aria-label={t('Field format')} value={field.format ?? 'text'} onChange={(event) => replace(index, { ...field, format: event.target.value as OpeningResponseFieldDefinition['format'] })}>{(['text', 'number', 'datetime', 'percent'] as const).map((format) => <option key={format} value={format}>{localizeHumanized(format)}</option>)}</select><IconButton type="button" icon="trash" label={t('Delete field')} onClick={() => onChange(fields.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</div>;
}

function VariantCard({ index, variant, post, onDelete }: { index: number; variant: RequestVariant; post: Post; onDelete: (index: number) => void }): React.JSX.Element {
  const [bodyText, setBodyText] = useState(() => JSON.stringify(variant.body ?? {}, null, 2));
  const [bodyError, setBodyError] = useState('');
  const condition = variant.when ?? {};
  const key: VariantKey = variant.id.toLocaleLowerCase().includes('continu') ? 'continuation' : variant.id.toLocaleLowerCase().includes('first') ? 'first-turn' : 'other';
  const base: Array<string | number> = ['conversation', 'send', 'variants', index];
  const patch = (suffix: string[], value: unknown) => post({ type: 'profile.patch', path: [...base, ...suffix], value });
  useEffect(() => { setBodyText(JSON.stringify(variant.body ?? {}, null, 2)); setBodyError(''); }, [variant.body]);
  const applyBody = () => {
    try {
      const value = JSON.parse(bodyText) as unknown;
      setBodyError('');
      patch(['body'], value);
    } catch (error) {
      setBodyError(error instanceof Error ? error.message : t('Enter valid JSON.'));
    }
  };
  return <article className="variant-card">
    <header><div><span className="variant-kind">{t(key === 'first-turn' ? 'First Turn' : key === 'continuation' ? 'Continuation' : 'Request Variant')}</span><strong>{variant.id || t('Variant {number}', { number: formatNumber(index + 1) })}</strong></div><button className="danger-subtle" onClick={() => onDelete(index)}>{t('Delete variant')}</button></header>
    <div className="form-grid variant-fields">
      <Field label={t('Variant ID')} error={!variant.id.trim() ? t('A variant ID is required.') : undefined}><PatchText aria-label={t('Variant ID')} value={variant.id} required onCommit={(value) => patch(['id'], value)} /></Field>
      <Field label={t('Condition summary')} hint={t('The first matching variant wins. Leave Path blank to use an unconditional variant.')}><PatchText aria-label={t('Variant condition path')} value={condition.path ?? ''} placeholder="conversation.id" onCommit={(value) => patch(['when', 'path'], value || undefined)} /></Field>
      <Field label={t('Condition operator')}><select aria-label={t('Variant condition operator')} value={condition.operator ?? 'equals'} onChange={(event) => patch(['when', 'operator'], event.target.value)}>{operators.map((operator) => <option key={operator} value={operator}>{localizeHumanized(operator)}</option>)}</select></Field>
      <Field label={t('Condition value')} hint={t('Values are parsed as JSON when possible.')}><input aria-label={t('Variant condition value')} value={formatValue(condition.value)} onChange={(event) => patch(['when', 'value'], parseLooseValue(event.target.value))} /></Field>
      <Field label={t('Headers (JSON)')} hint={t('Variant headers override matching base request headers.')} wide><JsonPatchEditor ariaLabel={t('Variant headers JSON')} value={variant.headers ?? {}} onCommit={(value) => patch(['headers'], value)} /></Field>
      <Field label={t('Body (JSON)')} hint={t('No JavaScript expressions are evaluated. Template references are data values.')} wide error={bodyError}><textarea aria-label={t('Variant body JSON')} className="code-input" rows={8} value={bodyText} spellCheck={false} aria-invalid={Boolean(bodyError)} onChange={(event) => setBodyText(event.target.value)} onBlur={applyBody} /><button className="apply-inline" onClick={applyBody}>{t('Apply body JSON')}</button></Field>
    </div>
  </article>;
}

export function EventsEditor({ profile, post, mappingTestResult }: { profile: TurnStageProfile; post: Post; mappingTestResult?: MappingTestResult }): React.JSX.Element {
  const add = () => {
    const number = profile.stream.mappings.length + 1;
    const next: MappingRule = { id: uniqueRuleId(profile, `mapping-${number}`), match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } };
    post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, next] });
  };
  const addMessageMetric = () => {
    const number = profile.stream.mappings.length + 1;
    const next: MappingRule = {
      id: uniqueRuleId(profile, `message-metric-${number}`),
      match: { event: 'done' },
      emit: { type: 'message.metric.updated', metric: { id: 'backendDuration', label: 'Backend reported', value: { path: '$.durationMs' }, format: 'duration', unit: 'ms', aggregation: 'last' } }
    };
    post({ type: 'profile.patch', path: ['stream', 'mappings'], value: [...profile.stream.mappings, next] });
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= profile.stream.mappings.length) return;
    const next = [...profile.stream.mappings]; [next[index], next[target]] = [next[target]!, next[index]!];
    post({ type: 'profile.patch', path: ['stream', 'mappings'], value: next });
  };
  const remove = (index: number) => post({ type: 'profile.patch', path: ['stream', 'mappings'], value: profile.stream.mappings.filter((_, itemIndex) => itemIndex !== index) });
  return <div className="content-page config-page mapping-page">
    <header className="page-heading"><div><h2>{t('Stream mappings')}</h2><p>{t('Match raw stream events and emit normalized TurnStage events. Rules run from top to bottom.')}</p></div><div className="page-heading-actions"><button onClick={addMessageMetric}>{t('Add message metric')}</button><button className="primary" onClick={add}>{t('Add mapping')}</button></div></header>
    <SampleEventTester result={mappingTestResult} post={post} />
    <div className="mapping-toolbar"><Field label={t('Mapping mode')}><select aria-label={t('Mapping mode')} value={profile.stream.mappingMode ?? 'firstMatch'} onChange={(event) => post({ type: 'profile.patch', path: ['stream', 'mappingMode'], value: event.target.value })}><option value="firstMatch">{t('First match')}</option><option value="allMatches">{t('All matches')}</option></select></Field><span>{profile.stream.mappings.length === 1 ? t('{count} rule', { count: formatNumber(profile.stream.mappings.length) }) : t('{count} rules', { count: formatNumber(profile.stream.mappings.length) })}</span></div>
    <ol className="mapping-list">{profile.stream.mappings.map((rule, index) => <li key={`${rule.id}-${index}`}><MappingCard rule={rule} index={index} count={profile.stream.mappings.length} post={post} onMove={move} onDelete={remove} /></li>)}</ol>
    {!profile.stream.mappings.length && <div className="empty-state"><strong>{t('No mapping rules')}</strong><p>{t('Add a rule here, or create a draft from a raw event in the Inspector.')}</p><button className="primary" onClick={add}>{t('Add first mapping')}</button></div>}
  </div>;
}

export function SampleEventTester({ result, post }: { result?: MappingTestResult; post: Post }): React.JSX.Element {
  const [protocol, setProtocol] = useState<MappingTestInput['protocol']>('sse');
  const [eventName, setEventName] = useState('message');
  const [sample, setSample] = useState('event: message\ndata: {"text":"Hello from a sample event"}\n');
  const [error, setError] = useState('');
  const test = () => {
    const parsed = parseSampleEvent(sample, protocol, eventName);
    if (parsed.error || !parsed.input) { setError(parsed.error ?? t('Enter a sample event.')); return; }
    setError('');
    post({ type: 'mapping.test', event: parsed.input });
  };
  return <section className="config-section sample-tester" aria-labelledby="sample-event-heading">
    <div className="section-heading"><div><h3 id="sample-event-heading">{t('Sample event tester')}</h3><p>{t('Paste one SSE block or raw JSON event and preview the same MappingEngine output used by the runtime. JavaScript is never executed.')}</p></div></div>
    <div className="form-grid">
      <Field label={t('Event format')}><select aria-label={t('Sample event format')} value={protocol} onChange={(event) => setProtocol(event.target.value as MappingTestInput['protocol'])}>{sampleProtocols.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
      <Field label={t('SSE event name')} hint={t('Optional for raw JSON; the event: line wins for SSE input.')}><input aria-label={t('Sample SSE event name')} value={eventName} onChange={(event) => setEventName(event.target.value)} /></Field>
      <Field label={t('Paste event')} wide error={error}><textarea aria-label={t('Sample event payload')} className="code-input" rows={6} value={sample} spellCheck={false} aria-invalid={Boolean(error)} onChange={(event) => setSample(event.target.value)} /></Field>
    </div>
    <div className="actions sample-actions"><button className="primary" onClick={test}>{t('Test mapping')}</button><button onClick={() => { setSample(''); setError(''); }}>{t('Clear')}</button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {result && <div className="sample-result" aria-live="polite"><div className="sample-result-heading"><strong>{t('Mapping result')}</strong><span>{result.ruleIds.length ? result.ruleIds.length === 1 ? t('{count} matched rule', { count: formatNumber(result.ruleIds.length) }) : t('{count} matched rules', { count: formatNumber(result.ruleIds.length) }) : t('No rule matched')}</span></div><div className="matched-rules"><span>{t('Matched rule IDs')}</span>{result.ruleIds.length ? result.ruleIds.map((id) => <code key={id}>{id}</code>) : <em>{t('None')}</em>}</div><div><span className="result-label">{t('Normalized preview')}</span><JsonPreview value={result.normalized} /></div>{result.errors.length > 0 && <div className="sample-errors" role="alert"><strong>{t('Mapping errors')}</strong>{result.errors.map((item, index) => <p key={`${item.ruleId}-${index}`}><code>{item.ruleId}</code> {item.message}</p>)}</div>}</div>}
  </section>;
}

export function parseSampleEvent(text: string, protocol: MappingTestInput['protocol'], eventName = ''): { input?: MappingTestInput; error?: string } {
  const raw = text.trim();
  if (!raw) return { error: t('Paste an SSE block or JSON event first.') };
  if (raw.length > 262_144) return { error: t('Sample events are limited to 256 KiB.') };
  let name = eventName.trim() || undefined;
  let payload = raw;
  if (protocol === 'sse' && /^(?:\s*(?:event|data|id|retry):)/m.test(raw)) {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim() || name;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    payload = dataLines.join('\n').trim();
    if (!payload) return { error: t('The SSE sample does not contain a data: line.') };
  } else if (protocol === 'ndjson') {
    payload = raw.split(/\r?\n/).find((line) => line.trim())?.trim() ?? raw;
  }
  let data: unknown;
  if (protocol === 'text-stream') data = payload;
  else {
    try { data = JSON.parse(payload) as unknown; } catch (error) { return { error: t('Sample event is not valid JSON: {message}', { message: error instanceof Error ? error.message : String(error) }) }; }
    if (!name && isRecord(data) && typeof data.event === 'string' && 'data' in data && Object.keys(data).length <= 3) { name = data.event; data = data.data; }
  }
  return { input: { protocol, raw: text, data, eventName: name } };
}

function MappingCard({ rule, index, count, post, onMove, onDelete }: { rule: MappingRule; index: number; count: number; post: Post; onMove: (index: number, direction: -1 | 1) => void; onDelete: (index: number) => void }): React.JSX.Element {
  const [emitText, setEmitText] = useState(() => JSON.stringify(rule.emit, null, 2));
  const [emitError, setEmitError] = useState('');
  const [matchValue, setMatchValue] = useState(() => formatValue(rule.match.value));
  useEffect(() => { setEmitText(JSON.stringify(rule.emit, null, 2)); setEmitError(''); }, [rule.emit]);
  useEffect(() => setMatchValue(formatValue(rule.match.value)), [rule.match.value]);
  const base: Array<string | number> = ['stream', 'mappings', index];
  const patch = (suffix: string[], value: unknown) => post({ type: 'profile.patch', path: [...base, ...suffix], value });
  const action = rule.emit.type === 'action.upsert' && isRecord(rule.emit.action) && !(typeof rule.emit.action.path === 'string' && Object.keys(rule.emit.action).length === 1) ? rule.emit.action : undefined;
  const patchAction = (key: 'appearance' | 'icon', value: string) => {
    if (!action || value === '__mapped__') return;
    const next = { ...action };
    if (value) next[key] = value;
    else delete next[key];
    patch(['emit', 'action'], next);
  };
  const applyEmit = () => { try { const parsed = JSON.parse(emitText) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== 'string') throw new Error(t('Emit must be an object with a string “{key}”.', { key: 'type' })); setEmitError(''); patch(['emit'], parsed); } catch (error) { setEmitError(error instanceof Error ? error.message : t('Enter valid JSON.')); } };
  return <article className="mapping-card">
    <header><div className="mapping-title"><span className="rule-number">{formatNumber(index + 1)}</span><div><strong>{rule.id}</strong><span>{rule.match.event ?? rule.match.path ?? t('Any event')} → {String(rule.emit.type)}</span></div></div><div className="rule-actions"><IconButton icon="arrow-up" label={t('Move {id} up', { id: rule.id })} disabled={index === 0} onClick={() => onMove(index, -1)} /><IconButton icon="arrow-down" label={t('Move {id} down', { id: rule.id })} disabled={index === count - 1} onClick={() => onMove(index, 1)} /><button className="danger-subtle" onClick={() => onDelete(index)}>{t('Delete')}</button></div></header>
    <div className="form-grid mapping-fields">
      <Field label={t('Rule ID')} error={!rule.id.trim() ? t('A rule ID is required.') : undefined}><PatchText aria-label={t('Rule ID')} value={rule.id} required onCommit={(value) => patch(['id'], value)} /></Field>
      <Field label={t('SSE event')} hint={t('Optional event name, such as {message} or {done}.', { message: 'message', done: 'done' })}><PatchText aria-label={t('SSE event name')} value={rule.match.event ?? ''} onCommit={(value) => patch(['match', 'event'], value || undefined)} /></Field>
      <Field label={t('Data path')} hint={t('Optional JSONPath evaluated against event data.')}><PatchText aria-label={t('Mapping data path')} value={rule.match.path ?? ''} placeholder="$.type" spellCheck={false} onCommit={(value) => patch(['match', 'path'], value || undefined)} /></Field>
      <Field label={t('Operator')}><select aria-label={t('Mapping operator')} value={rule.match.operator ?? 'equals'} onChange={(event) => patch(['match', 'operator'], event.target.value)}>{operators.map((operator) => <option key={operator} value={operator}>{localizeHumanized(operator)}</option>)}</select></Field>
      <Field label={t('Match value')} hint={t('JSON values are preserved; unquoted text is saved as a string.')}><input aria-label={t('Mapping match value')} value={matchValue} onChange={(event) => setMatchValue(event.target.value)} onBlur={() => patch(['match', 'value'], parseLooseValue(matchValue))} /></Field>
      <Field label={t('Continue matching')}><label className="checkbox-control"><input type="checkbox" checked={Boolean(rule.continue)} onChange={(event) => patch(['continue'], event.target.checked)} /><span>{t('Run later rules after this match')}</span></label></Field>
      {action ? <>
        <Field label={t('CTA style')} hint={t('Uses native VS Code button colors in every theme.')}><select aria-label={t('CTA style')} value={typeof action.appearance === 'string' ? action.appearance : isRecord(action.appearance) ? '__mapped__' : 'secondary'} onChange={(event) => patchAction('appearance', event.target.value)}>{isRecord(action.appearance) ? <option value="__mapped__">{t('Mapped from event')}</option> : null}<option value="primary">{t('Primary')}</option><option value="secondary">{t('Secondary')}</option><option value="link">{t('Link')}</option></select></Field>
        <Field label={t('CTA icon')} hint={t('Optional validated Codicon shown before the text label.')}><select aria-label={t('CTA icon')} value={typeof action.icon === 'string' ? action.icon : isRecord(action.icon) ? '__mapped__' : ''} onChange={(event) => patchAction('icon', event.target.value)}>{isRecord(action.icon) ? <option value="__mapped__">{t('Mapped from event')}</option> : null}<option value="">{t('No icon')}</option>{responseActionIcons.map((icon) => <option value={icon} key={icon}>{localizeHumanized(icon)}</option>)}</select></Field>
      </> : null}
      <Field label={t('Emit object (JSON)')} hint={t('Must include a string {key}. Paths extract values from the raw event.', { key: 'type' })} wide error={emitError}><textarea aria-label={t('Mapping emit JSON')} className="code-input" rows={7} value={emitText} spellCheck={false} aria-invalid={Boolean(emitError)} onChange={(event) => setEmitText(event.target.value)} onBlur={applyEmit} /><button className="apply-inline" onClick={applyEmit}>{t('Apply emit JSON')}</button></Field>
    </div>
  </article>;
}

export function UiConfigEditor({ profile, post }: { profile: TurnStageProfile; post: Post }): React.JSX.Element {
  const [disableText, setDisableText] = useState((profile.ui?.locks?.whileTurnActive?.disable ?? []).join(', '));
  const [allowText, setAllowText] = useState((profile.ui?.locks?.whileTurnActive?.allow ?? []).join(', '));
  const streaming = resolveStreaming(profile.ui);
  useEffect(() => setDisableText((profile.ui?.locks?.whileTurnActive?.disable ?? []).join(', ')), [profile.ui?.locks?.whileTurnActive?.disable]);
  useEffect(() => setAllowText((profile.ui?.locks?.whileTurnActive?.allow ?? []).join(', ')), [profile.ui?.locks?.whileTurnActive?.allow]);
  return <div className="content-page config-page">
    <header className="page-heading"><div><h2>{t('UI configuration')}</h2><p>{t('Shape the chat layout, composer behavior, visibility, and active-turn locks.')}</p></div></header>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Layout & composer')}</h3><p>{t('Changes are reflected in the Chat view immediately.')}</p></div></div><div className="form-grid">
      <Field label={t('Layout preset')}><select aria-label={t('Layout preset')} value={profile.ui?.layout?.preset ?? 'split-inspector'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'layout', 'preset'], value: event.target.value })}><option value="chat-only">{t('Chat only')}</option><option value="split-inspector">{t('Split inspector')}</option><option value="chat-with-metrics">{t('Chat with metrics')}</option><option value="compact">{t('Compact')}</option></select></Field>
      <Field label={t('Inspector position')}><select aria-label={t('Inspector position')} value={profile.ui?.layout?.inspectorPosition ?? 'right'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'layout', 'inspectorPosition'], value: event.target.value })}><option value="right">{t('Right')}</option><option value="bottom">{t('Bottom')}</option></select></Field>
      <Field label={t('Inspector width (px)')} hint={t('Used when the Inspector is positioned on the right.')}><PatchNumber aria-label={t('Inspector width in pixels')} value={profile.ui?.layout?.inspectorWidth} min={240} max={960} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'layout', 'inspectorWidth'], value })} /></Field>
      <Field label={t('Composer placeholder')} wide><PatchText aria-label={t('Composer placeholder')} value={profile.ui?.composer?.placeholder ?? ''} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'placeholder'], value })} /></Field>
      <Field label={t('Composer behavior')}><div className="stacked-checks"><Checkbox label={t('Multiline input')} checked={profile.ui?.composer?.multiline ?? true} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'multiline'], value })} /><Checkbox label={t('Show stop while streaming')} checked={profile.ui?.composer?.showStopWhileStreaming ?? true} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'showStopWhileStreaming'], value })} /></div></Field>
      <Field label={t('Enter key')}><select aria-label={t('Enter key behavior')} value={profile.ui?.composer?.enterBehavior ?? 'send'} disabled={profile.ui?.composer?.multiline === false} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'composer', 'enterBehavior'], value: event.target.value })}><option value="send">{t('Send')}</option><option value="newline">{t('New line')}</option></select></Field>
      <Field label={t('Shift+Enter key')}><select aria-label={t('Shift+Enter key behavior')} value={profile.ui?.composer?.shiftEnterBehavior ?? 'newline'} disabled={profile.ui?.composer?.multiline === false} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'composer', 'shiftEnterBehavior'], value: event.target.value })}><option value="send">{t('Send')}</option><option value="newline">{t('New line')}</option></select></Field>
    </div></section>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Assistant streaming')}</h3><p>{t('Control how large response events are revealed in Chat. Evidence and timing stay immediate.')}</p></div></div><div className="form-grid">
      <Field label={t('Content reveal')} hint={t('Adaptive smooths large events while keeping visual delay bounded.')}><select aria-label={t('Assistant content reveal')} value={streaming.reveal} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'reveal'], value: event.target.value })}><option value="adaptive">{t('Adaptive')}</option><option value="event">{t('Per event')}</option><option value="instant">{t('Instant')}</option></select></Field>
      <Field label={t('Reveal pace')}><select aria-label={t('Assistant content reveal pace')} value={streaming.pace} disabled={streaming.reveal !== 'adaptive'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'pace'], value: event.target.value })}><option value="calm">{t('Calm')}</option><option value="balanced">{t('Balanced')}</option><option value="fast">{t('Fast')}</option></select></Field>
      <Field label={t('Maximum visual lag (ms)')} hint={t('The Chat animation catches up within this limit.')}><PatchNumber aria-label={t('Assistant maximum visual lag')} value={streaming.maxVisualLagMs} min={100} max={2000} disabled={streaming.reveal !== 'adaptive'} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'maxVisualLagMs'], value })} /></Field>
      <Field label={t('Streaming indicator')}><select aria-label={t('Assistant streaming indicator')} value={streaming.indicator} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'indicator'], value: event.target.value })}><option value="caret">{t('Caret')}</option><option value="dots">{t('Dots')}</option><option value="shimmer">{t('Shimmer')}</option><option value="none">{t('None')}</option></select></Field>
      <Field label={t('Indicator speed (ms)')}><PatchNumber aria-label={t('Assistant streaming animation speed')} value={streaming.speedMs} min={400} max={4000} disabled={streaming.indicator === 'none'} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'speedMs'], value })} /></Field>
      <Field label={t('Indicator intensity (%)')}><PatchNumber aria-label={t('Assistant streaming intensity')} value={streaming.intensityPercent} min={10} max={100} disabled={streaming.indicator === 'none'} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'streaming', 'intensityPercent'], value })} /></Field>
    </div></section>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Components')}</h3><p>{t('Choose which response surfaces appear in Chat. Usage is hidden unless explicitly enabled.')}</p></div></div><div className="component-grid">{componentNames.map((name) => <Checkbox key={name} label={localizeHumanized(name)} checked={profile.ui?.components?.[name]?.visible ?? name !== 'usage'} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'components', name, 'visible'], value })} />)}</div></section>
    <MessageActionsEditor profile={profile} post={post} />
    <MessageTagsEditor profile={profile} post={post} />
    <section className="config-section"><div className="section-heading"><div><h3>{t('Active-turn locks')}</h3><p>{t('Comma-separated component or control IDs. Stop should normally remain allowed.')}</p></div></div><div className="form-grid">
      <Field label={t('Disable while active')} hint={t('Example: {ids}', { ids: 'composer, model, newConversation' })} wide><input aria-label={t('Components disabled while active')} value={disableText} onChange={(event) => setDisableText(event.target.value)} onBlur={() => post({ type: 'profile.patch', path: ['ui', 'locks', 'whileTurnActive', 'disable'], value: parseList(disableText) })} /></Field>
      <Field label={t('Allow while active')} hint={t('Example: {ids}', { ids: 'stop, message.copy, inspector.open' })} wide><input aria-label={t('Components allowed while active')} value={allowText} onChange={(event) => setAllowText(event.target.value)} onBlur={() => post({ type: 'profile.patch', path: ['ui', 'locks', 'whileTurnActive', 'allow'], value: parseList(allowText) })} /></Field>
    </div></section>
    <p className="muted">{t('All changes use WorkspaceEdit and participate in VS Code Undo/Redo.')}</p>
  </div>;
}

function MessageActionsEditor({ profile, post }: { profile: TurnStageProfile; post: Post }): React.JSX.Element {
  const configured = profile.ui?.messageActions ?? DEFAULT_MESSAGE_ACTIONS;
  const enabled = [...new Set(configured.filter((id): id is MessageActionId => DEFAULT_MESSAGE_ACTIONS.includes(id as MessageActionId)))];
  const patch = (value: MessageActionId[]) => post({ type: 'profile.patch', path: ['ui', 'messageActions'], value });
  const toggle = (id: MessageActionId, checked: boolean) => patch(checked ? [...enabled, id] : enabled.filter((item) => item !== id));
  const move = (id: MessageActionId, delta: -1 | 1) => {
    const index = enabled.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= enabled.length) return;
    const next = [...enabled];
    [next[index], next[target]] = [next[target]!, next[index]!];
    patch(next);
  };
  const ordered = [
    ...enabled.map((id) => messageActionOptions.find((option) => option.id === id)!),
    ...messageActionOptions.filter((option) => !enabled.includes(option.id)),
  ];
  const visibility = resolveMessageActionVisibility(profile.ui);
  return <section className="config-section"><div className="section-heading"><div><h3>{t('Message actions')}</h3><p>{t('Choose the message toolbar actions, display behavior, and order.')}</p></div></div>
    <div className="form-grid message-action-options"><Field label={t('Toolbar visibility')} hint={t('Always visible is the default; interaction mode reveals actions on hover or keyboard focus.')}><select aria-label={t('Message action toolbar visibility')} value={visibility} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'messageActionVisibility'], value: event.target.value })}><option value="always">{t('Always visible')}</option><option value="interaction">{t('On interaction')}</option></select></Field></div>
    <div className="message-action-list" role="group" aria-label={t('Message actions')}>
      {ordered.map(({ id, label }) => {
        const index = enabled.indexOf(id);
        const checked = index >= 0;
        return <div className="message-action-row" key={id}>
          <Checkbox label={t(label)} checked={checked} onChange={(value) => toggle(id, value)} />
          <div className="message-action-order">
            <IconButton type="button" icon="arrow-up" label={t('Move {id} up', { id: t(label) })} disabled={!checked || index === 0} onClick={() => move(id, -1)} />
            <IconButton type="button" icon="arrow-down" label={t('Move {id} down', { id: t(label) })} disabled={!checked || index === enabled.length - 1} onClick={() => move(id, 1)} />
          </div>
        </div>;
      })}
    </div>
  </section>;
}

function MessageTagsEditor({ profile, post }: { profile: TurnStageProfile; post: Post }): React.JSX.Element {
  const rules = profile.ui?.messageTags ?? [];
  const patch = (value: MessageTagRule[]) => post({ type: 'profile.patch', path: ['ui', 'messageTags'], value });
  const update = (index: number, values: Partial<MessageTagRule>) => patch(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...values } : rule));
  const add = () => {
    const used = new Set(rules.map((rule) => rule.id));
    let suffix = rules.length + 1;
    while (used.has(`tag-${suffix}`)) suffix += 1;
    patch([...rules, { id: `tag-${suffix}`, label: t('Event tag'), source: 'normalizedEvent', path: 'type', operator: 'equals', value: 'tool.started', tone: 'warning' }]);
  };
  return <section className="config-section"><div className="section-heading"><div><h3>{t('Message tags')}</h3><p>{t('Add deterministic labels from a message or its correlated events. Rules are bounded and do not use regular expressions.')}</p></div><button type="button" disabled={rules.length >= 20} onClick={add}>{t('Add tag rule')}</button></div>
    {rules.length ? <div className="message-tag-rule-list">{rules.map((rule, index) => <article className="message-tag-rule" key={`${rule.id}-${index}`}>
      <div className="message-tag-rule__identity"><input aria-label={t('Tag label')} value={rule.label} maxLength={48} onChange={(event) => update(index, { label: event.target.value })} /><IconButton type="button" icon="trash" label={t('Delete tag rule {label}', { label: rule.label })} onClick={() => patch(rules.filter((_item, ruleIndex) => ruleIndex !== index))} /></div>
      <div className="message-tag-rule__condition">
        <label><span>{t('Source')}</span><select aria-label={t('Tag source')} value={rule.source} onChange={(event) => update(index, { source: event.target.value as MessageTagRule['source'] })}><option value="message">{t('Message')}</option><option value="normalizedEvent">{t('Normalized event')}</option><option value="rawEvent">{t('Raw event')}</option></select></label>
        <label><span>{t('Path')}</span><input aria-label={t('Tag path')} value={rule.path} maxLength={256} placeholder="type" onChange={(event) => update(index, { path: event.target.value })} /></label>
        <label><span>{t('Operator')}</span><select aria-label={t('Tag operator')} value={rule.operator} onChange={(event) => update(index, { operator: event.target.value as MessageTagRule['operator'] })}><option value="exists">{t('Exists')}</option><option value="equals">{t('Equals')}</option><option value="contains">{t('Contains')}</option><option value="startsWith">{t('Starts with')}</option></select></label>
        <label><span>{t('Value')}</span><input aria-label={t('Tag value')} value={rule.value === undefined ? '' : String(rule.value)} disabled={rule.operator === 'exists'} maxLength={512} onChange={(event) => update(index, { value: parseLooseValue(event.target.value) as string | number | boolean })} /></label>
        <label><span>{t('Tone')}</span><select aria-label={t('Tag tone')} value={rule.tone ?? 'neutral'} onChange={(event) => update(index, { tone: event.target.value as NonNullable<MessageTagRule['tone']> })}><option value="neutral">{t('Neutral')}</option><option value="info">{t('Info')}</option><option value="success">{t('Success')}</option><option value="warning">{t('Warning')}</option><option value="error">{t('Error')}</option></select></label>
      </div>
    </article>)}</div> : <p className="muted">{t('No message tag rules configured.')}</p>}
  </section>;
}

export function mappingDraftFromRawEvent(event: RawStreamEvent, profile: TurnStageProfile): MappingRule {
  const eventName = event.sse?.event ?? (isRecord(event.data) && typeof event.data.type === 'string' ? event.data.type : undefined);
  const data = isRecord(event.data) ? event.data : {};
  const type = typeof data.type === 'string' && data.type.includes('.') ? data.type : inferEmitType(eventName, data);
  const emit: Record<string, unknown> & { type: string } = { type };
  const candidate = ['text', 'conversationId', 'assistantMessageId', 'title', 'citationId', 'toolCallId'].find((key) => key in data);
  if (candidate) emit[candidate] = { path: `$.${candidate}` };
  const base = eventName ? `draft-${eventName}` : `draft-event-${event.sequence}`;
  return { id: uniqueRuleId(profile, base.replace(/[^a-zA-Z0-9_-]/g, '-')), match: eventName ? { event: eventName } : { path: '$.type', operator: 'equals', value: data.type ?? '' }, emit };
}

function Field({ label, hint, error, wide, children }: { label: string; hint?: string; error?: string; wide?: boolean; children: React.ReactNode }): React.JSX.Element {
  const id = useId();
  const descriptionId = hint || error ? `${id}-description` : undefined;
  let linked = false;
  const describedChildren = React.Children.map(children, (child) => {
    if (!descriptionId || linked || !React.isValidElement(child)) return child;
    linked = true;
    const existing = (child.props as { 'aria-describedby'?: string })['aria-describedby'];
    return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, { 'aria-describedby': [existing, descriptionId].filter(Boolean).join(' ') });
  });
  return <fieldset className={`field ${wide ? 'field-wide' : ''}`} aria-describedby={descriptionId}><legend>{label}</legend><div>{describedChildren}</div>{descriptionId && <p id={descriptionId} className={error ? 'field-error' : 'field-hint'}>{error || hint}</p>}</fieldset>;
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.JSX.Element { return <label className="checkbox-control"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>; }
function PatchText({ value, onCommit, multiline = false, ...props }: { value: string; onCommit: (value: string) => void; multiline?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur'>): React.JSX.Element {
  const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const keyboard = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); } else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); } };
  return multiline ? <textarea {...props} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyboard} /> : <input {...props} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyboard} />;
}

function PatchNumber({ value, onCommit, min, max, ...props }: { value?: number; onCommit: (value: number | undefined) => void; min: number; max: number } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'type' | 'min' | 'max' | 'onChange' | 'onBlur'>): React.JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (!draft.trim()) { onCommit(undefined); return; }
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, Math.round(parsed))));
  };
  return <input {...props} type="number" min={min} max={max} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(value === undefined ? '' : String(value)); event.currentTarget.blur(); } else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

function JsonPatchEditor({ ariaLabel, value, onCommit, disabled = false }: { ariaLabel: string; value: unknown; onCommit: (value: unknown) => void; disabled?: boolean }): React.JSX.Element {
  const source = JSON.stringify(value, null, 2) ?? '{}';
  const [draft, setDraft] = useState(source);
  const [error, setError] = useState('');
  const errorId = useId();
  useEffect(() => { setDraft(source); setError(''); }, [source]);
  const commit = () => {
    if (disabled || draft === source) return;
    try {
      const parsed = JSON.parse(draft) as unknown;
      setError('');
      onCommit(parsed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('Enter valid JSON.'));
    }
  };
  return <div className="json-patch-editor">
    <textarea className="code-input" rows={7} aria-label={ariaLabel} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} value={draft} disabled={disabled} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
      if (event.key === 'Escape') { setDraft(source); setError(''); event.currentTarget.blur(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); event.currentTarget.blur(); }
    }} />
    <button className="apply-inline" type="button" disabled={disabled || draft === source} onClick={commit}>{t('Apply JSON')}</button>
    {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
  </div>;
}
function JsonPreview({ value }: { value: unknown }): React.JSX.Element { const text = JSON.stringify(value, null, 2) ?? ''; return <pre className="json sample-json"><code><JsonSyntax text={text} /></code><ClipboardButton text={text} label={t('Copy normalized JSON')} /></pre>; }
function parseList(value: string): string[] { return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]; }
function formatValue(value: unknown): string { if (value === undefined) return ''; return typeof value === 'string' ? value : JSON.stringify(value); }
function parseLooseValue(value: string): unknown { if (!value.trim()) return undefined; try { return JSON.parse(value); } catch { return value; } }
function uniqueRuleId(profile: TurnStageProfile, base: string): string { return uniqueId(profile.stream.mappings.map((rule) => rule.id), base); }
function uniqueId(ids: string[], base: string): string { const used = new Set(ids); let id = base; let suffix = 2; while (used.has(id)) id = `${base}-${suffix++}`; return id; }
function clampInteger(value: string, min: number, max: number, fallback: number): number { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function inferEmitType(event: string | undefined, data: Record<string, unknown>): string { if (event === 'done') return 'stream.completed'; if (event === 'error') return 'stream.failed'; if (event === 'start') return 'conversation.started'; if ('text' in data) return 'content.text.delta'; return 'diagnostic.updated'; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
