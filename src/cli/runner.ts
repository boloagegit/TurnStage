import { parseCliArgs, CLI_USAGE } from './args';
import type { CliExecutionResult, CliExecutionRuntime, CliIo, CliRunOptions, CliVerifyOptions } from './contracts';
import { aggregateExitCode, CLI_EXIT_CODES, type CliExitAggregation } from './exitCodes';
import { renderCliOutput } from './output';

const DEFAULT_VERSION_TEXT = `TurnStage ${typeof __TURNSTAGE_VERSION__ === 'string' ? __TURNSTAGE_VERSION__ : 'development'}\n`;

export interface HeadlessCliExecution {
  exitCode: number;
  output?: string;
  errors: string[];
  aggregation?: CliExitAggregation;
}

/**
 * Parse and execute a headless request through an injected runtime. The
 * runtime owns profile loading, secret resolution, scenario execution and all
 * scenario verdict semantics; this adapter only handles process concerns.
 */
export async function executeHeadlessCli(
  argv: readonly string[],
  runtime: CliExecutionRuntime,
  io: CliIo,
  signal?: AbortSignal,
): Promise<HeadlessCliExecution> {
  const parsed = parseCliArgs(argv);
  if (parsed.options?.command === 'help') {
    await io.writeStdout(parsed.usage);
    return { exitCode: CLI_EXIT_CODES.success, errors: [] };
  }
  if (parsed.options?.command === 'version') {
    await io.writeStdout(DEFAULT_VERSION_TEXT);
    return { exitCode: CLI_EXIT_CODES.success, errors: [] };
  }
  if (!parsed.ok || !parsed.options) {
    const errors = parsed.errors.length ? parsed.errors : ['Invalid command-line arguments.'];
    await io.writeStderr(`${errors.map((error) => `error: ${error}`).join('\n')}\n\n${CLI_USAGE}`);
    return { exitCode: CLI_EXIT_CODES.indeterminate, errors };
  }

  const options = parsed.options;
  if (options.command !== 'run' && options.command !== 'verify') {
    const errors = ['A runnable CLI command is required.'];
    await io.writeStderr(`${errors[0]}\n`);
    return { exitCode: CLI_EXIT_CODES.indeterminate, errors };
  }
  let result: CliExecutionResult;
  let aggregation: CliExitAggregation;
  try {
    if (options.command === 'verify') {
      if (!runtime.verify) {
        const errors = ['The injected runtime does not support manifest verification.'];
        await io.writeStderr(`${errors[0]}\n`);
        return { exitCode: CLI_EXIT_CODES.indeterminate, errors };
      }
      result = await runtime.verify(toVerifyRequest(options), signal);
      aggregation = result.verification
        ? aggregateExitCode([result.verification.valid ? 'passed' : 'configuration'])
        : aggregateExitCode(result.records ?? []);
    } else {
      result = await runtime.execute(toRunRequest(options), signal);
      aggregation = aggregateExitCode(result.records ?? []);
    }
  } catch {
    const errors = ['The injected TurnStage runtime failed before producing a result.'];
    await io.writeStderr(`${errors[0]}\n`);
    return { exitCode: CLI_EXIT_CODES.infrastructure, errors };
  }

  let output: string;
  try {
    const outputResult = options.command === 'verify' && result.verification && !result.records?.length
      ? { ...result, records: [{ id: 'provenance-manifest', outcome: result.verification.valid ? 'passed' : 'configuration' }] }
      : result;
    output = renderCliOutput(outputResult, options.format, aggregation);
  } catch {
    const errors = ['The runtime result could not be serialized safely.'];
    await io.writeStderr(`${errors[0]}\n`);
    return { exitCode: CLI_EXIT_CODES.indeterminate, errors, aggregation };
  }
  try {
    if (options.outputPath && options.outputPath !== '-') {
      if (!io.writeFile) {
        const errors = ['An output path was provided, but no file writer was injected.'];
        await io.writeStderr(`${errors[0]}\n`);
        return { exitCode: CLI_EXIT_CODES.indeterminate, errors, aggregation, output };
      }
      await io.writeFile(options.outputPath, output);
    } else await io.writeStdout(output);
  } catch {
    const errors = ['The CLI output could not be written.'];
    await io.writeStderr(`${errors[0]}\n`);
    return { exitCode: CLI_EXIT_CODES.infrastructure, errors, aggregation, output };
  }
  return { exitCode: aggregation.exitCode, errors: [], output, aggregation };
}

/** Conventional process-facing wrapper; callers may pass the returned code to process.exitCode. */
export async function runHeadlessCli(argv: readonly string[], runtime: CliExecutionRuntime, io: CliIo, signal?: AbortSignal): Promise<number> {
  return (await executeHeadlessCli(argv, runtime, io, signal)).exitCode;
}

export const runCli = runHeadlessCli;

function toRunRequest(options: CliRunOptions) {
  return {
    command: 'run' as const,
    configFiles: options.configFiles,
    selectors: options.selectors,
    policy: options.policy,
    impact: {
      workspaceRoot: options.workspaceRoot,
      includeUnbound: options.includeUnbound,
      caseIds: options.caseIds,
      tags: options.tags,
      caseSensitive: options.caseSensitive,
    },
  };
}

function toVerifyRequest(options: CliVerifyOptions) { return { command: 'verify' as const, manifestPath: options.manifestPath }; }
