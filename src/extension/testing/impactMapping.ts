/**
 * Host-independent source-to-behavior impact mapping.
 *
 * This module deliberately does not infer line coverage or inspect source code.
 * A test is selected only when an explicit binding intersects a changed path or
 * an explicitly supplied change label. This keeps the result explainable and
 * prevents a guessed mapping from being presented as proof of coverage.
 */

import type { ScenarioSourceBinding } from '../../shared/types';

export const MAX_IMPACT_CHANGED_FILES = 10_000;
export const MAX_IMPACT_TESTS = 10_000;
export const MAX_SOURCE_GLOBS_PER_BINDING = 100;
export const MAX_SOURCE_LABELS_PER_BINDING = 100;
export const MAX_SOURCE_PATTERN_LENGTH = 512;
export const MAX_SOURCE_PATH_LENGTH = 4_096;

export type SourceBinding = ScenarioSourceBinding;

/** A case may use either the nested binding or the direct fields for migration compatibility. */
export interface ImpactTestCase {
  id: string;
  name?: string;
  tags?: readonly string[];
  sourceBinding?: SourceBinding;
  sourceGlobs?: readonly string[];
  components?: readonly string[];
  endpoints?: readonly string[];
  riskTags?: readonly string[];
}

export interface ImpactTestSuite {
  id?: string;
  sourceBinding?: SourceBinding;
  sourceGlobs?: readonly string[];
  components?: readonly string[];
  endpoints?: readonly string[];
  riskTags?: readonly string[];
  cases: readonly ImpactTestCase[];
}

export interface ChangedSourceFile {
  path: string;
  components?: readonly string[];
  endpoints?: readonly string[];
  riskTags?: readonly string[];
}

export type ChangedSource = string | ChangedSourceFile;

export interface ImpactMappingOptions {
  /** An absolute workspace root may turn absolute Git paths into relative paths. */
  workspaceRoot?: string;
  /** Select unbound cases explicitly. Defaults to false to avoid claiming impact without evidence. */
  includeUnbound?: boolean;
  /** A manual case selection is authoritative and is included in the reason list. */
  caseIds?: readonly string[];
  /** A manual tag selection is authoritative and is included in the reason list. */
  tags?: readonly string[];
  /** Git paths are case-sensitive by default even when the host filesystem is not. */
  caseSensitive?: boolean;
}

export type ImpactReasonKind = 'sourceGlob' | 'component' | 'endpoint' | 'riskTag' | 'manual' | 'unbound' | 'noMatch';

export interface ImpactReason {
  kind: ImpactReasonKind;
  binding: string;
  changedFiles: string[];
  message: string;
}

export interface ImpactCandidate {
  id: string;
  name?: string;
  suiteId?: string;
  binding: SourceBinding;
  selected: boolean;
  matchedFiles: string[];
  reasons: ImpactReason[];
}

export interface ImpactDiagnostic {
  scope: string;
  message: string;
}

export interface ImpactMappingResult {
  changedFiles: string[];
  selected: ImpactCandidate[];
  omitted: ImpactCandidate[];
  diagnostics: ImpactDiagnostic[];
}

interface NormalizedChangedSource {
  path: string;
  components: string[];
  endpoints: string[];
  riskTags: string[];
}

interface NormalizedBinding {
  binding: SourceBinding;
  diagnostics: ImpactDiagnostic[];
}

/**
 * Select cases affected by changed files and explicit change labels.
 * All returned arrays are deterministic and bounded by the input limits.
 */
export function mapChangedFilesToTests(
  changedSources: readonly ChangedSource[],
  testCases: readonly ImpactTestCase[],
  options: ImpactMappingOptions = {},
): ImpactMappingResult {
  const diagnostics: ImpactDiagnostic[] = [];
  const changed = normalizeChangedSources(changedSources, options, diagnostics);
  const caseLimit = Math.min(testCases.length, MAX_IMPACT_TESTS);
  if (testCases.length > MAX_IMPACT_TESTS) diagnostics.push({ scope: 'cases', message: `Only the first ${MAX_IMPACT_TESTS} cases were considered.` });

  const manualCaseIds = new Set(normalizeLabels(options.caseIds, 'caseIds', diagnostics));
  const manualTags = new Set(normalizeLabels(options.tags, 'tags', diagnostics));
  const compiledCache = new Map<string, RegExp | undefined>();
  const selected: ImpactCandidate[] = [];
  const omitted: ImpactCandidate[] = [];

  for (let index = 0; index < caseLimit; index += 1) {
    const testCase = testCases[index];
    if (!testCase || typeof testCase !== 'object') {
      diagnostics.push({ scope: `cases[${index}]`, message: 'Case must be an object.' });
      continue;
    }
    const scope = `cases[${index}]${testCase.id ? `(${testCase.id})` : ''}`;
    const normalized = normalizeBinding(testCase, undefined, scope);
    diagnostics.push(...normalized.diagnostics);
    const binding = normalized.binding;
    const reasons: ImpactReason[] = [];
    const matchedFiles = new Set<string>();

    const manualId = typeof testCase.id === 'string' && manualCaseIds.has(testCase.id);
    const manualTag = manualTags.size > 0 && (testCase.tags ?? []).some((tag) => typeof tag === 'string' && manualTags.has(tag.trim()));
    if (manualId || manualTag) {
      const label = manualId ? `case id ${testCase.id}` : 'requested tag';
      reasons.push({ kind: 'manual', binding: label, changedFiles: [], message: `Selected by explicit ${label} override.` });
    }

    for (const pattern of binding.sourceGlobs ?? []) {
      const cacheKey = `${options.caseSensitive === false ? 'i' : 's'}\u0000${pattern}`;
      let matcher = compiledCache.get(cacheKey);
      if (!compiledCache.has(cacheKey)) {
        matcher = compileSourceGlob(pattern, options.caseSensitive !== false);
        compiledCache.set(cacheKey, matcher);
      }
      if (!matcher) continue;
      const matchingFiles = changed.filter((item) => matcher!.test(item.path)).map((item) => item.path);
      if (matchingFiles.length) {
        for (const path of matchingFiles) matchedFiles.add(path);
        reasons.push({
          kind: 'sourceGlob',
          binding: pattern,
          changedFiles: matchingFiles,
          message: `Selected because changed file${matchingFiles.length === 1 ? '' : 's'} ${formatList(matchingFiles)} ${matchingFiles.length === 1 ? 'matches' : 'match'} source glob "${pattern}".`,
        });
      }
    }

    addLabelReasons('component', binding.components, changed, matchedFiles, reasons);
    addLabelReasons('endpoint', binding.endpoints, changed, matchedFiles, reasons);
    addLabelReasons('riskTag', binding.riskTags, changed, matchedFiles, reasons);

    const hasBinding = hasSourceBinding(binding);
    if (!hasBinding && !reasons.length) {
      if (options.includeUnbound) reasons.push({ kind: 'unbound', binding: 'none', changedFiles: [], message: 'Selected because unbound cases were explicitly included.' });
      else reasons.push({ kind: 'noMatch', binding: 'none', changedFiles: [], message: 'Omitted because the case has no explicit source binding.' });
    } else if (hasBinding && !reasons.length) {
      reasons.push({ kind: 'noMatch', binding: 'explicit binding', changedFiles: [], message: 'Omitted because no changed file or change label matched its explicit binding.' });
    }

    const candidate: ImpactCandidate = {
      id: typeof testCase.id === 'string' ? testCase.id : `case-${index + 1}`,
      ...(typeof testCase.name === 'string' ? { name: testCase.name } : {}),
      binding,
      selected: reasons.some((reason) => reason.kind !== 'noMatch'),
      matchedFiles: [...matchedFiles].sort(comparePaths),
      reasons: sortReasons(reasons),
    };
    if (candidate.selected) selected.push(candidate);
    else omitted.push(candidate);
  }

  return {
    changedFiles: changed.map((item) => item.path),
    selected: sortCandidates(selected),
    omitted: sortCandidates(omitted),
    diagnostics,
  };
}

/** Map a suite while inheriting suite-level bindings into each case. */
export function mapSuiteImpact(
  changedSources: readonly ChangedSource[],
  suite: ImpactTestSuite,
  options: ImpactMappingOptions = {},
): ImpactMappingResult {
  const diagnostics: ImpactDiagnostic[] = [];
  const cases = suite.cases.map((testCase, index) => {
    const normalized = normalizeBinding(testCase, suite, `suite${suite.id ? `(${suite.id})` : ''}.cases[${index}]`);
    diagnostics.push(...normalized.diagnostics);
    return { ...testCase, sourceBinding: normalized.binding };
  });
  const result = mapChangedFilesToTests(changedSources, cases, options);
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}

/** Backward-compatible aliases for callers that use selection terminology. */
export const selectImpactedTests = mapChangedFilesToTests;
export const mapSourceImpact = mapChangedFilesToTests;

export function normalizeSourcePath(value: unknown, workspaceRoot?: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_SOURCE_PATH_LENGTH || hasControlCharacters(value)) return undefined;
  let path = value.replaceAll('\\', '/');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return undefined;
  const absolute = isAbsolutePath(path);
  if (absolute) {
    const root = workspaceRoot ? normalizeAbsolutePath(workspaceRoot) : undefined;
    if (!root || !isPathWithinRoot(path, root)) return undefined;
    path = path.slice(root.length).replace(/^\/+/, '');
  }
  while (path.startsWith('./')) path = path.slice(2);
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) return undefined;
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized || undefined;
}

export function isSafeSourceGlob(value: unknown): value is string {
  return normalizeSourceGlob(value) !== undefined;
}

/** Return true when one normalized path matches one bounded source glob. */
export function matchesSourceGlob(path: string, pattern: string, caseSensitive = true): boolean {
  const normalizedPath = normalizeSourcePath(path);
  const normalizedPattern = normalizeSourceGlob(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  const matcher = compileSourceGlob(normalizedPattern, caseSensitive);
  return Boolean(matcher?.test(normalizedPath));
}

export function validateSourceBinding(value: unknown, scope = 'sourceBinding'): ImpactDiagnostic[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ scope, message: 'Source binding must be an object.' }];
  const diagnostics: ImpactDiagnostic[] = [];
  for (const key of Object.keys(value)) if (!['sourceGlobs', 'components', 'endpoints', 'riskTags'].includes(key)) diagnostics.push({ scope: `${scope}.${key}`, message: `Unsupported source binding field: ${key}.` });
  const record = value as Record<string, unknown>;
  validateStringList(record.sourceGlobs, `${scope}.sourceGlobs`, MAX_SOURCE_GLOBS_PER_BINDING, MAX_SOURCE_PATTERN_LENGTH, diagnostics, true);
  for (const key of ['components', 'endpoints', 'riskTags']) validateStringList(record[key], `${scope}.${key}`, MAX_SOURCE_LABELS_PER_BINDING, 256, diagnostics, false);
  return diagnostics;
}

function normalizeChangedSources(values: readonly ChangedSource[], options: ImpactMappingOptions, diagnostics: ImpactDiagnostic[]): NormalizedChangedSource[] {
  const result: NormalizedChangedSource[] = [];
  const seen = new Set<string>();
  const limit = Math.min(values.length, MAX_IMPACT_CHANGED_FILES);
  if (values.length > MAX_IMPACT_CHANGED_FILES) diagnostics.push({ scope: 'changedFiles', message: `Only the first ${MAX_IMPACT_CHANGED_FILES} changed files were considered.` });
  for (let index = 0; index < limit; index += 1) {
    const value = values[index];
    const rawPath = typeof value === 'string' ? value : value && typeof value === 'object' ? value.path : undefined;
    const path = normalizeSourcePath(rawPath, options.workspaceRoot);
    if (!path) {
      diagnostics.push({ scope: `changedFiles[${index}]`, message: 'Changed path must be a workspace-relative, normalized path.' });
      continue;
    }
    const source = typeof value === 'string' ? undefined : value;
    const components = normalizeLabels(source?.components, `changedFiles[${index}].components`, diagnostics);
    const endpoints = normalizeLabels(source?.endpoints, `changedFiles[${index}].endpoints`, diagnostics);
    const riskTags = normalizeLabels(source?.riskTags, `changedFiles[${index}].riskTags`, diagnostics);
    const key = `${path}\u0000${components.join(',')}\u0000${endpoints.join(',')}\u0000${riskTags.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path, components, endpoints, riskTags });
  }
  return result.sort((a, b) => comparePaths(a.path, b.path));
}

function normalizeBinding(testCase: ImpactTestCase, suite: ImpactTestSuite | undefined, scope: string): NormalizedBinding {
  const diagnostics = [
    ...(testCase.sourceBinding ? validateSourceBinding(testCase.sourceBinding, `${scope}.sourceBinding`) : []),
    ...(suite?.sourceBinding ? validateSourceBinding(suite.sourceBinding, `${scope}.suiteSourceBinding`) : []),
  ];
  const binding: SourceBinding = {
    sourceGlobs: uniqueStrings([
      ...(suite ? directBinding(suite).sourceGlobs : []),
      ...(suite?.sourceBinding?.sourceGlobs ?? []),
      ...directBinding(testCase).sourceGlobs,
      ...(testCase.sourceBinding?.sourceGlobs ?? []),
    ], `${scope}.sourceGlobs`, diagnostics, true),
    components: uniqueStrings([
      ...(suite ? directBinding(suite).components : []),
      ...(suite?.sourceBinding?.components ?? []),
      ...directBinding(testCase).components,
      ...(testCase.sourceBinding?.components ?? []),
    ], `${scope}.components`, diagnostics, false),
    endpoints: uniqueStrings([
      ...(suite ? directBinding(suite).endpoints : []),
      ...(suite?.sourceBinding?.endpoints ?? []),
      ...directBinding(testCase).endpoints,
      ...(testCase.sourceBinding?.endpoints ?? []),
    ], `${scope}.endpoints`, diagnostics, false),
    riskTags: uniqueStrings([
      ...(suite ? directBinding(suite).riskTags : []),
      ...(suite?.sourceBinding?.riskTags ?? []),
      ...directBinding(testCase).riskTags,
      ...(testCase.sourceBinding?.riskTags ?? []),
    ], `${scope}.riskTags`, diagnostics, false),
  };
  return { binding, diagnostics };
}

function directBinding(value: ImpactTestCase | ImpactTestSuite): Required<SourceBinding> {
  return {
    sourceGlobs: Array.isArray(value.sourceGlobs) ? value.sourceGlobs : [],
    components: Array.isArray(value.components) ? value.components : [],
    endpoints: Array.isArray(value.endpoints) ? value.endpoints : [],
    riskTags: Array.isArray(value.riskTags) ? value.riskTags : [],
  };
}

function normalizeSourceGlob(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SOURCE_PATTERN_LENGTH || hasControlCharacters(value)) return undefined;
  let pattern = value.replaceAll('\\', '/').trim();
  if (pattern.startsWith('!') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(pattern) || isAbsolutePath(pattern)) return undefined;
  while (pattern.startsWith('./')) pattern = pattern.slice(2);
  const segments = pattern.split('/');
  if (!segments.length || segments.some((segment) => segment === '..')) return undefined;
  pattern = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!pattern || pattern.includes('[') && !hasBalancedClass(pattern)) return undefined;
  return pattern;
}

function compileSourceGlob(pattern: string, caseSensitive: boolean): RegExp | undefined {
  const normalized = normalizeSourceGlob(pattern);
  if (!normalized) return undefined;
  const alternatives = expandBraces(normalized);
  if (!alternatives.length) return undefined;
  const source = alternatives.map((item) => globToRegexSource(item)).join('|');
  try { return new RegExp(`^(?:${source})$`, caseSensitive ? '' : 'i'); } catch { return undefined; }
}

function globToRegexSource(pattern: string): string {
  const anyDepth = !pattern.includes('/');
  let source = anyDepth ? '(?:.*/)?' : '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
      continue;
    }
    if (character === '?') { source += '[^/]'; continue; }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end > index + 1) {
        let content = pattern.slice(index + 1, end);
        if (content[0] === '!') content = `^${content.slice(1)}`;
        if (content[0] === '^') content = `\\${content}`;
        source += `[${content.replaceAll('\\', '\\\\')}]`;
        index = end;
        continue;
      }
    }
    source += escapeRegex(character ?? '');
  }
  return source;
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  if (start < 0) return [pattern];
  const end = pattern.indexOf('}', start + 1);
  if (end < 0) return [pattern];
  const choices = pattern.slice(start + 1, end).split(',');
  if (choices.length < 2 || choices.some((choice) => !choice)) return [pattern];
  const expanded: string[] = [];
  for (const choice of choices.slice(0, 16)) {
    for (const suffix of expandBraces(`${pattern.slice(0, start)}${choice}${pattern.slice(end + 1)}`)) {
      expanded.push(suffix);
      if (expanded.length >= 16) return expanded;
    }
  }
  return expanded;
}

function addLabelReasons(kind: 'component' | 'endpoint' | 'riskTag', bindings: readonly string[] | undefined, changed: readonly NormalizedChangedSource[], matchedFiles: Set<string>, reasons: ImpactReason[]): void {
  if (!bindings?.length) return;
  const key = kind === 'component' ? 'components' : kind === 'endpoint' ? 'endpoints' : 'riskTags';
  for (const binding of bindings) {
    const matchingFiles = changed.filter((item) => item[key].includes(binding)).map((item) => item.path);
    if (!matchingFiles.length) continue;
    for (const path of matchingFiles) matchedFiles.add(path);
    reasons.push({
      kind,
      binding,
      changedFiles: matchingFiles,
      message: `Selected because changed file${matchingFiles.length === 1 ? '' : 's'} ${formatList(matchingFiles)} ${matchingFiles.length === 1 ? 'declares' : 'declare'} ${kind} "${binding}".`,
    });
  }
}

function hasSourceBinding(binding: SourceBinding): boolean { return Boolean(binding.sourceGlobs?.length || binding.components?.length || binding.endpoints?.length || binding.riskTags?.length); }

function normalizeLabels(value: readonly string[] | undefined, scope: string, diagnostics: ImpactDiagnostic[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { diagnostics.push({ scope, message: 'Expected an array of strings.' }); return []; }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 256).map((item) => item.trim()).filter((item, index, list) => list.indexOf(item) === index).slice(0, MAX_SOURCE_LABELS_PER_BINDING);
}

function uniqueStrings(value: readonly unknown[], scope: string, diagnostics: ImpactDiagnostic[], glob: boolean): string[] {
  const normalized: string[] = [];
  const max = glob ? MAX_SOURCE_GLOBS_PER_BINDING : MAX_SOURCE_LABELS_PER_BINDING;
  for (const item of value.slice(0, max)) {
    const normalizedItem = glob ? normalizeSourceGlob(item) : typeof item === 'string' && item.trim() && item.length <= 256 ? item.trim() : undefined;
    if (!normalizedItem) {
      if (item !== undefined) diagnostics.push({ scope, message: glob ? `Invalid source glob: ${String(item)}.` : 'Source labels must be non-empty strings of up to 256 characters.' });
      continue;
    }
    if (!normalized.includes(normalizedItem)) normalized.push(normalizedItem);
  }
  if (value.length > max) diagnostics.push({ scope, message: `Only the first ${max} binding values were considered.` });
  return normalized;
}

function validateStringList(value: unknown, scope: string, max: number, maxLength: number, diagnostics: ImpactDiagnostic[], glob: boolean): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength || (glob && !normalizeSourceGlob(item)))) diagnostics.push({ scope, message: glob ? `Source globs must contain at most ${max} safe workspace-relative patterns.` : `Labels must contain at most ${max} non-empty strings of up to ${maxLength} characters.` });
}

function sortCandidates(values: readonly ImpactCandidate[]): ImpactCandidate[] { return [...values].sort((a, b) => a.id.localeCompare(b.id)); }

function sortReasons(values: readonly ImpactReason[]): ImpactReason[] {
  return [...values].sort((a, b) => a.kind.localeCompare(b.kind) || a.binding.localeCompare(b.binding) || a.message.localeCompare(b.message));
}

function comparePaths(a: string, b: string): number { return a.localeCompare(b); }
function formatList(values: readonly string[]): string { return values.map((value) => `"${value}"`).join(', '); }
function escapeRegex(value: string): string { return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'); }
function isAbsolutePath(value: string): boolean { return value.startsWith('/') || /^\/?[A-Za-z]:\//.test(value); }
function normalizeAbsolutePath(value: string): string { return value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, ''); }
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function isPathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedRoot = normalizeAbsolutePath(root);
  const foldedPath = normalizedPath.toLowerCase();
  const foldedRoot = normalizedRoot.toLowerCase();
  return foldedPath === foldedRoot || foldedPath.startsWith(`${foldedRoot}/`);
}
function hasBalancedClass(value: string): boolean {
  let open = false;
  for (const character of value) {
    if (character === '[') open = true;
    if (character === ']') open = false;
  }
  return !open;
}
