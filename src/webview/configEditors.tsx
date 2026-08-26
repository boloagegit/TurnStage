import React, { useEffect, useId, useState } from 'react';
import type { MappingTestInput, MappingTestResult, WebviewPayload } from '../shared/protocol';
import type { MappingRule, RawStreamEvent, RequestVariant, TurnStageProfile } from '../shared/types';
import { formatNumber, localizeHumanized, t } from './i18n';
import { IconButton } from './Icon';

type Post = (message: WebviewPayload) => void;

const methods = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] as const;
const operators = ['equals', 'notEquals', 'exists', 'notExists', 'oneOf', 'contains', 'startsWith', 'endsWith', 'regex'] as const;
const componentNames = ['opening', 'starters', 'progress', 'toolCalls', 'citations', 'followups', 'responseActions', 'forms', 'diagnostics', 'metrics'] as const;
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
      <div className="section-heading"><div><h3 id="opening-heading">{t('Opening')}</h3><p>{t('Static content never makes a network request. Request mode waits for an explicit Start Session action.')}</p></div><span className="section-index" aria-hidden="true">01</span></div>
      <div className="form-grid">
        <Field label={t('Opening mode')} hint={t('The same mode is used when New Conversation resets the session.')}>
          <select aria-label={t('Opening mode')} value={openingMode} onChange={(event) => patch(['opening', 'mode'], event.target.value)}>
            <option value="static">{t('Static message')}</option><option value="request">{t('Opening request')}</option><option value="disabled">{t('Disabled')}</option>
          </select>
        </Field>
        <Field label={t('Opening message')} hint={t(openingMode === 'static' ? 'Shown before the first turn.' : 'Used by static opening and configured fallbacks.')} wide>
          <PatchText aria-label={t('Opening message')} value={profile.opening?.message ?? ''} multiline rows={3} disabled={openingMode !== 'static'} onCommit={(value) => patch(['opening', 'message'], value)} />
        </Field>
      </div>
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('then')}</span></div>

    <section className="config-section" aria-labelledby="request-heading">
      <div className="section-heading"><div><h3 id="request-heading">{t('Conversation request')}</h3><p>{t('The base endpoint is shared by first-turn and continuation variants.')}</p></div><span className="section-index" aria-hidden="true">02</span></div>
      <div className="form-grid">
        <Field label={t('HTTP method')}><select aria-label={t('Conversation request method')} value={profile.conversation.send.method} onChange={(event) => patch(['conversation', 'send', 'method'], event.target.value)}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
        <Field label={t('Request URL')} hint={t('Template values such as ${env.baseUrl} are resolved in the Extension Host.')} wide error={!profile.conversation.send.url.trim() ? t('A request URL is required.') : undefined}><PatchText aria-label={t('Conversation request URL')} value={profile.conversation.send.url} required spellCheck={false} onCommit={(value) => patch(['conversation', 'send', 'url'], value)} /></Field>
      </div>
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('choose a variant')}</span></div>

    <section className="config-section variant-section" aria-labelledby="variants-heading">
      <div className="section-heading"><div><h3 id="variants-heading">{t('First Turn & Continuation')}</h3><p>{t('Variants are selected in declaration order using structured conditions. Bodies accept JSON and template references such as')} <code>{'{$value: "input.text"}'}</code>.</p></div><span className="section-index" aria-hidden="true">03</span></div>
      <div className="variant-toolbar"><span>{variants.length === 1 ? t('{count} configured variant', { count: formatNumber(variants.length) }) : t('{count} configured variants', { count: formatNumber(variants.length) })}</span><div className="actions"><button onClick={() => addVariant('first-turn')}>{t('Add First Turn')}</button><button onClick={() => addVariant('continuation')}>{t('Add Continuation')}</button></div></div>
      {variants.length ? <div className="variant-list">{variants.map((variant, index) => <VariantCard key={`${variant.id}-${index}`} index={index} variant={variant} post={post} onDelete={removeVariant} />)}</div> : <div className="empty-state"><strong>{t('No request variants')}</strong><p>{t('Add a First Turn or Continuation variant before sending a request.')}</p><div className="actions"><button className="primary" onClick={() => addVariant('first-turn')}>{t('Add First Turn')}</button><button onClick={() => addVariant('continuation')}>{t('Add Continuation')}</button></div></div>}
    </section>

    <div className="flow-connector" aria-hidden="true"><span>{t('while streaming')}</span></div>

    <section className="config-section" aria-labelledby="stop-heading">
      <div className="section-heading"><div><h3 id="stop-heading">{t('Stop')}</h3><p>{t('Stop always aborts locally. An optional request can notify the remote service when context is available.')}</p></div><span className="section-index" aria-hidden="true">04</span></div>
      <div className="form-grid">
        <Field label={t('Stop mode')}><select aria-label={t('Stop mode')} value={stop?.strategy ?? 'abortOnly'} onChange={(event) => {
          const strategy = event.target.value;
          patch(['conversation', 'stop', 'strategy'], strategy);
          if (strategy === 'abortThenRequest' && !stopRequest) patch(['conversation', 'stop', 'request'], { method: 'POST', url: '', body: {} });
        }}><option value="abortOnly">{t('Local abort only')}</option><option value="abortThenRequest">{t('Abort then request')}</option></select></Field>
        <Field label={t('Stop request method')} hint={t('Required when Stop mode is Abort then request.')}><select aria-label={t('Stop request method')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.method ?? 'POST'} onChange={(event) => patch(['conversation', 'stop', 'request', 'method'], event.target.value)}>{methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
        <Field label={t('Stop request URL')} hint={t('Secrets and template values are resolved only in the Extension Host.')} wide error={stop?.strategy === 'abortThenRequest' && !stopRequest?.url?.trim() ? t('A stop request URL is required for this mode.') : undefined}><PatchText aria-label={t('Stop request URL')} disabled={stop?.strategy !== 'abortThenRequest'} value={stopRequest?.url ?? ''} spellCheck={false} onCommit={(value) => patch(['conversation', 'stop', 'request', 'url'], value)} /></Field>
        <Field label={t('Stop context')} hint={t('Comma-separated paths required before sending a remote stop request.')} wide><PatchText aria-label={t('Required stop context')} value={(stop?.requiredContext ?? []).join(', ')} disabled={stop?.strategy !== 'abortThenRequest'} onCommit={(value) => patch(['conversation', 'stop', 'requiredContext'], parseList(value))} /></Field>
        <Field label={t('Partial response')}><div className="stacked-checks"><Checkbox label={t('Preserve partial content')} checked={stop?.preservePartialContent ?? true} onChange={(value) => patch(['conversation', 'stop', 'preservePartialContent'], value)} /><Checkbox label={t('Append a system notice')} checked={stop?.appendSystemNotice ?? true} onChange={(value) => patch(['conversation', 'stop', 'appendSystemNotice'], value)} /></div></Field>
      </div>
    </section>

    <section className="config-section" aria-labelledby="error-policy-heading">
      <div className="section-heading"><div><h3 id="error-policy-heading">{t('Error policy')}</h3><p>{t('Choose whether an unexpected end is a failure and how partial/error content remains visible.')}</p></div><span className="section-index" aria-hidden="true">05</span></div>
      <div className="form-grid">
        <Field label={t('Unexpected stream end')}><select aria-label={t('Unexpected stream end policy')} value={profile.stream.unexpectedEndPolicy ?? 'fail'} onChange={(event) => patch(['stream', 'unexpectedEndPolicy'], event.target.value)}><option value="fail">{t('Fail the turn')}</option><option value="completeWithWarning">{t('Complete with warning')}</option></select></Field>
        <Field label={t('Error handling')}><div className="stacked-checks"><Checkbox label={t('Preserve partial content')} checked={errorPolicy?.preservePartialContent ?? true} onChange={(value) => patch(['errorPolicy', 'preservePartialContent'], value)} /><Checkbox label={t('Show an error part')} checked={errorPolicy?.showErrorPart ?? true} onChange={(value) => patch(['errorPolicy', 'showErrorPart'], value)} /><Checkbox label={t('Keep conversation ID')} checked={errorPolicy?.keepConversationId ?? true} onChange={(value) => patch(['errorPolicy', 'keepConversationId'], value)} /><Checkbox label={t('Allow continuation after error')} checked={errorPolicy?.allowContinuation ?? true} onChange={(value) => patch(['errorPolicy', 'allowContinuation'], value)} /><Checkbox label={t('Release all locks')} checked={errorPolicy?.releaseAllLocks ?? true} onChange={(value) => patch(['errorPolicy', 'releaseAllLocks'], value)} /></div></Field>
      </div>
    </section>

    <section className="config-section" aria-labelledby="new-conversation-heading">
      <div className="section-heading"><div><h3 id="new-conversation-heading">{t('New Conversation')}</h3><p>{t('Reset clears messages, IDs, turn metrics, and interaction context, preserves configured controls, then runs this opening behavior.')}</p></div><span className="section-index" aria-hidden="true">06</span></div>
      <div className="form-grid">
        <Field label={t('Opening behavior after reset')} hint={t("This maps to the profile's opening.mode so the text editor and Visual Editor stay in sync.")}><select aria-label={t('New Conversation opening behavior')} value={openingMode} onChange={(event) => patch(['opening', 'mode'], event.target.value)}><option value="static">{t('Show static opening')}</option><option value="request">{t('Run opening request')}</option><option value="disabled">{t('No opening')}</option></select></Field>
        <div className="flow-note"><strong>{t('Preserved controls')}</strong><p>{t('Actor, model, and environment values remain selected; New Conversation is unavailable while a turn is active.')}</p></div>
      </div>
    </section>

    <section className="config-section" aria-labelledby="history-heading">
      <div className="section-heading"><div><h3 id="history-heading">{t('History')}</h3><p>{t('Local runs are stored by the Extension Host and can be replayed without sending another network request.')}</p></div><span className="section-index" aria-hidden="true">07</span></div>
      <div className="form-grid">
        <Field label={t('Local runs')}><div className="stacked-checks"><Checkbox label={t('Enable local run history')} checked={localRuns?.enabled ?? true} onChange={(value) => patch(['history', 'localRuns', 'enabled'], value)} /><Checkbox label={t('Record raw events')} checked={localRuns?.recordRawEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordRawEvents'], value)} /><Checkbox label={t('Record normalized events')} checked={localRuns?.recordNormalizedEvents ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordNormalizedEvents'], value)} /><Checkbox label={t('Record chat snapshot')} checked={localRuns?.recordChatSnapshot ?? true} onChange={(value) => patch(['history', 'localRuns', 'recordChatSnapshot'], value)} /></div></Field>
        <Field label={t('Maximum local runs')} hint={t('Older runs are evicted after this count.')}><input aria-label={t('Maximum local runs')} type="number" min={1} max={100} value={localRuns?.maxRuns ?? 20} onChange={(event) => patch(['history', 'localRuns', 'maxRuns'], clampInteger(event.target.value, 1, 100, 20))} /></Field>
      </div>
    </section>

    <p className="muted">{t('All changes use WorkspaceEdit and participate in VS Code Undo/Redo. Comments and surrounding JSONC formatting are preserved where the parser can make a local edit.')}</p>
  </div>;
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
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= profile.stream.mappings.length) return;
    const next = [...profile.stream.mappings]; [next[index], next[target]] = [next[target]!, next[index]!];
    post({ type: 'profile.patch', path: ['stream', 'mappings'], value: next });
  };
  const remove = (index: number) => post({ type: 'profile.patch', path: ['stream', 'mappings'], value: profile.stream.mappings.filter((_, itemIndex) => itemIndex !== index) });
  return <div className="content-page config-page mapping-page">
    <header className="page-heading"><div><h2>{t('Stream mappings')}</h2><p>{t('Match raw stream events and emit normalized TurnStage events. Rules run from top to bottom.')}</p></div><button className="primary" onClick={add}>{t('Add mapping')}</button></header>
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
    <div className="section-heading"><div><h3 id="sample-event-heading">{t('Sample Event tester')}</h3><p>{t('Paste one SSE block or raw JSON event and preview the same MappingEngine output used by the runtime. JavaScript is never executed.')}</p></div><span className="section-index" aria-hidden="true">{t('TRY')}</span></div>
    <div className="form-grid">
      <Field label={t('Event format')}><select aria-label={t('Sample event format')} value={protocol} onChange={(event) => setProtocol(event.target.value as MappingTestInput['protocol'])}>{sampleProtocols.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
      <Field label={t('SSE event name')} hint={t('Optional for raw JSON; the event: line wins for SSE input.')}><input aria-label={t('Sample SSE event name')} value={eventName} onChange={(event) => setEventName(event.target.value)} /></Field>
      <Field label={t('Paste event')} wide error={error}><textarea aria-label={t('Sample event payload')} className="code-input" rows={6} value={sample} spellCheck={false} aria-invalid={Boolean(error)} onChange={(event) => setSample(event.target.value)} /></Field>
    </div>
    <div className="actions sample-actions"><button className="primary" onClick={test}>{t('Test Mapping')}</button><button onClick={() => { setSample(''); setError(''); }}>{t('Clear')}</button></div>
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
  const applyEmit = () => { try { const parsed = JSON.parse(emitText) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== 'string') throw new Error(t('Emit must be an object with a string “{key}”.', { key: 'type' })); setEmitError(''); patch(['emit'], parsed); } catch (error) { setEmitError(error instanceof Error ? error.message : t('Enter valid JSON.')); } };
  return <article className="mapping-card">
    <header><div className="mapping-title"><span className="rule-number">{formatNumber(index + 1)}</span><div><strong>{rule.id}</strong><span>{rule.match.event ?? rule.match.path ?? t('Any event')} → {String(rule.emit.type)}</span></div></div><div className="rule-actions"><button aria-label={t('Move {id} up', { id: rule.id })} title={t('Move up')} disabled={index === 0} onClick={() => onMove(index, -1)}>↑</button><button aria-label={t('Move {id} down', { id: rule.id })} title={t('Move down')} disabled={index === count - 1} onClick={() => onMove(index, 1)}>↓</button><button className="danger-subtle" onClick={() => onDelete(index)}>{t('Delete')}</button></div></header>
    <div className="form-grid mapping-fields">
      <Field label={t('Rule ID')} error={!rule.id.trim() ? t('A rule ID is required.') : undefined}><PatchText aria-label={t('Rule ID')} value={rule.id} required onCommit={(value) => patch(['id'], value)} /></Field>
      <Field label={t('SSE event')} hint={t('Optional event name, such as {message} or {done}.', { message: 'message', done: 'done' })}><PatchText aria-label={t('SSE event name')} value={rule.match.event ?? ''} onCommit={(value) => patch(['match', 'event'], value || undefined)} /></Field>
      <Field label={t('Data path')} hint={t('Optional JSONPath evaluated against event data.')}><PatchText aria-label={t('Mapping data path')} value={rule.match.path ?? ''} placeholder="$.type" spellCheck={false} onCommit={(value) => patch(['match', 'path'], value || undefined)} /></Field>
      <Field label={t('Operator')}><select aria-label={t('Mapping operator')} value={rule.match.operator ?? 'equals'} onChange={(event) => patch(['match', 'operator'], event.target.value)}>{operators.map((operator) => <option key={operator} value={operator}>{localizeHumanized(operator)}</option>)}</select></Field>
      <Field label={t('Match value')} hint={t('JSON values are preserved; unquoted text is saved as a string.')}><input aria-label={t('Mapping match value')} value={matchValue} onChange={(event) => setMatchValue(event.target.value)} onBlur={() => patch(['match', 'value'], parseLooseValue(matchValue))} /></Field>
      <Field label={t('Continue matching')}><label className="checkbox-control"><input type="checkbox" checked={Boolean(rule.continue)} onChange={(event) => patch(['continue'], event.target.checked)} /><span>{t('Run later rules after this match')}</span></label></Field>
      <Field label={t('Emit object (JSON)')} hint={t('Must include a string {key}. Paths extract values from the raw event.', { key: 'type' })} wide error={emitError}><textarea aria-label={t('Mapping emit JSON')} className="code-input" rows={7} value={emitText} spellCheck={false} aria-invalid={Boolean(emitError)} onChange={(event) => setEmitText(event.target.value)} onBlur={applyEmit} /><button className="apply-inline" onClick={applyEmit}>{t('Apply emit JSON')}</button></Field>
    </div>
  </article>;
}

export function UiConfigEditor({ profile, post }: { profile: TurnStageProfile; post: Post }): React.JSX.Element {
  const [disableText, setDisableText] = useState((profile.ui?.locks?.whileTurnActive?.disable ?? []).join(', '));
  const [allowText, setAllowText] = useState((profile.ui?.locks?.whileTurnActive?.allow ?? []).join(', '));
  useEffect(() => setDisableText((profile.ui?.locks?.whileTurnActive?.disable ?? []).join(', ')), [profile.ui?.locks?.whileTurnActive?.disable]);
  useEffect(() => setAllowText((profile.ui?.locks?.whileTurnActive?.allow ?? []).join(', ')), [profile.ui?.locks?.whileTurnActive?.allow]);
  return <div className="content-page config-page">
    <header className="page-heading"><div><h2>{t('UI configuration')}</h2><p>{t('Shape the chat layout, composer behavior, visibility, and active-turn locks.')}</p></div></header>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Layout & composer')}</h3><p>{t('Changes are reflected in the Chat view immediately.')}</p></div></div><div className="form-grid">
      <Field label={t('Layout preset')}><select aria-label={t('Layout preset')} value={profile.ui?.layout?.preset ?? 'split-inspector'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'layout', 'preset'], value: event.target.value })}><option value="chat-only">{t('Chat only')}</option><option value="split-inspector">{t('Split inspector')}</option><option value="chat-with-metrics">{t('Chat with metrics')}</option><option value="compact">{t('Compact')}</option></select></Field>
      <Field label={t('Inspector position')}><select aria-label={t('Inspector position')} value={profile.ui?.layout?.inspectorPosition ?? 'right'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'layout', 'inspectorPosition'], value: event.target.value })}><option value="right">{t('Right')}</option><option value="bottom">{t('Bottom')}</option></select></Field>
      <Field label={t('Composer placeholder')} wide><PatchText aria-label={t('Composer placeholder')} value={profile.ui?.composer?.placeholder ?? ''} onCommit={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'placeholder'], value })} /></Field>
      <Field label={t('Composer behavior')}><div className="stacked-checks"><Checkbox label={t('Multiline input')} checked={profile.ui?.composer?.multiline ?? true} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'multiline'], value })} /><Checkbox label={t('Show Stop while streaming')} checked={profile.ui?.composer?.showStopWhileStreaming ?? true} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'composer', 'showStopWhileStreaming'], value })} /></div></Field>
      <Field label={t('Enter key')}><select aria-label={t('Enter key behavior')} value={profile.ui?.composer?.enterBehavior ?? 'send'} onChange={(event) => post({ type: 'profile.patch', path: ['ui', 'composer', 'enterBehavior'], value: event.target.value })}><option value="send">{t('Send')}</option><option value="newline">{t('New line')}</option></select></Field>
    </div></section>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Components')}</h3><p>{t('Choose which response surfaces appear in Chat. The runtime treats an omitted visibility flag as visible.')}</p></div></div><div className="component-grid">{componentNames.map((name) => <Checkbox key={name} label={localizeHumanized(name)} checked={profile.ui?.components?.[name]?.visible ?? true} onChange={(value) => post({ type: 'profile.patch', path: ['ui', 'components', name, 'visible'], value })} />)}</div></section>
    <section className="config-section"><div className="section-heading"><div><h3>{t('Active-turn locks')}</h3><p>{t('Comma-separated component or control IDs. Stop should normally remain allowed.')}</p></div></div><div className="form-grid">
      <Field label={t('Disable while active')} hint={t('Example: {ids}', { ids: 'composer, model, newConversation' })} wide><input aria-label={t('Components disabled while active')} value={disableText} onChange={(event) => setDisableText(event.target.value)} onBlur={() => post({ type: 'profile.patch', path: ['ui', 'locks', 'whileTurnActive', 'disable'], value: parseList(disableText) })} /></Field>
      <Field label={t('Allow while active')} hint={t('Example: {ids}', { ids: 'stop, message.copy, inspector.open' })} wide><input aria-label={t('Components allowed while active')} value={allowText} onChange={(event) => setAllowText(event.target.value)} onBlur={() => post({ type: 'profile.patch', path: ['ui', 'locks', 'whileTurnActive', 'allow'], value: parseList(allowText) })} /></Field>
    </div></section>
    <p className="muted">{t('All changes use WorkspaceEdit and participate in VS Code Undo/Redo.')}</p>
  </div>;
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
  return <fieldset className={`field ${wide ? 'field-wide' : ''}`} aria-describedby={hint || error ? `${id}-description` : undefined}><legend>{label}</legend><div>{children}</div>{(error || hint) && <p id={`${id}-description`} className={error ? 'field-error' : 'field-hint'}>{error || hint}</p>}</fieldset>;
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): React.JSX.Element { return <label className="checkbox-control"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>; }
function PatchText({ value, onCommit, multiline = false, ...props }: { value: string; onCommit: (value: string) => void; multiline?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur'>): React.JSX.Element {
  const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const keyboard = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); } else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); } };
  return multiline ? <textarea {...props} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyboard} /> : <input {...props} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyboard} />;
}
function JsonPreview({ value }: { value: unknown }): React.JSX.Element { const text = JSON.stringify(value, null, 2); return <pre className="json sample-json"><code>{text}</code><IconButton icon="copy" label={t('Copy normalized JSON')} onClick={() => navigator.clipboard.writeText(text)} /></pre>; }
function parseList(value: string): string[] { return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]; }
function formatValue(value: unknown): string { if (value === undefined) return ''; return typeof value === 'string' ? value : JSON.stringify(value); }
function parseLooseValue(value: string): unknown { if (!value.trim()) return undefined; try { return JSON.parse(value); } catch { return value; } }
function uniqueRuleId(profile: TurnStageProfile, base: string): string { return uniqueId(profile.stream.mappings.map((rule) => rule.id), base); }
function uniqueId(ids: string[], base: string): string { const used = new Set(ids); let id = base; let suffix = 2; while (used.has(id)) id = `${base}-${suffix++}`; return id; }
function clampInteger(value: string, min: number, max: number, fallback: number): number { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function inferEmitType(event: string | undefined, data: Record<string, unknown>): string { if (event === 'done') return 'stream.completed'; if (event === 'error') return 'stream.failed'; if (event === 'start') return 'conversation.started'; if ('text' in data) return 'content.text.delta'; return 'diagnostic.updated'; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
