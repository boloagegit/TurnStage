import { findNodeAtLocation, type Node } from 'jsonc-parser';
import type { MatchCondition, RequestDefinition, TurnStageEnvironment, TurnStageProfile } from '../../shared/types';
import { localize } from '../l10n';

export interface ValidationIssue { severity: 'error' | 'warning'; message: string; offset: number; length: number }

const requiredEmitFields: Record<string, string[]> = {
  'conversation.started': ['conversationId'], 'content.text.delta': ['text'], 'content.markdown.delta': ['text'],
  'tool.started': ['toolCallId', 'name'], 'tool.completed': ['toolCallId'], 'citation.upsert': ['citation'],
  'content.citation': ['citationId'], 'followup.upsert': ['followup'], 'action.upsert': ['action'], 'form.upsert': ['form']
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
    if (profile.version !== 1) out.push(issue(tree, ['version'], localize('Unsupported config version: {version}.', { version: String(profile.version) })));
    if (!profile.id?.trim()) out.push(issue(tree, ['id'], localize('Profile id is required.')));
    if (!profile.name?.trim()) out.push(issue(tree, ['name'], localize('Profile name is required.')));
    if (!profile.conversation?.send) out.push(issue(tree, ['conversation'], localize('Conversation send request is required.')));
    if (!profile.conversation?.send?.variants?.length) out.push(issue(tree, ['conversation', 'send'], localize('At least one request variant is required.')));
    if (!profile.stream?.mappings?.length) out.push(issue(tree, ['stream'], localize('At least one stream mapping is required.')));
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
    const secretNames = new Set<string>();
    const source = JSON.stringify(profile);
    for (const match of source.matchAll(/\$\{secret\.([A-Za-z0-9_-]+)\}/g)) if (match[1]) secretNames.add(match[1]);
    for (const name of secretNames) if (selectedEnvironment && !selectedEnvironment.secretReferences?.[name]) out.push(issue(tree, [], localize('Secret reference "{name}" is not declared by environment "{environment}".', { name, environment: selectedEnvironment.id })));
    const actionIds = new Set(['message.copy', 'message.retry', 'message.editAndResend', 'message.inspectRaw', 'request.send', 'request.abort', 'request.resend', 'conversation.new', 'conversation.clear', 'input.fill', 'followup.send', 'citation.open', 'uri.open', 'event.inspect', 'run.export', 'form.open', 'form.submit', 'form.cancel', 'vscodeCommand.invoke']);
    for (const actionId of profile.ui?.messageActions ?? []) if (!actionIds.has(actionId)) out.push(issue(tree, ['ui', 'messageActions'], localize('Unknown action id: {id}.', { id: actionId })));
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
