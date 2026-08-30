import { describe, expect, it } from 'vitest';
import {
  aggregateBatchOutcome,
  cancelBatchProgress,
  completeBatchAttempt,
  createBatchProgress,
  createBatchResumeCursor,
  createBatchRunPlan,
  nextBatchWorkItem,
  resumeBatchProgress,
  startBatchAttempt,
  validateBatchResumeCursor,
  type BatchCaseInput,
} from '../src/extension/testing/batchRun';

function batchCase(id: string, overrides: Partial<BatchCaseInput> = {}): BatchCaseInput {
  return { id, requestedAttempts: 5, turnsPerAttempt: 10, timeoutMs: 1000, tags: ['security', 'chat'], ...overrides };
}

describe('batch planning and resume contracts', () => {
  it('plans 100 cases x five attempts without expanding attempts', () => {
    const plan = createBatchRunPlan(Array.from({ length: 100 }, (_, index) => batchCase(`case-${index + 1}`)), { maxConcurrency: 4 });
    expect(plan.valid).toBe(true);
    expect(plan.selectedCases).toBe(100);
    expect(plan.plannedAttempts).toBe(500);
    expect(plan.remainingAttempts).toBe(500);
    expect(plan.plannedTurns).toBe(5000);
    expect(plan.plannedRequests).toBe(5000);
    expect(plan.maximumDurationMs).toBe(500_000);
    expect(plan.cases).toHaveLength(100);
    expect(plan.cases[0]).toMatchObject({ requestedAttempts: 5, plannedTurns: 50, plannedRequests: 50, nextAttempt: 1, remainingAttempts: 5 });
  });

  it('supports profile, suite, tag, case and rerun status filters', () => {
    const cases = [
      batchCase('safe', { profileId: 'p1', suiteId: 's1', outcome: 'resisted', stability: 'stable-pass', sampleComplete: true }),
      batchCase('attack', { profileId: 'p1', suiteId: 's1', outcome: 'attackSucceeded', stability: 'stable-fail', sampleComplete: true }),
      batchCase('infra', { profileId: 'p2', suiteId: 's2', outcome: 'infrastructureError', sampleComplete: true }),
      batchCase('partial', { profileId: 'p1', suiteId: 's2', outcome: 'resisted', sampleComplete: false, tags: ['chat'] }),
    ];
    expect(createBatchRunPlan(cases, { filter: { profileIds: ['p1'], tags: ['security'], rerunStatus: 'failed' } }).cases.map((item) => item.id)).toEqual(['attack']);
    expect(createBatchRunPlan(cases, { filter: { statuses: ['infrastructure-error'] } }).cases.map((item) => item.id)).toEqual(['infra']);
    expect(createBatchRunPlan(cases, { filter: { statuses: ['incomplete'] } }).cases.map((item) => item.id)).toEqual(['partial']);
    expect(createBatchRunPlan(cases, { filter: { tags: ['missing'], tagMode: 'any' } }).selectedCases).toBe(0);
    expect(createBatchRunPlan(cases, { filter: { ids: ['p1/s1/attack'] } }).cases.map((item) => item.id)).toEqual(['attack']);
  });

  it('tracks active attempts, cancellation, and recovery at exact attempt boundaries', () => {
    const plan = createBatchRunPlan([batchCase('case-a', { requestedAttempts: 3, turnsPerAttempt: 1 })]);
    let progress = createBatchProgress(plan);
    const first = nextBatchWorkItem(plan, progress);
    expect(first).toMatchObject({ caseId: 'case-a', attempt: 1 });
    const started = startBatchAttempt(progress, first!);
    expect(started.accepted).toBe(true);
    progress = started.progress;
    progress = cancelBatchProgress(progress);
    expect(nextBatchWorkItem(plan, progress)).toBeUndefined();

    const cancelledCursor = createBatchResumeCursor(plan, progress);
    expect(cancelledCursor).toMatchObject({ nextCaseIndex: 0, cancellationRequested: true, nextAttemptByCase: { 'case-a': 1 } });
    expect(validateBatchResumeCursor(plan, cancelledCursor).valid).toBe(true);

    progress = resumeBatchProgress(progress);
    const retried = nextBatchWorkItem(plan, progress);
    expect(retried).toMatchObject({ attempt: 1 });
    progress = startBatchAttempt(progress, retried!).progress;
    progress = completeBatchAttempt(progress, retried!, 'resisted').progress;
    expect(nextBatchWorkItem(plan, progress)).toMatchObject({ attempt: 2 });
    expect(progress.cases[0]).toMatchObject({ completedAttempts: 1, status: 'pending', sampleComplete: false, outcome: 'resisted' });
  });

  it('keeps outcome precedence and does not count rejected or duplicate transitions', () => {
    const plan = createBatchRunPlan([batchCase('case-a', { requestedAttempts: 3, turnsPerAttempt: 1 })]);
    let progress = createBatchProgress(plan);
    const first = nextBatchWorkItem(plan, progress)!;
    expect(startBatchAttempt(progress, { ...first, attempt: 2 }).accepted).toBe(false);
    progress = startBatchAttempt(progress, first).progress;
    progress = completeBatchAttempt(progress, first, 'indeterminate').progress;
    const second = nextBatchWorkItem(plan, progress)!;
    progress = startBatchAttempt(progress, second).progress;
    progress = completeBatchAttempt(progress, second, 'infrastructureError').progress;
    const third = nextBatchWorkItem(plan, progress)!;
    progress = startBatchAttempt(progress, third).progress;
    progress = completeBatchAttempt(progress, third, 'attackSucceeded').progress;
    expect(progress.cases[0]).toMatchObject({ completedAttempts: 3, status: 'completed', sampleComplete: true, outcome: 'attackSucceeded', counts: { indeterminate: 1, infrastructureError: 1, attackSucceeded: 1, resisted: 0 } });
    expect(nextBatchWorkItem(plan, progress)).toBeUndefined();
    expect(completeBatchAttempt(progress, third, 'resisted').accepted).toBe(false);
    expect(aggregateBatchOutcome({ resisted: 9, attackSucceeded: 0, indeterminate: 0, infrastructureError: 2 })).toBe('infrastructureError');
  });

  it('rejects fabricated, non-started, and out-of-order completions', () => {
    const plan = createBatchRunPlan([batchCase('case-a', { requestedAttempts: 3, turnsPerAttempt: 1 })]);
    let progress = createBatchProgress(plan);
    const first = nextBatchWorkItem(plan, progress)!;

    expect(completeBatchAttempt(progress, first, 'resisted').accepted).toBe(false);
    progress = startBatchAttempt(progress, first).progress;

    expect(completeBatchAttempt(progress, { ...first, attempt: 2 }, 'resisted').accepted).toBe(false);
    expect(completeBatchAttempt(progress, { ...first, caseId: 'fabricated' }, 'resisted').accepted).toBe(false);
    expect(completeBatchAttempt(progress, { ...first, caseIndex: 1 }, 'resisted').accepted).toBe(false);
    expect(progress.cases[0]).toMatchObject({ completedAttempts: 0, status: 'running', activeAttempt: 1 });

    const completed = completeBatchAttempt(progress, first, 'resisted');
    expect(completed.accepted).toBe(true);
    progress = completed.progress;
    const second = nextBatchWorkItem(plan, progress)!;
    expect(completeBatchAttempt(progress, second, 'resisted').accepted).toBe(false);
    expect(progress.cases[0]).toMatchObject({ completedAttempts: 1, status: 'pending', counts: { resisted: 1 } });
  });

  it('resumes from a persisted progress map and reports remaining totals', () => {
    const plan = createBatchRunPlan([
      batchCase('first', { requestedAttempts: 5, turnsPerAttempt: 2 }),
      batchCase('second', { requestedAttempts: 2, turnsPerAttempt: 4 }),
    ], { progress: new Map([
      ['first', { completedAttempts: 3, sampleComplete: false }],
      ['second', { completedAttempts: 2, sampleComplete: true, outcome: 'resisted' }],
    ]) });
    expect(plan).toMatchObject({ plannedAttempts: 7, remainingAttempts: 2, plannedTurns: 18, remainingTurns: 4, plannedRequests: 18, remainingRequests: 4 });
    expect(plan.cases.map((item) => [item.id, item.completedAttempts, item.nextAttempt])).toEqual([['first', 3, 4], ['second', 2, 3]]);
    const progress = createBatchProgress(plan);
    const cursor = createBatchResumeCursor(plan, progress);
    expect(cursor.nextCaseIndex).toBe(0);
    expect(cursor.nextAttemptByCase.first).toBe(4);
    expect(nextBatchWorkItem(plan, cursor)).toMatchObject({ caseId: 'first', attempt: 4 });
  });

  it('fails closed on duplicate keys, caps, overflow, and malformed resume cursors', () => {
    const duplicate = createBatchRunPlan([batchCase('same'), batchCase('same')]);
    expect(duplicate.valid).toBe(false);
    expect(duplicate.issues.some((issue) => issue.code === 'duplicate-case')).toBe(true);

    const capped = createBatchRunPlan([batchCase('too-many', { requestedAttempts: 10_001 })]);
    expect(capped.valid).toBe(false);
    expect(capped.issues.some((issue) => issue.code === 'invalid-case')).toBe(true);

    const overflow = createBatchRunPlan([batchCase('overflow', { requestedAttempts: 10, turnsPerAttempt: Number.MAX_VALUE })]);
    expect(overflow.valid).toBe(false);
    expect(overflow.issues.some((issue) => issue.code === 'invalid-case' || issue.code === 'overflow')).toBe(true);
    expect(JSON.stringify(overflow)).not.toContain('Infinity');

    const plan = createBatchRunPlan([batchCase('case-a', { requestedAttempts: 2 })]);
    const cursor = createBatchResumeCursor(plan);
    const invalid = { ...cursor, nextCaseIndex: 1, nextAttemptByCase: { ...cursor.nextAttemptByCase, extra: 1 } };
    expect(validateBatchResumeCursor(plan, invalid).valid).toBe(false);
    expect(nextBatchWorkItem(plan, invalid)).toBeUndefined();
  });

  it('does not mark a full case complete when a persisted progress sample is explicitly incomplete', () => {
    const plan = createBatchRunPlan([batchCase('incomplete', { requestedAttempts: 2, completedAttempts: 2, sampleComplete: false })]);
    expect(plan.cases[0]).toMatchObject({ completedAttempts: 2, remainingAttempts: 0, sampleComplete: false, status: 'pending' });
    const progress = createBatchProgress(plan);
    expect(progress.completedCases).toBe(0);
    expect(createBatchResumeCursor(plan, progress).nextCaseIndex).toBe(1);
  });
});
