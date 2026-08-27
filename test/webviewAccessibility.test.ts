import { describe, expect, it } from 'vitest';
import { getRovingIndex, inspectorPanelId, inspectorTabId } from '../src/webview/main';

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
});
