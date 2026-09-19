import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfileCodec } from '../src/extension/config/profileCodec';
import { ProfileValidator } from '../src/extension/config/profileValidator';
import {
  isSafeResponseStyleSelector,
  normalizeResponseStyleRules,
  responseStyleRuleClassNames,
  scopedResponseStyleSheet,
} from '../src/shared/responseClassStyles';

describe('response style rules', () => {
  it('ships a complete importable Profile example', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../examples/response-style-rules.jsonc'), 'utf8');
    const parsed = new ProfileCodec().parse(source);
    expect(parsed.errors).toEqual([]);
    expect(new ProfileValidator().validate(parsed.profile, parsed.tree)).toEqual([]);
  });

  it('accepts the documented bounded class selector grammar', () => {
    for (const selector of [
      '.card .detail',
      '.card > .title',
      '.item + .item',
      '.card.featured:hover',
      '.card:focus-within > .action:focus-visible',
      '.list > .item:first-child',
      '.body ul > li',
      '.body:has(p) ul',
      '.cover img',
    ]) expect(isSafeResponseStyleSelector(selector), selector).toBe(true);
  });

  it('rejects selectors that could target application or unbounded document structure', () => {
    for (const selector of [
      'body .card',
      '.card, .other',
      '.card::before',
      '.card:has(body .secret)',
      '.card:has(*)',
      '.card[data-state="open"]',
      '#app .card',
      '* > .card',
      '.card ~ .card',
      '.one .two .three .four .five',
    ]) expect(isSafeResponseStyleSelector(selector), selector).toBe(false);
  });

  it('normalizes selectors and values before generating a response-scoped stylesheet', () => {
    const rules = normalizeResponseStyleRules({
      ' .card>.title ': { color: '#123456', position: 'fixed' },
      '.item + .item': { marginBlock: '6px', backgroundColor: 'url(https://bad.test/x)' },
      'body .card': { color: 'red' },
    });
    expect(rules).toEqual({
      '.card > .title': { color: '#123456' },
      '.item + .item': { marginBlock: '6px' },
    });
    expect(responseStyleRuleClassNames(rules)).toEqual(new Set(['card', 'title', 'item']));
    expect(scopedResponseStyleSheet('response-one', rules, { card: { padding: '8px' } })).toBe(
      '[data-response-style-scope="response-one"] .card{padding:8px}\n'
      + '[data-response-style-scope="response-one"] .card > .title{color:#123456}\n'
      + '[data-response-style-scope="response-one"] .item + .item{margin-block:6px}',
    );
    expect(scopedResponseStyleSheet('bad scope', rules)).toBe('');
  });
});
