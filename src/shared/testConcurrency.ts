import type { ProfileTestsDefinition } from './types';

export const DEFAULT_WEB_TEST_CONCURRENCY = 1;
export const MAX_TEST_CASE_CONCURRENCY = 8;

export function isTestCaseConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TEST_CASE_CONCURRENCY;
}

export function resolveWebTestConcurrency(policy: ProfileTestsDefinition['runPolicy'], campaignOverride?: number): number {
  if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) {
    throw new Error('tests.runPolicy must be an object.');
  }
  const profileLimit = policy?.maxConcurrency;
  if (profileLimit !== undefined && !isTestCaseConcurrency(profileLimit)) {
    throw new Error('tests.runPolicy.maxConcurrency must be an integer from 1 to 8.');
  }
  if (campaignOverride !== undefined && !isTestCaseConcurrency(campaignOverride)) {
    throw new Error('Campaign maxConcurrency must be an integer from 1 to 8.');
  }
  return campaignOverride ?? profileLimit ?? DEFAULT_WEB_TEST_CONCURRENCY;
}
