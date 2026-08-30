export const MAX_REGEX_PATTERN_LENGTH = 256;

/** Conservative guard for user-authored JavaScript regexes used on runtime data. */
export function isSafeRegexPattern(pattern: unknown, maxLength = MAX_REGEX_PATTERN_LENGTH): pattern is string {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  if (/\\(?:[1-9]|k<)/u.test(pattern)) return false;
  if (/\(\?(?:[=!]|<[=!])/u.test(pattern)) return false;
  if (/(?:\.\*|\.\+)[\s\S]*(?:\.\*|\.\+)/u.test(pattern)) return false;
  if (hasRiskyQuantifiedGroup(pattern)) return false;
  try { new RegExp(pattern, 'u'); return true; } catch { return false; }
}

function hasRiskyQuantifiedGroup(pattern: string): boolean {
  const stack: Array<{ alternation: boolean; quantifier: boolean }> = [];
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') { stack.push({ alternation: false, quantifier: false }); continue; }
    if (char === '|') { if (stack.length) stack[stack.length - 1]!.alternation = true; continue; }
    if (char === '*' || char === '+' || char === '{') { if (stack.length) stack[stack.length - 1]!.quantifier = true; continue; }
    if (char !== ')') continue;
    const group = stack.pop();
    if (!group) continue;
    const next = pattern[index + 1];
    const groupIsQuantified = next === '*' || next === '+' || next === '{';
    if (groupIsQuantified && (group.alternation || group.quantifier)) return true;
    if (stack.length && (group.quantifier || groupIsQuantified)) stack[stack.length - 1]!.quantifier = true;
  }
  return false;
}
