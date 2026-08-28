import { findNodeAtLocation, type Node } from 'jsonc-parser';
import type { MatchCondition, RequestDefinition, TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { localize } from '../l10n';

export interface ValidationIssue { severity: 'error' | 'warning'; message: string; offset: number; length: number }

const requiredEmitFields: Record<string, string[]> = {
  'conversation.started': ['conversationId'], 'content.text.delta': ['text'], 'content.markdown.delta': ['text'],
  'tool.started': ['toolCallId', 'name'], 'tool.completed': ['toolCallId'], 'citation.upsert': ['citation'],
  'content.citation': ['citationId'], 'followup.upsert': ['followup'], 'action.upsert': ['action'], 'form.upsert': ['form'],
  'message.metric.updated': ['metric']
};

function issue(tree: Node | undefined, path: (string | number)[], message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  return { severity, message, offset: node?.offset ?? 0, length: node?.length ?? 1 };
}

function duplicates(values: string[]): string[] { return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]; }

function validatesRegex(condition: MatchCondition): string | undefined {
  if (condition.operator !== 'regex') return;
  if (typeof condition.value !== 'string') return localize('Regex match value must be a string.');
  if (condition.value.length > 256) return localize('Regex patterns are limited to 256 characters.');
  if (/\([^)]*[+*][^)]*\)[+*]/.test(condition.value)) return localize('Potentially unsafe nested quantifier.');
  try { new RegExp(condition.value); } catch { return localize('Invalid regular expression.'); }
}

function requestTemplatePaths(request: Partial<RequestDefinition> | undefined): string[] {
  const paths: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { for (const match of value.matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)) if (match[1]) paths.push(match[1]); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.$value === 'string') paths.push(object.$value);
    Object.values(object).forEach(visit);
  };
  visit(request);
  return paths;
}

export class ProfileValidator {
  validate(profile: TurnStageProfile | undefined, tree?: Node, environments: TurnStageEnvironment[] = []): ValidationIssue[] {
    if (!profile) return [issue(tree, [], localize('Profile could not be parsed.'))];
    const out: ValidationIssue[] = [];
    const sourceProfile = profile as unknown as Record<string, unknown>;
    const conversation = sourceProfile.conversation;
    const stream = sourceProfile.stream;
    if (typeof profile.id !== 'string') out.push(issue(tree, ['id'], localize('Profile id must be a string.')));
    if (typeof profile.name !== 'string') out.push(issue(tree, ['name'], localize('Profile name must be a string.')));
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation) || !(conversation as Record<string, unknown>).send || typeof (conversation as Record<string, unknown>).send !== 'object') out.push(issue(tree, ['conversation'], localize('Conversation send request is required.')));
    if (!stream || typeof stream !== 'object' || Array.isArray(stream) || !Array.isArray((stream as Record<string, unknown>).mappings)) out.push(issue(tree, ['stream'], localize('Stream mappings must be an array.')));
    if (sourceProfile.controls !== undefined && !Array.isArray(sourceProfile.controls)) out.push(issue(tree, ['controls'], localize('Controls must be an array.')));
    if (out.length) return out;
    if (profile.version !== 1) out.push(issue(tree, ['version'], localize('Unsupported config version: {version}.', { version: String(profile.version) })));
    if (!profile.id?.trim()) out.push(issue(tree, ['id'], localize('Profile id is required.')));
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) out.push(issue(tree, ['id'], localize('Profile id must use lowercase letters, numbers, and hyphens.')));
    if (!profile.name?.trim()) out.push(issue(tree, ['name'], localize('Profile name is required.')));
    if (!profile.conversation?.send) out.push(issue(tree, ['conversation'], localize('Conversation send request is required.')));
    if (!profile.conversation?.send?.variants?.length) out.push(issue(tree, ['conversation', 'send'], localize('At least one request variant is required.')));
    if (!profile.stream?.mappings?.length) out.push(issue(tree, ['stream'], localize('At least one stream mapping is required.')));
    if (!['sse', 'ndjson', 'json', 'text-stream', 'fixture'].includes(profile.stream.transport)) out.push(issue(tree, ['stream', 'transport'], localize('Unsupported stream transport: {transport}.', { transport: String(profile.stream.transport) })));
    for (const [path, request] of [['conversation.send', profile.conversation.send], ['opening.request', profile.opening?.request], ['conversation.stop.request', profile.conversation.stop?.request]] as const) {
      if (!request) continue;
      if (!['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) out.push(issue(tree, path.split('.'), localize('Unsupported HTTP method: {method}.', { method: String(request.method) })));
      if (typeof request.url !== 'string' || !request.url.trim()) out.push(issue(tree, path.split('.'), localize('Request URL is required.')));
      for (const [key, value] of [['timeoutMs', request.timeoutMs], ['idleTimeoutMs', request.idleTimeoutMs]] as const) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 900_000)) out.push(issue(tree, [...path.split('.'), key], localize('{field} must be an integer from 1 to 900000.', { field: key })));
      const reconnect = request.reconnect;
      if (reconnect?.maxAttempts !== undefined && (!Number.isInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0 || reconnect.maxAttempts > 5)) out.push(issue(tree, [...path.split('.'), 'reconnect', 'maxAttempts'], localize('Reconnect attempts must be an integer from 0 to 5.')));
      if (reconnect?.baseDelayMs !== undefined && (!Number.isInteger(reconnect.baseDelayMs) || reconnect.baseDelayMs < 0 || reconnect.baseDelayMs > 30_000)) out.push(issue(tree, [...path.split('.'), 'reconnect', 'baseDelayMs'], localize('Reconnect base delay must be an integer from 0 to 30000.')));
      if (reconnect?.maxDelayMs !== undefined && (!Number.isInteger(reconnect.maxDelayMs) || reconnect.maxDelayMs < 0 || reconnect.maxDelayMs > 120_000)) out.push(issue(tree, [...path.split('.'), 'reconnect', 'maxDelayMs'], localize('Reconnect maximum delay must be an integer from 0 to 120000.')));
      if (request.redirectPolicy !== undefined && !['same-origin', 'follow', 'error'].includes(request.redirectPolicy)) out.push(issue(tree, [...path.split('.'), 'redirectPolicy'], localize('Unsupported redirect policy: {policy}.', { policy: String(request.redirectPolicy) })));
      if (request.maxRedirects !== undefined && (!Number.isInteger(request.maxRedirects) || request.maxRedirects < 0 || request.maxRedirects > 10)) out.push(issue(tree, [...path.split('.'), 'maxRedirects'], localize('Maximum redirects must be an integer from 0 to 10.')));
    }
    const maxRuns = profile.history?.localRuns?.maxRuns;
    if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100)) out.push(issue(tree, ['history', 'localRuns', 'maxRuns'], localize('Local run retention must be an integer from 1 to 100.')));
    if (profile.environment && environments.length && !environments.some((env) => env.id === profile.environment)) out.push(issue(tree, ['environment'], localize('Environment "{environment}" was not found.', { environment: profile.environment })));
    for (const duplicate of duplicates((profile.controls ?? []).map((control) => control.id))) out.push(issue(tree, ['controls'], localize('Duplicate control id: {id}.', { id: duplicate })));
    for (const duplicate of duplicates((profile.stream?.mappings ?? []).map((mapping) => mapping.id))) out.push(issue(tree, ['stream', 'mappings'], localize('Duplicate mapping id: {id}.', { id: duplicate })));
    profile.stream?.mappings?.forEach((rule, index) => {
      const required = requiredEmitFields[rule.emit.type] ?? [];
      for (const field of required) if (!(field in rule.emit)) out.push(issue(tree, ['stream', 'mappings', index, 'emit'], localize('{type} requires emit.{field}.', { type: rule.emit.type, field })));
      const regexError = validatesRegex(rule.match); if (regexError) out.push(issue(tree, ['stream', 'mappings', index, 'match'], localize('{id}: {error}', { id: rule.id, error: regexError })));
      if (profile.stream.mappingMode === 'firstMatch' && index > 0) {
        const prior = profile.stream.mappings[index - 1];
        if (prior && Object.keys(prior.match).length === 0 && !prior.continue) out.push(issue(tree, ['stream', 'mappings', index], localize('Mapping "{id}" is unreachable after an unconditional first-match rule.', { id: rule.id }), 'warning'));
      }
    });
    profile.conversation?.send?.variants?.forEach((variant, index) => {
      if (!variant.when) return;
      const regexError = validatesRegex(variant.when);
      if (regexError) out.push(issue(tree, ['conversation', 'send', 'variants', index, 'when'], localize('{id}: {error}', { id: variant.id, error: regexError })));
    });
    const selectedEnvironment = environments.find((environment) => environment.id === profile.environment);
    const knownRoots = new Set(['input', 'conversation', 'opening', 'controls', 'env', 'profile', 'workspace', 'runtime', 'turn', 'secret']);
    const controlIds = new Set((profile.controls ?? []).map((control) => control.id));
    const templatePaths = [
      ...requestTemplatePaths(profile.opening?.request),
      ...requestTemplatePaths(profile.conversation?.send),
      ...requestTemplatePaths(profile.conversation?.stop?.request),
    ];
    for (const path of new Set(templatePaths)) {
      const [root, name] = path.split('.');
      if (!root || !knownRoots.has(root)) out.push(issue(tree, [], localize('Template path "{path}" uses an unknown context root.', { path })));
      else if (root === 'controls' && name && !controlIds.has(name)) out.push(issue(tree, ['controls'], localize('Template path "{path}" references an unknown control.', { path })));
      else if (root === 'env' && name && selectedEnvironment && !(name in selectedEnvironment.variables)) out.push(issue(tree, ['environment'], localize('Template path "{path}" references an unknown environment variable.', { path })));
    }
    const stop = profile.conversation.stop;
    if (stop?.strategy === 'abortThenRequest' && !stop.request) out.push(issue(tree, ['conversation', 'stop'], localize('abortThenRequest requires a stop request.')));
    for (const scheme of profile.security?.allowedUriSchemes ?? []) if (!['https', 'http', 'file'].includes(scheme)) out.push(issue(tree, ['security', 'allowedUriSchemes'], localize('URI scheme "{scheme}" is not supported.', { scheme })));
    const layoutPreset = profile.ui?.layout?.preset as unknown;
    if (layoutPreset !== undefined && !['chat-only', 'split-inspector', 'chat-with-metrics', 'compact'].includes(String(layoutPreset))) out.push(issue(tree, ['ui', 'layout', 'preset'], localize('Unknown UI layout preset: {value}.', { value: String(layoutPreset) })));
    const inspectorPosition = profile.ui?.layout?.inspectorPosition as unknown;
    if (inspectorPosition !== undefined && !['right', 'bottom'].includes(String(inspectorPosition))) out.push(issue(tree, ['ui', 'layout', 'inspectorPosition'], localize('Unknown Inspector position: {value}.', { value: String(inspectorPosition) })));
    const inspectorWidth = profile.ui?.layout?.inspectorWidth as unknown;
    if (inspectorWidth !== undefined && (typeof inspectorWidth !== 'number' || !Number.isInteger(inspectorWidth) || inspectorWidth < 240 || inspectorWidth > 960)) out.push(issue(tree, ['ui', 'layout', 'inspectorWidth'], localize('Inspector width must be an integer from 240 to 960.')));
    const streamingEffect = profile.ui?.streaming?.effect as unknown;
    if (streamingEffect !== undefined && !['none', 'caret', 'dots', 'shimmer'].includes(String(streamingEffect))) out.push(issue(tree, ['ui', 'streaming', 'effect'], localize('Unknown Assistant streaming effect: {value}.', { value: String(streamingEffect) })));
    const streamingSpeed = profile.ui?.streaming?.speedMs as unknown;
    if (streamingSpeed !== undefined && (typeof streamingSpeed !== 'number' || !Number.isInteger(streamingSpeed) || streamingSpeed < 400 || streamingSpeed > 4000)) out.push(issue(tree, ['ui', 'streaming', 'speedMs'], localize('Assistant streaming speed must be an integer from 400 to 4000 milliseconds.')));
    const streamingIntensity = profile.ui?.streaming?.intensityPercent as unknown;
    if (streamingIntensity !== undefined && (typeof streamingIntensity !== 'number' || !Number.isInteger(streamingIntensity) || streamingIntensity < 10 || streamingIntensity > 100)) out.push(issue(tree, ['ui', 'streaming', 'intensityPercent'], localize('Assistant streaming intensity must be an integer from 10 to 100 percent.')));
    const messageActionVisibility = profile.ui?.messageActionVisibility as unknown;
    if (messageActionVisibility !== undefined && !['always', 'interaction'].includes(String(messageActionVisibility))) out.push(issue(tree, ['ui', 'messageActionVisibility'], localize('Unknown message action visibility: {value}.', { value: String(messageActionVisibility) })));
    profile.stream.mappings.forEach((mapping, index) => {
      if (mapping.emit.type !== 'message.metric.updated') return;
      const metric = mapping.emit.metric;
      if (!metric || typeof metric !== 'object' || Array.isArray(metric)) { out.push(issue(tree, ['stream', 'mappings', index, 'emit', 'metric'], localize('Message metrics require id and value fields.'))); return; }
      const definition = metric as Record<string, unknown>;
      if (!('id' in definition) || !('value' in definition)) out.push(issue(tree, ['stream', 'mappings', index, 'emit', 'metric'], localize('Message metrics require id and value fields.')));
      if (definition.aggregation !== undefined && !['first', 'last', 'sum', 'min', 'max', 'count'].includes(String(definition.aggregation))) out.push(issue(tree, ['stream', 'mappings', index, 'emit', 'metric', 'aggregation'], localize('Unknown message metric aggregation: {value}.', { value: String(definition.aggregation) })));
      if (definition.format !== undefined && !['number', 'duration', 'bytes', 'percent', 'text'].includes(String(definition.format))) out.push(issue(tree, ['stream', 'mappings', index, 'emit', 'metric', 'format'], localize('Unknown message metric format: {value}.', { value: String(definition.format) })));
    });
    const secretNames = new Set<string>();
    const source = JSON.stringify(profile);
    for (const match of source.matchAll(/\$\{secret\.([A-Za-z0-9_-]+)\}/g)) if (match[1]) secretNames.add(match[1]);
    for (const name of secretNames) if (selectedEnvironment && !selectedEnvironment.secretReferences?.[name]) out.push(issue(tree, [], localize('Secret reference "{name}" is not declared by environment "{environment}".', { name, environment: selectedEnvironment.id })));
    const messageActionIds = new Set(['message.copy', 'message.retry', 'message.editAndResend', 'message.inspectRaw']);
    const actionIds = new Set([...messageActionIds, 'request.send', 'request.abort', 'request.resend', 'conversation.new', 'conversation.clear', 'input.fill', 'followup.send', 'citation.open', 'uri.open', 'event.inspect', 'run.export', 'form.open', 'form.submit', 'form.cancel', 'vscodeCommand.invoke']);
    for (const actionId of profile.ui?.messageActions ?? []) if (!messageActionIds.has(actionId)) out.push(issue(tree, ['ui', 'messageActions'], localize('Unknown action id: {id}.', { id: actionId })));
    const declaredActionIds = profile.stream.mappings.flatMap((mapping) => { const action = mapping.emit.action; return action && typeof action === 'object' && typeof (action as Record<string, unknown>).id === 'string' ? [(action as Record<string, unknown>).id as string] : []; });
    for (const duplicate of duplicates(declaredActionIds)) out.push(issue(tree, ['stream', 'mappings'], localize('Duplicate action id: {id}.', { id: duplicate })));
    profile.stream.mappings.forEach((mapping, index) => {
      const action = mapping.emit.action;
      const actionId = action && typeof action === 'object' ? (action as Record<string, unknown>).actionId : undefined;
      if (typeof actionId === 'string' && !actionIds.has(actionId) && !actionId.startsWith('vscodeCommand.invoke:')) out.push(issue(tree, ['stream', 'mappings', index, 'emit'], localize('Unknown response action id: {id}.', { id: actionId })));
    });
    for (const starter of profile.opening?.starters ?? []) if (starter.behavior === 'action' && (!starter.actionId || !actionIds.has(starter.actionId))) out.push(issue(tree, ['opening', 'starters'], localize('Unknown starter action id: {id}.', { id: starter.actionId ?? localize('(missing)') })));
    const lockable = new Set(['composer', 'environment', 'newConversation', 'runProfile', 'history.apply', 'history.open', 'configuration.open', 'inspector.open', 'message.copy', 'stop', ...(profile.controls ?? []).map((control) => control.id)]);
    for (const reference of [...(profile.ui?.locks?.whileTurnActive?.disable ?? []), ...(profile.ui?.locks?.whileTurnActive?.allow ?? [])]) if (!lockable.has(reference)) out.push(issue(tree, ['ui', 'locks'], localize('UI lock references unknown component "{component}".', { component: reference }), 'warning'));
    if (/\b(?:sk|token|bearer)[-_][A-Za-z0-9]{16,}\b/i.test(source)) out.push(issue(tree, [], localize('The profile may contain a secret value. Move secrets to SecretStorage.'), 'warning'));
    return out;
  }
}
