import { describe, expect, it } from 'vitest';
import { isHostMessage, isWebviewMessage, isWorkspaceSection, PROTOCOL_VERSION, WORKSPACE_SECTIONS } from '../src/shared/protocol';

describe('workspace section protocol', () => {
  it('accepts every section exposed by the profile tree', () => {
    expect(WORKSPACE_SECTIONS.every(isWorkspaceSection)).toBe(true);
  });

  it('rejects legacy workspace tabs and untrusted values', () => {
    expect(isWorkspaceSection('Settings')).toBe(false);
    expect(isWorkspaceSection('runs')).toBe(false);
    expect(isWorkspaceSection({ section: 'test' })).toBe(false);
  });
});

describe('cross-boundary message validation', () => {
  const envelope = { protocolVersion: PROTOCOL_VERSION, editorInstanceId: 'editor-1', requestId: 'request-1' };

  it('accepts valid Webview payloads and rejects unknown or malformed nested values', () => {
    expect(isWebviewMessage({ ...envelope, type: 'request.send', text: 'hello', interaction: { kind: 'manual' } }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'unknown.command' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'request.send', text: 'hello', interaction: { kind: 'made-up' } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'form.submit', formId: 'form-1', values: [] }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'profile.patch', path: ['ui', '__proto__'], value: true }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'run.replay.speed', speed: 99 }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'run.import' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'uri.open', uri: 'https://example.test/docs' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.file', action: 'importCsv' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'test.evidence.open', evidenceId: 'evidence-1', location: { kind: 'network', networkId: 'network-1' } }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'test.evidence.open', evidenceId: 'evidence-1', location: { kind: 'rawEvent', sequence: -1 } }, 'editor-1')).toBe(false);
  });

  it('bounds cyclic, deep, oversized, and wrong-instance messages', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let deep: Record<string, unknown> = {}; const root = deep;
    for (let index = 0; index < 30; index++) { const next: Record<string, unknown> = {}; deep.next = next; deep = next; }
    expect(isWebviewMessage({ ...envelope, type: 'control.set', controlId: 'control', value: cyclic }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'control.set', controlId: 'control', value: root }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'request.send', text: 'x'.repeat(1024 * 1024 + 1), interaction: { kind: 'manual' } }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'webview.ready' }, 'editor-2')).toBe(false);
  });

  it('validates Host messages before the Webview consumes them', () => {
    expect(isHostMessage({ ...envelope, type: 'host.ready', trusted: true, locale: 'zh-tw', direction: 'ltr' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'workspace.section', section: 'legacy' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'profile.validation', diagnostics: [{ severity: 'fatal', message: 'bad', offset: 0, length: 1 }] }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'profile.validated', valid: true }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'profile.validated', valid: 'yes' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'action.feedback', actionId: 'message.copy', sourceMessageId: 'message-1', status: 'success', message: 'Message copied.' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'action.feedback', actionId: 'message.copy', sourceMessageId: 'message-1', status: 'pending', message: 'Copying' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'session.snapshot', snapshot: {}, runs: [], networkEntries: [{ id: 'network-1', kind: 'stream', state: 'completed' }] }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'session.snapshot', snapshot: {}, runs: [], networkEntries: 'not-an-array' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'run.imported', path: 'file:///run.json', runId: 'run-1', duplicate: false }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'run.imported', path: 'file:///run.json', runId: 'run-1', duplicate: 'no' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'form.accepted', formId: 'form-1', sourceMessageId: 'message-1' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'workspaceTrust.changed', trusted: 'yes' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.results', results: [] }, 'editor-1')).toBe(true);
  });

  it('accepts bounded inspector focus targets and rejects invalid selections', () => {
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Network', evidenceId: 'evidence-1', networkId: 'network-2' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Raw Events', sequence: 12 }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Normalized', sequence: 3, messageId: 'assistant-1' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Events', sequence: 1 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Raw Events', sequence: -1 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Raw Events', sequence: 1.5 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Raw Events', sequence: '1' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Network', networkId: 'x'.repeat(1025) }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'inspector.focus', tab: 'Network', evidenceId: 'x'.repeat(1025) }, 'editor-1')).toBe(false);
  });
});
