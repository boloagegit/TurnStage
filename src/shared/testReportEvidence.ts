import type { ScenarioDefinition, ScenarioRunResult } from './types';
import type { TestReportEvidence } from './testReportHtml';
import { redactDeep } from './redaction';

/** Build the downloadable HTML projection from retained execution evidence. */
export function buildTestReportEvidence(result: ScenarioRunResult, scenario?: ScenarioDefinition): TestReportEvidence {
  const snapshot = result.evidence.snapshot;
  const inputs = new Map((scenario?.steps ?? []).map((step) => [step.id, step.input]));
  const checks = (items: ScenarioRunResult['checks']) => items.map((check) => ({
    id: check.id,
    label: check.label,
    passed: check.passed,
    kind: check.kind,
    ...(check.expected !== undefined ? { expected: check.expected } : {}),
    ...(check.actual !== undefined ? { actual: check.actual } : {}),
    location: check.location,
  }));
  return {
    metrics: {
      ...snapshot.metrics,
      scenarioDurationMs: result.durationMs,
    },
    steps: result.steps.map((step) => ({
      id: step.stepId,
      name: step.name,
      durationMs: step.durationMs,
      ...(step.input !== undefined ? { input: step.input } : inputs.has(step.stepId) ? { input: inputs.get(step.stepId) } : {}),
      checks: checks(step.checks),
    })),
    checks: checks(result.checks),
    messages: snapshot.messages.map((message) => ({
      role: message.role,
      status: message.status,
      parts: message.parts,
      ...(message.timing ? { timing: message.timing } : {}),
    })),
    requests: result.evidence.networkEntries.map((entry) => ({
      kind: entry.kind,
      method: entry.method,
      url: entry.url,
      state: entry.state,
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      requestHeaders: redactDeep(entry.requestHeaders),
      ...(entry.requestBody !== undefined ? { requestBody: redactDeep(entry.requestBody) } : {}),
      ...(entry.responseHeaders ? { responseHeaders: redactDeep(entry.responseHeaders) } : {}),
      ...(entry.responseBodyPreview !== undefined ? { responseBody: entry.responseBodyPreview, responseBodyTruncated: entry.responseBodyTruncated } : {}),
      timing: entry.timing,
      transferredBytes: entry.transferredBytes,
      eventCount: entry.eventCount,
      ...(entry.error ? { error: redactDeep(entry.error) } : {}),
    })),
    rawEvents: snapshot.rawEvents.map((event) => ({ sequence: event.sequence, protocol: event.protocol, elapsedMs: event.elapsedMs, event: event.sse?.event, data: event.data, raw: event.raw, parseError: event.parseError, mappingError: event.mappingError })),
    normalizedEvents: snapshot.normalizedEvents.map((event) => ({ ...event })),
    errors: snapshot.errors.map((error) => redactDeep(error)),
  };
}
