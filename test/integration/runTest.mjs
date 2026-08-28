import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporaryRoots = [];

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
  for (const trustMode of ['trusted', 'untrusted']) {
    const workspace = await createWorkspace(trustMode);
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
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
}

async function createWorkspace(trustMode) {
  const workspace = await mkdtemp(path.join(tmpdir(), `turnstage-${trustMode}-integration-`));
  await mkdir(path.join(workspace, '.vscode', 'turnstage', 'profiles'), { recursive: true });
  await mkdir(path.join(workspace, '.vscode', 'turnstage', 'environments'), { recursive: true });
  await writeFile(path.join(workspace, '.vscode', 'turnstage', 'profiles', 'integration.turnstage.jsonc'), JSON.stringify({ version: 1, id: 'integration', name: 'Integration Profile', environment: 'local', opening: { mode: 'static', message: 'Hello from integration.' }, conversation: { send: { method: 'POST', url: '${env.baseUrl}/basic/chat/stream', variants: [{ id: 'first', body: { message: { $value: 'input.text' } } }] } }, stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] } }, null, 2));
  await writeFile(path.join(workspace, '.vscode', 'turnstage', 'environments', 'local.environment.jsonc'), JSON.stringify({ version: 1, id: 'local', name: 'Local', variables: { baseUrl: 'http://127.0.0.1:8787' } }, null, 2));
  return workspace;
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
