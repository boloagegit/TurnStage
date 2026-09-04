import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'resources', 'schemas', 'turnstage-profile.schema.json'), 'utf8')) as {
  $defs: Record<string, { additionalProperties?: boolean; properties?: Record<string, { oneOf?: Array<{ enum?: unknown[] }> }>; required?: string[] }>;
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

  it('exposes closed adversarial case and linked-suite definitions', () => {
    expect(schema.$defs.tests!.properties).toMatchObject({ contractSuites: expect.any(Object), adversarialSuites: expect.any(Object) });
    expect(schema.$defs.scenario!.properties).toMatchObject({ adversarial: { $ref: '#/$defs/scenarioAdversarial' } });
    expect(schema.$defs.scenario!.properties).toMatchObject({ sourceBinding: { $ref: '#/$defs/sourceBinding' } });
    expect(schema.$defs.scenarioStep!.properties).toMatchObject({ additionalForbid: { $ref: '#/$defs/adversarialForbid' } });
    for (const name of ['scenarioAdversarial', 'adversarialForbid', 'adversarialContentRule', 'sourceBinding']) expect(schema.$defs[name]?.additionalProperties).toBe(false);
  });

  it('ships a closed standalone schema for linked functional suites', () => {
    const contractSchema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'resources', 'schemas', 'turnstage-contract-suite.schema.json'), 'utf8')) as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
      $defs?: Record<string, { additionalProperties?: boolean }>;
    };
    expect(contractSchema.additionalProperties).toBe(false);
    expect(contractSchema.properties).toMatchObject({ format: { const: 'turnstage-contract-suite' }, cases: expect.any(Object) });
    expect(contractSchema.$defs?.case?.additionalProperties).toBe(false);
    expect(contractSchema.$defs?.step?.additionalProperties).toBe(false);
  });

  it('lists all supported performance metrics in threshold and regression maps', () => {
    const expected = ['scenario.durationMs', 'metrics.headersLatency', 'metrics.firstChunkLatency', 'metrics.firstEventLatency', 'metrics.ttft', 'metrics.streamDuration', 'metrics.totalDuration', 'metrics.averageEventGap', 'metrics.maxEventGap'];
    expect(Object.keys(schema.$defs.scenarioPerformanceThresholds?.properties ?? {})).toEqual(expected);
    expect(Object.keys(schema.$defs.scenarioPerformanceRegression?.properties ?? {})).toEqual(expected);
  });

  it('offers a closed response-action contract with a bounded icon allowlist', () => {
    const action = schema.$defs.responseAction;
    expect(action?.additionalProperties).toBe(false);
    expect(action?.required).toEqual(['id', 'label', 'actionId']);
    expect(action?.properties?.appearance?.oneOf?.[0]?.enum).toEqual(['primary', 'secondary', 'link']);
    expect(action?.properties?.icon?.oneOf?.[0]?.enum).toEqual(['add', 'arrow-right', 'beaker', 'check', 'copy', 'debug-start', 'diff', 'edit', 'export', 'file-code', 'go-to-file', 'info', 'link', 'refresh', 'save', 'send', 'target', 'warning']);
  });
});
