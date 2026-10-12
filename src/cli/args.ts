import type { CliOutputFormat, CliParseResult, CliRunOptions, CliVerifyOptions } from './contracts';

export const CLI_USAGE = `Usage: turnstage run [options] [profile ...]
       turnstage verify [--manifest] <provenance.json>

Commands:
  run       Execute selected contracts against configured HTTP/SSE backends.
            Without profile paths, loads .vscode/turnstage/profiles/*.turnstage.jsonc.
  verify    Verify a provenance manifest and its evidence-file digests.

Workspace:
  --workspace <dir>    Workspace root for profiles, environments, and suites (default: current directory).

Run selectors:
  --profile <id>       Select a profile (repeatable, comma-separated).
  --suite <id>         Select a linked suite (repeatable, comma-separated).
  --case <id>          Select a case (repeatable, comma-separated).
  --tag <tag>          Select cases that have every given tag (repeatable).
  --changed-file <p>   Select cases affected by a changed workspace path (repeatable).
  --include-unbound    With --changed-file, also include cases without source bindings.

Run policy:
  --repetitions <n>    Red Team repetition override (1-50).
  --concurrency <n>    Concurrent cases (1-8, default 3).
  --timeout-ms <n>     Red Team case timeout (1000-300000).
  --max-requests <n>   Refuse to start if the selection plans more requests.
  --fail-fast          Stop Red Team repetitions after the first blocking outcome.

Output:
  --format <json|junit|html|evidence>  Report format (default json; --json, --junit, --html also work).
  --output <path>      Write the report to a new file instead of stdout. Existing files are never overwritten.
  --help, --version

Exit codes:
  0  All selected cases passed or resisted.
  1  A case failed its checks, regressed against its baseline, or an attack succeeded.
  2  Indeterminate: invalid arguments or configuration, no matching cases, a budget
     refusal, an existing --output file, or a manifest that does not verify.
  3  Infrastructure: a Red Team infrastructure error, a runtime failure, or an unwritable report.
`;

const OUTPUT_FORMATS = new Set<CliOutputFormat>(['json', 'junit', 'html', 'evidence']);
const VALUE_FLAGS = new Set(['profile', 'profile-id', 'suite', 'suite-id', 'case', 'case-id', 'tag', 'changed-file', 'format', 'output', 'workspace', 'repetitions', 'concurrency', 'timeout-ms', 'timeout', 'max-requests', 'manifest']);
const BOOLEAN_FLAGS = new Set(['fail-fast', 'no-fail-fast', 'include-unbound', 'no-color', 'help', 'version', 'json', 'junit', 'html']);

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  let command: 'run' | 'verify' | undefined;
  const positional: string[] = [];
  const profiles: string[] = [];
  const suites: string[] = [];
  const cases: string[] = [];
  const tags: string[] = [];
  const changedFiles: string[] = [];
  const errors: string[] = [];
  let format: CliOutputFormat = 'json';
  let outputPath: string | undefined;
  let workspaceRoot: string | undefined;
  let manifestPath: string | undefined;
  let repetitions: number | undefined;
  let concurrency: number | undefined;
  let timeoutMs: number | undefined;
  let maxRequests: number | undefined;
  let failFast = false;
  let includeUnbound = false;
  let noColor = false;
  let help = false;
  let version = false;
  let afterSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.length) { errors.push(`Argument ${index + 1} is empty.`); continue; }
    if (afterSeparator) { positional.push(token); continue; }
    if (token === '--') { afterSeparator = true; continue; }
    if (token === '-h' || token === '--help') { help = true; continue; }
    if (token === '-V' || token === '--version') { version = true; continue; }
    if (!token.startsWith('-') || token === '-') {
      if (!command && (token === 'run' || token === 'verify')) command = token;
      else if (!command && (token === 'help' || token === 'version')) { if (token === 'help') help = true; else version = true; }
      else if (isSafeArgument(token)) positional.push(token);
      else errors.push(`Invalid positional argument: ${token}.`);
      continue;
    }

    const parsed = splitFlag(token);
    if (!parsed || (!VALUE_FLAGS.has(parsed.name) && !BOOLEAN_FLAGS.has(parsed.name))) {
      errors.push(`Unknown option: ${token}.`);
      continue;
    }
    if (BOOLEAN_FLAGS.has(parsed.name)) {
      if (parsed.value !== undefined && !['true', 'false'].includes(parsed.value)) errors.push(`Boolean option --${parsed.name} does not accept "${parsed.value}".`);
      const enabled = parsed.value === undefined || parsed.value === 'true';
      if (parsed.name === 'help') help = enabled;
      else if (parsed.name === 'version') version = enabled;
      else if (parsed.name === 'fail-fast') failFast = enabled;
      else if (parsed.name === 'no-fail-fast') failFast = !enabled;
      else if (parsed.name === 'include-unbound') includeUnbound = enabled;
      else if (parsed.name === 'no-color') noColor = enabled;
      else if (parsed.name === 'json' && enabled) format = 'json';
      else if (parsed.name === 'junit' && enabled) format = 'junit';
      else if (parsed.name === 'html' && enabled) format = 'html';
      continue;
    }

    let value = parsed.value;
    if (value === undefined) {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.startsWith('-')) { errors.push(`Option --${parsed.name} requires a value.`); continue; }
      value = next;
      index += 1;
    }
    if (!isSafeArgument(value)) { errors.push(`Invalid value for --${parsed.name}.`); continue; }
    const values = ['profile', 'profile-id', 'suite', 'suite-id', 'case', 'case-id', 'tag'].includes(parsed.name) ? splitList(value, `--${parsed.name}`, errors) : [value];
    if (['profile', 'profile-id'].includes(parsed.name)) profiles.push(...values);
    else if (['suite', 'suite-id'].includes(parsed.name)) suites.push(...values);
    else if (['case', 'case-id'].includes(parsed.name)) cases.push(...values);
    else if (parsed.name === 'tag') tags.push(...values);
    else if (parsed.name === 'changed-file') changedFiles.push(value);
    else if (parsed.name === 'format') {
      if (!OUTPUT_FORMATS.has(value as CliOutputFormat)) errors.push(`Unsupported output format: ${value}.`);
      else format = value as CliOutputFormat;
    } else if (parsed.name === 'output') outputPath = value;
    else if (parsed.name === 'workspace') workspaceRoot = value;
    else if (parsed.name === 'manifest') manifestPath = value;
    else if (parsed.name === 'repetitions') repetitions = parseInteger(value, '--repetitions', 1, 50, errors);
    else if (parsed.name === 'concurrency') concurrency = parseInteger(value, '--concurrency', 1, 8, errors);
    else if (['timeout-ms', 'timeout'].includes(parsed.name)) timeoutMs = parseInteger(value, `--${parsed.name}`, 1_000, 300_000, errors);
    else if (parsed.name === 'max-requests') maxRequests = parseInteger(value, '--max-requests', 1, 100_000, errors);
  }

  if (help) return { ok: errors.length === 0, options: { command: 'help' }, errors, usage: CLI_USAGE };
  if (version) return { ok: errors.length === 0, options: { command: 'version' }, errors, usage: CLI_USAGE };
  command ??= 'run';
  if (command === 'verify') {
    if (manifestPath === undefined) manifestPath = positional.shift();
    if (!manifestPath) errors.push('verify requires a manifest path (use --manifest <path>).');
    if (positional.length) errors.push(`Unexpected positional arguments for verify: ${positional.join(', ')}.`);
    if (profiles.length || suites.length || cases.length || tags.length || changedFiles.length || repetitions !== undefined || concurrency !== undefined || timeoutMs !== undefined || maxRequests !== undefined || includeUnbound || failFast) errors.push('run-only options cannot be used with verify.');
    const options: CliVerifyOptions = { command, manifestPath: manifestPath ?? '', format, ...(outputPath ? { outputPath } : {}), noColor };
    return { ok: errors.length === 0, options: errors.length ? undefined : options, errors, usage: CLI_USAGE };
  }

  if (manifestPath !== undefined) errors.push('--manifest is only valid with verify.');
  const options: CliRunOptions = {
    command,
    configFiles: positional,
    selectors: {
      profiles: unique(profiles),
      suites: unique(suites),
      cases: unique(cases),
      tags: unique(tags),
      changedFiles: unique(changedFiles),
    },
    policy: {
      ...(repetitions !== undefined ? { repetitions } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxRequests !== undefined ? { maxRequests } : {}),
      failFast,
    },
    workspaceRoot,
    includeUnbound,
    caseIds: unique(cases),
    tags: unique(tags),
    format,
    ...(outputPath ? { outputPath } : {}),
    noColor,
  };
  return { ok: errors.length === 0, options: errors.length ? undefined : options, errors, usage: CLI_USAGE };
}

export const parseCli = parseCliArgs;
export const parseHeadlessArgs = parseCliArgs;

function splitFlag(value: string): { name: string; value?: string } | undefined {
  const normalized = value.startsWith('--') ? value.slice(2) : value.startsWith('-') ? value.slice(1) : '';
  if (!normalized) return undefined;
  const separator = normalized.indexOf('=');
  if (separator < 0) return { name: normalized };
  return { name: normalized.slice(0, separator), value: normalized.slice(separator + 1) };
}

function splitList(value: string, flag: string, errors: string[]): string[] {
  const values = value.split(',').map((item) => item.trim());
  if (values.some((item) => !item)) errors.push(`${flag} contains an empty selector.`);
  return values.filter(Boolean);
}

function parseInteger(value: string, flag: string, min: number, max: number, errors: string[]): number | undefined {
  if (!/^\d+$/.test(value)) { errors.push(`${flag} must be an integer from ${min} to ${max}.`); return undefined; }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) { errors.push(`${flag} must be an integer from ${min} to ${max}.`); return undefined; }
  return parsed;
}

function isSafeArgument(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !hasControlCharacters(value); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
