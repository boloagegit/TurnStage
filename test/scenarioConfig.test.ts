import { describe, expect, it } from 'vitest';
import { isSafeReportDirectory } from '../src/extension/testing/scenarioConfig';

describe('scenario report configuration', () => {
  it('accepts only explicit workspace-relative directories', () => {
    expect(isSafeReportDirectory('.turnstage/reports')).toBe(true);
    expect(isSafeReportDirectory('artifacts/turnstage')).toBe(true);
    for (const path of ['', '.', '..', '../outside', 'reports/../outside', '/tmp/reports', 'C:/reports', 'file://reports', 'reports\\private']) expect(isSafeReportDirectory(path)).toBe(false);
  });
});
