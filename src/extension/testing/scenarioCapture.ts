import type { AdversarialForbidDefinition, ScenarioCaptureDefinition, ScenarioDefinition, SessionSnapshot, TurnStageProfile } from '../../shared/types';
import { digestValue } from './provenance';

export const MAX_CAPTURED_TURNS = 10;
export const MAX_CAPTURED_TURN_CHARACTERS = 256 * 1024;
export const MAX_CAPTURED_TOTAL_CHARACTERS = 1024 * 1024;
export const CAPTURED_TAG = 'captured';
export const NEEDS_REVIEW_TAG = 'needs-review';

export type CaptureKind = 'contract' | 'adversarial';
export type CaptureSource =
  | { kind: 'conversation' }
  | { kind: 'run'; runId: string }
  | { kind: 'evidence'; evidenceId: string };

export interface CaptureScenarioInput {
  kind: CaptureKind;
  name: string;
  snapshot: SessionSnapshot;
  profile: TurnStageProfile;
  source: CaptureSource;
  existingIds?: ReadonlySet<string>;
  forbid?: AdversarialForbidDefinition;
  repetitions?: number;
  timeoutMs?: number;
  capturedAt?: string;
}

export interface CaptureEffectOption {
  kind: 'urls' | 'ctas' | 'tools' | 'event';
  event?: string;
  observed: boolean;
}

export function buildCapturedScenario(input: CaptureScenarioInput): ScenarioDefinition {
  const name = boundedRequired(input.name, 120, 'Case name');
  const steps = capturedUserSteps(input.snapshot);
  const baseId = slugScenarioId(name) || `captured-${input.kind}`;
  const id = nextScenarioId(input.existingIds ?? new Set(), baseId);
  const capture: ScenarioCaptureDefinition = {
    status: 'needsReview',
    source: input.source.kind,
    capturedAt: validCapturedAt(input.capturedAt),
    profileId: boundedRequired(input.profile.id, 256, 'Profile id'),
    profileDigest: digestValue(input.profile, { redactPayloads: true }),
    ...(input.source.kind === 'run' ? { runId: boundedRequired(input.source.runId, 256, 'Run id') } : {}),
    ...(input.source.kind === 'evidence' ? { evidenceId: boundedRequired(input.source.evidenceId, 256, 'Evidence id') } : {}),
  };
  const common: ScenarioDefinition = {
    id,
    name,
    tags: [CAPTURED_TAG, NEEDS_REVIEW_TAG],
    capture,
    steps,
  };
  if (input.kind === 'contract') return {
    ...common,
    assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }],
  };
  const forbid = normalizeForbid(input.forbid);
  if (!hasForbid(forbid)) throw new Error('Choose at least one prohibited effect before saving the adversarial draft.');
  const repetitions = boundedInteger(input.repetitions ?? 1, 1, 50, 'Repetitions');
  const timeoutMs = boundedInteger(input.timeoutMs ?? 60_000, 1_000, 300_000, 'Timeout');
  return {
    ...common,
    adversarial: {
      mode: steps.length > 1 ? 'multiTurn' : 'singleTurn',
      maxTurns: steps.length,
      timeoutMs,
      stopOnAttackSucceeded: true,
      repetitions,
      forbid,
    },
  };
}

export function capturedUserSteps(snapshot: SessionSnapshot): ScenarioDefinition['steps'] {
  const messages: string[] = [];
  let totalCharacters = 0;
  for (const message of snapshot.messages) {
    if (message.role !== 'user') continue;
    const text = message.parts
      .filter((part) => part.type === 'text' || part.type === 'markdown')
      .map((part) => part.text ?? '')
      .join('\n');
    if (!text.trim()) continue;
    if (messages.length >= MAX_CAPTURED_TURNS) throw new Error(`This conversation has more than ${MAX_CAPTURED_TURNS} user turns. Start a shorter conversation before saving it as one case.`);
    if (text.length > MAX_CAPTURED_TURN_CHARACTERS) throw new Error('A user turn is too large to save safely as one test step.');
    totalCharacters += text.length;
    if (totalCharacters > MAX_CAPTURED_TOTAL_CHARACTERS) throw new Error('The selected user turns are too large to save safely as one test case.');
    messages.push(text);
  }
  if (!messages.length) throw new Error('There are no user messages to save as a test case.');
  return messages.map((input, index) => ({ id: `turn-${index + 1}`, name: `Turn ${index + 1}`, input }));
}

export function captureEffectOptions(profile: TurnStageProfile, snapshot: SessionSnapshot): CaptureEffectOption[] {
  const emitted = new Set(profile.stream.mappings.map((mapping) => String(mapping.emit.type)));
  const observed = new Set(snapshot.normalizedEvents.map((event) => String(event.type)).filter(Boolean));
  const visible = [...emitted].some((type) => ['content.text.delta', 'content.markdown.delta', 'citation.upsert', 'citation.attach', 'action.upsert', 'followup.upsert', 'form.upsert'].includes(type));
  const options: CaptureEffectOption[] = [];
  if (visible) options.push({ kind: 'urls', observed: snapshot.messages.some((message) => message.citations.some((citation) => citation.kind === 'url')) });
  if ([...emitted].some((type) => ['action.upsert', 'followup.upsert', 'form.upsert'].includes(type))) options.push({ kind: 'ctas', observed: snapshot.messages.some((message) => message.actions.length > 0 || message.followups.length > 0) });
  if ([...emitted].some((type) => type.startsWith('tool.'))) options.push({ kind: 'tools', observed: [...observed].some((type) => type.startsWith('tool.')) });
  for (const event of [...observed].filter((type) => emitted.has(type)).sort().slice(0, 50)) options.push({ kind: 'event', event, observed: true });
  return options;
}

export function markCapturedScenarioReady(scenario: ScenarioDefinition): ScenarioDefinition {
  if (!scenario.capture) return scenario;
  return {
    ...scenario,
    tags: (scenario.tags ?? []).filter((tag) => tag !== NEEDS_REVIEW_TAG),
    capture: { ...scenario.capture, status: 'ready' },
  };
}

export function isScenarioReady(scenario: ScenarioDefinition): boolean {
  return scenario.capture?.status !== 'needsReview' && !(scenario.tags ?? []).includes(NEEDS_REVIEW_TAG);
}

export function slugScenarioId(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64).replace(/-+$/u, '');
}

export function nextScenarioId(existing: ReadonlySet<string>, base: string): string {
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix <= 10_000; suffix++) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, Math.max(1, 64 - tail.length)).replace(/-+$/u, '')}${tail}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a unique case id.');
}

function normalizeForbid(value: AdversarialForbidDefinition | undefined): AdversarialForbidDefinition {
  const events = [...new Set((value?.events ?? []).map((entry) => boundedRequired(entry, 256, 'Forbidden event')))];
  const content = (value?.content ?? []).slice(0, 50);
  return {
    ...(content.length ? { content } : {}),
    ...(value?.urls ? { urls: true } : {}),
    ...(value?.ctas ? { ctas: true } : {}),
    ...(value?.tools ? { tools: true } : {}),
    ...(events.length ? { events } : {}),
  };
}

function hasForbid(value: AdversarialForbidDefinition): boolean {
  return Boolean(value.content?.length || value.urls || value.ctas || value.tools || value.events?.length);
}

function validCapturedAt(value?: string): string {
  const capturedAt = value ?? new Date().toISOString();
  if (capturedAt.length > 64 || Number.isNaN(Date.parse(capturedAt))) throw new Error('Captured timestamp is invalid.');
  return capturedAt;
}

function boundedRequired(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters.`);
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
