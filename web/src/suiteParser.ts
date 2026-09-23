import type { ScenarioDefinition } from '../../src/shared/types';
import { parseAdversarialCsv } from '../../src/extension/testing/adversarialCsv';
import { parseContractCsv } from '../../src/extension/testing/contractCsv';
import { parseAdversarialJsonl } from '../../src/extension/testing/adversarialJsonl';
import { normalizeAdversarialSuite, parseAdversarialSuite } from '../../src/extension/testing/adversarialSuite';
import { normalizeContractSuite, parseContractSuite } from '../../src/extension/testing/contractSuite';
import { browserSha256, browserUuid } from './browserCrypto';

export interface WebSuite {
  suiteId: string;
  name: string;
  kind: 'contract' | 'adversarial';
  sourceFormat: 'csv' | 'jsonc' | 'jsonl';
  sourcePath: string;
  revision: string;
  scenarios: ScenarioDefinition[];
  raw: string;
}

export async function parseWebSuite(kind: 'contract' | 'adversarial', format: 'csv' | 'jsonc' | 'jsonl', fileName: string, raw: string): Promise<WebSuite> {
  let name = fileName;
  let suiteId = fileName.replace(/\.[^.]+$/u, '').replaceAll(/[^A-Za-z0-9_-]+/gu, '-');
  let scenarios: ScenarioDefinition[] = [];
  if (format === 'csv') {
    const parsed = kind === 'adversarial' ? parseAdversarialCsv(raw) : parseContractCsv(raw);
    if (parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `Row ${issue.row}: ${issue.message}`).join(' '));
    scenarios = parsed.scenarios;
  } else if (format === 'jsonl') {
    if (kind !== 'adversarial') throw new Error('JSONL is supported only for adversarial suites.');
    const parsed = parseAdversarialJsonl(raw);
    if (!parsed.suite || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `Line ${issue.line}: ${issue.message}`).join(' ') || 'Invalid adversarial JSONL.');
    suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeAdversarialSuite(parsed.suite);
  } else if (kind === 'adversarial') {
    const parsed = parseAdversarialSuite(raw);
    if (!parsed.suite || parsed.parseErrors.length || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(' ') || 'Invalid adversarial suite JSONC.');
    suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeAdversarialSuite(parsed.suite);
  } else {
    const parsed = parseContractSuite(raw);
    if (!parsed.suite || parsed.parseErrors.length || parsed.issues.length) throw new Error(parsed.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.message}`).join(' ') || 'Invalid contract suite JSONC.');
    suiteId = parsed.suite.id; name = parsed.suite.name; scenarios = normalizeContractSuite(parsed.suite);
  }
  if (!scenarios.length) throw new Error('The selected suite contains no cases.');
  return { suiteId, name, kind, sourceFormat: format, sourcePath: `browser://suite/${browserUuid()}/${fileName}`, revision: await browserSha256(raw), scenarios, raw };
}

export async function parseWebSuiteInWorker(kind: 'contract' | 'adversarial', format: 'csv' | 'jsonc' | 'jsonl', fileName: string, raw: string): Promise<WebSuite> {
  if (typeof Worker === 'undefined') return parseWebSuite(kind, format, fileName, raw);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./suiteImportWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ suite?: WebSuite; error?: string }>) => {
      worker.terminate();
      if (event.data.suite) resolve(event.data.suite);
      else reject(new Error(event.data.error ?? 'The test suite could not be parsed.'));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'The test suite worker failed.')); };
    worker.postMessage({ kind, format, fileName, raw });
  });
}
