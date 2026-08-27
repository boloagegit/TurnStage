import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCESSIBLE_EVENT_WINDOW_SIZE, accessibleEventWindowStart, getRovingIndex, inspectorPanelId, inspectorTabId } from '../src/webview/main';

const root = resolve(import.meta.dirname, '..');
const mainSource = readFileSync(resolve(root, 'src/webview/main.tsx'), 'utf8');
const mobileSource = readFileSync(resolve(root, 'src/webview/MobileChatPreview.tsx'), 'utf8');
const mobileStyles = readFileSync(resolve(root, 'src/webview/mobileChatPreview.css'), 'utf8');
const baseStyles = readFileSync(resolve(root, 'src/webview/styles.css'), 'utf8');
const iconSource = readFileSync(resolve(root, 'src/webview/Icon.tsx'), 'utf8');

describe('Inspector keyboard helpers', () => {
  it('moves horizontal tabs with wrapping and Home/End', () => {
    expect(getRovingIndex(0, 'ArrowLeft', 4, 'horizontal')).toBe(3);
    expect(getRovingIndex(3, 'ArrowRight', 4, 'horizontal')).toBe(0);
    expect(getRovingIndex(2, 'Home', 4, 'horizontal')).toBe(0);
    expect(getRovingIndex(2, 'End', 4, 'horizontal')).toBe(3);
  });

  it('moves vertical event options with wrapping and ignores unrelated keys', () => {
    expect(getRovingIndex(0, 'ArrowUp', 3, 'vertical')).toBe(2);
    expect(getRovingIndex(2, 'ArrowDown', 3, 'vertical')).toBe(0);
    expect(getRovingIndex(1, 'Home', 3, 'vertical')).toBe(0);
    expect(getRovingIndex(1, 'End', 3, 'vertical')).toBe(2);
    expect(getRovingIndex(1, 'ArrowLeft', 3, 'vertical')).toBeUndefined();
    expect(getRovingIndex(1, 'Enter', 3, 'vertical')).toBeUndefined();
    expect(getRovingIndex(0, 'ArrowDown', 0, 'vertical')).toBeUndefined();
  });

  it('creates stable tab and panel IDs for the APG relationship', () => {
    expect(inspectorTabId('Raw Events')).toBe('inspector-tab-raw-events');
    expect(inspectorPanelId('Raw Events')).toBe('inspector-panel-raw-events');
    expect(inspectorTabId('Raw Events')).toBe(inspectorTabId('Raw Events'));
  });

  it('keeps message selection and its toolbar reachable without a mouse', () => {
    expect(mobileSource).toContain('tabIndex={onSelectMessage ? 0 : undefined}');
    expect(mobileSource).toContain('onKeyDown={onMessageKeyDown}');
    expect(mobileSource).toContain("event.key !== 'Enter' && event.key !== ' '");
    expect(mobileSource).toContain('role="group" aria-label={t(\'Message actions\')}');
    expect(mobileStyles).toContain('.mobile-chat-preview__message-toolbar {\n  display: flex;');
    expect(mobileStyles).toContain('pointer-events: none;');
  });

  it('keeps secret controls write-only in the preview and clears local drafts after submit', () => {
    expect(mobileSource).toContain("control.persist === 'secret'");
    expect(mobileSource).toContain('type="password"');
    expect(mobileSource).toContain('autoComplete="new-password"');
    expect(mobileSource).toContain('delete next[controlId]');
  });

  it('uses codicons and explicit static reduced-motion states', () => {
    expect(iconSource).not.toContain('<svg');
    expect(iconSource).toContain("stop: 'debug-stop'");
    expect(mobileSource).toContain("<ProductIcon name={active ? 'stop' : 'send'} />");
    expect(mobileStyles).not.toContain('0.001ms');
    expect(mobileStyles).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(mobileStyles).toContain('animation: none;');
    expect(baseStyles).not.toContain('transition-duration: 0s');
    expect(baseStyles).not.toContain('animation-duration: 0s');
  });

  it('keeps splitter semantics and visual initialization on the same state', () => {
    expect(mainSource).toContain('const trackSizes = splitTrackSizes(splitPercent');
    expect(mainSource).toContain('!hasConfiguredRightWidth || splitCustomized');
    expect(mainSource).toContain('const occupied = previewRect.width');
    expect(mainSource).toContain('preview.getBoundingClientRect()');
    expect(mainSource).toContain('previewRect.width >= workspaceRect.width - 1');
    expect(mainSource).toContain('splitCustomized, selectedMessageId');
    expect(mainSource).toContain('setSplitCustomized(true)');
    expect(mainSource).toContain('aria-valuenow={Math.round(splitPercent)}');
    expect(mainSource).toContain("'--preview-size': trackSizes.preview");
    expect(mainSource).toContain("'--inspector-size': trackSizes.inspector");
    expect(baseStyles).toContain('@media (max-width: 64em)');
    expect(baseStyles).toContain('var(--preview-size, 64fr)');
    expect(baseStyles).toContain('var(--inspector-size, 36fr)');
    expect(mobileSource).toContain('Math.max(0.1, Math.min(1, widthScale, heightScale))');
  });

  it('uses logical directional CSS and keeps long-script content breakable', () => {
    expect(mobileStyles).toContain('inset-inline: 0;');
    expect(mobileStyles).toContain('margin-inline: auto;');
    expect(mobileStyles).toContain('border-end-end-radius: 3px;');
    expect(mobileStyles).toContain('overflow-wrap: anywhere;');
    expect(mobileStyles).not.toMatch(/(?:^|[;{\s])(margin|padding|border|inset)-(?:left|right)\s*:/i);
    expect(baseStyles).toContain('border-inline-start: 1px solid');
    expect(baseStyles).toContain('border-inline-end: 1px solid');
    expect(baseStyles).not.toMatch(/(?:^|[;{\s])(margin|padding|border|inset)-(?:left|right)\s*:/i);
    expect(baseStyles).not.toContain('box-shadow: inset 2px 0');
  });

  it('bounds screen-reader event rendering while retaining full-list positions', () => {
    expect(ACCESSIBLE_EVENT_WINDOW_SIZE).toBeLessThan(1000);
    expect(accessibleEventWindowStart(0, 1000)).toBe(0);
    expect(accessibleEventWindowStart(500, 1000)).toBe(400);
    expect(accessibleEventWindowStart(999, 1000)).toBe(800);
    expect(mainSource).toContain('event-accessibility-notice');
    expect(mainSource).toContain('aria-setsize={items.length}');
    expect(mainSource).toContain('aria-posinset={itemIndex + 1}');
    expect(mainSource).not.toContain('const visible = screenReader ? items :');
  });
});
