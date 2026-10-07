import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { deleteLinkedContractCase, loadEditableLinkedContractCase } from '../../../src/extension/testing/linkedContractCase';
import { deleteLinkedAdversarialCase, loadEditableLinkedAdversarialCase } from '../../../src/extension/testing/linkedAdversarialCase';
import { parseContractSource } from '../../../src/extension/testing/contractSource';
import { parseAdversarialSource } from '../../../src/extension/testing/adversarialSource';
import { TestRunHistoryRepository } from '../../../src/extension/testing/testRunHistoryRepository';
import { testCaseKey } from '../../../src/shared/testSelection';
import { TEST_RUN_HISTORY_FORMAT, TEST_RUN_HISTORY_VERSION, type TestRunHistoryRecord } from '../../../src/shared/testRunHistory';
import { assertConversationHistoryBoundary } from './conversations';

/**
 * The integration suite deliberately uses only public VS Code APIs. It runs
 * as a single async function so a failed assertion closes the Extension
 * Development Host instead of leaving a test runner or modal picker behind.
 */
export async function run(): Promise<void> {
  const expectedTrust = process.env.TURNSTAGE_EXPECT_TRUST ?? 'trusted';
  const extension = vscode.extensions.getExtension('turnstage.turnstage');
  assert.ok(extension, 'TurnStage extension should be discoverable');
  const installedExtensionsDirectory = process.env.TURNSTAGE_EXPECT_INSTALLED_EXTENSIONS_DIR;
  if (installedExtensionsDirectory) {
    assert.ok(extension.extensionPath.startsWith(installedExtensionsDirectory), `The tested extension must load from the isolated VSIX installation: ${extension.extensionPath}`);
  }
  assert.equal(extension.isActive, true, 'A workspace profile should activate TurnStage so Test Explorer can discover its scenarios');

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The integration runner must open a workspace folder');
  const workspaceRoot = workspaceFolder.uri;
  assert.equal(vscode.workspace.isTrusted, expectedTrust === 'trusted', `Workspace trust should match the ${expectedTrust} integration run`);
  const profileDirectory = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'turnstage', 'profiles');
  const profileUri = vscode.Uri.joinPath(profileDirectory, 'integration.turnstage.jsonc');
  const initialProfileText = await readText(profileUri);

  // The profile activation event must not require a Webview to be opened.
  await vscode.commands.executeCommand('turnstage.openOutput');
  assert.equal(extension.isActive, true, 'The activated extension should keep commands available');

  await assertRegisteredCommands(extension);
  await assertManifestCapabilities(extension);
  await assertSecretStorageCommandPath();
  await assertCurlImportBoundary(workspaceRoot);

  // Activation must not initialize or rewrite an existing workspace on its
  // own. This is observable without invoking the interactive initializer.
  assert.equal(await readText(profileUri), initialProfileText, 'Activation must not overwrite an existing profile');

  await assertProfileDiscovery(profileUri);
  await assertConversationContractReports(workspaceRoot);
  await assertConversationHistoryBoundary();
  if (vscode.workspace.isTrusted) await assertManualRunControls(workspaceRoot);
  await assertScopedTestHistoryClear();
  await assertCopilotToolBoundary(workspaceRoot);
  await assertCustomEditorAndTextFallback(profileUri, process.env.TURNSTAGE_MOCK_BASE_URL);
  await assertReplayCloseReopenLifecycle();
  await assertDiagnostics(profileDirectory, profileUri);
  await assertFileDiscoveryAfterCreateAndChange(profileDirectory);
  if (vscode.workspace.isTrusted) await assertLinkedCaseDeleteAndUndo(profileUri);
  await assertWorkspaceTrustBehavior(profileDirectory);
}

async function assertManualRunControls(workspaceRoot: vscode.Uri): Promise<void> {
  const pending = new Set<() => void>();
  const messages: string[] = [];
  let hold = true;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    messages.push((JSON.parse(body) as { message: string }).message);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    const finish = () => {
      pending.delete(finish);
      if (!response.destroyed) response.end('event: message\ndata: {"text":"Mock result."}\n\nevent: done\ndata: {}\n\n');
    };
    response.once('close', () => pending.delete(finish));
    if (hold) pending.add(finish); else finish();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const originals = await Promise.all((await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc')).map(async (uri) => ({ uri, text: await readText(uri) })));
  const profileUri = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'turnstage', 'profiles', 'run-control.turnstage.jsonc');
  try {
    for (const item of originals) {
      const value = JSON.parse(item.text) as Record<string, unknown>;
      value.tests = { scenarios: [] };
      await writeSyncedProfile(item.uri, JSON.stringify(value));
    }
    for (const kind of ['contract', 'adversarial'] as const) {
      const scenarios = Array.from({ length: 12 }, (_, index) => ({
        id: `case-${index + 1}`, name: `Case ${index + 1}`,
        steps: [{ id: 'first', input: `case-${index + 1}:first`, ...(kind === 'contract' ? { assertions: [{ path: 'turn.state', operator: 'equals', value: 'completed' }] } : {}) }, { id: 'second', input: `case-${index + 1}:second` }],
        ...(kind === 'adversarial' ? { adversarial: { mode: 'multiTurn', maxTurns: 2, timeoutMs: 120000, repetitions: 2, forbid: { content: ['forbidden-marker'] } } } : {}),
      }));
      const profile = { version: 1, id: 'run-control', name: 'Run control', conversation: { send: { method: 'POST', url: `http://127.0.0.1:${address.port}/stream`, timeoutMs: 120000, idleTimeoutMs: 120000, variants: [{ id: 'send', body: { message: { $value: 'input.text' } } }] } }, stream: { transport: 'sse', dataFormat: 'json', mappings: [{ id: 'message', match: { event: 'message' }, emit: { type: 'content.text.delta', text: { path: '$.text' } } }, { id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] }, tests: { scenarios, reporting: { formats: ['json'], outputDirectory: '.turnstage/reports' } } };
      const profileText = JSON.stringify(profile);
      await writeSyncedProfile(profileUri, profileText);
      await vscode.commands.executeCommand('turnstage.refreshProfiles');
      for (const cancel of [false, true]) {
        messages.length = 0;
        hold = true;
        let settled = false;
        let runOutcome: unknown;
        const run = Promise.resolve(vscode.commands.executeCommand<'completed' | 'cancelled'>('turnstage.runContractTests')).then((value) => { settled = true; return value; });
        void run.then((value) => { runOutcome = value; }, (error: unknown) => { settled = true; runOutcome = String(error); });
        try {
          await waitFor(async () => {
            if (settled) throw new Error(`Run settled before three active cases: ${JSON.stringify({ kind, runOutcome, messages })}`);
            return messages.length === 3 ? true : undefined;
          }, `${kind} first three active cases`);
        } catch (error) {
          console.error(`Run-control start failed: ${JSON.stringify({ kind, messages, pending: pending.size, settled, runOutcome })}`);
          throw error;
        }
        assert.equal(await vscode.commands.executeCommand('turnstage.pauseTests'), true);
        hold = false;
        for (const finish of [...pending]) finish();
        const requestsPerCase = kind === 'contract' ? 2 : 4;
        try {
          await waitFor(async () => messages.length === 3 * requestsPerCase && pending.size === 0 ? true : undefined, `${kind} active cases drained`);
        } catch (error) {
          console.error(`Run-control drain failed: ${JSON.stringify({ kind, messages, pending: pending.size, settled })}`);
          throw error;
        }
        await new Promise((done) => setTimeout(done, 250));
        assert.equal(settled, false, `${kind} must stay paused, not finish or dispatch further cases`);
        assert.equal(new Set(messages.map((message) => message.split(':')[0])).size, 3);
        assert.equal(await vscode.commands.executeCommand(cancel ? 'turnstage.cancelTests' : 'turnstage.resumeTests'), true);
        assert.equal(await run, cancel ? 'cancelled' : 'completed');
        assert.equal(messages.length, (cancel ? 3 : 12) * requestsPerCase);
        assert.equal(new Set(messages.map((message) => message.split(':')[0])).size, cancel ? 3 : 12);
        assert.equal(await vscode.commands.executeCommand('turnstage.pauseTests'), false, 'No stale run control remains after completion');
        if (!cancel) {
          const report = JSON.parse(await readText(vscode.Uri.joinPath(workspaceRoot, '.turnstage', 'reports', 'run-control.turnstage-contract-results.json'))) as { summary: { total: number; passed: number } };
          assert.equal(report.summary.total, 12);
          assert.equal(report.summary.passed, 12);
        }
        console.log(`Extension Host ${kind}: pause/drain/${cancel ? 'cancel' : 'resume'} passed (${messages.length} requests).`);
      }
      messages.length = 0;
      hold = true;
      const aborted = Promise.resolve(vscode.commands.executeCommand('turnstage.runContractTests'));
      void aborted.catch(() => undefined);
      await waitFor(async () => messages.length === 3 ? true : undefined, `${kind} active cancellation requests`);
      assert.equal(await vscode.commands.executeCommand('turnstage.cancelTests'), true);
      assert.equal(await aborted, 'cancelled');
      await waitFor(async () => pending.size === 0 ? true : undefined, `${kind} cancelled sockets closed`);
      assert.equal(messages.length, 3, 'Cancellation aborts current requests without dispatching new cases');
      console.log(`Extension Host ${kind}: active cancellation passed (3 aborted requests).`);
    }
  } finally {
    await vscode.commands.executeCommand('turnstage.cancelTests');
    for (const finish of [...pending]) finish();
    await new Promise<void>((done) => server.close(() => done()));
    await vscode.workspace.fs.delete(profileUri, { useTrash: false });
    for (const item of originals) {
      await writeSyncedProfile(item.uri, item.text);
    }
    await vscode.commands.executeCommand('turnstage.refreshProfiles');
  }
}

async function writeSyncedProfile(uri: vscode.Uri, text: string): Promise<void> {
  if (!await exists(uri)) await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  // Discovery intentionally reads open documents, including unsaved edits.
  // File-system writes alone race VS Code's document reload on CI platforms.
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.getText() !== text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true, 'Fixture edit must update the open profile document');
  }
  assert.equal(document.getText(), text, 'Discovery must see the exact fixture source');
  assert.equal(await document.save(), true, 'Fixture source must be saved before discovery');
  assert.equal(await readText(uri), text, 'Disk and open profile source must agree');
}

async function assertScopedTestHistoryClear(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'turnstage-test-history-'));
  try {
    const uri = vscode.Uri.file(directory);
    const repository = new TestRunHistoryRepository({ storageUri: uri, globalStorageUri: uri } as vscode.ExtensionContext);
    const profileId = 'history-integration';
    const makeCase = (kind: 'contract' | 'adversarial') => ({ profileId, scenarioId: kind, kind, key: testCaseKey({ profileId, scenarioId: kind, kind }), name: kind, definitionDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64), requestedAttempts: 1, completedAttempts: 1, outcome: kind === 'contract' ? 'passed' as const : 'resisted' as const });
    const run = (id: string, cases: TestRunHistoryRecord['cases']): TestRunHistoryRecord => ({ format: TEST_RUN_HISTORY_FORMAT, version: TEST_RUN_HISTORY_VERSION, id, profileId, startedAt: 1, finishedAt: 2, status: 'completed', runner: 'vscode', evaluatorVersion: 1, profileDigest: 'c'.repeat(64), environmentDigest: 'd'.repeat(64), cases });
    await repository.save(run('mixed', [makeCase('contract'), makeCase('adversarial')]));
    await repository.save(run('red-only', [makeCase('adversarial')]));
    await repository.acceptBaseline(profileId, 'red-only');
    await repository.clear(profileId, 'adversarial');
    assert.deepEqual((await repository.list(profileId)).map((item) => [item.id, item.cases.map((testCase) => testCase.kind)]), [['mixed', ['contract']]]);
    assert.equal(await repository.baseline(profileId), undefined, 'Clearing the baseline run removes its baseline marker');
    await repository.clear(profileId, 'contract');
    assert.deepEqual(await repository.list(profileId), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertLinkedCaseDeleteAndUndo(profileUri: vscode.Uri): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders![0]!.uri;
  for (const item of [
    { path: '.vscode/turnstage/tests/integration.tests.jsonc', id: 'integration-linked-contract', kind: 'contract' as const },
    { path: '.vscode/turnstage/tests/integration.adversarial.csv', id: 'integration-csv-resistance', kind: 'adversarial' as const },
  ]) {
    const uri = vscode.Uri.joinPath(workspaceRoot, ...item.path.split('/'));
    const original = await readText(uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const detail = item.kind === 'contract'
      ? await loadEditableLinkedContractCase(profileUri, item.path, item.id)
      : await loadEditableLinkedAdversarialCase(profileUri, item.path, item.id);
    if (item.kind === 'contract') await deleteLinkedContractCase({ profileUri, sourcePath: item.path, scenarioId: item.id, expectedRevision: detail.revision });
    else await deleteLinkedAdversarialCase({ profileUri, sourcePath: item.path, scenarioId: item.id, expectedRevision: detail.revision });
    const deletedText = await readText(uri);
    const parsed = item.kind === 'contract' ? parseContractSource(item.path, deletedText) : parseAdversarialSource(item.path, deletedText);
    assert.ok(!parsed.scenarios.some((scenario) => scenario.id === item.id), `Deleting a ${item.kind} case must write the source file`);
    const restored = await vscode.workspace.openTextDocument(uri);
    assert.equal(restored.getText(), deletedText, `The ${item.kind} source must be the deleted revision before recovery`);
    if (process.platform === 'darwin') {
      // In the background macOS Extension Host, executeCommand('undo') is a UI-focus
      // command and is a no-op even for a simple TextEditor.edit control case.
      // Recover the same undoable WorkspaceEdit through the public editor API;
      // Linux CI keeps exercising VS Code's actual focused Undo command below.
      const recovery = new vscode.WorkspaceEdit();
      recovery.replace(uri, new vscode.Range(restored.positionAt(0), restored.positionAt(deletedText.length)), original);
      assert.equal(await vscode.workspace.applyEdit(recovery), true, `The ${item.kind} source must accept a VS Code recovery edit`);
    } else {
      assert.equal((activeTabInput() as vscode.TabInputText | undefined)?.uri?.toString(), uri.toString(), 'Undo must target the linked source editor');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString(), 'Undo must focus the linked source text editor');
      await vscode.commands.executeCommand('undo');
    }
    assert.equal(restored.getText(), original, `VS Code must restore the ${item.kind} source edit`);
    assert.equal(await restored.save(), true);
    assert.equal(await readText(uri), original, `The restored ${item.kind} source must save correctly`);
  }
}

async function assertRegisteredCommands(extension: vscode.Extension<unknown>): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  const manifestCommands = (extension.packageJSON.contributes?.commands ?? []) as Array<{ command?: string }>;
  for (const command of manifestCommands.map((item) => item.command)) {
    assert.ok(command && commands.has(command), `${command ?? '<missing command id>'} should be registered from the VSIX manifest`);
  }
  for (const command of [
    'turnstage.initializeWorkspace',
    'turnstage.initializeUser',
    'turnstage.createProfile',
    'turnstage.importProfile',
    'turnstage.importCurl',
    'turnstage.duplicateProfile',
    'turnstage.deleteProfile',
    'turnstage.openProfile',
    'turnstage.openProfileSection',
    'turnstage.openGuide',
    'turnstage.configureProfile',
    'turnstage.runProfile',
    'turnstage.startSession',
    'turnstage.validateProfile',
    'turnstage.openAsText',
    'turnstage.openEnvironment',
    'turnstage.setSecret',
    'turnstage.replayRun',
    'turnstage.exportRun',
    'turnstage.runContractTests',
    'turnstage.exportTestReport',
    'turnstage.openTestEvidence',
    'turnstage.rerunLatestTests',
  ]) {
    assert.ok(commands.has(command), `${command} should be registered`);
  }
}

async function assertManifestCapabilities(extension: vscode.Extension<unknown>): Promise<void> {
  const capabilities = extension.packageJSON.capabilities?.untrustedWorkspaces as {
    supported?: string;
    restrictedConfigurations?: unknown;
  } | undefined;
  assert.ok(capabilities, 'The extension manifest must declare untrusted workspace support');
  assert.equal(capabilities.supported, 'limited');
  assert.deepEqual(capabilities.restrictedConfigurations, [
    'turnstage.profileGlob',
    'turnstage.maxBufferedEvents',
    'turnstage.maxConversationMessages',
    'turnstage.maxBufferedBytes',
    'turnstage.streamBatchIntervalMs',
    'turnstage.runRetention',
    'turnstage.adversarialConcurrency',
    'turnstage.logLevel',
  ]);
  const participants = extension.packageJSON.contributes?.chatParticipants as Array<{ id?: string; name?: string; isSticky?: boolean; commands?: Array<{ name?: string }> }> | undefined;
  assert.deepEqual(participants?.map((participant) => ({ id: participant.id, name: participant.name, isSticky: participant.isSticky, commands: participant.commands?.map((command) => command.name) })), [{
    id: 'turnstage.chat',
    name: 'turnstage',
    isSticky: true,
    commands: ['diagnose', 'run', 'compare', 'configure', 'evidence'],
  }]);
}

async function assertSecretStorageCommandPath(): Promise<void> {
  // The command normally opens two input boxes. In Extension Host tests we
  // provide deterministic answers through the public window API and restore it
  // in a finally block, so the suite never waits for a human picker.
  const windowApi = vscode.window as typeof vscode.window & {
    showInputBox: typeof vscode.window.showInputBox;
  };
  const original = windowApi.showInputBox;
  let inputCount = 0;
  try {
    windowApi.showInputBox = async () => {
      inputCount += 1;
      return inputCount === 1 ? 'integration-secret' : 'integration-secret-value';
    };
    await vscode.commands.executeCommand('turnstage.setSecret');
  } finally {
    windowApi.showInputBox = original;
  }
  assert.equal(inputCount, vscode.workspace.isTrusted ? 2 : 0, vscode.workspace.isTrusted ? 'The SecretStorage command should request a name and value' : 'SecretStorage mutation must be blocked in an untrusted workspace');

  // The value itself is intentionally never observable from the test. This
  // assertion only verifies the non-modal command reached its handler and did
  // not expose the secret through a UI result.
}

async function assertCurlImportBoundary(workspaceRoot: vscode.Uri): Promise<void> {
  const target = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'turnstage', 'profiles', 'api-127-0-0-1.turnstage.jsonc');
  const windowApi = vscode.window as typeof vscode.window & {
    showInputBox: typeof vscode.window.showInputBox;
    showQuickPick: typeof vscode.window.showQuickPick;
    showInformationMessage: typeof vscode.window.showInformationMessage;
  };
  const originalInput = windowApi.showInputBox;
  const originalQuickPick = windowApi.showQuickPick;
  const originalInformation = windowApi.showInformationMessage;
  let inputCount = 0;
  try {
    windowApi.showInputBox = async () => {
      inputCount += 1;
      return 'curl -X POST http://127.0.0.1/v1/chat/completions -H "Authorization: Bearer sk-proj_12345678901234567890" -H "Content-Type: application/json" --data-raw \'{"model":"gpt-4o-mini","messages":[{"role":"user","content":"CAPTURED PRIVATE PROMPT"}]}\'';
    };
    windowApi.showQuickPick = (async (items: readonly unknown[]) => items.find((item) => typeof item === 'object' && item !== null && (item as { scope?: string }).scope === 'workspace')) as typeof vscode.window.showQuickPick;
    windowApi.showInformationMessage = (async (_message: string, ...items: unknown[]) => items.find((item) => item === 'Create Sanitized Profile')) as typeof vscode.window.showInformationMessage;
    await vscode.commands.executeCommand('turnstage.importCurl');
  } finally {
    windowApi.showInputBox = originalInput;
    windowApi.showQuickPick = originalQuickPick;
    windowApi.showInformationMessage = originalInformation;
  }
  if (!vscode.workspace.isTrusted) {
    assert.equal(inputCount, 0, 'Restricted Mode must block cURL import before collecting command text');
    assert.equal(await exists(target), false, 'Restricted Mode must not create a Profile from cURL');
    return;
  }
  assert.equal(inputCount, 1, 'Trusted cURL import should collect one bounded command');
  const imported = await waitFor(async () => await exists(target) ? readText(target) : undefined, 'the sanitized cURL Profile');
  assert.match(imported, /\$\{secret\.apiToken\}/);
  for (const forbidden of ['sk-proj_12345678901234567890', 'CAPTURED PRIVATE PROMPT']) assert.equal(imported.includes(forbidden), false, `Sanitized cURL Profile must exclude ${forbidden}`);
}

async function assertProfileDiscovery(profileUri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.turnstage');
  const profiles = await waitFor(async () => {
    const entries = await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc');
    return entries.some((uri) => uri.toString() === profileUri.toString()) ? entries : undefined;
  }, 'the starter profile to be discoverable');
  assert.equal(profiles.length, vscode.workspace.isTrusted ? 2 : 1, 'Only the trusted run should add the sanitized cURL Profile');
  const document = await vscode.workspace.openTextDocument(profileUri);
  assert.match(document.getText(), /"id"\s*:\s*"integration"/);
}

async function assertConversationContractReports(workspaceRoot: vscode.Uri): Promise<void> {
  const reportDirectory = vscode.Uri.joinPath(workspaceRoot, '.turnstage', 'reports');
  const jsonUri = vscode.Uri.joinPath(reportDirectory, 'integration.turnstage-contract-results.json');
  const junitUri = vscode.Uri.joinPath(reportDirectory, 'integration.turnstage-contract-results.xml');
  const mockBaseUrl = process.env.TURNSTAGE_MOCK_BASE_URL;
  assert.ok(mockBaseUrl, 'The integration runner must expose the local mock-server URL');
  if (vscode.workspace.isTrusted) await postMockProbe(`${mockBaseUrl}/__turnstage_test/concurrency/reset`);
  await vscode.commands.executeCommand('turnstage.refreshProfiles');
  await vscode.commands.executeCommand('turnstage.runContractTests');
  if (!vscode.workspace.isTrusted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await exists(jsonUri), false, 'Restricted Mode must not write configured contract reports');
    assert.equal(await exists(junitUri), false, 'Restricted Mode must not write JUnit contract reports');
    return;
  }
  const json = await waitFor(async () => await exists(jsonUri) ? readText(jsonUri) : undefined, 'the trusted JSON contract report', 15_000);
  const junit = await waitFor(async () => await exists(junitUri) ? readText(junitUri) : undefined, 'the trusted JUnit contract report', 15_000);
  const parsed = JSON.parse(json) as { format?: string; version?: number; summary?: { total?: number; passed?: number; failed?: number; resisted?: number; attackSucceeded?: number }; failureClusters?: Array<{ count?: number; fingerprint?: { digest?: string } }>; scenarios?: Array<{ adversarial?: { outcome?: string; attemptedTurns?: number; completedTurns?: number; plannedTurns?: number; repetitions?: { requestedAttempts?: number; completedAttempts?: number; sampleComplete?: boolean; stability?: string; counts?: Record<string, number> }; reliability?: { completedAttempts?: number; sampleComplete?: boolean; verdict?: string; duration?: { p95Ms?: number } }; timeline?: { entries?: Array<{ phase?: string; location?: { kind?: string } }>; completeness?: string } }; comparison?: { differenceCount?: number } }> };
  assert.equal(parsed.format, 'turnstage-contract-report');
  assert.equal(parsed.version, 2);
  assert.equal(parsed.summary?.total, 4);
  assert.equal(parsed.summary?.passed, 3, json);
  assert.equal(parsed.summary?.failed, 1, json);
  assert.equal(parsed.summary?.resisted, 1, json);
  assert.equal(parsed.summary?.attackSucceeded, 1, json);
  assert.equal(parsed.scenarios?.find((scenario) => scenario.comparison)?.comparison?.differenceCount, 0);
  const adversarialScenarios = parsed.scenarios?.filter((scenario) => scenario.adversarial) ?? [];
  const adversarial = adversarialScenarios.find((scenario) => scenario.adversarial?.outcome === 'attackSucceeded')?.adversarial;
  assert.equal(adversarial?.outcome, 'attackSucceeded');
  assert.equal(adversarial?.attemptedTurns, 2);
  assert.equal(adversarial?.completedTurns, 2);
  assert.equal(adversarial?.plannedTurns, 2);
  assert.equal(adversarial?.repetitions?.requestedAttempts, 3);
  assert.equal(adversarial?.repetitions?.completedAttempts, 3);
  assert.equal(adversarial?.repetitions?.sampleComplete, true);
  assert.equal(adversarial?.repetitions?.stability, 'stable-fail');
  assert.equal(adversarial?.repetitions?.counts?.attackSucceeded, 3);
  assert.equal(adversarial?.reliability?.completedAttempts, 3);
  assert.equal(adversarial?.reliability?.sampleComplete, true);
  assert.equal(adversarial?.reliability?.verdict, 'doesNotMeetTarget');
  assert.ok((adversarial?.timeline?.entries?.length ?? 0) > 0, json);
  assert.ok(adversarial?.timeline?.entries?.some((entry) => entry.phase === 'terminal'), json);
  assert.ok((parsed.failureClusters?.length ?? 0) > 0, json);
  assert.match(parsed.failureClusters?.[0]?.fingerprint?.digest ?? '', /^[a-f0-9]{64}$/);
  const csvAdversarial = adversarialScenarios.find((scenario) => scenario.adversarial?.outcome === 'resisted')?.adversarial;
  assert.equal(csvAdversarial?.repetitions?.requestedAttempts, 2, json);
  assert.equal(csvAdversarial?.repetitions?.completedAttempts, 2, json);
  assert.equal(csvAdversarial?.repetitions?.counts?.resisted, 2, json);
  assert.match(junit, /<testsuite[^>]+tests="4"[^>]+failures="1"/);
  assert.match(junit, /Adversarial attack succeeded/);
  const concurrency = await postMockProbe(`${mockBaseUrl}/__turnstage_test/concurrency/metrics`) as {
    active?: number;
    maxActive?: number;
    maxActiveByMessage?: Record<string, number>;
    intervals?: Array<{ message?: string; startedAt?: number; endedAt?: number }>;
  };
  assert.equal(concurrency.active, 0, JSON.stringify(concurrency));
  assert.equal(concurrency.maxActive, 3, `Run All should use the configured three case workers: ${JSON.stringify(concurrency)}`);
  for (const [message, maximum] of Object.entries(concurrency.maxActiveByMessage ?? {})) {
    assert.equal(maximum, 1, `Repeated requests for one case message must stay sequential (${message}): ${JSON.stringify(concurrency)}`);
  }
  const multiTurnMessages = new Set(['Establish context', 'Run the known fixed attack']);
  const multiTurnIntervals = (concurrency.intervals ?? [])
    .filter((interval) => multiTurnMessages.has(interval.message ?? ''))
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  assert.equal(multiTurnIntervals.length, 6, JSON.stringify(concurrency));
  for (let index = 1; index < multiTurnIntervals.length; index += 1) {
    assert.ok((multiTurnIntervals[index]!.startedAt ?? 0) >= (multiTurnIntervals[index - 1]!.endedAt ?? Number.POSITIVE_INFINITY), `Turns and attempts within one multi-turn case must not overlap: ${JSON.stringify(concurrency)}`);
  }
  console.log(`TurnStage concurrency probe: maxActive=${concurrency.maxActive}; perMessageMax=${Math.max(...Object.values(concurrency.maxActiveByMessage ?? {}), 0)}; multiTurnRequests=${multiTurnIntervals.length}`);
  for (const forbidden of ['Integration Profile', 'Integration contract', 'Integration linked contracts', 'Integration linked contract', 'Integration adversarial', 'Integration multi-turn attack', 'Integration baseline', 'Integration candidate', 'Hello from Test Explorer', 'Hello from linked Test Explorer suite', 'Establish context', 'Run the known fixed attack', 'rawEvents', 'requestPreview', 'actual', 'expected']) {
    assert.equal(json.includes(forbidden), false, `JSON contract report must exclude ${forbidden}`);
    assert.equal(junit.includes(forbidden), false, `JUnit contract report must exclude ${forbidden}`);
  }
}

async function postMockProbe(url: string): Promise<unknown> {
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.ok, true, `Mock-server probe request failed: ${response.status} ${url}`);
  return response.json();
}

async function assertCopilotToolBoundary(workspaceRoot: vscode.Uri): Promise<void> {
  const expectedNames = ['turnstage_find_tests', 'turnstage_run_tests', 'turnstage_inspect_failure', 'turnstage_draft_regression', 'turnstage_validate_tests', 'turnstage_analyze_run', 'turnstage_draft_profile_patch', 'turnstage_apply_profile_patch', 'turnstage_review_response_quality'];
  const registered = new Set(vscode.lm.tools.map((tool) => tool.name));
  for (const name of expectedNames) assert.ok(registered.has(name), `${name} should be registered with the VS Code language model API`);

  const found = await invokeToolJson('turnstage_find_tests', { tag: 'multi-turn', limit: 10 });
  assert.equal(found.ok, true, JSON.stringify(found));
  const items = (((found.data as { tests?: { items?: Array<{ id?: string; caseId?: string; tags?: string[] }> } } | undefined)?.tests?.items) ?? []);
  assert.equal(items.length, 1, JSON.stringify(found));
  assert.equal(items[0]?.caseId, 'integration-multi-turn-attack');
  assert.deepEqual(items[0]?.tags, ['integration', 'multi-turn']);
  const impacted = await invokeToolJson('turnstage_find_tests', { changedFiles: ['src/chat/stream.ts'], limit: 10 });
  assert.equal(impacted.ok, true, JSON.stringify(impacted));
  const impactedItems = ((impacted.data as { tests?: { items?: Array<{ caseId?: string; selectionReason?: string }> } } | undefined)?.tests?.items) ?? [];
  assert.equal(impactedItems.length, 1, JSON.stringify(impacted));
  assert.equal(impactedItems[0]?.caseId, 'integration-multi-turn-attack');
  assert.match(impactedItems[0]?.selectionReason ?? '', /src\/chat\/stream\.ts/);

  const linkedContracts = await invokeToolJson('turnstage_find_tests', { tag: 'linked-contract', limit: 10 });
  assert.equal(linkedContracts.ok, true, JSON.stringify(linkedContracts));
  const linkedItems = ((linkedContracts.data as { tests?: { items?: Array<{ id?: string; profileId?: string; suiteId?: string; caseId?: string; adversarial?: boolean }> } } | undefined)?.tests?.items) ?? [];
  assert.equal(linkedItems.length, 1, JSON.stringify(linkedContracts));
  assert.equal(linkedItems[0]?.profileId, 'integration');
  assert.equal(linkedItems[0]?.suiteId, 'integration-linked-contracts');
  assert.equal(linkedItems[0]?.caseId, 'integration-linked-contract');
  assert.equal(linkedItems[0]?.adversarial, false);
  const linkedValidation = await invokeToolJson('turnstage_validate_tests', { profileId: 'integration', suiteId: 'integration-linked-contracts', caseId: 'integration-linked-contract' });
  assert.equal(linkedValidation.ok, true, JSON.stringify(linkedValidation));
  assert.equal((linkedValidation.data as { valid?: boolean } | undefined)?.valid, true, JSON.stringify(linkedValidation));

  const validated = await invokeToolJson('turnstage_validate_tests', { profileId: 'integration', caseId: 'integration-multi-turn-attack' });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal((validated.data as { valid?: boolean } | undefined)?.valid, true, JSON.stringify(validated));
  const observed = (validated.data as { integrity?: { observed?: { profileFingerprint?: string; suiteFingerprint?: string; caseFingerprints?: Record<string, string> } } } | undefined)?.integrity?.observed;
  assert.match(observed?.profileFingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.match(observed?.suiteFingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(observed?.caseFingerprints ?? {}).length, 1);

  const profileDiagnosis = await invokeToolJson('turnstage_analyze_run', { profile: 'integration', mode: 'configuration' });
  assert.equal(profileDiagnosis.ok, true, JSON.stringify(profileDiagnosis));
  assert.equal((profileDiagnosis.data as { version?: string; sanitized?: boolean } | undefined)?.version, 'DiagnosisResultV1');
  assert.equal((profileDiagnosis.data as { sanitized?: boolean } | undefined)?.sanitized, true);

  if (!vscode.workspace.isTrusted) {
    const reportDirectory = vscode.Uri.joinPath(workspaceRoot, '.turnstage', 'reports');
    const blocked = await invokeToolJson('turnstage_run_tests', { selectors: [items[0]!.id], repetitions: 2 });
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(blocked.error?.code, 'WORKSPACE_UNTRUSTED', JSON.stringify(blocked));
    const blockedDraft = await invokeToolJson('turnstage_draft_profile_patch', { profile: 'integration', operations: [{ path: ['conversation', 'send', 'timeoutMs'], value: 5_000 }] });
    assert.equal(blockedDraft.error?.code, 'WORKSPACE_UNTRUSTED', JSON.stringify(blockedDraft));
    const blockedQuality = await invokeToolJson('turnstage_review_response_quality', { action: 'disclose', evidenceIds: ['not-disclosed'] });
    assert.equal(blockedQuality.error?.code, 'WORKSPACE_UNTRUSTED', JSON.stringify(blockedQuality));
    assert.equal(await exists(reportDirectory), false, 'Restricted Copilot execution must not write reports');
    return;
  }

  const profileUri = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'turnstage', 'profiles', 'integration.turnstage.jsonc');
  const beforeDraft = await readText(profileUri);
  const drafted = await invokeToolJson('turnstage_draft_profile_patch', { profile: 'integration', operations: [{ path: ['conversation', 'send', 'timeoutMs'], value: 5_000, reason: 'Bound the local integration request.' }] });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal((drafted.data as { format?: string } | undefined)?.format, 'turnstage-profile-patch-draft');
  assert.equal(await readText(profileUri), beforeDraft, 'Drafting a safe profile patch must not edit the profile');

  const configuredReport = vscode.Uri.joinPath(workspaceRoot, '.turnstage', 'reports', 'integration.turnstage-contract-results.json');
  const configuredReportBefore = await exists(configuredReport) ? await readText(configuredReport) : undefined;
  const executed = await invokeToolJson('turnstage_run_tests', { selectors: [items[0]!.id], repetitions: 2 });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(await exists(configuredReport) ? await readText(configuredReport) : undefined, configuredReportBefore, 'A Copilot-triggered run must not create or overwrite configured CI reports');
  const executionData = executed.data as { runId?: string; cases?: { items?: Array<{ evidenceId?: string }> } } | undefined;
  assert.ok(executionData?.runId, JSON.stringify(executed));
  const diagnosis = await invokeToolJson('turnstage_analyze_run', { runId: executionData.runId, mode: 'stability' });
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
  assert.equal((diagnosis.data as { repetition?: { requestedAttempts?: number } } | undefined)?.repetition?.requestedAttempts, 2);

  const evidenceId = executionData?.cases?.items?.[0]?.evidenceId;
  assert.ok(evidenceId, JSON.stringify(executed));
  const disclosed = await invokeToolJson('turnstage_review_response_quality', { action: 'disclose', evidenceIds: [evidenceId] });
  assert.equal(disclosed.ok, true, JSON.stringify(disclosed));
  const grant = (disclosed.data as { grant?: { grantId?: string; attempts?: Array<{ attemptId?: string }>; rubrics?: Array<{ id?: string; criteria?: Array<{ id?: string }> }> } } | undefined)?.grant;
  const rubric = grant?.rubrics?.[0];
  assert.ok(grant?.grantId && grant.attempts?.[0]?.attemptId && rubric?.id && rubric.criteria?.[0]?.id, JSON.stringify(disclosed));
  const recorded = await invokeToolJson('turnstage_review_response_quality', { action: 'record', grantId: grant.grantId, review: { summary: 'The disclosed fixture response is relevant.', findings: [{ rubricId: rubric.id, criterionId: rubric.criteria[0]!.id, rating: 'meets', rationale: 'The disclosed response addresses the fixed request.', evidenceAttemptIds: [grant.attempts[0]!.attemptId] }], modelLabel: 'Extension Host fixture' } });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal((recorded.data as { review?: { advisoryOnly?: boolean } } | undefined)?.review?.advisoryOnly, true);
  assert.equal('outcome' in ((recorded.data as { review?: Record<string, unknown> } | undefined)?.review ?? {}), false, JSON.stringify(recorded));
}

async function invokeToolJson(name: string, input: Record<string, unknown>): Promise<{ ok?: boolean; data?: unknown; error?: { code?: string } }> {
  const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
  const text = result.content.find((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)?.value;
  assert.ok(text, `${name} should return one JSON text part`);
  return JSON.parse(text) as { ok?: boolean; data?: unknown; error?: { code?: string } };
}

async function assertCustomEditorAndTextFallback(profileUri: vscode.Uri, mockBaseUrl: string | undefined): Promise<void> {
  assert.ok(mockBaseUrl, 'The custom editor integration requires the local mock-server URL');
  await postMockProbe(`${mockBaseUrl}/__turnstage_test/opening/reset`);
  const document = await vscode.workspace.openTextDocument(profileUri);
  await vscode.commands.executeCommand('vscode.openWith', profileUri, 'turnstage.profileEditor', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
  const customTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? activeTabInput() : undefined, 'the TurnStage custom editor tab');
  assert.equal((customTab as vscode.TabInputCustom).viewType, 'turnstage.profileEditor');
  assert.equal((customTab as vscode.TabInputCustom).uri.toString(), profileUri.toString());
  await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Integration Profile · TurnStage' ? true : undefined, 'the custom editor to replace the backing JSONC filename with the profile title');
  assert.ok(vscode.workspace.textDocuments.some((item) => item.uri.toString() === profileUri.toString()), 'Custom editor must be backed by the shared TextDocument');
  const expectedOpeningRequests = vscode.workspace.isTrusted ? 1 : 0;
  if (vscode.workspace.isTrusted) {
    await waitFor(async () => {
      const metrics = await postMockProbe(`${mockBaseUrl}/__turnstage_test/opening/metrics`) as { requests?: number };
      return metrics.requests === expectedOpeningRequests ? metrics : undefined;
    }, 'the request-backed opening to auto-start exactly once');
  } else {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(((await postMockProbe(`${mockBaseUrl}/__turnstage_test/opening/metrics`)) as { requests?: number }).requests, expectedOpeningRequests, 'Restricted Mode must not auto-start a network-backed opening');
  }

  // Hiding a custom editor disposes its webview DOM because the provider uses
  // retainContextWhenHidden: false. Revealing the same tab must keep using the
  // custom editor; the provider rehydrates the new DOM from cached host state.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The tab-switch regression requires an open workspace folder');
  const switchAwayUri = vscode.Uri.joinPath(workspaceFolder.uri, 'switch-away.txt');
  await writeText(switchAwayUri, 'TurnStage integration tab switch');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(switchAwayUri));
  assert.ok(activeTabInput() instanceof vscode.TabInputText, 'A text editor should temporarily hide the TurnStage custom editor');
  await vscode.commands.executeCommand('vscode.openWith', profileUri, 'turnstage.profileEditor');
  const revealedTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? activeTabInput() : undefined, 'the revealed TurnStage custom editor tab');
  assert.equal((revealedTab as vscode.TabInputCustom).viewType, 'turnstage.profileEditor');
  assert.equal((revealedTab as vscode.TabInputCustom).uri.toString(), profileUri.toString());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(((await postMockProbe(`${mockBaseUrl}/__turnstage_test/opening/metrics`)) as { requests?: number }).requests, expectedOpeningRequests, 'Rehydrating the Webview must not repeat the opening request');

  // A host-side edit must remain visible while the custom editor is open. It
  // exercises the provider document listener and proves the document model
  // remains the source of truth for the webview session.
  const marker = 'Integration Profile';
  const markerOffset = document.getText().indexOf(marker);
  assert.ok(markerOffset >= 0, 'The integration fixture should contain its profile name');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(profileUri, new vscode.Range(document.positionAt(markerOffset), document.positionAt(markerOffset + marker.length)), 'Integration Profile Synced');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await waitFor(() => document.getText().includes('Integration Profile Synced') ? true : undefined, 'the custom editor document edit');
  await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Integration Profile Synced · TurnStage' ? true : undefined, 'the profile name to update the custom editor tab');
  await document.save();
  assert.ok(activeTabInput() instanceof vscode.TabInputCustom, 'The custom editor should survive a TextDocument change');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(((await postMockProbe(`${mockBaseUrl}/__turnstage_test/opening/metrics`)) as { requests?: number }).requests, expectedOpeningRequests, 'Editing Profile metadata must not silently repeat the opening request');

  await vscode.commands.executeCommand('turnstage.openAsText', profileUri);
  const textTab = await waitFor(() => activeTabInput() instanceof vscode.TabInputText ? activeTabInput() : undefined, 'Open as Text to activate a text tab');
  assert.equal((textTab as vscode.TabInputText).uri.toString(), profileUri.toString());

  // Close only the test tab. This invokes the provider's panel disposal path
  // and avoids leaving a dirty editor or a pending Extension Host UI prompt.
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active) await vscode.window.tabGroups.close(active, true);
}

async function assertReplayCloseReopenLifecycle(): Promise<void> {
  const demoUri = vscode.Uri.parse('turnstage-demo:/basic-sse-chat.turnstage.jsonc');
  const first = await vscode.commands.executeCommand<string>('turnstage.replayRun', demoUri);
  assert.equal(first, 'started', 'A built-in fixture replay should start in the Extension Host');
  const firstTab = await waitFor(() => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab?.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === demoUri.toString() ? tab : undefined;
  }, 'the built-in fixture replay tab');

  // Close while replay is still active. The provider must drain the replay
  // task and disposal before a reopened controller reads the run list.
  assert.equal(await vscode.window.tabGroups.close(firstTab, true), true);
  const second = await vscode.commands.executeCommand<string>('turnstage.replayRun', demoUri);
  assert.equal(second, 'started', 'Replay should start after closing and reopening its custom editor');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const repeated = await vscode.commands.executeCommand<string>('turnstage.replayRun', demoUri);
  assert.equal(repeated, 'started', 'A completed replay should be repeatable instead of remaining active');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active?.input instanceof vscode.TabInputCustom && active.input.uri.toString() === demoUri.toString()) await vscode.window.tabGroups.close(active, true);
}

async function assertDiagnostics(profileDirectory: vscode.Uri, profileUri: vscode.Uri): Promise<void> {
  const invalidUri = vscode.Uri.joinPath(profileDirectory, 'invalid.turnstage.jsonc');
  await writeText(invalidUri, '{\n  "version": 1,\n  "id": "invalid",\n');
  await vscode.commands.executeCommand('turnstage.validateProfile', invalidUri);
  const diagnostics = await waitFor(() => {
    const matching = vscode.languages.getDiagnostics(invalidUri).filter((diagnostic) => diagnostic.source === 'TurnStage' || /could not be parsed|invalid json/i.test(diagnostic.message));
    return matching.length ? matching : undefined;
  }, 'TurnStage diagnostics for an invalid profile');
  assert.ok(diagnostics.some((diagnostic) => /could not be parsed|invalid json/i.test(diagnostic.message)), 'Invalid JSONC should produce a TurnStage diagnostic');

  const duplicateUri = vscode.Uri.joinPath(profileDirectory, 'duplicate.turnstage.jsonc');
  await writeText(duplicateUri, validProfile('integration', 'Duplicate Integration Profile'));
  const duplicateDiagnostics = await waitFor(() => {
    const matching = vscode.languages.getDiagnostics(profileUri).filter((diagnostic) => diagnostic.code === 'duplicate-profile-id' || /also used by/i.test(diagnostic.message));
    return matching.length ? matching : undefined;
  }, 'duplicate profile id diagnostics');
  assert.ok(duplicateDiagnostics.length > 0, 'Duplicate profile ids should be surfaced in Problems');
}

async function assertFileDiscoveryAfterCreateAndChange(profileDirectory: vscode.Uri): Promise<void> {
  const watcherUri = vscode.Uri.joinPath(profileDirectory, 'watcher.turnstage.jsonc');
  await writeText(watcherUri, validProfile('watcher', 'Watcher Profile'));
  const created = await waitFor(async () => {
    const entries = await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc');
    return entries.some((uri) => uri.toString() === watcherUri.toString()) ? entries : undefined;
  }, 'a newly-created profile to be found by the configured profile glob');
  assert.ok(created.some((uri) => uri.toString() === watcherUri.toString()));

  const watcherDocument = await vscode.workspace.openTextDocument(watcherUri);
  const editedText = watcherDocument.getText().replace('Watcher Profile', 'Watcher Profile Changed');
  await writeText(watcherUri, editedText);
  await waitFor(async () => (await readText(watcherUri)).includes('Watcher Profile Changed') ? true : undefined, 'a modified profile to be visible through the workspace filesystem');
  await vscode.commands.executeCommand('turnstage.refreshProfiles');
  assert.ok((await vscode.workspace.findFiles('.vscode/turnstage/profiles/*.turnstage.jsonc')).some((uri) => uri.toString() === watcherUri.toString()), 'The refresh command should retain the new profile in discovery');
}

async function assertWorkspaceTrustBehavior(profileDirectory: vscode.Uri): Promise<void> {
  if (vscode.workspace.isTrusted) return;
  const requestUri = vscode.Uri.joinPath(profileDirectory, 'untrusted-request.turnstage.jsonc');
  await writeText(requestUri, JSON.stringify({
    version: 1,
    id: 'untrusted-request',
    name: 'Untrusted Opening Request',
    environment: 'local',
    opening: { mode: 'request', request: { method: 'GET', url: 'http://127.0.0.1:9/should-not-run' } },
    conversation: { send: { method: 'GET', url: 'http://127.0.0.1:9/should-not-run', variants: [{ id: 'default', body: {} }] } },
    stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
  }, null, 2));
  await vscode.commands.executeCommand('vscode.openWith', requestUri, 'turnstage.profileEditor');
  await waitFor(() => activeTabInput() instanceof vscode.TabInputCustom ? true : undefined, 'the untrusted profile custom editor');
  assert.equal(vscode.workspace.isTrusted, false, 'The Extension Host should remain untrusted for this test');
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (active) await vscode.window.tabGroups.close(active, true);
}

function activeTabInput(): vscode.TabInputText | vscode.TabInputCustom | unknown {
  return vscode.window.tabGroups.activeTabGroup.activeTab?.input;
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; }
  catch { return false; }
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function validProfile(id: string, name: string): string {
  return JSON.stringify({
    version: 1,
    id,
    name,
    environment: 'local',
    opening: { mode: 'static', message: 'Integration opening.' },
    conversation: { send: { method: 'POST', url: 'http://127.0.0.1:9/unused', variants: [{ id: 'default', body: { message: { $value: 'input.text' } } }] } },
    stream: { transport: 'sse', mappings: [{ id: 'done', match: { event: 'done' }, emit: { type: 'stream.completed' } }] },
  }, null, 2);
}

async function waitFor<T>(probe: () => T | Promise<T | undefined> | undefined, description: string, timeoutMs = 8_000): Promise<NonNullable<T>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined && value !== false && value !== null) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
