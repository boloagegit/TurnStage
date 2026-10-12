import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/types';
import { promptBeforeReply } from '../src/shared/retryPrompt';

function message(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, role, status: 'completed', createdAt: 1, parts: [{ type: 'text', text }], citations: [], actions: [], followups: [] };
}

describe('Retry prompt', () => {
  const messages = [message('u1', 'user', 'FIRST prompt'), message('a1', 'assistant', 'Reply 1'), message('u2', 'user', 'SECOND prompt'), message('a2', 'assistant', 'Reply 2')];

  it('resends the prompt that produced the clicked reply', () => {
    expect(promptBeforeReply(messages, 'a1')).toBe('FIRST prompt');
    expect(promptBeforeReply(messages, 'a2')).toBe('SECOND prompt');
  });

  it('falls back to the latest prompt when the reply is unknown', () => {
    expect(promptBeforeReply(messages)).toBe('SECOND prompt');
    expect(promptBeforeReply(messages, 'missing')).toBe('SECOND prompt');
    expect(promptBeforeReply([message('a0', 'assistant', 'Opening')], 'a0')).toBeUndefined();
  });
});
