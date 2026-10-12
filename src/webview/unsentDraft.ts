import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { SessionSnapshot } from '../shared/types';

const ACTIVE_TURN_STATES = new Set<SessionSnapshot['turnState']>(['submitting', 'waitingStart', 'streaming', 'stopping']);

interface PendingSend { text: string; lastUserMessageId?: string; restored: boolean }

function lastUserMessageId(snapshot: SessionSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) if (snapshot.messages[index]!.role === 'user') return snapshot.messages[index]!.id;
  return undefined;
}

/**
 * The composer clears as soon as a message is sent, but the host adds the user message only after the request is
 * built and authorized. When the turn settles without that message (a declined connection prompt or a request
 * that could not be built), put the text back so it is not lost.
 */
export function useRestoreUnsentDraft(snapshot: SessionSnapshot | undefined, setDraft: Dispatch<SetStateAction<string>>): (text: string) => void {
  const pending = useRef<PendingSend | undefined>(undefined);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    const current = pending.current;
    if (!current || !snapshot) return;
    if (lastUserMessageId(snapshot) !== current.lastUserMessageId && snapshot.messages.some((message) => message.role === 'user')) {
      pending.current = undefined;
      if (current.restored) setDraft((draft) => draft === current.text ? '' : draft);
      return;
    }
    if (!current.restored && !ACTIVE_TURN_STATES.has(snapshot.turnState)) {
      current.restored = true;
      setDraft((draft) => draft || current.text);
    }
  }, [snapshot, setDraft]);
  return useCallback((text: string) => { pending.current = { text, lastUserMessageId: lastUserMessageId(snapshotRef.current), restored: false }; }, []);
}
