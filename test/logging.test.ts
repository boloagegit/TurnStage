import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ level: 'info', workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: string) => mock.level ?? fallback) })) } }));
vi.mock('vscode', () => ({ workspace: mock.workspace }));

import { diagnosticUrl, diagnosticValue, logAt } from '../src/extension/logging';

describe('configured logging', () => {
  const output = { appendLine: vi.fn() };
  beforeEach(() => { output.appendLine.mockReset(); mock.level = 'info'; });

  it('filters messages below the configured detail level', () => {
    logAt(output, 'error', 'failed');
    logAt(output, 'debug', 'details');
    expect(output.appendLine).toHaveBeenCalledWith('[error] failed');
    expect(output.appendLine).not.toHaveBeenCalledWith('[debug] details');
  });

  it('writes debug messages when debug logging is enabled', () => {
    mock.level = 'debug';
    logAt(output, 'debug', 'details');
    expect(output.appendLine).toHaveBeenCalledWith('[debug] details');
  });

  it('removes credentials, query values, and fragments from diagnostic URLs', () => {
    expect(diagnosticUrl('https://user:password@example.test/chat/stream?token=secret#frame')).toBe('https://example.test/chat/stream');
    expect(diagnosticUrl('not a URL')).toBe('[invalid-url]');
  });

  it('keeps server-controlled diagnostic values on one bounded line', () => {
    expect(diagnosticValue('event\r\n[fake] injected')).toBe('event [fake] injected');
    expect(diagnosticValue('123456789', 5)).toBe('1234…');
  });
});
