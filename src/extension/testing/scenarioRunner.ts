import type {
  InteractionContext,
  NetworkExchange,
  ScenarioDefinition,
  ScenarioRunResult,
  SessionSnapshot,
} from '../../shared/types';
import { evaluateAssertions, evaluateSessionInvariants } from './assertionEvaluator';

export interface ScenarioSession {
  readonly snapshot: SessionSnapshot;
  readonly requestPreview?: unknown;
  setEphemeralControls(values: Record<string, unknown>): void;
  startSession(): Promise<void>;
  send(text: string, interaction: InteractionContext): Promise<void>;
  abort(): Promise<void>;
  getNetworkEntries(): NetworkExchange[];
}

export interface ScenarioCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void };
}

export async function runScenario(profileId: string, scenario: ScenarioDefinition, session: ScenarioSession, cancellation?: ScenarioCancellation): Promise<ScenarioRunResult> {
  const startedAt = Date.now();
  let abortPromise: Promise<void> | undefined;
  const cancellationSubscription = cancellation?.onCancellationRequested?.(() => { abortPromise ??= session.abort(); });
  if (cancellation?.isCancellationRequested) abortPromise ??= session.abort();
  if (scenario.controls) session.setEphemeralControls(scenario.controls);
  const stepResults: ScenarioRunResult['steps'] = [];
  try {
    if (!cancellation?.isCancellationRequested) await session.startSession();
    for (const step of scenario.steps) {
      if (cancellation?.isCancellationRequested) break;
      const stepStartedAt = Date.now();
      await session.send(step.input, { kind: 'manual' });
      const evidence = { snapshot: session.snapshot, networkEntries: session.getNetworkEntries() };
      const checks = [...evaluateSessionInvariants(evidence), ...evaluateAssertions(step.assertions, evidence)];
      stepResults.push({ stepId: step.id, name: step.name?.trim() || step.id, durationMs: Date.now() - stepStartedAt, checks });
    }
  } finally {
    cancellationSubscription?.dispose();
    await abortPromise;
  }

  const finalEvidence = { snapshot: structuredClone(session.snapshot), networkEntries: session.getNetworkEntries() };
  const checks = evaluateAssertions(scenario.assertions, finalEvidence);
  const allChecks = [...stepResults.flatMap((step) => step.checks), ...checks];
  return {
    scenarioId: scenario.id,
    passed: !cancellation?.isCancellationRequested && allChecks.every((check) => check.passed),
    durationMs: Date.now() - startedAt,
    steps: stepResults,
    checks,
    evidence: {
      profileId,
      scenarioId: scenario.id,
      snapshot: finalEvidence.snapshot,
      networkEntries: finalEvidence.networkEntries,
      requestPreview: session.requestPreview as ScenarioRunResult['evidence']['requestPreview'],
      faults: scenario.faults ? structuredClone(scenario.faults) : undefined,
    },
  };
}
