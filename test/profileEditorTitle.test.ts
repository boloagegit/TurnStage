import { describe, expect, it } from 'vitest';
import { profileEditorTitle } from '../src/extension/editors/profileEditorTitle';

describe('Profile editor title', () => {
  it('distinguishes a TurnStage custom editor from its JSONC backing file', () => {
    expect(profileEditorTitle('Slow SSE Visual Proof', 'slow-sse.turnstage.jsonc')).toBe('Slow SSE Visual Proof · TurnStage');
  });

  it('falls back to the resource title when a profile has no usable name', () => {
    expect(profileEditorTitle(' \n\t ', 'empty.turnstage.jsonc')).toBe('empty.turnstage.jsonc');
  });

  it('removes control characters and bounds long tab titles', () => {
    const title = profileEditorTitle(`Unsafe\u202ename ${'x'.repeat(100)}`, 'fallback.turnstage.jsonc');
    expect(title).not.toContain('\u202e');
    expect(title).toMatch(/… · TurnStage$/);
    expect(title.length).toBeLessThanOrEqual(92);
  });
});
