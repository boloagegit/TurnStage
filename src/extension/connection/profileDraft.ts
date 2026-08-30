/**
 * Persistence-safe OpenAI-compatible profile draft generation.
 *
 * A draft is an object for review. It is never written by this module. Any
 * header, URL query parameter, or JSON field identified as secret-bearing is
 * represented by a `${secret.<name>}` reference and the draft contains no
 * captured secret value.
 */

import type { TurnStageProfile } from '../../shared/types';
import {
  type CurlParseResult,
  type CurlSecretLocation,
  type CurlSecretSuggestion,
  parseCurlCommand,
} from './curlParser';

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const MAX_PROFILE_DRAFT_WARNINGS = 32;
export const MAX_PROFILE_DRAFT_SECRETS = 64;

export interface ProfileDraftSecret {
  readonly referenceName: string;
  readonly location: CurlSecretLocation;
  readonly reason: CurlSecretSuggestion['reason'];
  readonly headerName?: string;
  readonly bodyPath?: string;
  readonly urlParameter?: string;
  readonly urlPath?: string;
}

export interface OpenAICompatibleProfileDraftV1 {
  readonly format: 'turnstage-profile-draft';
  readonly version: 1;
  readonly profile: TurnStageProfile;
  readonly requiredSecrets: readonly ProfileDraftSecret[];
  readonly warnings: readonly string[];
  readonly source: {
    readonly host: string;
    readonly protocol: 'sse' | 'json' | 'ndjson' | 'text-stream' | 'unknown';
  };
  readonly safeForPersistence: true;
}

export interface OpenAICompatibleDraftOptions {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly profileEnvironment?: string;
  readonly transport?: 'sse' | 'ndjson' | 'json' | 'text-stream';
  readonly dataFormat?: 'json' | 'text';
}

export type OpenAICompatibleDraftInput = CurlParseResult | string;

/**
 * Build a review-only profile draft from a safe cURL parse result or command
 * text. The result can be JSON-serialized without disclosing sensitive values.
 */
export function buildOpenAICompatibleProfileDraft(input: OpenAICompatibleDraftInput, options: OpenAICompatibleDraftOptions = {}): OpenAICompatibleProfileDraftV1 {
  const parsed = typeof input === 'string' ? parseCurlCommand(input) : input;
  return buildDraftFromParse(parsed, options);
}

export const buildOpenAiCompatibleProfileDraft = buildOpenAICompatibleProfileDraft;
export const buildProfileDraft = buildOpenAICompatibleProfileDraft;

function buildDraftFromParse(parsed: CurlParseResult, options: OpenAICompatibleDraftOptions): OpenAICompatibleProfileDraftV1 {
  if (parsed.method !== 'POST') throw new Error('OpenAI-compatible chat profiles require a POST request.');
  const secretSuggestions = normalizeSuggestions(parsed.secretSuggestions);
  const usedReferences = new Set(secretSuggestions.map((suggestion) => suggestion.referenceName));
  const safeHeaders = buildSafeHeaders(parsed.headers, secretSuggestions, usedReferences);
  const safeUrl = buildSafeUrl(parsed.url, secretSuggestions, usedReferences);
  const sourceBody = parsed.bodyFormat === 'json' ? parsed.body : undefined;
  const warnings = [...parsed.warnings];
  if (parsed.bodyFormat !== 'json') warnings.push('The captured body was not JSON; the draft uses the standard OpenAI chat-completions request shape.');
  else if (capturedContentFields(sourceBody)) warnings.push('Captured messages, tool definitions, and response payload content are not copied into the draft.');
  const model = normalizeModel(options.model ?? modelFromBody(sourceBody) ?? DEFAULT_OPENAI_MODEL);
  const body = buildChatBody(sourceBody, model, usedReferences);
  const headers = addHeaderIfMissing(safeHeaders, 'Content-Type', 'application/json');
  const transport = options.transport ?? 'sse';
  const dataFormat = options.dataFormat ?? 'json';
  const id = profileId(options.id ?? hostFromUrl(safeUrl));
  const name = boundedText(options.name ?? `${hostFromUrl(safeUrl)} OpenAI-compatible Chat`, 120);
  const profile: TurnStageProfile = {
    version: 1,
    id,
    name,
    ...(options.description ? { description: boundedText(options.description, 500) } : { description: 'Review-only draft generated from an OpenAI-compatible cURL request.' }),
    ...(options.profileEnvironment ? { environment: boundedText(options.profileEnvironment, 128) } : {}),
    controls: [{ id: 'model', type: 'text', label: 'Model', default: model, persist: 'workspace' }],
    conversation: {
      send: {
        method: 'POST',
        url: safeUrl,
        headers,
        variants: [{ id: 'chat-completions', body }],
        timeoutMs: 120_000,
        idleTimeoutMs: 30_000,
        redirectPolicy: 'same-origin',
        maxRedirects: 3,
      },
    },
    stream: {
      transport,
      dataFormat,
      mappingMode: 'firstMatch',
      unexpectedEndPolicy: 'fail',
      doneValue: '[DONE]',
      mappings: buildMappings(),
    },
    history: { localRuns: { enabled: true, maxRuns: 20, recordRawEvents: true, recordNormalizedEvents: true, recordChatSnapshot: true } },
    errorPolicy: { preservePartialContent: true, showErrorPart: true, keepConversationId: false, allowContinuation: true, releaseAllLocks: true },
    metrics: { enabled: ['headersLatency', 'firstChunkLatency', 'firstEventLatency', 'ttft', 'streamDuration', 'totalDuration', 'eventCount', 'byteCount', 'averageEventGap', 'maxEventGap', 'parseErrorCount', 'mappingErrorCount', 'unmatchedEventCount'] },
  };
  const requiredSuggestions = [...secretSuggestions];
  const referencedNames = new Set(requiredSuggestions.map((suggestion) => suggestion.referenceName));
  for (const referenceName of profileSecretReferences(profile)) if (!referencedNames.has(referenceName)) {
    referencedNames.add(referenceName);
    requiredSuggestions.push({ referenceName, location: 'body', reason: 'token-like-value' });
  }
  const requiredSecrets = requiredSuggestions.slice(0, MAX_PROFILE_DRAFT_SECRETS).map((suggestion) => ({
    referenceName: suggestion.referenceName,
    location: suggestion.location,
    reason: suggestion.reason,
    ...(suggestion.headerName ? { headerName: suggestion.headerName } : {}),
    ...(suggestion.bodyPath ? { bodyPath: suggestion.bodyPath } : {}),
    ...(suggestion.urlParameter ? { urlParameter: suggestion.urlParameter } : {}),
    ...(suggestion.urlPath ? { urlPath: suggestion.urlPath } : {}),
  }));
  if (requiredSuggestions.length > MAX_PROFILE_DRAFT_SECRETS) warnings.push(`Only the first ${MAX_PROFILE_DRAFT_SECRETS} secret references are included in the draft.`);
  const protocol = transport === 'sse' || transport === 'json' || transport === 'ndjson' || transport === 'text-stream' ? transport : 'unknown';
  return {
    format: 'turnstage-profile-draft',
    version: 1,
    profile,
    requiredSecrets,
    warnings: [...new Set(warnings)].slice(0, MAX_PROFILE_DRAFT_WARNINGS),
    source: { host: hostFromUrl(safeUrl), protocol },
    safeForPersistence: true,
  };
}

function buildSafeHeaders(headers: Record<string, string>, suggestions: CurlSecretSuggestion[], used: Set<string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const suggestion = suggestions.find((item) => item.location === 'header' && item.headerName?.toLowerCase() === name.toLowerCase());
    if (suggestion) output[name] = headerTemplate(value, suggestion.referenceName);
    else if (isSafeProtocolHeader(name, value)) output[name] = value;
    else {
      const referenceName = nextFallbackSecret(referenceNameFor('header', name), used);
      output[name] = `\${secret.${referenceName}}`;
      suggestions.push({ referenceName, location: 'header', reason: 'token-like-value', headerName: name });
    }
  }
  return output;
}

function buildSafeUrl(value: string, suggestions: CurlSecretSuggestion[], used: Set<string>): string {
  try { new URL(value); } catch { return value; }
  const pathSuggestion = suggestions.find((item) => item.location === 'url' && item.urlPath);
  const sourceValue = pathSuggestion ? replaceTokenLike(value, pathSuggestion.referenceName) : value;
  const querySuggestions = suggestions.filter((item) => item.location === 'url' && item.urlParameter);
  const references = new Map<string, string>();
  for (const suggestion of querySuggestions) if (suggestion.urlParameter && !references.has(suggestion.urlParameter)) references.set(suggestion.urlParameter, suggestion.referenceName);
  const question = sourceValue.indexOf('?');
  if (question < 0) return sourceValue;
  const hash = sourceValue.indexOf('#', question);
  const end = hash < 0 ? sourceValue.length : hash;
  const query = sourceValue.slice(question + 1, end);
  const safeQuery = query.split('&').map((part) => {
    const equals = part.indexOf('=');
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    let key: string;
    try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { key = rawKey; }
    if (equals < 0) return part;
    const rawValue = part.slice(equals + 1);
    if (isSafeProtocolQuery(key, rawValue)) return part;
    let reference = references.get(key);
    if (!reference) {
      reference = nextFallbackSecret(referenceNameFor('query', key), used);
      references.set(key, reference);
      suggestions.push({ referenceName: reference, location: 'url', reason: 'token-like-value', urlParameter: key });
    }
    return `${rawKey}=\${secret.${reference}}`;
  }).join('&');
  return `${sourceValue.slice(0, question + 1)}${safeQuery}${hash < 0 ? '' : sourceValue.slice(hash)}`;
}

function isSafeProtocolHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'content-type') return /^(?:application\/json|text\/event-stream)(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(value.trim());
  if (lower === 'accept') return /^(?:application\/json|text\/event-stream|\*\/\*)(?:\s*,\s*(?:application\/json|text\/event-stream|\*\/\*))*$/i.test(value.trim());
  return false;
}

function isSafeProtocolQuery(name: string, rawValue: string): boolean {
  if (!/^(?:api-version|version)$/i.test(name)) return false;
  let value: string;
  try { value = decodeURIComponent(rawValue.replace(/\+/g, ' ')); } catch { return false; }
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value);
}

function referenceNameFor(kind: 'header' | 'query', name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const suffix = words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join('').slice(0, 80) || 'Value';
  return `${kind}${suffix}`;
}

const SAFE_OPENAI_SCALAR_FIELDS = new Set([
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n', 'presence_penalty',
  'frequency_penalty', 'seed', 'logprobs', 'top_logprobs', 'stop',
]);

function buildChatBody(source: unknown, model: string, used: Set<string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (!SAFE_OPENAI_SCALAR_FIELDS.has(key)) continue;
      const safe = safeOpenAiScalar(value, used);
      if (safe !== undefined) body[key] = safe;
    }
  }
  body.model = { $value: 'controls.model' };
  body.stream = true;
  body.messages = [{ role: 'user', content: { $value: 'input.text' } }];
  return body;
}

function safeOpenAiScalar(value: unknown, used: Set<string>): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubTokenLike(value, () => nextFallbackSecret('apiSecret', used));
  if (Array.isArray(value) && value.length <= 8) {
    const values = value.map((item) => safeOpenAiScalar(item, used));
    return values.every((item) => item !== undefined) ? values : undefined;
  }
  return undefined;
}

function capturedContentFields(source: unknown): boolean {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const body = source as Record<string, unknown>;
  return Array.isArray(body.messages) || 'tools' in body || 'tool_choice' in body || 'response_format' in body || 'input' in body || 'prompt' in body;
}

function buildMappings(): TurnStageProfile['stream']['mappings'] {
  return [
    { id: 'content-delta', match: { path: 'choices.0.delta.content', operator: 'exists' }, emit: { type: 'content.text.delta', text: { path: 'choices.0.delta.content' } } },
    { id: 'content-message', match: { path: 'choices.0.message.content', operator: 'exists' }, emit: { type: 'content.text.delta', text: { path: 'choices.0.message.content' } } },
    { id: 'content-text', match: { path: 'choices.0.text', operator: 'exists' }, emit: { type: 'content.text.delta', text: { path: 'choices.0.text' } } },
    { id: 'done', match: { path: 'choices.0.finish_reason', operator: 'exists' }, emit: { type: 'stream.completed' } },
    { id: 'error', match: { path: 'error', operator: 'exists' }, emit: { type: 'stream.failed', error: { path: 'error' } } },
  ];
}

function normalizeSuggestions(suggestions: readonly CurlSecretSuggestion[]): CurlSecretSuggestion[] {
  const output: CurlSecretSuggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.location}:${suggestion.headerName?.toLowerCase() ?? suggestion.bodyPath ?? suggestion.urlParameter ?? suggestion.urlPath ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(suggestion);
  }
  return output;
}

function modelFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const model = (body as Record<string, unknown>).model;
  return typeof model === 'string' && isSafeModel(model) ? model : undefined;
}
function normalizeModel(value: string): string { return isSafeModel(value) ? value : DEFAULT_OPENAI_MODEL; }
function nextFallbackSecret(preferred: string, used: Set<string>): string {
  let candidate = preferred.replace(/[^A-Za-z0-9_-]/g, '') || 'apiSecret';
  if (!used.has(candidate)) { used.add(candidate); return candidate; }
  for (let index = 2; index <= 100; index += 1) { const next = `${candidate}${index}`; if (!used.has(next)) { used.add(next); return next; } }
  candidate = `${candidate}${used.size + 1}`;
  used.add(candidate);
  return candidate;
}
function scrubTokenLike(value: string, fallback: string | (() => string)): string {
  const tokenLike = /(?:sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/.test(value);
  return tokenLike ? replaceTokenLike(value, typeof fallback === 'function' ? fallback() : fallback) : value;
}
function replaceTokenLike(value: string, fallback: string): string {
  const placeholder = `\${secret.${fallback}}`;
  return value
    .replace(/sk-proj-[A-Za-z0-9_-]{16,}/g, placeholder)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, placeholder)
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, placeholder)
    .replace(/xox[baprs]-[A-Za-z0-9-]{16,}/g, placeholder)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, placeholder)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{16,}/g, `Bearer ${placeholder}`);
}
function headerTemplate(value: string, reference: string): string {
  const prefix = value.match(/^\S+\s+/)?.[0] ?? '';
  return `${prefix}\${secret.${reference}}`;
}
function addHeaderIfMissing(headers: Record<string, string>, name: string, value: string): Record<string, string> {
  if (Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) return headers;
  return { ...headers, [name]: value };
}
function profileId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'openai-compatible-chat';
  return /^[a-z]/.test(normalized) ? normalized : `api-${normalized}`;
}
function hostFromUrl(value: string): string {
  try { return new URL(value).hostname || 'OpenAI-compatible'; } catch { return 'OpenAI-compatible'; }
}
function boundedText(value: string, maxLength: number): string { return value.length > maxLength ? value.slice(0, maxLength) : value; }
function isSafeModel(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && !/(?:sk-proj-|sk-|gh[pousr]_|xox[baprs]-|AIza)/i.test(value);
}

function profileSecretReferences(value: unknown): string[] {
  const references = new Set<string>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 10 || references.size >= MAX_PROFILE_DRAFT_SECRETS) return;
    if (typeof current === 'string') {
      for (const match of current.matchAll(/\$\{secret\.([A-Za-z0-9_-]{1,128})\}/g)) if (match[1]) references.add(match[1]);
      return;
    }
    if (Array.isArray(current)) { for (const item of current) visit(item, depth + 1); return; }
    if (current && typeof current === 'object') for (const child of Object.values(current as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...references];
}
