import { parseWebSuite } from './suiteParser';

self.onmessage = (event: MessageEvent<{ kind: 'contract' | 'adversarial'; format: 'csv' | 'jsonc' | 'jsonl'; fileName: string; raw: string }>) => {
  const { kind, format, fileName, raw } = event.data;
  void parseWebSuite(kind, format, fileName, raw).then(
    (suite) => self.postMessage({ suite }),
    (error: unknown) => self.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
};
