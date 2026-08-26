import { describe, expect, it } from 'vitest';
import { parseSampleEvent } from '../src/webview/configEditors';

describe('Sample Event tester parser', () => {
  it('parses SSE event and JSON data while preserving the pasted raw text', () => {
    const result = parseSampleEvent('event: message\ndata: {"text":"hello"}\n', 'sse');
    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({ protocol: 'sse', eventName: 'message', raw: 'event: message\ndata: {"text":"hello"}\n', data: { text: 'hello' } });
  });

  it('accepts a raw JSON event envelope and rejects oversized/invalid input', () => {
    expect(parseSampleEvent('{"event":"done","data":{}}', 'json').input).toMatchObject({ eventName: 'done', data: {} });
    expect(parseSampleEvent('{bad', 'json').error).toMatch(/not valid JSON/);
    expect(parseSampleEvent('x'.repeat(262_145), 'text-stream').error).toMatch(/256 KiB/);
  });
});
