import { describe, expect, it } from 'vitest';
import { CurlParseError, MAX_CURL_INPUT_BYTES, parseCurlCommand } from '../src/extension/connection/curlParser';

function expectCode(command: string, code: CurlParseError['code']): void {
  try { parseCurlCommand(command); throw new Error('expected parse to fail'); }
  catch (error) { expect(error).toBeInstanceOf(CurlParseError); expect((error as CurlParseError).code).toBe(code); }
}

describe('safe cURL parser', () => {
  it('parses quoted JSON, Chinese text, headers, and an explicit method without executing a shell', () => {
    const parsed = parseCurlCommand(String.raw`curl -X POST 'https://api.example.test/v1/chat/completions' -H 'Authorization: Bearer sk-test_12345678901234567890' -H 'Content-Type: application/json' --data-raw '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"請用中文回答"}],"stream":true}'`);
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toBe('https://api.example.test/v1/chat/completions');
    expect(parsed.headers).toMatchObject({ Authorization: 'Bearer sk-test_12345678901234567890', 'Content-Type': 'application/json' });
    expect(parsed.body).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: '請用中文回答' }], stream: true });
    expect(parsed.secretSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: 'header', headerName: 'Authorization', referenceName: 'apiToken' }),
    ]));
  });

  it('parses Windows curl.exe quoting and escaped JSON quotes', () => {
    const parsed = parseCurlCommand(String.raw`curl.exe "https://api.example.test/v1/chat/completions" -H "Content-Type: application/json" -H "api-key: win-key-123" --data-raw "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"`);
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toMatchObject({ model: 'gpt-4o-mini', messages: [{ content: '你好' }] });
    expect(parsed.secretSuggestions[0]).toMatchObject({ location: 'header', referenceName: 'apiKey' });
  });

  it('keeps literal dollar text inside single-quoted JSON while rejecting shell expansion in double quotes', () => {
    const parsed = parseCurlCommand('curl https://example.test/chat --data-raw \'{"metadata":{"$schema":"literal"},"messages":[]}\'');
    expect(parsed.body).toMatchObject({ metadata: { $schema: 'literal' } });
    expectCode('curl https://example.test/chat --data-raw "{\\"token\\":\\"$TOKEN\\"}"', 'unsafe-syntax');
  });

  it('accepts common harmless flags but does not silently accept unsupported behavior', () => {
    const parsed = parseCurlCommand('curl --silent --show-error --compressed --no-buffer --http1.1 --request POST --url https://example.test/chat --json \'{"message":"hello"}\'');
    expect(parsed.dataFlags).toEqual(['--json']);
    expect(parsed.headers['Content-Type']).toBe('application/json');
    expectCode('curl --location https://example.test/chat', 'unsupported-flag');
    expectCode('curl --config ./request.conf https://example.test/chat', 'unsupported-flag');
  });

  it('rejects shell injection, expansion, response files, malformed quotes, and duplicate request fields', () => {
    expectCode('curl https://example.test/$(touch /tmp/pwned)', 'unsafe-syntax');
    expectCode('curl https://example.test/chat -H "X-Token: $TOKEN"', 'unsafe-syntax');
    expectCode('curl https://example.test/chat --data @request.json', 'response-file');
    expectCode('curl https://example.test/chat --data-raw \'{bad}\'', 'invalid-json-body');
    expectCode('curl "https://example.test/chat', 'unterminated-quote');
    expectCode('curl https://example.test/chat https://example.test/other', 'duplicate-url');
    expectCode('curl -X POST -X GET https://example.test/chat', 'duplicate-method');
    expectCode('curl -H "X-Test: one" -H "x-test: two" https://example.test/chat', 'duplicate-header');
  });

  it('rejects non-http schemes, embedded credentials, oversized commands, and unsafe body shapes', () => {
    expectCode('curl file:///tmp/request.json', 'unsupported-url-scheme');
    expectCode('curl https://user:password@example.test/chat', 'embedded-url-credentials');
    expectCode(`curl https://example.test/chat --data-raw '${'x'.repeat(MAX_CURL_INPUT_BYTES)}'`, 'input-too-large');
    expectCode(`curl https://example.test/chat --data-raw '{bad}' -H 'Content-Type: application/json'`, 'invalid-json-body');
    const tooDeep = JSON.stringify({ a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: { a: 1 } } } } } } } } } } } } });
    expectCode(`curl https://example.test/chat --data-raw '${tooDeep}'`, 'body-too-complex');
  });

  it('identifies sensitive URL query and body locations without copying their values into suggestions', () => {
    const parsed = parseCurlCommand('curl -X POST "https://example.test/chat?api_key=url-secret-123&tenant=demo" -H "Content-Type: application/json" --data-raw \'{"credentials":{"access_token":"body-secret"},"messages":[]}\'');
    expect(parsed.secretSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: 'url', urlParameter: 'api_key', referenceName: 'apiKey' }),
      expect.objectContaining({ location: 'body', bodyPath: 'body.credentials.access_token', referenceName: 'apiToken' }),
    ]));
    expect(parsed.secretSuggestions.every((item) => !JSON.stringify(item).includes('url-secret-123') && !JSON.stringify(item).includes('body-secret'))).toBe(true);
  });

  it('marks token-like URL path values as secret locations', () => {
    const parsed = parseCurlCommand('curl https://example.test/v1/sk-proj_12345678901234567890/chat');
    expect(parsed.secretSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: 'url', urlPath: 'path', reason: 'token-like-value' }),
    ]));
  });
});
