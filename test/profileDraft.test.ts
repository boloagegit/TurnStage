import { describe, expect, it } from 'vitest';
import { buildOpenAICompatibleProfileDraft } from '../src/extension/connection/profileDraft';
import { parseCurlCommand } from '../src/extension/connection/curlParser';
import { ProfileValidator } from '../src/extension/config/profileValidator';

describe('OpenAI-compatible profile draft builder', () => {
  it('creates a reviewable chat profile with dynamic input/model and canonical mappings', () => {
    const parsed = parseCurlCommand('curl https://api.example.test/v1/chat/completions -H "Authorization: Bearer sk-proj_12345678901234567890" -H "Content-Type: application/json" --data-raw \'{"model":"gpt-4o","messages":[{"role":"system","content":"PRIVATE SYSTEM PROMPT"},{"role":"user","content":"captured prompt"}],"tools":[{"type":"function","function":{"name":"private_tool","description":"PRIVATE TOOL DESCRIPTION"}}],"temperature":0.2,"stream":false}\'');
    const draft = buildOpenAICompatibleProfileDraft(parsed);
    expect(draft).toMatchObject({ format: 'turnstage-profile-draft', version: 1, safeForPersistence: true, source: { host: 'api.example.test', protocol: 'sse' } });
    expect(draft.profile).toMatchObject({ version: 1, id: 'api-example-test', conversation: { send: { method: 'POST', url: 'https://api.example.test/v1/chat/completions' } }, stream: { transport: 'sse', dataFormat: 'json', doneValue: '[DONE]' } });
    expect(draft.profile.conversation.send.headers?.Authorization).toBe('Bearer ${secret.apiToken}');
    expect(draft.profile.conversation.send.variants?.[0]?.body).toMatchObject({ model: { $value: 'controls.model' }, stream: true, temperature: 0.2, messages: [{ role: 'user', content: { $value: 'input.text' } }] });
    expect(JSON.stringify(draft)).not.toContain('PRIVATE SYSTEM PROMPT');
    expect(JSON.stringify(draft)).not.toContain('captured prompt');
    expect(JSON.stringify(draft)).not.toContain('PRIVATE TOOL DESCRIPTION');
    expect(draft.warnings).toContain('Captured messages, tool definitions, and response payload content are not copied into the draft.');
    expect(draft.profile.stream.mappings.map((mapping) => mapping.id)).toEqual(['content-delta', 'content-message', 'content-text', 'done', 'error']);
    expect(new ProfileValidator().validate(draft.profile).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('never persists header, URL-query, or body secret plaintext in the draft', () => {
    const secretHeader = 'sk-proj_12345678901234567890';
    const secretUrl = 'url-secret-987654321';
    const secretBody = 'body-secret-987654321';
    const draft = buildOpenAICompatibleProfileDraft(parseCurlCommand(`curl -X POST "https://api.example.test/v1/chat/completions?api_key=${secretUrl}" -H "Authorization: Bearer ${secretHeader}" -H "Content-Type: application/json" --data-raw '{"apiKey":"${secretBody}","messages":[]}'`));
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain(secretHeader);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).toContain('${secret.apiToken}');
    expect(serialized).toContain('${secret.apiKey}');
    expect(draft.requiredSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: 'header', referenceName: 'apiToken' }),
      expect.objectContaining({ location: 'url', referenceName: 'apiKey' }),
      expect.objectContaining({ location: 'body', referenceName: expect.stringMatching(/^apiKey/) }),
    ]));
  });

  it('fails closed for unknown header and query values while preserving protocol configuration', () => {
    const privateHeader = 'opaque-private-tenant-value';
    const privateQuery = 'customer-workspace-17';
    const draft = buildOpenAICompatibleProfileDraft(parseCurlCommand(`curl -X POST "https://api.example.test/v1/chat/completions?api-version=2026-08-01&workspace=${privateQuery}" -H "Accept: text/event-stream" -H "Content-Type: application/json" -H "X-Custom-Internal: ${privateHeader}" --data-raw '{"messages":[]}'`));
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain(privateHeader);
    expect(serialized).not.toContain(privateQuery);
    expect(draft.profile.conversation.send.url).toContain('api-version=2026-08-01');
    expect(draft.profile.conversation.send.url).toContain('workspace=${secret.queryWorkspace}');
    expect(draft.profile.conversation.send.headers).toMatchObject({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Custom-Internal': '${secret.headerXCustomInternal}',
    });
    expect(draft.requiredSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: 'header', headerName: 'X-Custom-Internal', referenceName: 'headerXCustomInternal' }),
      expect.objectContaining({ location: 'url', urlParameter: 'workspace', referenceName: 'queryWorkspace' }),
    ]));
  });

  it('does not retain captured user content and warns when the imported body is non-JSON', () => {
    const draft = buildOpenAICompatibleProfileDraft(parseCurlCommand('curl -X POST https://api.example.test/chat -H "Content-Type: text/plain" --data-raw "captured private prompt"'));
    expect(JSON.stringify(draft)).not.toContain('captured private prompt');
    expect(draft.warnings.some((warning) => warning.includes('not JSON'))).toBe(true);
    expect(draft.profile.conversation.send.variants?.[0]?.body).toMatchObject({ messages: [{ role: 'user', content: { $value: 'input.text' } }], stream: true });
  });

  it('rejects GET and protects profile identity/model bounds', () => {
    expect(() => buildOpenAICompatibleProfileDraft(parseCurlCommand('curl https://api.example.test/chat'))).toThrow(/POST/);
    const draft = buildOpenAICompatibleProfileDraft(parseCurlCommand('curl -X POST https://123.example.test/chat --data-raw \'{"messages":[]}\''), { id: '!!!', model: 'bad model' });
    expect(draft.profile.id).toBe('openai-compatible-chat');
    expect(draft.profile.controls?.[0]?.default).toBe('gpt-4o-mini');
    const secretModel = buildOpenAICompatibleProfileDraft(parseCurlCommand('curl -X POST https://api.example.test/chat --data-raw \'{"model":"sk-proj_12345678901234567890","messages":[]}\''));
    expect(JSON.stringify(secretModel)).not.toContain('sk-proj_12345678901234567890');
    expect(secretModel.profile.controls?.[0]?.default).toBe('gpt-4o-mini');
  });
});
