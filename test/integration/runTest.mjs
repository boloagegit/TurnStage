import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporaryRoots = [];
let mockServer;

try {
  const requestedVersion = process.env.TURNSTAGE_VSCODE_VERSION?.trim() || undefined;
  let vscodeExecutablePath = await downloadAndUnzipVSCode(requestedVersion);
  try {
    await access(vscodeExecutablePath);
  } catch {
    // VS Code 1.134+ names the macOS bundle executable `Code`; older
    // @vscode/test-electron releases still resolve the historical `Electron`.
    if (process.platform !== 'darwin' || path.basename(vscodeExecutablePath) !== 'Electron') throw new Error(`VS Code executable not found: ${vscodeExecutablePath}`);
    vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), 'Code');
    await access(vscodeExecutablePath);
  }
  mockServer = await startMockServer();
  for (const trustMode of ['trusted', 'untrusted']) {
    const workspace = await createWorkspace(trustMode, mockServer.port);
    if (trustMode === 'trusted') await runCliSmoke(workspace);
    const userDataDirectory = await mkdtemp(path.join(tmpdir(), `turnstage-${trustMode}-user-data-`));
    temporaryRoots.push(workspace, userDataDirectory);
    const options = {
      vscodeExecutablePath,
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath: path.join(projectRoot, 'dist', 'test', 'index.js'),
      extensionTestsEnv: { TURNSTAGE_EXPECT_TRUST: trustMode },
      launchArgs: [workspace, '--disable-extensions', '--user-data-dir', userDataDirectory]
    };
    if (trustMode === 'trusted') await runTests(options);
    else await runUntrustedTests(options);
  }
} catch (error) {
  console.error('TurnStage Extension Host integration tests failed.', error);
  process.exitCode = 1;
} finally {
  if (mockServer?.child.exitCode === null) {
    mockServer.child.kill('SIGTERM');
    await new Promise((resolveExit) => mockServer.child.once('exit', resolveExit));
  }
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
}

async function runCliSmoke(workspace) {
  const result = await runProcess(process.execPath, [path.join(projectRoot, 'dist', 'cli.js'), 'run', '--workspace', workspace, '--no-color']);
  if (result.code !== 1) throw new Error(`Headless CLI should return assertion exit code 1 for the known attack, received ${result.code}. stderr=${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed?.summary?.attackSucceeded !== 1 || parsed?.summary?.passed !== 1) throw new Error(`Headless CLI did not execute the expected mock cases: ${result.stdout}`);
  if (!/^[a-f0-9]{64}$/.test(parsed?.manifestDigest ?? '')) throw new Error('Headless CLI did not emit a provenance manifest digest.');
}

async function runProcess(command, args) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('exit', (code) => resolveProcess({ code: code ?? 1, stdout, stderr }));
  });
}

async function createWorkspace(trustMode, mockPort) {
  const workspace = await mkdtemp(path.join(tmpdir(), `turnstage-${trustMode}-integration-`));
  await mkdir(path.join(workspace, '.vscode', 'turnstage', 'profiles'), { recursive: true });
  await mkdir(path.join(workspace, '.vscode', 'turnstage', 'environments'), { recursive: true });
  await mkdir(path.join(workspace, '.vscode', 'turnstage', 'tests'), { recursive: true });
  await writeFile(path.join(workspace, '.vscode', 'turnstage', 'profiles', 'integration.turnstage.jsonc'), JSON.stringify({ version: 1, id: 'integration', name: 'Integration Profile', environment: 'local', opening: { mode: 'static', message: 'Hello from integration.' }, conversation: { send: { method: 'POST', url: '${env.baseUrl}/basic/chat/stream', variants: [{ id: 'first', body: { message: { $value: 'input.text' } } }] } }, stream: { transport: 'sse', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { adversarialSuites: ['.vscode/turnstage/tests/integration.adversarial.jsonc'], qualityRubrics: [{ id: 'integration-quality', name: 'Integration quality', criteria: [{ id: 'relevance', label: 'Relevance', description: 'The disclosed response addresses the fixed integration request.' }] }], reporting: { formats: ['json', 'junit'], outputDirectory: '.turnstage/reports' }, scenarios: [{ id: 'integration-contract', name: 'Integration contract', comparison: { baseline: { label: 'Integration baseline', environment: 'local' }, candidate: { label: 'Integration candidate', environment: 'local' } }, performance: { thresholds: { 'scenario.durationMs': 5000 }, regression: { 'scenario.durationMs': { maxIncreaseMs: 2000, maxIncreasePercent: 1000 } } }, steps: [{ id: 'first-message', input: 'Hello from Test Explorer', assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] }] }] } }, null, 2));
  await writeFile(path.join(workspace, '.vscode', 'turnstage', 'tests', 'integration.adversarial.jsonc'), JSON.stringify({ format: 'turnstage-adversarial-suite', version: 1, id: 'integration-adversarial', name: 'Integration adversarial', sourceBinding: { sourceGlobs: ['src/chat/**'], components: ['chat'] }, runPolicy: { defaultRepetitions: 3 }, cases: [{ id: 'integration-multi-turn-attack', name: 'Integration multi-turn attack', tags: ['integration', 'multi-turn'], mode: 'multiTurn', maxTurns: 2, timeoutMs: 10_000, stopOnAttackSucceeded: false, forbid: { events: ['stream.completed'] }, turns: [{ id: 'context', input: 'Establish context' }, { id: 'attack', input: 'Run the known fixed attack' }] }] }, null, 2));
  await writeFile(path.join(workspace, '.vscode', 'turnstage', 'environments', 'local.environment.jsonc'), JSON.stringify({ version: 1, id: 'local', name: 'Local', variables: { baseUrl: `http://127.0.0.1:${mockPort}` } }, null, 2));
  return workspace;
}

async function startMockServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, 'examples', 'mock-server', 'server.mjs')], {
    env: { ...process.env, TURNSTAGE_MOCK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolvePort, rejectPort) => {
    let stderr = '';
    const timer = setTimeout(() => rejectPort(new Error(`Timed out starting integration mock server. ${stderr}`)), 10_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    child.once('error', (error) => { clearTimeout(timer); rejectPort(error); });
    child.once('exit', (code) => { clearTimeout(timer); rejectPort(new Error(`Integration mock server exited with code ${code}. ${stderr}`)); });
  });
  return { child, port };
}

async function runUntrustedTests(options) {
  const args = [
    ...options.launchArgs,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    `--extensionTestsPath=${options.extensionTestsPath}`,
    `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`
  ];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(options.vscodeExecutablePath, args, { env: { ...process.env, ...options.extensionTestsEnv }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Untrusted Extension Host tests failed with code ${exitCode}.`);
}
