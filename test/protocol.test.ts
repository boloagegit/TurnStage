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
    expect(isWebviewMessage({ ...envelope, type: 'run.delete', runId: 'run-1' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'run.delete', runId: '' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'run.clear' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'profile.save' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'artifact.action', artifactId: 'artifact-1', action: 'open' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'artifact.action', artifactId: '', action: 'open' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'artifact.action', artifactId: 'artifact-1', action: 'delete' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'uri.open', uri: 'https://example.test/docs' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.file', action: 'importCsv' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.file', action: 'linkSuite' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.openLinkedSuite', path: 'tests/safety.adversarial.csv' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.openLinkedSuite', path: '' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.catalog.request', force: true }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.catalog.request', force: 'yes' }, 'editor-1')).toBe(false);
    const linkedScenario = { id: 'case-1', name: 'Case 1', steps: [{ id: 'turn-1', input: 'hello' }], adversarial: { forbid: { urls: true } } };
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.case.request', sourcePath: 'tests/safety.adversarial.csv', scenarioId: 'case-1' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.case.request', sourcePath: '', scenarioId: 'case-1' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.case.save', sourcePath: 'tests/safety.adversarial.csv', scenarioId: 'case-1', expectedRevision: 'a'.repeat(64), scenario: linkedScenario }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'adversarial.case.save', sourcePath: 'tests/safety.adversarial.csv', scenarioId: 'case-1', expectedRevision: 'stale', scenario: linkedScenario }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'test.cancel' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'connection.analyze' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'test.evidence.open', evidenceId: 'evidence-1', location: { kind: 'network', networkId: 'network-1' } }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'test.report.export', format: 'html', evidenceId: 'evidence-1' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'test.report.export', format: 'csv' }, 'editor-1')).toBe(false);
    expect(isWebviewMessage({ ...envelope, type: 'test.evidenceBundle.export' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'campaign.cancel', campaignId: 'release' }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'campaign.cancel', campaignId: '' }, 'editor-1')).toBe(false);
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
    expect(isHostMessage({ ...envelope, type: 'workspace.navigate', destination: { pane: 'adversarial', section: 'results' } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'workspace.navigate', destination: { pane: 'adversarial', section: 'unknown' } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'profile.editState', dirty: true }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'profile.validation', diagnostics: [{ severity: 'fatal', message: 'bad', offset: 0, length: 1 }] }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'profile.validated', valid: true }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'profile.validated', valid: 'yes' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'action.feedback', actionId: 'message.copy', sourceMessageId: 'message-1', status: 'success', message: 'Message copied.' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'action.feedback', actionId: 'message.copy', sourceMessageId: 'message-1', status: 'pending', message: 'Copying' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'session.snapshot', snapshot: {}, runs: [], networkEntries: [{ id: 'network-1', kind: 'stream', state: 'completed' }] }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'session.snapshot', snapshot: {}, runs: [], networkEntries: 'not-an-array' }, 'editor-1')).toBe(false);
    const sessionDelta = { baseSessionId: 'session-1', core: { sessionId: 'session-1', sessionState: 'active', turnState: 'streaming', metrics: {}, errors: [], droppedEventCount: 0, trusted: true, controls: {} }, rawEvents: { append: [] }, normalizedEvents: { append: [] }, messages: { removeIds: [], upsert: [] } };
    expect(isHostMessage({ ...envelope, type: 'session.delta', delta: sessionDelta }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'session.delta', delta: { ...sessionDelta, baseSessionId: 'other' } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'session.delta', delta: { ...sessionDelta, messages: { removeIds: [''], upsert: [] } } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'run.imported', path: 'file:///run.json', runId: 'run-1', duplicate: false }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'run.imported', path: 'file:///run.json', runId: 'run-1', duplicate: 'no' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'run.history.changed', deletedCount: 2, deletedBytes: 2048 }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'run.history.changed', deletedCount: -1, deletedBytes: 0 }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'run.history.changed', deletedCount: 1, deletedBytes: Number.MAX_SAFE_INTEGER }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'form.accepted', formId: 'form-1', sourceMessageId: 'message-1' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'workspaceTrust.changed', trusted: 'yes' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.results', results: [] }, 'editor-1')).toBe(true);
    const catalogEntry = { sourcePath: 'tests/safety.csv', suiteId: 'safety', suiteName: 'Safety', scenarioId: 'case-1', scenarioName: 'Case 1', tags: ['security'], mode: 'singleTurn', turns: 1, maxTurns: 1, repetitions: 1, timeoutMs: 60000, prohibit: { content: 0, events: 0, urls: true, ctas: false, tools: false } };
    expect(isHostMessage({ ...envelope, type: 'adversarial.catalog', catalog: { entries: [catalogEntry], total: 1, truncated: false, issues: [] } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'adversarial.catalog', catalog: { entries: Array.from({ length: 101 }, () => catalogEntry), total: 101, truncated: true, issues: [] } }, 'editor-1')).toBe(false);
    const linkedDetail = { sourcePath: 'tests/safety.adversarial.csv', sourceFormat: 'csv', revision: 'a'.repeat(64), scenario: { id: 'case-1', name: 'Case 1', steps: [{ id: 'turn-1', input: 'hello' }], adversarial: { forbid: { urls: true } } } };
    expect(isHostMessage({ ...envelope, type: 'adversarial.case.loaded', detail: linkedDetail }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'adversarial.case.saved', detail: { ...linkedDetail, revision: 'invalid' } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'adversarial.case.error', sourcePath: linkedDetail.sourcePath, scenarioId: 'case-1', message: 'changed', conflict: true }, 'editor-1')).toBe(true);
    const boundedResult = { profileId: 'profile', scenarioId: 'case', scenarioName: 'Case', outcome: 'resisted', durationMs: 1, attemptedTurns: 1, completedTurns: 1, plannedTurns: 1, findingCount: 0, issueCount: 0, evidenceId: 'aggregate', primaryLocation: { kind: 'profile', path: 'tests.scenarios' }, availableLocations: [], repetitions: { requestedAttempts: 1, completedAttempts: 1, skippedAttempts: 0, sampleComplete: true, stability: 'stable-pass', counts: { resisted: 1, attackSucceeded: 0, indeterminate: 0, infrastructureError: 0 }, attempts: [{ attempt: 1, outcome: 'resisted', durationMs: 1, attemptedTurns: 1, completedTurns: 1, evidenceId: 'attempt-1', primaryLocation: { kind: 'message', messageId: 'assistant-1' }, availableLocations: [] }] } };
    expect(isHostMessage({ ...envelope, type: 'test.results', results: [boundedResult] }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'test.results', results: [{ ...boundedResult, repetitions: { ...boundedResult.repetitions, attempts: Array.from({ length: 101 }, (_, index) => ({ ...boundedResult.repetitions.attempts[0], attempt: index + 1 })) } }] }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.exported', kind: 'report', path: '/tmp/report.html', artifactId: 'artifact-1' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'campaign.exported', path: 'results.jsonl', artifactId: 'artifact-2' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'adversarial.operation', action: 'exportCsv', status: 'completed', detail: 'Exported.', path: 'cases.csv', artifactId: 'artifact-3' }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'test.operation', operation: { action: 'runAll', state: 'running' } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'test.operation', operation: { action: 'runAll', state: 'running', progress: { totalCases: 100, completedCases: 24, totalAttempts: 120, completedAttempts: 31, maxConcurrency: 3, activeCaseNames: ['Case 25'] } } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'test.operation', operation: { action: 'runAll', state: 'running', progress: { totalCases: 10, completedCases: 11, totalAttempts: 10, completedAttempts: 0, maxConcurrency: 3 } } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.operation', operation: { action: 'runAll', state: 'running', progress: { totalCases: 10, completedCases: 0, totalAttempts: 10, completedAttempts: 0, maxConcurrency: 9 } } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.operation', operation: { action: 'runAll', state: 'unknown' } }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'test.timeline', evidenceId: 'evidence-1', timeline: { version: 1, baseTime: 0, entries: [], completeness: 'missing', missingPhases: ['request'], truncated: false } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'test.timeline', evidenceId: 'evidence-1', timeline: 'untrusted' }, 'editor-1')).toBe(false);
    expect(isHostMessage({ ...envelope, type: 'connection.result', result: { protocol: 'sse', confidence: 'high', rawEventCount: 2, normalizedEventCount: 2, mappedEventCount: 2, unmatchedEventCount: 0, parseErrorCount: 0, mappingErrorCount: 0, terminalEventSeen: true, terminalMapped: true, safe: true, findings: [] } }, 'editor-1')).toBe(true);
    expect(isHostMessage({ ...envelope, type: 'connection.result', result: 'untrusted' }, 'editor-1')).toBe(false);
  });

  it('accepts a bounded retained session snapshot without relaxing Webview input limits', () => {
    const events = Array.from({ length: 6000 }, (_, index) => ({ version: 1, type: 'content.text.delta', sequence: index + 1, receivedAt: index + 1, text: 'x' }));
    expect(isHostMessage({ ...envelope, type: 'session.snapshot', snapshot: { normalizedEvents: events }, runs: [] }, 'editor-1')).toBe(true);
    expect(isWebviewMessage({ ...envelope, type: 'control.set', controlId: 'control', value: events }, 'editor-1')).toBe(false);
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
