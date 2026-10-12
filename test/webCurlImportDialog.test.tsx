// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurlImportDialog } from '../web/src/CurlImportDialog';

const labels = { curlTitle: 'Create profile from cURL', curlHint: 'Paste a cURL command.', curlCommand: 'cURL command', curlCreate: 'Create profile', curlCancel: 'Cancel', curlFailed: 'Could not create a profile from this cURL.' };

afterEach(cleanup);

describe('Create profile from cURL dialog', () => {
  it('keeps the dialog open with the error until the command creates a Profile', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCreate = vi.fn().mockReturnValueOnce('Could not create a profile from this cURL. Unsupported flag.').mockReturnValueOnce(undefined);
    render(<CurlImportDialog open labels={labels} onClose={onClose} onCreate={onCreate} />);
    const field = screen.getByRole('textbox', { name: 'cURL command' });
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(labels.curlFailed);
    await user.type(field, 'curl https://x.test --bogus');
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(screen.getByRole('alert').textContent).toContain('Unsupported flag');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(onCreate).toHaveBeenLastCalledWith('curl https://x.test --bogus');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
