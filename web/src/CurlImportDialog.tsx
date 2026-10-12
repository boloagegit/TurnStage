import React, { useEffect, useId, useRef, useState } from 'react';

export interface CurlImportLabels {
  curlTitle: string;
  curlHint: string;
  curlCommand: string;
  curlCreate: string;
  curlCancel: string;
  curlFailed: string;
}

/**
 * Modal for creating a Profile from a pasted cURL command. `onCreate` returns
 * an error message to keep the dialog open, or nothing once the Profile exists.
 */
export function CurlImportDialog({ open, labels, onClose, onCreate }: { open: boolean; labels: CurlImportLabels; onClose: () => void; onCreate: (command: string) => string | undefined }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string>();
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setCommand('');
      setError(undefined);
      if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', '');
      requestAnimationFrame(() => field.current?.focus());
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close(); else element.removeAttribute('open');
    }
  }, [open]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!command.trim()) { setError(labels.curlFailed); field.current?.focus(); return; }
    const failure = onCreate(command);
    if (failure) { setError(failure); field.current?.focus(); return; }
    onClose();
  };
  return <dialog ref={dialog} className="curl-import" aria-labelledby={titleId} aria-describedby={hintId} onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form method="dialog" onSubmit={submit}>
      <h2 id={titleId}>{labels.curlTitle}</h2>
      <p id={hintId} className="curl-import__hint">{labels.curlHint}</p>
      <label className="curl-import__field">
        <span>{labels.curlCommand}</span>
        <textarea ref={field} value={command} rows={8} spellCheck={false} autoComplete="off" placeholder="curl https://api.example.com/v1/chat/completions -H 'Authorization: Bearer …' -d '{…}'" aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={(event) => { setCommand(event.target.value); setError(undefined); }} />
      </label>
      {error && <p id={errorId} className="curl-import__error" role="alert">{error}</p>}
      <div className="curl-import__actions">
        <button type="button" onClick={onClose}>{labels.curlCancel}</button>
        <button type="submit" className="primary">{labels.curlCreate}</button>
      </div>
    </form>
  </dialog>;
}
