import { describe, expect, it } from 'vitest';
import { NdjsonParser, SseParser, toRawEvent, type ParsedSse } from '../src/extension/transport/streamParser';

describe('SseParser', () => {
  it('keeps an event across arbitrary chunk boundaries', () => {
    const parser = new SseParser();

    expect(parser.feed('ev')).toEqual([]);
    expect(parser.feed('ent: message\nda')).toEqual([]);
    expect(parser.feed('ta: {"text":"hel')).toEqual([]);
    expect(parser.feed('lo"}\n\n')).toEqual([
      {
        event: 'message',
        data: '{"text":"hello"}',
        raw: 'event: message\ndata: {"text":"hello"}',
      },
    ]);
  });

  it('joins multiline data fields with a newline and parses SSE metadata', () => {
    const parser = new SseParser();

    const events = parser.feed(
      ': keep-alive\r\n' +
      'event: delta\r\n' +
      'id: response-7\r\n' +
      'retry: 1500\r\n' +
      'data: first\r\n' +
      'data: second\r\n\r\n',
    );

    expect(events).toEqual([
      {
        event: 'delta',
        id: 'response-7',
        retry: 1500,
        data: 'first\nsecond',
        raw: ': keep-alive\nevent: delta\nid: response-7\nretry: 1500\ndata: first\ndata: second',
      },
    ]);
  });

  it('does not dispatch comments or events without data', () => {
    const parser = new SseParser();

    expect(parser.feed(': heartbeat\n\n')).toEqual([]);
    expect(parser.feed('event: no-data\n\n')).toEqual([]);
    expect(parser.feed('data: yes\n\n')).toHaveLength(1);
  });

  it('finishes a partial final event without a blank-line terminator', () => {
    const parser = new SseParser();

    expect(parser.feed('event: message\ndata: tail')).toEqual([]);
    expect(parser.finish()).toEqual([
      {
        event: 'message',
        data: 'tail',
        raw: 'event: message\ndata: tail',
      },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it('ignores NUL-containing ids and invalid retry values', () => {
    const parser = new SseParser();
    const [event] = parser.feed('id: bad\0id\nretry: 1.5\ndata: value\n\n') as [ParsedSse];

    expect(event).toMatchObject({ data: 'value' });
    expect(event.id).toBeUndefined();
    expect(event.retry).toBeUndefined();
  });
});

describe('NdjsonParser', () => {
  it('buffers partial lines and handles CRLF boundaries', () => {
    const parser = new NdjsonParser();

    expect(parser.feed('{"n":1}\r\n{"n":')).toEqual(['{"n":1}']);
    expect(parser.feed('2}\n\n  \r\n{"n":3}')).toEqual(['{"n":2}']);
    expect(parser.finish()).toEqual(['{"n":3}']);
  });

  it('returns a non-newline-terminated final line only from finish', () => {
    const parser = new NdjsonParser();

    expect(parser.feed(' {"ok":true} ')).toEqual([]);
    expect(parser.finish()).toEqual(['{"ok":true}']);
  });
});

describe('toRawEvent', () => {
  it('parses JSON payloads while preserving [DONE] as a string sentinel', () => {
    const startedAt = Date.now() - 10;
    const sse: ParsedSse = { event: 'done', data: '[DONE]', raw: 'event: done\ndata: [DONE]' };

    const done = toRawEvent('sse', sse.raw, 4, startedAt, sse);
    const json = toRawEvent('ndjson', '{"text":"hello"}', 5, startedAt);
    const malformed = toRawEvent('ndjson', '{not-json}', 6, startedAt);

    expect(done).toMatchObject({
      sequence: 4,
      protocol: 'sse',
      raw: sse.raw,
      data: '[DONE]',
      sse: { event: 'done' },
    });
    expect(done.parseError).toBeUndefined();
    expect(json.data).toEqual({ text: 'hello' });
    expect(malformed.data).toBe('{not-json}');
    expect(malformed.parseError).toEqual(expect.any(String));
    expect(done.receivedAt).toBeGreaterThanOrEqual(startedAt);
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
