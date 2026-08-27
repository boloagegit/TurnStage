import type { ChatMessage, FormDefinition } from '../../shared/types';
import { localize } from '../l10n';

export interface ValidatedFormSubmission { form: FormDefinition; values: Record<string, unknown> }

/** Resolve a form against its source message, then repeat all client validation in the host. */
export function validateFormSubmission(messages: ChatMessage[], formId: string, sourceMessageId: string | undefined, submitted: Record<string, unknown>): ValidatedFormSubmission {
  const candidates = messages.flatMap((message) => message.parts
    .filter((part): part is typeof part & { form: FormDefinition } => part.type === 'form' && isFormDefinition(part.form))
    .filter((part) => part.form.id === formId)
    .map((part) => ({ message, form: part.form })));
  const selected = sourceMessageId
    ? candidates.find((candidate) => candidate.message.id === sourceMessageId)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) throw new Error(localize('The submitted form no longer matches its source message.'));

  const fieldIds = selected.form.fields.map((field) => field.id);
  if (new Set(fieldIds).size !== fieldIds.length) throw new Error(localize('The form contains duplicate field ids.'));
  for (const key of Object.keys(submitted)) if (!fieldIds.includes(key)) throw new Error(localize('The form submission contains an unknown field: {field}.', { field: key }));

  const values: Record<string, unknown> = {};
  for (const field of selected.form.fields) {
    const value = submitted[field.id];
    const empty = value === undefined || value === '' || value === false;
    if (field.required && empty) throw new Error(localize('{field} is required.', { field: field.label }));
    if (value === undefined) continue;
    if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error(localize('{field} must be a checkbox value.', { field: field.label }));
      values[field.id] = value;
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(localize('{field} has an invalid value type.', { field: field.label }));
    const text = String(value);
    if (text.length > (field.maxLength ?? 1_048_576)) throw new Error(localize('Use no more than {count} characters.', { count: String(field.maxLength ?? 1_048_576) }));
    if (field.type === 'number' && text !== '' && !Number.isFinite(Number(text))) throw new Error(localize('{field} must be a finite number.', { field: field.label }));
    if (field.type === 'select' && text !== '' && !field.options?.some((option) => option.value === text)) throw new Error(localize('{field} must use one of the configured options.', { field: field.label }));
    if (field.pattern && text) {
      if (field.pattern.length > 256 || /\([^)]*[+*][^)]*\)[+*]/.test(field.pattern)) throw new Error(localize('The profile contains an unsafe validation pattern.'));
      let pattern: RegExp;
      try { pattern = new RegExp(field.pattern); } catch { throw new Error(localize('The profile contains an invalid validation pattern.')); }
      if (!pattern.test(text.slice(0, 4096))) throw new Error(localize('{field} has an invalid format.', { field: field.label }));
    }
    values[field.id] = value;
  }
  return { form: selected.form, values };
}

function isFormDefinition(value: unknown): value is FormDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const form = value as Partial<FormDefinition>;
  return form.type === 'form' && typeof form.id === 'string' && typeof form.title === 'string' && Array.isArray(form.fields)
    && form.fields.length <= 256
    && form.fields.every((field) => Boolean(field) && typeof field.id === 'string' && typeof field.label === 'string' && ['text', 'textarea', 'tel', 'email', 'number', 'select', 'checkbox'].includes(field.type))
    && Boolean(form.submit) && typeof form.submit?.messageTemplate === 'string';
}
