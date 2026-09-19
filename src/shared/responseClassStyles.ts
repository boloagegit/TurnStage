export const RESPONSE_CLASS_STYLE_PROPERTIES = [
  'backgroundColor',
  'alignItems',
  'borderBottomColor',
  'borderBottomStyle',
  'borderBottomWidth',
  'borderColor',
  'borderRadius',
  'borderStyle',
  'borderTopColor',
  'borderTopStyle',
  'borderTopWidth',
  'borderWidth',
  'color',
  'display',
  'flex',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'height',
  'justifyContent',
  'lineHeight',
  'listStyle',
  'margin',
  'marginBlock',
  'marginInline',
  'marginLeft',
  'marginTop',
  'maxHeight',
  'maxWidth',
  'overflow',
  'padding',
  'paddingBlock',
  'paddingBottom',
  'paddingInline',
  'paddingTop',
  'textAlign',
  'textDecoration',
  'whiteSpace',
  'width',
] as const;

export type ResponseClassStyleProperty = typeof RESPONSE_CLASS_STYLE_PROPERTIES[number];
export type ResponseClassStyle = Partial<Record<ResponseClassStyleProperty, string>>;
export type ResponseClassStyles = Record<string, ResponseClassStyle>;
export type ResponseStyleRules = Record<string, ResponseClassStyle>;

export const MAX_RESPONSE_CLASSES = 64;
export const MAX_RESPONSE_CLASS_PROPERTIES = 40;
export const MAX_RESPONSE_STYLE_RULES = 64;
export const RESPONSE_CLASS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const RESPONSE_CLASS_SELECTOR = String.raw`\.[A-Za-z_][A-Za-z0-9_-]{0,63}`;
const RESPONSE_TAG_SELECTOR = String.raw`(?:a|blockquote|br|code|div|em|h[1-6]|img|li|ol|p|pre|section|span|strong|table|tbody|td|th|thead|tr|ul)`;
const RESPONSE_SIMPLE_SELECTOR = String.raw`(?:${RESPONSE_CLASS_SELECTOR}|${RESPONSE_TAG_SELECTOR})`;
const RESPONSE_PSEUDO_SELECTOR = String.raw`:(?:hover|active|focus|focus-visible|focus-within|first-child|last-child|only-child|first-of-type|last-of-type|disabled|checked)`;
const RESPONSE_HAS_SELECTOR = String.raw`:has\(${RESPONSE_SIMPLE_SELECTOR}\)`;
const RESPONSE_COMPOUND_SELECTOR = String.raw`${RESPONSE_SIMPLE_SELECTOR}(?:${RESPONSE_CLASS_SELECTOR}|${RESPONSE_PSEUDO_SELECTOR}|${RESPONSE_HAS_SELECTOR}){0,7}`;
const RESPONSE_STYLE_SELECTOR_PATTERN = new RegExp(String.raw`^${RESPONSE_COMPOUND_SELECTOR}(?:(?:\s*[>+]\s*|\s+)${RESPONSE_COMPOUND_SELECTOR}){0,3}$`, 'u');

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^;{}]*\)|var\(--vscode-[a-z0-9-]+\)|[a-z]{3,24})$/iu;
const FONT_WEIGHT = /^(?:normal|bold|[1-9]00)$/u;
const FONT_STYLE = /^(?:normal|italic|oblique)$/u;
const TEXT_ALIGN = /^(?:start|end|left|right|center|justify)$/u;
const TEXT_DECORATION = /^(?:none|underline|line-through)$/u;
const WHITE_SPACE = /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/u;
const BORDER_STYLE = /^(?:none|solid|dashed|dotted|double)$/u;
const DISPLAY = /^(?:block|flex|grid|inline|inline-block|inline-flex|none)$/u;
const JUSTIFY_CONTENT = /^(?:start|end|left|right|center|space-between|space-around|space-evenly)$/u;
const ALIGN_ITEMS = /^(?:start|end|center|stretch|baseline)$/u;
const OVERFLOW = /^(?:visible|hidden|clip|auto|scroll)$/u;
const LIST_STYLE = /^(?:none|disc|circle|square|decimal)$/u;
const FLEX = /^(?:none|auto|initial|[0-9](?:\s+[0-9])?(?:\s+(?:auto|0|\d+(?:\.\d+)?(?:px|rem|em|%)))?)$/u;
const STYLE_PROPERTIES = new Set<string>(RESPONSE_CLASS_STYLE_PROPERTIES);

export function isSafeResponseClassStyleProperty(value: string): value is ResponseClassStyleProperty {
  return STYLE_PROPERTIES.has(value);
}

export function isSafeResponseClassStyleValue(property: ResponseClassStyleProperty, value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 96 || /[;{}\\]|url\s*\(|expression\s*\(|@import/iu.test(value)) return false;
  const trimmed = value.trim();
  if (property === 'color' || property === 'backgroundColor' || property.endsWith('Color')) return COLOR.test(trimmed);
  if (property === 'fontWeight') return FONT_WEIGHT.test(trimmed);
  if (property === 'fontStyle') return FONT_STYLE.test(trimmed);
  if (property === 'textAlign') return TEXT_ALIGN.test(trimmed);
  if (property === 'textDecoration') return TEXT_DECORATION.test(trimmed);
  if (property === 'whiteSpace') return WHITE_SPACE.test(trimmed);
  if (property === 'listStyle') return LIST_STYLE.test(trimmed);
  if (property === 'borderStyle' || property.endsWith('BorderStyle') || /^border(?:Top|Bottom)Style$/u.test(property)) return BORDER_STYLE.test(trimmed);
  if (property === 'display') return DISPLAY.test(trimmed);
  if (property === 'justifyContent') return JUSTIFY_CONTENT.test(trimmed);
  if (property === 'alignItems') return ALIGN_ITEMS.test(trimmed);
  if (property === 'overflow') return OVERFLOW.test(trimmed);
  if (property === 'flex') return FLEX.test(trimmed);
  if (property === 'fontSize') return safeLengths(trimmed, 1, 64);
  if (['width', 'height', 'maxWidth', 'maxHeight'].includes(property)) return safeDimensions(trimmed);
  if (property === 'lineHeight') return safeLineHeight(trimmed);
  if (property === 'borderWidth' || property.endsWith('Width')) return safeLengths(trimmed, 1, 8);
  return safeLengths(trimmed, 4, 64);
}

export function normalizeResponseClassStyles(value: unknown): ResponseClassStyles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: ResponseClassStyles = {};
  for (const [className, candidate] of Object.entries(value).slice(0, MAX_RESPONSE_CLASSES)) {
    if (!RESPONSE_CLASS_NAME_PATTERN.test(className) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const style: ResponseClassStyle = {};
    for (const [property, raw] of Object.entries(candidate).slice(0, MAX_RESPONSE_CLASS_PROPERTIES)) {
      if (isSafeResponseClassStyleProperty(property) && isSafeResponseClassStyleValue(property, raw)) style[property] = raw.trim();
    }
    if (Object.keys(style).length) result[className] = style;
  }
  return result;
}

export function isSafeResponseStyleSelector(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && RESPONSE_STYLE_SELECTOR_PATTERN.test(value.trim());
}

export function normalizeResponseStyleRules(value: unknown): ResponseStyleRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: ResponseStyleRules = {};
  for (const [selector, candidate] of Object.entries(value).slice(0, MAX_RESPONSE_STYLE_RULES)) {
    if (!isSafeResponseStyleSelector(selector) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const style: ResponseClassStyle = {};
    for (const [property, raw] of Object.entries(candidate).slice(0, MAX_RESPONSE_CLASS_PROPERTIES)) {
      if (isSafeResponseClassStyleProperty(property) && isSafeResponseClassStyleValue(property, raw)) style[property] = raw.trim();
    }
    if (Object.keys(style).length) result[normalizeResponseStyleSelector(selector)] = style;
  }
  return result;
}

export function responseStyleRuleClassNames(rules: ResponseStyleRules): Set<string> {
  const result = new Set<string>();
  for (const selector of Object.keys(rules)) {
    for (const match of selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]{0,63})/gu)) result.add(match[1]!);
  }
  return result;
}

export function scopedResponseStyleSheet(scope: string, rules: ResponseStyleRules, classStyles: ResponseClassStyles = {}): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(scope)) return '';
  return [
    ...Object.entries(classStyles).map(([className, style]) => scopedRule(scope, `.${className}`, style)),
    ...Object.entries(rules).map(([selector, style]) => scopedRule(scope, selector, style)),
  ].join('\n');
}

function scopedRule(scope: string, selector: string, style: ResponseClassStyle): string {
  const declarations = Object.entries(style).map(([property, value]) => `${camelToKebab(property)}:${value}`).join(';');
  return `[data-response-style-scope="${scope}"] ${selector}{${declarations}}`;
}

function normalizeResponseStyleSelector(value: string): string {
  return value.trim().replace(/\s*([>+])\s*/gu, ' $1 ').replace(/\s+/gu, ' ');
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function safeLengths(value: string, maxTokens: number, maxPx: number): boolean {
  const tokens = value.split(/\s+/u);
  return tokens.length <= maxTokens && tokens.every((token) => {
    if (token === '0') return true;
    const match = /^(\d+(?:\.\d+)?)(px|rem|em|%)$/u.exec(token);
    if (!match) return false;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return false;
    if (match[2] === 'px') return amount <= maxPx;
    if (match[2] === '%') return amount <= 100;
    return amount <= 4;
  });
}

function safeLineHeight(value: string): boolean {
  const unitless = Number(value);
  if (Number.isFinite(unitless) && unitless >= 1 && unitless <= 2) return true;
  return safeLengths(value, 1, 40);
}

function safeDimensions(value: string): boolean {
  if (value === 'auto') return true;
  const match = /^(\d+(?:\.\d+)?)(px|rem|em|%)$/u.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return false;
  if (match[2] === 'px') return amount <= 4096;
  if (match[2] === '%') return amount <= 100;
  return amount <= 128;
}
