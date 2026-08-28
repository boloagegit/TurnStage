import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'resources', 'schemas', 'turnstage-profile.schema.json'), 'utf8')) as {
  $defs: Record<string, { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] }>;
};

describe('scenario profile JSON Schema', () => {
  it('exposes closed comparison, performance, and reporting definitions', () => {
    expect(schema.$defs.tests!.properties).toMatchObject({
      scenarios: expect.any(Object),
      reporting: { $ref: '#/$defs/scenarioReporting' },
    });
    expect(schema.$defs.scenario!.properties).toMatchObject({
      comparison: { $ref: '#/$defs/scenarioComparison' },
      performance: { $ref: '#/$defs/scenarioPerformance' },
    });
    for (const name of ['scenarioReporting', 'scenarioComparison', 'scenarioComparisonTarget', 'scenarioPerformance', 'scenarioPerformanceThresholds', 'scenarioPerformanceRegression', 'scenarioRegressionLimit']) expect(schema.$defs[name]?.additionalProperties).toBe(false);
  });

  it('exposes closed Fault Lab and visual regression definitions', () => {
    expect(schema.$defs.tests!.properties).toMatchObject({ visual: { $ref: '#/$defs/scenarioVisual' } });
    expect(schema.$defs.scenario!.properties).toMatchObject({ faults: { $ref: '#/$defs/scenarioFaults' } });
    expect(schema.$defs.scenarioVisual?.additionalProperties).toBe(false);
    expect(schema.$defs.scenarioFaults?.additionalProperties).toBe(false);
  });

  it('lists all supported performance metrics in threshold and regression maps', () => {
    const expected = ['scenario.durationMs', 'metrics.headersLatency', 'metrics.firstChunkLatency', 'metrics.firstEventLatency', 'metrics.ttft', 'metrics.streamDuration', 'metrics.totalDuration', 'metrics.averageEventGap', 'metrics.maxEventGap'];
    expect(Object.keys(schema.$defs.scenarioPerformanceThresholds?.properties ?? {})).toEqual(expected);
    expect(Object.keys(schema.$defs.scenarioPerformanceRegression?.properties ?? {})).toEqual(expected);
  });
});
