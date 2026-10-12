import type { ChatMessage } from './types';

function messageText(message: ChatMessage): string {
  return message.parts.filter((part) => part.type === 'text' || part.type === 'markdown').map((part) => part.text).join('');
}

/**
 * The prompt a Retry on `sourceMessageId` should resend: the user message just before that reply.
 * Without a source (or when it is gone) this is the latest user message.
 */
export function promptBeforeReply(messages: readonly ChatMessage[], sourceMessageId?: string): string | undefined {
  const sourceIndex = sourceMessageId ? messages.findIndex((message) => message.id === sourceMessageId) : -1;
  const end = sourceIndex >= 0 ? sourceIndex : messages.length;
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const text = messageText(message);
    if (text.trim()) return text;
  }
  return undefined;
}
