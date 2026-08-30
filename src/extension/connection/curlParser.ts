/**
 * Safe, non-executing cURL importer.
 *
 * This module deliberately parses a small, explicit subset of cURL's command
 * line syntax. It is not a shell parser and must never be passed to a shell.
 * The returned parse result contains request values in memory so it can be
 * probed by a caller, while `buildOpenAICompatibleProfileDraft` produces the
 * separate persistence-safe projection.
 */

export const MAX_CURL_INPUT_BYTES = 64 * 1024;
export const MAX_CURL_TOKENS = 128;
export const MAX_CURL_TOKEN_BYTES = 16 * 1024;
export const MAX_CURL_HEADERS = 100;
export const MAX_CURL_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_CURL_JSON_DEPTH = 12;
export const MAX_CURL_JSON_NODES = 2_048;

export type CurlHttpMethod = 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
export type CurlBodyFormat = 'none' | 'json' | 'text';

export type CurlParseErrorCode =
  | 'empty-input'
  | 'input-too-large'
  | 'too-many-tokens'
  | 'token-too-large'
  | 'not-curl'
  | 'unsafe-syntax'
  | 'unterminated-quote'
  | 'unsupported-flag'
  | 'missing-flag-value'
  | 'duplicate-url'
  | 'duplicate-method'
  | 'duplicate-header'
  | 'too-many-headers'
  | 'invalid-header'
  | 'response-file'
  | 'invalid-method'
  | 'body-with-get'
  | 'multiple-bodies'
  | 'invalid-json-body'
  | 'body-too-large'
  | 'body-too-complex'
  | 'invalid-url'
  | 'unsupported-url-scheme'
  | 'embedded-url-credentials'
  | 'unsupported-body';

export class CurlParseError extends Error {
  readonly code: CurlParseErrorCode;
  readonly tokenIndex?: number;

  constructor(code: CurlParseErrorCode, message: string, tokenIndex?: number) {
    super(message);
    this.name = 'CurlParseError';
    this.code = code;
    this.tokenIndex = tokenIndex;
  }
}

export type CurlSecretLocation = 'header' | 'body' | 'url';
export type CurlSecretReason =
  | 'sensitive-header'
  | 'sensitive-body-field'
  | 'sensitive-url-parameter'
  | 'token-like-value';

/** A reference suggestion never contains the value it is suggesting to store. */
export interface CurlSecretSuggestion {
  readonly referenceName: string;
  readonly location: CurlSecretLocation;
  readonly reason: CurlSecretReason;
  readonly headerName?: string;
  readonly bodyPath?: string;
  readonly urlParameter?: string;
  readonly urlPath?: string;
}

/**
 * This is an in-memory parse result. `headers` and `body` can contain secrets
 * from the imported command and must not be persisted or sent to a webview.
 * Use the profile draft builder for a persistence-safe representation.
 */
export interface CurlParseResult {
  readonly format: 'turnstage-curl-parse';
  readonly version: 1;
  readonly method: CurlHttpMethod;
  readonly url: string;
  /** In-memory only; may contain credentials. */
  readonly headers: Record<string, string>;
  /** In-memory only; may contain credentials or private request data. */
  readonly body?: unknown;
  readonly bodyText?: string;
  readonly bodyFormat: CurlBodyFormat;
  readonly explicitMethod: boolean;
  readonly dataFlags: readonly string[];
  readonly secretSuggestions: readonly CurlSecretSuggestion[];
  readonly warnings: readonly string[];
}

interface Token {
  readonly value: string;
}

interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

export interface CurlParseOptions {
  readonly maxInputBytes?: number;
  readonly maxTokenBytes?: number;
  readonly maxBodyBytes?: number;
}

const encoder = new TextEncoder();

const HTTP_METHODS = new Set<CurlHttpMethod>(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']);
const VALUE_FLAGS = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-ascii', '--data-binary', '--json', '--url', '--max-time']);
const NO_VALUE_FLAGS = new Set([
  '-s', '-S', '-N', '-g', '--silent', '--show-error', '--no-buffer', '--globoff', '--compressed',
  '--http1.1', '--http2', '--fail-with-body',
]);
const UNSUPPORTED_FLAGS = new Set([
  '-I', '--head', '-G', '--get', '-K', '--config', '--url-query', '--data-urlencode', '--form', '-F',
  '--form-string', '--upload-file', '-T', '--remote-name', '-o', '--output', '-w', '--write-out',
  '--proxy', '-x', '--proxy-user', '-U', '--cert', '--key', '--cacert', '--insecure', '-k', '--location',
  '-L', '--max-redirs', '--connect-timeout', '--retry', '--retry-all-errors', '--retry-delay', '--retry-max-time',
]);

const SENSITIVE_HEADER_RE = /^(?:authorization|proxy-authorization|cookie2?|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SENSITIVE_HEADER_WORD_RE = /(?:api[-_]?key|auth(?:orization)?|access[-_]?token|refresh[-_]?token|session|secret|password|credential|private[-_]?key|bearer)/i;
const SENSITIVE_BODY_KEY_RE = /(?:api[-_]?key|auth(?:orization)?|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|credential|private[-_]?key|cookie|bearer)/i;
const TOKEN_LIKE_RE = /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})(?:$|[^A-Za-z0-9])/;
const SENSITIVE_URL_KEY_RE = /(?:api[-_]?key|token|secret|password|credential|authorization|signature|sig)/i;

/**
 * Parse a cURL command without invoking a shell or any external process.
 */
export function parseCurlCommand(input: string, options: CurlParseOptions = {}): CurlParseResult {
  if (typeof input !== 'string' || !input.trim()) throw new CurlParseError('empty-input', 'The cURL command is empty.');
  const maxInputBytes = boundedPositiveInteger(options.maxInputBytes, MAX_CURL_INPUT_BYTES);
  if (exceedsUtf8Bytes(input, maxInputBytes)) throw new CurlParseError('input-too-large', `The cURL command exceeds the ${maxInputBytes}-byte limit.`);
  if (input.includes('\0')) throw new CurlParseError('unsafe-syntax', 'NUL characters are not allowed in a cURL command.');
  rejectUnsafeExpansions(input);

  const tokens = tokenize(input, boundedPositiveInteger(options.maxTokenBytes, MAX_CURL_TOKEN_BYTES));
  if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0]!.value)) throw new CurlParseError('not-curl', 'The command must start with curl or curl.exe.');
  if (tokens.length > MAX_CURL_TOKENS) throw new CurlParseError('too-many-tokens', `The cURL command contains more than ${MAX_CURL_TOKENS} arguments.`);

  const headers: HeaderEntry[] = [];
  const headerNames = new Set<string>();
  const dataValues: Array<{ flag: string; value: string }> = [];
  const warnings: string[] = [];
  let method: CurlHttpMethod | undefined;
  let url: string | undefined;
  let explicitMethod = false;
  let jsonFlag = false;
  let maxTimeSeconds: number | undefined;
  let positionalOnly = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!.value;
    if (!token) throw new CurlParseError('unsafe-syntax', 'Empty cURL arguments are not supported.', index);
    if (positionalOnly) {
      url = assignUrl(url, token, index);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      url = assignUrl(url, token, index);
      continue;
    }

    const equal = token.indexOf('=');
    const flag = equal > 0 ? token.slice(0, equal) : token;
    const inlineValue = equal > 0 ? token.slice(equal + 1) : undefined;
    if (UNSUPPORTED_FLAGS.has(flag)) throw new CurlParseError('unsupported-flag', `The cURL flag ${flag} is not supported by the safe importer.`, index);

    if (VALUE_FLAGS.has(flag)) {
      const value = inlineValue === undefined ? nextFlagValue(tokens, index) : inlineValue;
      if (inlineValue === undefined) index += 1;
      if (isResponseFileReference(value)) throw new CurlParseError('response-file', `Response-file references are not allowed for ${flag}.`, index);
      if (flag === '-X' || flag === '--request') {
        if (explicitMethod) throw new CurlParseError('duplicate-method', 'Only one request method may be imported.', index);
        const normalized = value.toUpperCase();
        if (!HTTP_METHODS.has(normalized as CurlHttpMethod)) throw new CurlParseError('invalid-method', `The request method ${value} is not supported by TurnStage.`, index);
        method = normalized as CurlHttpMethod;
        explicitMethod = true;
      } else if (flag === '-H' || flag === '--header') {
        if (headers.length >= MAX_CURL_HEADERS) throw new CurlParseError('too-many-headers', `The cURL command contains more than ${MAX_CURL_HEADERS} headers.`, index);
        const header = parseHeader(value, index);
        const lower = header.name.toLowerCase();
        if (headerNames.has(lower)) throw new CurlParseError('duplicate-header', `The header ${header.name} is specified more than once.`, index);
        headerNames.add(lower);
        headers.push(header);
      } else if (flag === '--url') {
        url = assignUrl(url, value, index);
      } else if (flag === '--json') {
        jsonFlag = true;
        dataValues.push({ flag, value });
      } else if (flag === '--max-time') {
        if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 900 || Number(value) < 0) throw new CurlParseError('unsafe-syntax', 'The --max-time value must be between 0 and 900 seconds.', index);
        maxTimeSeconds = Number(value);
      } else {
        dataValues.push({ flag, value });
      }
      continue;
    }
    if (NO_VALUE_FLAGS.has(flag) || isHarmlessShortBundle(flag)) continue;
    if (/^-X[A-Za-z]+$/i.test(flag)) {
      if (explicitMethod) throw new CurlParseError('duplicate-method', 'Only one request method may be imported.', index);
      const normalized = flag.slice(2).toUpperCase();
      if (!HTTP_METHODS.has(normalized as CurlHttpMethod)) throw new CurlParseError('invalid-method', `The request method ${normalized} is not supported by TurnStage.`, index);
      method = normalized as CurlHttpMethod;
      explicitMethod = true;
      continue;
    }
    if (/^-H.+/.test(flag)) {
      if (headers.length >= MAX_CURL_HEADERS) throw new CurlParseError('too-many-headers', `The cURL command contains more than ${MAX_CURL_HEADERS} headers.`, index);
      const header = parseHeader(flag.slice(2), index);
      const lower = header.name.toLowerCase();
      if (headerNames.has(lower)) throw new CurlParseError('duplicate-header', `The header ${header.name} is specified more than once.`, index);
      headerNames.add(lower);
      headers.push(header);
      continue;
    }
    if (/^-d.+/.test(flag)) {
      const value = flag.slice(2);
      if (isResponseFileReference(value)) throw new CurlParseError('response-file', 'Response-file references are not allowed for -d.', index);
      dataValues.push({ flag: '-d', value });
      continue;
    }
    throw new CurlParseError('unsupported-flag', `The cURL flag ${flag} is not supported by the safe importer.`, index);
  }

  if (!url) throw new CurlParseError('missing-flag-value', 'A request URL is required.');
  const validatedUrl = validateUrl(url);
  if (dataValues.length > 1) throw new CurlParseError('multiple-bodies', 'Multiple request body flags are ambiguous and are not imported.');
  if (dataValues.length && method === 'GET') throw new CurlParseError('body-with-get', 'A request body cannot be imported with GET.');
  if (dataValues.length && !method) method = 'POST';
  if (!method) method = 'GET';

  const headerRecord = Object.fromEntries(headers.map((header) => [header.name, header.value]));
  const contentType = headerRecordValue(headerRecord, 'content-type');
  const bodyFlag = dataValues[0];
  const maxBodyBytes = boundedPositiveInteger(options.maxBodyBytes, MAX_CURL_BODY_BYTES);
  let body: unknown;
  let bodyText: string | undefined;
  let bodyFormat: CurlBodyFormat = 'none';
  if (bodyFlag) {
    if (encoder.encode(bodyFlag.value).byteLength > maxBodyBytes) throw new CurlParseError('body-too-large', `The request body exceeds the ${maxBodyBytes}-byte limit.`);
    bodyText = bodyFlag.value;
    if (jsonFlag || isJsonContentType(contentType) || looksLikeJson(bodyFlag.value)) {
      try { body = JSON.parse(bodyFlag.value) as unknown; }
      catch { throw new CurlParseError('invalid-json-body', 'The imported request body is not valid JSON.'); }
      validateJsonBounds(body, maxBodyBytes);
      bodyFormat = 'json';
      bodyText = undefined;
    } else {
      bodyFormat = 'text';
      warnings.push('The request body is not JSON; OpenAI-compatible draft generation may replace it with a chat body.');
    }
  }
  if (jsonFlag && !headerRecordValue(headerRecord, 'content-type')) {
    headers.push({ name: 'Content-Type', value: 'application/json' });
    headerNames.add('content-type');
  }
  if (maxTimeSeconds !== undefined) warnings.push(`Imported --max-time=${maxTimeSeconds}s as a suggestion; request timeout is not applied by the parse result.`);

  const secretSuggestions = collectSecretSuggestions(validatedUrl, headers, body, bodyText);
  return {
    format: 'turnstage-curl-parse',
    version: 1,
    method,
    url: validatedUrl,
    headers: Object.fromEntries(headers.map((header) => [header.name, header.value])),
    ...(bodyFormat === 'json' ? { body } : bodyFormat === 'text' ? { bodyText } : {}),
    bodyFormat,
    explicitMethod,
    dataFlags: dataValues.map((item) => item.flag),
    secretSuggestions,
    warnings: [...new Set(warnings)],
  };
}

/** Backwards-compatible short alias for callers that treat this as a parser. */
export const parseCurl = parseCurlCommand;

function tokenize(input: string, maxTokenBytes: number): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let started = false;
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  const push = (): void => {
    if (!started) return;
    if (encoder.encode(current).byteLength > maxTokenBytes) throw new CurlParseError('token-too-large', `A cURL argument exceeds the ${maxTokenBytes}-byte limit.`);
    if (current.startsWith('#')) throw new CurlParseError('unsafe-syntax', 'Shell comments are not accepted in imported cURL text.');
    tokens.push({ value: current });
    if (tokens.length > MAX_CURL_TOKENS) throw new CurlParseError('too-many-tokens', `The cURL command contains more than ${MAX_CURL_TOKENS} arguments.`);
    current = '';
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      if (character !== '\n' && character !== '\r') current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') {
        // cmd.exe commonly represents a literal quote inside a quoted value as "".
        if (input[index + 1] === '"') { current += '"'; index += 1; }
        else quote = undefined;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '^' && input[index + 1] !== undefined) {
        current += input[index + 1]!;
        index += 1;
      } else current += character;
      started = true;
      continue;
    }
    if (character === "'") { quote = 'single'; started = true; continue; }
    if (character === '"') { quote = 'double'; started = true; continue; }
    if (character === '\\' || character === '^') {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) { push(); continue; }
    if (';&|<>()`'.includes(character)) throw new CurlParseError('unsafe-syntax', `Unsafe shell syntax ${character} is not accepted.`);
    if ('*?[]'.includes(character)) throw new CurlParseError('unsafe-syntax', 'Unquoted shell glob characters are not accepted.');
    current += character;
    started = true;
  }
  if (escaped) throw new CurlParseError('unsafe-syntax', 'The cURL command ends with an escape character.');
  if (quote) throw new CurlParseError('unterminated-quote', 'The cURL command contains an unterminated quote.');
  push();
  return tokens;
}

function rejectUnsafeExpansions(input: string): void {
  if (input.includes('`') || /\$\(/.test(input)) throw new CurlParseError('unsafe-syntax', 'Shell command substitution is not accepted.');
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote === 'single') { if (character === "'") quote = undefined; continue; }
    if (quote === 'double') {
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') { quote = undefined; continue; }
    } else if (character === "'") { quote = 'single'; continue; }
    else if (character === '"') { quote = 'double'; continue; }
    if (character === '$' && (input[index + 1] === '{' || /[A-Za-z_]/.test(input[index + 1] ?? ''))) throw new CurlParseError('unsafe-syntax', 'Shell variable expansion is not accepted.');
  }
}

function nextFlagValue(tokens: readonly Token[], index: number): string {
  const next = tokens[index + 1]?.value;
  if (next === undefined) throw new CurlParseError('missing-flag-value', `The flag ${tokens[index]!.value} requires a value.`, index);
  return next;
}

function isHarmlessShortBundle(value: string): boolean {
  return /^-[sSNg]+$/.test(value) && value.length > 2;
}

function assignUrl(previous: string | undefined, value: string, tokenIndex: number): string {
  if (previous !== undefined) throw new CurlParseError('duplicate-url', 'Only one request URL may be imported.', tokenIndex);
  return value;
}

function parseHeader(value: string, tokenIndex: number): HeaderEntry {
  if (isResponseFileReference(value) || /[\0\r\n]/.test(value)) throw new CurlParseError('invalid-header', 'Header values must not contain response-file references or line breaks.', tokenIndex);
  const colon = value.indexOf(':');
  if (colon <= 0) throw new CurlParseError('invalid-header', 'Headers must use the name: value form.', tokenIndex);
  const name = value.slice(0, colon).trim();
  const headerValue = value.slice(colon + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || name.length > 256 || headerValue.length > 16 * 1024) throw new CurlParseError('invalid-header', 'The imported header name or value is invalid or too large.', tokenIndex);
  return { name, value: headerValue };
}

function validateUrl(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new CurlParseError('invalid-url', 'The request URL must not contain control characters.');
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new CurlParseError('invalid-url', 'The request URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new CurlParseError('unsupported-url-scheme', `The URL scheme ${parsed.protocol} is not supported.`);
  if (parsed.username || parsed.password) throw new CurlParseError('embedded-url-credentials', 'Embedded URL credentials are not accepted by the safe importer.');
  return parsed.toString();
}

function isResponseFileReference(value: string): boolean { return value === '@' || value.startsWith('@'); }
function headerRecordValue(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}
function isJsonContentType(value: string | undefined): boolean { return Boolean(value && /(?:^|[;\s])application\/(?:[^;\s]+\+)?json(?:[;\s]|$)/i.test(value)); }
function looksLikeJson(value: string): boolean { return /^(?:\{|\[)/.test(value.trim()); }

function validateJsonBounds(value: unknown, maxBodyBytes: number): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CURL_JSON_NODES || depth > MAX_CURL_JSON_DEPTH) throw new CurlParseError('body-too-complex', `The JSON body exceeds the bounded depth or node limit.`);
    if (Array.isArray(current)) { for (const item of current) visit(item, depth + 1); return; }
    if (current && typeof current === 'object') for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (encoder.encode(key).byteLength > maxBodyBytes) throw new CurlParseError('body-too-large', 'A JSON body key exceeds the body limit.');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function collectSecretSuggestions(url: string, headers: readonly HeaderEntry[], body: unknown, bodyText: string | undefined): CurlSecretSuggestion[] {
  const suggestions: CurlSecretSuggestion[] = [];
  const used = new Set<string>();
  const add = (suggestion: Omit<CurlSecretSuggestion, 'referenceName'>, preferred: string): void => {
    const referenceName = uniqueReferenceName(preferred, used);
    used.add(referenceName);
    suggestions.push({ ...suggestion, referenceName });
  };
  for (const header of headers) {
    if (isSensitiveHeader(header.name) || TOKEN_LIKE_RE.test(header.value)) {
      add({ location: 'header', reason: isSensitiveHeader(header.name) ? 'sensitive-header' : 'token-like-value', headerName: header.name }, referenceForHeader(header.name));
    }
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { parsedUrl = new URL('https://invalid.local/'); }
  for (const [key] of parsedUrl.searchParams.entries()) if (SENSITIVE_URL_KEY_RE.test(key)) {
    add({ location: 'url', reason: 'sensitive-url-parameter', urlParameter: key }, referenceForKey(key));
  }
  if (TOKEN_LIKE_RE.test(url)) add({ location: 'url', reason: 'token-like-value', urlPath: 'path' }, 'apiToken');
  if (body !== undefined) collectBodySecrets(body, [], add);
  if (bodyText !== undefined && TOKEN_LIKE_RE.test(bodyText)) add({ location: 'body', reason: 'token-like-value', bodyPath: '$' }, 'apiToken');
  return suggestions;
}

function collectBodySecrets(value: unknown, path: string[], add: (suggestion: Omit<CurlSecretSuggestion, 'referenceName'>, preferred: string) => void, depth = 0): void {
  if (depth > MAX_CURL_JSON_DEPTH) return;
  if (Array.isArray(value)) { value.forEach((item, index) => collectBodySecrets(item, [...path, String(index)], add, depth + 1)); return; }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && TOKEN_LIKE_RE.test(value)) add({ location: 'body', reason: 'token-like-value', bodyPath: bodyPath(path) }, 'apiToken');
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (SENSITIVE_BODY_KEY_RE.test(key) && (!child || typeof child !== 'object')) add({ location: 'body', reason: 'sensitive-body-field', bodyPath: bodyPath(childPath) }, referenceForKey(key));
    else collectBodySecrets(child, childPath, add, depth + 1);
  }
}

function bodyPath(path: readonly string[]): string { return path.length ? `body.${path.map((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `[${JSON.stringify(part)}]`).join('.')}` : 'body'; }
function isSensitiveHeader(name: string): boolean { return SENSITIVE_HEADER_RE.test(name) || SENSITIVE_HEADER_WORD_RE.test(name); }
function referenceForHeader(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'cookie' || lower === 'cookie2' || lower === 'set-cookie') return 'sessionCookie';
  if (lower.includes('token') || lower === 'authorization' || lower === 'proxy-authorization') return 'apiToken';
  if (lower.includes('key')) return 'apiKey';
  return 'apiSecret';
}
function referenceForKey(key: string): string {
  const lower = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (lower.includes('password')) return 'password';
  if (lower.includes('cookie') || lower.includes('session')) return 'sessionCookie';
  if (lower.includes('secret')) return 'clientSecret';
  if (lower.includes('token')) return 'apiToken';
  if (lower.includes('key')) return 'apiKey';
  return 'apiSecret';
}
function uniqueReferenceName(preferred: string, used: ReadonlySet<string>): string {
  const normalized = preferred.replace(/[^A-Za-z0-9_-]/g, '') || 'apiSecret';
  if (!used.has(normalized)) return normalized;
  for (let suffix = 2; suffix <= 100; suffix += 1) if (!used.has(`${normalized}${suffix}`)) return `${normalized}${suffix}`;
  return `${normalized}${used.size + 1}`;
}
function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function exceedsUtf8Bytes(value: string, limit: number): boolean {
  let bytes = 0;
  for (const character of value) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > limit) return true;
  }
  return false;
}
