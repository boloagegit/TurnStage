import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ level: 'info', workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn((_key: string, fallback: string) => mock.level ?? fallback) })) } }));
vi.mock('vscode', () => ({ workspace: mock.workspace }));

import { diagnosticUrl, diagnosticValue, logAt, resetLoggingForTests, startLogOperation } from '../src/extension/logging';

describe('configured logging', () => {
  const output = { appendLine: vi.fn() };
  beforeEach(() => { output.appendLine.mockReset(); mock.workspace.getConfiguration.mockClear(); mock.level = 'info'; resetLoggingForTests(); });

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

  it('caches the configured level and never evaluates disabled lazy messages', () => {
    const message = vi.fn(() => 'expensive details');
    for (let index = 0; index < 10_000; index += 1) logAt(output, 'debug', message);
    expect(message).not.toHaveBeenCalled();
    expect(mock.workspace.getConfiguration).toHaveBeenCalledTimes(1);
    expect(output.appendLine).not.toHaveBeenCalled();
  });

  it('uses native log channel severity methods when available', () => {
    const native = { appendLine: vi.fn(), info: vi.fn() };
    logAt(native, 'info', 'ready');
    expect(native.info).toHaveBeenCalledWith('ready');
    expect(native.appendLine).not.toHaveBeenCalled();
  });

  it('records one bounded operation lifecycle without duplicating terminal states', () => {
    const operation = startLogOperation(output, 'Campaign', 'Run Tests', { cases: 100 });
    operation.progress({ completed: 50 });
    operation.complete({ completed: 100 });
    operation.fail({ reason: 'late-error' });
    expect(output.appendLine).toHaveBeenCalledTimes(3);
    expect(output.appendLine.mock.calls[0]?.[0]).toContain('campaign-1');
    expect(output.appendLine.mock.calls[2]?.[0]).toContain('state=completed');
    expect(output.appendLine.mock.calls.flat().join('\n')).not.toContain('late-error');
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
