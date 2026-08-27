import { describe, expect, it } from 'vitest';
import type { ChatMessage, FormDefinition } from '../src/shared/types';
import { validateFormSubmission } from '../src/extension/editors/formSubmission';

function formMessage(messageId: string, form: FormDefinition): ChatMessage {
  return { id: messageId, role: 'assistant', status: 'completed', createdAt: 1, parts: [{ type: 'form', form }], citations: [], actions: [], followups: [] };
}

const form: FormDefinition = {
  type: 'form', id: 'details', title: 'Details',
  fields: [
    { id: 'name', type: 'text', label: 'Name', required: true, maxLength: 8, pattern: '^[A-Za-z]+$' },
    { id: 'count', type: 'number', label: 'Count' },
    { id: 'plan', type: 'select', label: 'Plan', options: [{ label: 'Basic', value: 'basic' }] },
    { id: 'agree', type: 'checkbox', label: 'Agree' },
  ],
  submit: { action: 'request.send', messageTemplate: 'Submit form', interactionKind: 'formSubmit' },
};

describe('host form submission validation', () => {
  it('binds duplicate form ids to the exact source message', () => {
    const older = structuredClone(form); older.submit.messageTemplate = 'old';
    const result = validateFormSubmission([formMessage('old-message', older), formMessage('new-message', form)], 'details', 'new-message', { name: 'Alice' });
    expect(result.form.submit.messageTemplate).toBe('Submit form');
    expect(() => validateFormSubmission([formMessage('old-message', older), formMessage('new-message', form)], 'details', undefined, { name: 'Alice' })).toThrow(/source message/);
  });

  it('accepts configured field values and rejects unknown fields or wrong types', () => {
    expect(validateFormSubmission([formMessage('message-1', form)], 'details', 'message-1', { name: 'Alice', count: '12', plan: 'basic', agree: true }).values).toEqual({ name: 'Alice', count: '12', plan: 'basic', agree: true });
    expect(() => validateFormSubmission([formMessage('message-1', form)], 'details', 'message-1', { name: 'Alice', extra: 'x' })).toThrow(/unknown field/);
    expect(() => validateFormSubmission([formMessage('message-1', form)], 'details', 'message-1', { name: 'Alice', agree: 'yes' })).toThrow(/checkbox/);
    expect(() => validateFormSubmission([formMessage('message-1', form)], 'details', 'message-1', { name: 'Alice', plan: 'enterprise' })).toThrow(/configured options/);
  });

  it('repeats required, length, numeric, and safe-pattern validation in the host', () => {
    const messages = [formMessage('message-1', form)];
    expect(() => validateFormSubmission(messages, 'details', 'message-1', {})).toThrow(/required/);
    expect(() => validateFormSubmission(messages, 'details', 'message-1', { name: 'LongerName' })).toThrow(/no more than/);
    expect(() => validateFormSubmission(messages, 'details', 'message-1', { name: 'Alice1' })).toThrow(/invalid format/);
    expect(() => validateFormSubmission(messages, 'details', 'message-1', { name: 'Alice', count: 'Infinity' })).toThrow(/finite number/);
    const unsafe = structuredClone(form); unsafe.fields[0]!.pattern = '(a+)+$';
    expect(() => validateFormSubmission([formMessage('message-1', unsafe)], 'details', 'message-1', { name: 'aaaa' })).toThrow(/unsafe validation pattern/);
  });
});
