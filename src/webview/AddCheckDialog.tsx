import React, { useId, useState } from 'react';
import { CaseEditorOverlay } from './CaseEditorOverlay';
import { ClipboardButton } from './ClipboardButton';
import type { CheckTarget, EventCheckKind, EventCheckOption } from './eventCheck';
import { t } from './i18n';

const KIND_LABELS: Record<EventCheckKind, string> = {
  'event-type': 'The case produces a {value} event',
  'reply-contains': 'The final reply contains “{value}”',
  'tool-called': 'The tool {value} is called',
};

/** Turns an inspected event into a check on a General case, after the user picks what to check and where. */
export function AddCheckDialog({ options, targets, readOnly, onAdd, onClose }: {
  options: readonly EventCheckOption[];
  targets: readonly CheckTarget[];
  readOnly: boolean;
  onAdd: (option: EventCheckOption, target: CheckTarget) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [optionIndex, setOptionIndex] = useState(0);
  const [targetKey, setTargetKey] = useState(targets[0]?.key ?? '');
  const name = useId();
  const option = options[optionIndex] ?? options[0];
  // Linked cases can arrive after the dialog opens; until the user picks one, the first case is the target.
  const target = targets.find((item) => item.key === targetKey) ?? targets[0];
  const disabled = readOnly || !option || !target;
  return <CaseEditorOverlay title={t('Add check from event')} className="add-check-dialog" closeLabel={t('Cancel')} onRequestClose={onClose} footer={<>
    {option && <ClipboardButton text={JSON.stringify(option.assertion, null, 2)} label={t('Copy check as JSON')} />}
    <button type="button" onClick={onClose}>{t('Cancel')}</button>
    <button type="button" className="primary" disabled={disabled} onClick={() => { if (option && target) onAdd(option, target); }}>{t('Add check')}</button>
  </>}>
    <fieldset className="add-check-dialog__options">
      <legend>{t('What to check')}</legend>
      {options.map((item, index) => <label key={item.kind}><input type="radio" name={name} checked={index === optionIndex} onChange={() => setOptionIndex(index)} /><span>{t(KIND_LABELS[item.kind], { value: item.value })}</span></label>)}
    </fieldset>
    {targets.length
      ? <label className="add-check-dialog__target"><span>{t('Add to case')}</span><select value={target?.key ?? ''} onChange={(event) => setTargetKey(event.target.value)}>{targets.map((item) => <option key={item.key} value={item.key}>{item.kind === 'linked' && item.suiteName ? `${item.name} · ${item.suiteName}` : item.name}</option>)}</select></label>
      : <p className="add-check-dialog__empty">{t('No General cases yet. Save this conversation as a test first, or copy the check as JSON.')}</p>}
    {readOnly && <p className="add-check-dialog__empty">{t('This Profile is read-only. Copy the check as JSON, or duplicate the Profile to edit its cases.')}</p>}
    <p className="add-check-dialog__hint">{t('The check runs after the case’s last turn, so it holds whichever turn produced the event.')}</p>
  </CaseEditorOverlay>;
}
