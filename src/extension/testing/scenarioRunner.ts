import type {
  AdversarialFinding,
  AdversarialIssue,
  InteractionContext,
  NetworkExchange,
  ScenarioCheckResult,
  ScenarioDefinition,
  ScenarioRunResult,
  SessionSnapshot,
} from '../../shared/types';
import { evaluateAssertions, evaluateSessionInvariants } from './assertionEvaluator';
import { captureAdversarialBoundary, evaluateAdversarialTurn } from './adversarialEvaluator';
import { localize } from '../l10n';

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
  if (scenario.adversarial) return runAdversarialScenario(profileId, scenario, session, cancellation);
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

async function runAdversarialScenario(profileId: string, scenario: ScenarioDefinition, session: ScenarioSession, cancellation?: ScenarioCancellation): Promise<ScenarioRunResult> {
  const definition = scenario.adversarial!;
  const startedAt = Date.now();
  const timeoutMs = definition.timeoutMs ?? 60_000;
  const maxTurns = definition.maxTurns ?? (definition.mode === 'multiTurn' ? Math.max(2, scenario.steps.length) : 1);
  if (scenario.steps.length > maxTurns) throw new Error(localize('Adversarial case {id} has more turns than maxTurns.', { id: scenario.id }));
  let timedOut = false;
  let abortPromise: Promise<void> | undefined;
  let resolveTimeout: (() => void) | undefined;
  const timeoutSignal = new Promise<void>((resolve) => { resolveTimeout = resolve; });
  let resolveCancellation: (() => void) | undefined;
  const cancellationSignal = new Promise<void>((resolve) => { resolveCancellation = resolve; });
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortPromise ??= session.abort();
    resolveTimeout?.();
  }, timeoutMs);
  const cancellationSubscription = cancellation?.onCancellationRequested?.(() => { abortPromise ??= session.abort(); resolveCancellation?.(); });
  if (cancellation?.isCancellationRequested) { abortPromise ??= session.abort(); resolveCancellation?.(); }
  if (scenario.controls) session.setEphemeralControls(scenario.controls);
  const stepResults: ScenarioRunResult['steps'] = [];
  const findings: AdversarialFinding[] = [];
  const issues: AdversarialIssue[] = [];
  let attemptedTurns = 0;
  let completedTurns = 0;
  let activeTurn: { step: ScenarioDefinition['steps'][number]; index: number; startedAt: number } | undefined;
  try {
    if (!cancellation?.isCancellationRequested) {
      const start = await raceWithTermination(session.startSession(), timeoutSignal, cancellationSignal);
      if (start === 'timeout') timedOut = true;
    }
    for (const [turnIndex, step] of scenario.steps.entries()) {
      if (timedOut || cancellation?.isCancellationRequested) break;
      attemptedTurns += 1;
      const stepStartedAt = Date.now();
      activeTurn = { step, index: turnIndex, startedAt: stepStartedAt };
      const beforeNetwork = session.getNetworkEntries();
      const boundary = captureAdversarialBoundary(session.snapshot, beforeNetwork);
      const send = await raceWithTermination(session.send(step.input, { kind: 'manual' }), timeoutSignal, cancellationSignal);
      if (send === 'timeout') {
        const location = { kind: 'network' as const, networkId: session.getNetworkEntries().at(-1)?.id };
        const issue: AdversarialIssue = { id: `infrastructure-timeout-${turnIndex + 1}`, kind: 'infrastructure', turnId: step.id, turnIndex, label: localize('The adversarial case timeout elapsed.'), location };
        issues.push(issue);
        stepResults.push({ stepId: step.id, name: step.name?.trim() || step.id, durationMs: Date.now() - stepStartedAt, checks: [issueCheck(issue)] });
        break;
      }
      if (send === 'cancelled') break;
      const evaluation = evaluateAdversarialTurn(definition, step, turnIndex, session.snapshot, session.getNetworkEntries(), boundary);
      findings.push(...evaluation.findings);
      issues.push(...evaluation.issues);
      if (evaluation.completed) completedTurns += 1;
      const checks = evaluation.findings.length || evaluation.issues.length
        ? [...evaluation.findings.map(findingCheck), ...evaluation.issues.map(issueCheck)]
        : [resistedTurnCheck(step.id, turnIndex, session.snapshot.messages.filter((message) => message.role === 'assistant').at(-1)?.id)];
      stepResults.push({ stepId: step.id, name: step.name?.trim() || step.id, durationMs: Date.now() - stepStartedAt, checks });
      if (evaluation.findings.length && definition.stopOnAttackSucceeded !== false) break;
      if (evaluation.issues.some((issue) => issue.kind === 'infrastructure')) break;
      activeTurn = undefined;
    }
  } catch (error) {
    const issue: AdversarialIssue = {
      id: `infrastructure-execution-${activeTurn ? activeTurn.index + 1 : 'start'}`,
      kind: 'infrastructure',
      ...(activeTurn ? { turnId: activeTurn.step.id, turnIndex: activeTurn.index } : {}),
      label: error instanceof Error ? error.message : localize('The adversarial case failed before it could be evaluated.'),
      location: { kind: 'network', networkId: session.getNetworkEntries().at(-1)?.id },
    };
    issues.push(issue);
    if (activeTurn && !stepResults.some((step) => step.stepId === activeTurn!.step.id)) stepResults.push({ stepId: activeTurn.step.id, name: activeTurn.step.name?.trim() || activeTurn.step.id, durationMs: Date.now() - activeTurn.startedAt, checks: [issueCheck(issue)] });
  } finally {
    clearTimeout(timeoutHandle);
    cancellationSubscription?.dispose();
    await abortPromise;
  }

  if (cancellation?.isCancellationRequested && !findings.length && !issues.some((issue) => issue.id.startsWith('indeterminate-cancel'))) {
    issues.push({ id: 'indeterminate-cancelled', kind: 'indeterminate', label: localize('The adversarial case was cancelled before all planned turns completed.'), location: { kind: 'profile', path: 'tests.scenarios' } });
  }
  if (timedOut && !findings.length && !issues.some((issue) => issue.id.includes('timeout'))) {
    issues.push({ id: 'infrastructure-timeout', kind: 'infrastructure', label: localize('The adversarial case timeout elapsed.'), location: { kind: 'network', networkId: session.getNetworkEntries().at(-1)?.id } });
  }
  const outcome = findings.length
    ? 'attackSucceeded'
    : issues.some((issue) => issue.kind === 'infrastructure')
      ? 'infrastructureError'
      : issues.length || attemptedTurns < scenario.steps.length
        ? 'indeterminate'
        : 'resisted';
  const finalEvidence = { snapshot: structuredClone(session.snapshot), networkEntries: session.getNetworkEntries() };
  const checks: ScenarioCheckResult[] = issues.filter((issue) => !stepResults.some((step) => step.checks.some((check) => check.id === issue.id))).map(issueCheck);
  return {
    scenarioId: scenario.id,
    passed: outcome === 'resisted',
    durationMs: Date.now() - startedAt,
    steps: stepResults,
    checks,
    adversarial: { outcome, attemptedTurns, completedTurns, plannedTurns: scenario.steps.length, maxTurns, timeoutMs, findings, issues },
    evidence: {
      profileId,
      scenarioId: scenario.id,
      snapshot: finalEvidence.snapshot,
      networkEntries: finalEvidence.networkEntries,
      requestPreview: session.requestPreview as ScenarioRunResult['evidence']['requestPreview'],
    },
  };
}

async function raceWithTermination(promise: Promise<void>, deadline: Promise<void>, cancellation: Promise<void>): Promise<'completed' | 'timeout' | 'cancelled'> {
  return Promise.race([
    promise.then(() => 'completed' as const),
    deadline.then(() => 'timeout' as const),
    cancellation.then(() => 'cancelled' as const),
  ]);
}

function findingCheck(finding: AdversarialFinding): ScenarioCheckResult {
  return { id: finding.id, label: finding.label, passed: false, kind: 'adversarial', actual: finding.category, expected: 'not observed', location: finding.locations[0] ?? { kind: 'profile', path: 'tests.scenarios' } };
}

function issueCheck(issue: AdversarialIssue): ScenarioCheckResult {
  return { id: issue.id, label: issue.label, passed: false, kind: 'adversarial', actual: issue.kind, expected: 'complete evidence', location: issue.location };
}

function resistedTurnCheck(stepId: string, turnIndex: number, messageId?: string): ScenarioCheckResult {
  return { id: `adversarial-resisted-${turnIndex + 1}`, label: localize('No prohibited observable effect was found in turn {turn}.', { turn: String(turnIndex + 1) }), passed: true, kind: 'adversarial', actual: stepId, expected: 'no prohibited effect', location: { kind: 'message', messageId } };
}
