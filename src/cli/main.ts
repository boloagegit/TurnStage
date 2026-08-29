import { writeFile } from 'node:fs/promises';
import { executeHeadlessCli } from './runner';
import { NodeCliRuntime } from './nodeRuntime';

void main();

async function main(): Promise<void> {
  const cancellation = new AbortController();
  process.once('SIGINT', () => cancellation.abort());
  process.once('SIGTERM', () => cancellation.abort());
  const io = {
    writeStdout: (text: string) => new Promise<void>((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve())),
    writeStderr: (text: string) => new Promise<void>((resolve, reject) => process.stderr.write(text, (error) => error ? reject(error) : resolve())),
    writeFile: (path: string, text: string) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }).then(() => undefined),
  };
  const result = await executeHeadlessCli(process.argv.slice(2), new NodeCliRuntime(__TURNSTAGE_VERSION__), io, cancellation.signal);
  process.exitCode = result.exitCode;
}
