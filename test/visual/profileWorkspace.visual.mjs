import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const artifactDirectory = resolve(root, 'artifacts', 'visual-regression');
const browserCandidates = [
  process.env.TURNSTAGE_CHROMIUM_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('Path outside visual-test root');
    response.setHeader('Content-Type', contentType(file));
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});

await mkdir(artifactDirectory, { recursive: true });
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          globalThis.__turnstageClipboardItems = items;
          await Promise.all(items.flatMap((item) => item.types.map((type) => item.getType(type))));
        }
      }
    });
  });
  const url = `http://127.0.0.1:${address.port}/test/visual/profileWorkspaceHarness.html`;
  const waitForProfile = async () => {
    try { await page.locator('.mobile-chat-preview__app-header strong').waitFor(); }
    catch (error) { throw new Error(`Profile Webview did not hydrate. Page errors: ${pageErrors.join(' | ') || 'none'}`, { cause: error }); }
    assert.equal(await page.getByText('Loading profile…').count(), 0, 'The recreated Webview must not remain on Loading profile…');
    assert.equal(await page.locator('.mobile-chat-preview__app-header strong').innerText(), 'Slow SSE Visual Proof');
    assert.equal(await page.locator('.profile-identity').count(), 0, 'The duplicated full-width Profile identity row must stay removed');
  };

  await page.goto(url);
  await waitForProfile();
  const iconButtons = page.locator('.icon-button');
  for (let index = 0; index < await iconButtons.count(); index += 1) {
    const button = iconButtons.nth(index);
    const accessibleName = await button.getAttribute('aria-label');
    assert.ok(accessibleName?.trim(), `Icon button ${index + 1} must have an accessible name`);
    assert.equal(await button.getAttribute('title'), accessibleName, `Icon button ${index + 1} tooltip must match its accessible name`);
  }
  const sessionTools = page.getByRole('group', { name: 'Session status and actions' });
  assert.ok((await sessionTools.innerText()).includes('Ready'), 'Idle session diagnostics must report Ready instead of the previous turn result');
  assert.equal(await page.locator('.mobile-chat-preview__app-header').getByRole('button').count(), 0, 'Harness actions must stay outside the simulated Chat header');
  assert.equal(await sessionTools.getByRole('button', { name: 'Restart session' }).locator('.codicon-debug-restart').count(), 1, 'Restart session must use the specific VS Code restart Codicon');
  assert.equal(await page.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected'), 'true', 'Debug is the default right-panel mode');
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'false', 'Red Team remains directly available beside Debug');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'false', 'Configure remains directly available beside Debug');
  await page.getByRole('tab', { name: 'Debug' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'true', 'Right Arrow switches to Red Team');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'true', 'A second Right Arrow switches to Configure');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'true', 'Left Arrow switches back to Red Team');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected'), 'true', 'Left Arrow switches back to Debug');
  await page.screenshot({ path: resolve(artifactDirectory, 'wide-dark.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Network' }).click();
  const networkList = page.getByRole('listbox', { name: 'Network requests' });
  assert.equal(await networkList.getByRole('option').count(), 3, 'Network must list opening and each stream attempt');
  assert.equal(await networkList.getByRole('option', { name: /stream.*Attempt 2/i }).getAttribute('aria-selected'), 'true', 'Latest request must be selected by default');
  assert.ok((await page.getByRole('region', { name: 'Request details' }).innerText()).includes('IdleTimeoutError'), 'Failed request details must expose the timeout class');
  await page.getByRole('tab', { name: 'Payload' }).click();
  assert.ok((await page.getByRole('tabpanel', { name: 'Payload' }).innerText()).includes('Why did this time out?'), 'Payload view must expose the redacted request payload');
  await page.getByRole('tab', { name: 'Response' }).click();
  assert.ok((await page.getByRole('tabpanel', { name: 'Response' }).innerText()).includes('Working'), 'Response view must expose the bounded response preview');
  await page.getByRole('tab', { name: 'Timing' }).click();
  assert.ok((await page.getByRole('tabpanel', { name: 'Timing' }).innerText()).includes('5,000 ms'), 'Timing view must expose the configured idle timeout');
  await page.getByRole('tab', { name: 'Headers' }).click();
  const networkHeaders = await page.getByRole('tabpanel', { name: 'Headers' }).innerText();
  assert.ok(!networkHeaders.includes('local-debug-token') && networkHeaders.includes('••••••••'), 'Header view must mask Authorization and response cookies');
  assert.ok(networkHeaders.includes('4bf92f3577b34da6a3ce929d0e0e4736') && networkHeaders.includes('visual-request-2'), 'Header view must expose bounded trace and request correlation identifiers');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'network-timeout-dark.png') });
  await page.getByRole('tab', { name: 'Raw Events' }).click();
  const screenshotButton = page.getByRole('button', { name: 'Copy chat screenshot' });
  await page.keyboard.press('Tab');
  await screenshotButton.focus();
  assert.equal(await screenshotButton.evaluate((element) => element.matches(':focus-visible')), true, 'Screenshot button must expose keyboard focus');
  await screenshotButton.click();
  await page.waitForFunction(() => Array.isArray(globalThis.__turnstageClipboardItems) && globalThis.__turnstageClipboardItems.length === 1);
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Chat screenshot copied to clipboard.' }).waitFor();
  assert.equal(await page.locator('.mobile-chat-preview__status').textContent(), 'Chat screenshot copied to clipboard.', 'Screenshot action must confirm the clipboard write');
  const screenshotDataUrl = await page.evaluate(async () => {
    const clipboardItem = globalThis.__turnstageClipboardItems[0];
    const blob = await clipboardItem.getType('image/png');
    return new Promise((resolveRead, rejectRead) => {
      const reader = new globalThis.FileReader();
      reader.onload = () => resolveRead(reader.result);
      reader.onerror = rejectRead;
      reader.readAsDataURL(blob);
    });
  });
  assert.ok(screenshotDataUrl.startsWith('data:image/png;base64,iVBOR'), 'Screenshot button must copy a PNG payload');
  const screenshotBytes = Buffer.from(screenshotDataUrl.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(screenshotBytes.length > 1_000, 'Generated PNG must contain the rendered Chat viewport');
  const screenshotComposerMargins = await page.evaluate(async (dataUrl) => {
    const capturedImage = document.createElement('img');
    await new Promise((resolveLoad, rejectLoad) => {
      capturedImage.onload = resolveLoad;
      capturedImage.onerror = rejectLoad;
      capturedImage.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = capturedImage.naturalWidth;
    canvas.height = capturedImage.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas context is unavailable');
    context.drawImage(capturedImage, 0, 0);
    const sampleY = Math.max(0, canvas.height - 30);
    const background = context.getImageData(0, canvas.height - 1, 1, 1).data;
    const row = context.getImageData(0, sampleY, canvas.width, 1).data;
    const differsFromBackground = (offset) => Math.abs(row[offset] - background[0]) + Math.abs(row[offset + 1] - background[1]) + Math.abs(row[offset + 2] - background[2]) > 12;
    let first = -1;
    let last = -1;
    for (let x = 0; x < canvas.width; x += 1) {
      if (!differsFromBackground(x * 4)) continue;
      if (first < 0) first = x;
      last = x;
    }
    return { left: first, right: last < 0 ? -1 : canvas.width - 1 - last, width: canvas.width };
  }, screenshotDataUrl);
  assert.ok(screenshotComposerMargins.left > 0 && screenshotComposerMargins.right > 0, 'Captured composer must be inset from both Chat viewport edges');
  assert.ok(Math.abs(screenshotComposerMargins.left - screenshotComposerMargins.right) <= 2, `Captured composer must remain centered; observed margins ${JSON.stringify(screenshotComposerMargins)}`);
  await writeFile(resolve(artifactDirectory, 'chat-viewport-capture-dark.png'), screenshotBytes);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Save visual baseline' }).click();
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual baseline saved.' }).waitFor();
  const baselineMessage = await page.evaluate(() => globalThis.__turnstageMessages.findLast((message) => message.type === 'visual.baseline.save'));
  assert.ok(baselineMessage?.dataUrl.startsWith('data:image/png;base64,iVBOR'), 'Visual baseline must send a validated PNG capture to the Host');
  assert.deepEqual(baselineMessage.viewport, { id: 'responsive', width: baselineMessage.viewport.width, height: baselineMessage.viewport.height }, 'Visual baseline must identify the active logical viewport');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Compare visual baseline' }).click();
  await page.locator('.mobile-chat-preview__status').filter({ hasText: 'Visual comparison passed (0%).' }).waitFor();
  await page.locator('.preview-pane').screenshot({ path: resolve(artifactDirectory, 'visual-regression-toolbar-dark.png') });
  const openingRegion = page.getByRole('region', { name: 'Opening' });
  assert.equal(await openingRegion.getByRole('heading', { name: 'Opening' }).count(), 1, 'Opening content must be explicitly labelled');
  const openingAlignment = await Promise.all([
    openingRegion.locator('.mobile-chat-preview__opening-avatar'),
    openingRegion.locator('.mobile-chat-preview__opening-label'),
  ].map((locator) => locator.boundingBox()));
  assert.ok(openingAlignment.every(Boolean), 'Opening avatar and label must be rendered');
  const openingAvatarCenter = openingAlignment[0].y + openingAlignment[0].height / 2;
  const openingLabelCenter = openingAlignment[1].y + openingAlignment[1].height / 2;
  assert.ok(Math.abs(openingAvatarCenter - openingLabelCenter) <= 1, `Opening avatar and label must share a vertical center; observed ${openingAvatarCenter} and ${openingLabelCenter}`);
  const assistantMessage = page.locator('[data-message-id="assistant-1"]');
  const assistantAvatar = assistantMessage.locator('.mobile-chat-preview__message-avatar');
  const assistantHeading = assistantMessage.locator('.mobile-chat-preview__message-heading');
  const assistantAlignment = await Promise.all([assistantAvatar, assistantHeading].map((locator) => locator.boundingBox()));
  assert.ok(assistantAlignment.every(Boolean), 'Assistant avatar and heading must be rendered');
  const avatarCenter = assistantAlignment[0].y + assistantAlignment[0].height / 2;
  const headingCenter = assistantAlignment[1].y + assistantAlignment[1].height / 2;
  assert.ok(Math.abs(avatarCenter - headingCenter) <= 1, `Assistant avatar and name must share a vertical center; observed ${avatarCenter} and ${headingCenter}`);
  assert.equal(await assistantMessage.getByRole('group', { name: 'Message actions' }).evaluate((element) => getComputedStyle(element).opacity), '1', 'Message actions must be visible by default');
  const messageMetricText = await assistantMessage.getByLabel('Message metrics').innerText();
  assert.ok(messageMetricText.includes('TTFT') && messageMetricText.includes('1,808 ms'), 'Per-message TTFT must be visible');
  assert.ok(messageMetricText.includes('Total') && messageMetricText.includes('3,612 ms'), 'Per-message total duration must be visible');
  assert.ok(!messageMetricText.includes('E2E') && !messageMetricText.includes('Tokens'), 'Backend-reported and token metrics must not appear unless a profile opts in');
  await page.locator('.preview-pane').screenshot({ path: resolve(artifactDirectory, 'message-actions-metrics-dark.png') });
  await page.getByRole('tab', { name: 'Configure' }).click();
  const inspectMessage = assistantMessage.getByRole('button', { name: 'Inspect message' });
  await inspectMessage.click();
  assert.equal(await page.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected'), 'true', 'Inspect message must switch the right pane from Configure to Debug');
  assert.equal(await page.getByRole('tab', { name: 'Raw Events' }).getAttribute('aria-selected'), 'true', 'Inspect message must open Raw Events');
  await page.locator('#inspector-event-6').waitFor();
  assert.equal(await page.locator('#inspector-event-6').getAttribute('aria-selected'), 'true', 'Inspect message must select the last linked raw event');
  await page.waitForFunction(() => document.activeElement?.id === 'inspector-event-6');
  assert.equal(await page.locator('#inspector-event-6').evaluate((element) => element === document.activeElement), true, 'Inspect message must focus the selected raw event');
  assert.ok((await assistantMessage.getByRole('status').innerText()).includes('Opened raw event #6 in Debug.'), 'Inspect message must show visible action feedback');
  await page.screenshot({ path: resolve(artifactDirectory, 'inspect-message-debug-dark.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Raw Events' }).click();
  await page.getByRole('combobox', { name: 'Conversation turn' }).selectOption('all');
  const eventTree = page.getByRole('tree', { name: 'Raw Events' });
  const turnRows = eventTree.locator('[role="treeitem"][aria-level="1"]');
  const eventRows = eventTree.locator('[role="treeitem"][aria-level="2"]');
  const firstEventRow = eventRows.first();
  const secondEventRow = eventRows.nth(1);
  const fourthEventRow = eventRows.nth(3);
  assert.ok((await firstEventRow.innerText()).includes('Δ—'), 'The first raw event must show that no previous-event gap exists');
  assert.ok((await secondEventRow.innerText()).includes('Δ601 ms'), 'Raw event rows must show the interval from the complete source stream');
  assert.ok((await turnRows.nth(0).innerText()).includes('Turn 1') && (await turnRows.nth(1).innerText()).includes('Turn 2'), 'Conversation-wide events must render as explicit turn groups');
  assert.ok((await turnRows.nth(0).innerText()).includes('Explain the safety boundary') && (await turnRows.nth(1).innerText()).includes('Verify themed streaming layout'), 'Turn groups must expose a bounded user-message excerpt');
  assert.ok((await firstEventRow.innerText()).includes('#1') && (await fourthEventRow.innerText()).includes('#1'), 'Event children must expose their per-turn sequence');
  assert.ok((await fourthEventRow.innerText()).includes('Δ—'), 'The first event in each turn must reset its event gap');
  assert.deepEqual(await page.getByRole('combobox', { name: 'Conversation turn' }).locator('option').allTextContents(), ['All turns', 'Turn 1 (3)', 'Turn 2 (3)'], 'Turn filter must expose every retained conversation turn');
  await turnRows.nth(0).click();
  assert.equal(await turnRows.nth(0).getAttribute('aria-expanded'), 'false', 'Turn groups must collapse without removing other conversation turns');
  assert.equal(await eventTree.locator('[role="treeitem"][aria-level="2"]').count(), 3, 'Collapsing one group must keep the other turn events visible');
  await turnRows.nth(0).click();
  assert.equal(await firstEventRow.getAttribute('data-disclosure-state'), 'collapsed', 'Event rows must expose their collapsed state');
  await firstEventRow.click();
  await page.getByRole('region', { name: 'Event payload' }).waitFor();
  assert.equal(await firstEventRow.getAttribute('aria-selected'), 'true', 'Selecting an event must expose its payload');
  assert.equal(await firstEventRow.locator('.codicon-chevron-down').count(), 1, 'Selected event must use the expanded VS Code Codicon');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'event-payload-dark.png') });
  await page.getByRole('tab', { name: 'Configure' }).click();
  await page.getByRole('heading', { level: 1, name: 'General' }).waitFor();
  assert.equal(await page.locator('.preview-pane').count(), 1, 'Opening Configure must keep the Chat preview mounted');
  assert.equal(await page.locator('.settings-workspace--embedded').count(), 1, 'Configure uses the compact right-pane settings layout');
  assert.equal(await page.getByRole('navigation', { name: 'Profile configuration sections' }).count(), 0, 'Embedded Configure must not add another navigation rail');
  assert.equal(await page.getByRole('combobox', { name: 'Profile configuration sections' }).inputValue(), 'general', 'Embedded Configure uses one compact section picker');
  assert.equal(await page.locator('[data-message-id="assistant-1"][data-selected="true"]').count(), 0, 'Configure must hide Debug message selection styling');
  await page.screenshot({ path: resolve(artifactDirectory, 'profile-config-right-pane-dark.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Profile configuration sections' }).selectOption('request');
  await page.getByRole('heading', { level: 1, name: 'Request' }).waitFor();
  await page.getByRole('heading', { name: 'Connection Doctor' }).waitFor();
  assert.equal(await page.getByText('Connection needs attention', { exact: true }).count(), 1, 'Connection Doctor must expose a clear fail-closed status');
  assert.equal(await page.getByText('Terminal not mapped', { exact: true }).count(), 1, 'Connection Doctor must expose the terminal mapping cause without payload content');
  assert.equal(await page.getByRole('button', { name: 'Ask Copilot to diagnose this configuration' }).count(), 1, 'Connection Doctor must expose an explicit Copilot handoff only when attention is required');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'connection-doctor-dark.png') });
  await page.getByRole('combobox', { name: 'Profile configuration sections' }).selectOption('scenario-tests');
  await page.getByRole('heading', { level: 1, name: 'Scenarios' }).waitFor();
  assert.equal(await page.locator('.scenario-editor').count(), 1, 'Configure must keep the conversation contract separate from adversarial cases');
  assert.equal(await page.locator('.scenario-step').count(), 1, 'The contract editor must keep its configured turn compact');
  assert.equal(await page.locator('.assertion-row').count(), 3, 'The contract editor must render step and final assertions');
  assert.equal(await page.getByRole('heading', { name: 'CI reports' }).count(), 1, 'Scenario configuration must expose CI report settings');
  assert.equal(await page.getByRole('heading', { name: 'Visual regression' }).count(), 1, 'Scenario configuration must expose visual baseline settings');
  assert.equal(await page.getByLabel('HTML').isChecked(), true, 'Scenario reports must expose HTML output');
  assert.equal(await page.locator('.scenario-advanced[open]').count(), 1, 'Configured baseline comparison must remain expanded');
  assert.equal(await page.locator('.scenario-budget__row').count(), 9, 'Every supported performance metric must be configurable');
  const advisoryReview = page.getByRole('heading', { name: 'Advisory AI review' });
  await advisoryReview.scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('checkbox', { name: 'Use custom quality rubrics' }).isChecked(), true, 'Advisory review must expose an explicit custom-rubric control');
  assert.equal(await page.getByLabel('Rubric name').inputValue(), 'Support response quality', 'The rubric editor must keep human-readable quality criteria visible');
  assert.equal(await page.getByLabel('Evaluation guidance').inputValue(), 'The response directly addresses the requested task without unrelated content.', 'Quality criteria must expose concrete evaluation guidance');
  await page.locator('.quality-rubric-editor').screenshot({ path: resolve(artifactDirectory, 'advisory-quality-rubric-dark.png') });
  await page.screenshot({ path: resolve(artifactDirectory, 'scenario-contract-settings-dark.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Red Team' }).click();
  await page.getByRole('heading', { level: 1, name: 'Adversarial testing' }).waitFor();
  const campaignCard = page.locator('.campaign-card').filter({ hasText: 'Release safety' });
  await campaignCard.scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('heading', { name: 'Test campaigns' }).count(), 1, 'Scenario configuration must expose bounded test campaigns');
  assert.equal(await campaignCard.getByText('Completed', { exact: true }).count(), 1, 'Campaign status must be visible without opening a detail page');
  assert.equal(await campaignCard.getByText('1 regression', { exact: true }).count(), 1, 'Campaign baseline regressions must be visible at a glance');
  assert.equal(await campaignCard.getByText(/Resisted.*Attack succeeded/i).count(), 1, 'Campaign regression must explain the baseline-to-current transition');
  assert.equal(await campaignCard.getByRole('button', { name: 'Preview plan' }).count(), 1, 'Campaign preview must remain distinct from execution');
  assert.equal(await campaignCard.getByRole('button', { name: 'Run', exact: true }).count(), 1, 'Campaign execution must expose one clear primary action');
  await campaignCard.getByText('More', { exact: true }).click();
  assert.equal(await campaignCard.getByRole('button', { name: 'Export results JSONL' }).count(), 1, 'Campaign history must expose bulk machine-readable export');
  assert.equal(await campaignCard.getByRole('button', { name: 'Summarize with Copilot' }).count(), 1, 'Copilot analysis must stay a distinct advisory action');
  assert.equal(await campaignCard.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Campaign controls must not overflow the settings pane');
  await campaignCard.screenshot({ path: resolve(artifactDirectory, 'campaign-regression-dark.png') });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-test-run', type: 'test.operation', operation: { action: 'runAll', state: 'running', progress: { totalCases: 100, completedCases: 24, totalAttempts: 125, completedAttempts: 31, activeCaseNames: ['Prompt boundary', 'Tool policy'] } } } })));
  const activeTestRun = page.locator('.test-operation-status--running');
  await activeTestRun.waitFor();
  assert.ok((await activeTestRun.innerText()).includes('24 / 100 cases · 31 / 125 attempts'), 'Run all feedback must expose measurable case and attempt progress');
  assert.equal(await activeTestRun.getByRole('progressbar').getAttribute('value'), '24', 'Run all feedback must use a determinate progress value after planning');
  assert.equal(await page.getByRole('button', { name: 'Running all…' }).isDisabled(), true, 'An active Red Team run must disable duplicate starts');
  assert.equal(await page.getByRole('button', { name: 'Stop test run' }).locator('.codicon-debug-stop').count(), 1, 'An active Red Team run must expose a distinct stop action');
  await activeTestRun.screenshot({ path: resolve(artifactDirectory, 'adversarial-run-active-dark.png') });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-test-run-complete', type: 'test.operation', operation: { action: 'runAll', state: 'completed' } } })));
  const linkedCsv = page.getByText('.vscode/turnstage/tests/security-regression.adversarial.csv', { exact: true });
  await linkedCsv.scrollIntoViewIfNeeded();
  assert.equal(await linkedCsv.count(), 1, 'Red Team must show a directly linked CSV source without copying it into Profile JSONC');
  const openLinkedCsv = page.getByRole('button', { name: 'Open linked suite .vscode/turnstage/tests/security-regression.adversarial.csv' });
  assert.equal(await openLinkedCsv.locator('.codicon-go-to-file').count(), 1, 'Linked suites must expose a distinct open-file Codicon');
  await openLinkedCsv.click();
  assert.equal((await page.evaluate(() => globalThis.__turnstageMessages.findLast((message) => message.type === 'adversarial.openLinkedSuite'))).path, '.vscode/turnstage/tests/security-regression.adversarial.csv', 'Open linked suite must send the exact linked path');
  assert.equal(await page.getByRole('button', { name: 'Unlink suite .vscode/turnstage/tests/security-regression.adversarial.csv' }).locator('.codicon-trash').count(), 1, 'Open and unlink must use distinguishable icons');
  assert.equal(await page.locator('button:visible', { hasText: 'Link suite' }).count(), 1, 'Bulk source linking must use one visible format-neutral action');
  await page.locator('.adversarial-linked-suites').screenshot({ path: resolve(artifactDirectory, 'linked-adversarial-csv-dark.png') });
  const runningPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await runningPage.goto(`${url}?section=scenario-tests&campaignStatus=running`);
  await runningPage.getByRole('tab', { name: 'Red Team' }).click();
  const runningCampaign = runningPage.locator('.campaign-card').filter({ hasText: 'Release safety' });
  await runningCampaign.waitFor();
  assert.equal(await runningCampaign.getByText('Running', { exact: true }).count(), 1, 'A running campaign must expose its current state');
  assert.equal(await runningCampaign.getByRole('button', { name: 'Run', exact: true }).isDisabled(), true, 'A running campaign must prevent duplicate execution');
  assert.equal(await runningCampaign.getByRole('button', { name: 'Cancel run' }).count(), 1, 'A running campaign must expose a distinct cancellation action');
  await runningCampaign.screenshot({ path: resolve(artifactDirectory, 'campaign-running-dark.png') });
  await runningPage.close();
  assert.equal(await page.getByRole('table').count(), 1, 'Red Team must present case settings in a compact table');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('.adversarial-case-editor').count(), 1, 'Adversarial configuration must expose its bounded case editor');
  assert.equal(await page.locator('.scenario-step').count(), 2, 'The expanded adversarial row must expose both configured turns');
  assert.equal(await page.getByRole('spinbutton', { name: 'Repetitions', exact: true }).inputValue(), '5', 'Adversarial configuration must expose the case repetition count');
  assert.equal(await page.getByRole('checkbox', { name: 'Stop remaining turns after an attack succeeds' }).isChecked(), true, 'Turn-level stopping must remain distinct from repetition fail-fast');
  assert.equal(await page.getByRole('checkbox', { name: 'Stop remaining repetitions after an attack succeeds (incomplete sample)' }).isChecked(), false, 'Repetition fail-fast must remain explicit and off unless configured');
  await page.getByRole('spinbutton', { name: 'Repetitions', exact: true }).scrollIntoViewIfNeeded();
  const settingsMainScroll = await page.locator('.settings-main').evaluate((element) => ({ scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, panelWidth: element.querySelector('.settings-panel')?.getBoundingClientRect().width, tableWrapWidth: element.querySelector('.adversarial-case-table-wrap')?.getBoundingClientRect().width }));
  assert.equal(settingsMainScroll.scrollLeft, 0, `Focusing a wide adversarial table field must not horizontally shift the entire settings pane: ${JSON.stringify(settingsMainScroll)}`);
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-repetitions-dark.png') });
  assert.equal(await page.getByRole('heading', { name: 'Latest adversarial results' }).count(), 1, 'Scenario configuration must expose the compact latest-result list');
  assert.equal(await page.getByText('Attack succeeded', { exact: true }).count(), 1, 'Latest results must distinguish an attack from resistance');
  assert.equal(await page.getByText('3/5 resisted · 5 attempts', { exact: true }).count(), 1, 'Latest results must expose the repeated-run sample at a glance');
  assert.equal(await page.getByText('Unstable result', { exact: true }).count(), 1, 'Latest results must expose whether repeated outcomes are stable');
  const adversarialResults = page.locator('.adversarial-result-list');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Open evidence' }).count(), 2, 'Every latest result must expose one clear primary evidence action');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Review timeline' }).count(), 2, 'Every latest result must keep timeline review as the single secondary action');
  await adversarialResults.getByLabel('More actions').first().click();
  assert.equal(await adversarialResults.getByRole('button', { name: 'Diagnose with Copilot' }).count(), 1, 'The opened overflow menu must retain Copilot diagnosis without crowding the result row');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Chat' }).count(), 1, 'The overflow menu must retain the Chat evidence location when available');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Events' }).count(), 1, 'The opened overflow menu must retain its available Events location');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Advisory quality review' }).count(), 1, 'Quality review must remain visibly advisory and separate from formal diagnosis');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'copilot-result-actions-dark.png') });
  await adversarialResults.getByLabel('More actions').first().click();
  await page.getByLabel('Export adversarial results').click();
  assert.equal(await page.getByRole('button', { name: 'HTML report' }).count(), 1, 'Latest results must expose HTML export in the compact export menu');
  assert.equal(await page.getByRole('button', { name: 'Evidence Bundle' }).isEnabled(), true, 'Trusted workspaces must expose the sanitized Evidence Bundle export');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-export-menu-dark.png') });
  await page.getByLabel('Export adversarial results').click();
  assert.equal(await page.locator('.debug-pane').evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Red Team configuration must not overflow the right pane horizontally');
  await adversarialResults.scrollIntoViewIfNeeded();
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-results-dark.png') });
  await adversarialResults.getByRole('button', { name: 'Review timeline' }).first().click();
  const findingTimelineAction = page.getByRole('button', { name: 'Open Forbidden URL observed evidence at 1,840 ms' });
  await findingTimelineAction.waitFor();
  assert.equal(await findingTimelineAction.count(), 1, 'Red Team timeline must make the failure point directly navigable');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-timeline-dark.png') });
  await adversarialResults.getByRole('button', { name: 'Open evidence' }).first().click();
  await page.getByRole('tab', { name: 'Debug' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#right-pane-debug-tab')?.getAttribute('aria-selected') === 'true');
  await page.getByRole('heading', { name: 'Attack succeeded: Known two-turn probe' }).waitFor();
  assert.equal(await page.getByText('3/5 resisted · 5 attempts · Unstable result', { exact: true }).count(), 1, 'Evidence summary must preserve the repeated-run stability context');
  assert.equal(await page.getByText('Reliability: 60% · Does not meet target · p95 3,612 ms', { exact: true }).count(), 1, 'Evidence summary must expose bounded reliability and p95 context');
  assert.equal(await page.locator('.profile-identity').count(), 0, 'Evidence arrival must not restore the duplicated Profile row');
  assert.equal(await page.getByRole('button', { name: 'Open Chat' }).count(), 1, 'Evidence summary must promote the most relevant location');
  assert.equal(await page.getByRole('heading', { name: 'Causal timeline' }).count(), 0, 'Evidence summary must not duplicate the Red Team causal timeline');
  assert.equal(await page.getByRole('combobox', { name: 'Test case' }).locator('option').count(), 2, 'Evidence review must keep every latest result directly switchable');
  assert.equal(await page.getByRole('combobox', { name: 'Test attempt' }).locator('option').count(), 4, 'Evidence review must expose aggregate and bounded repeated attempts');
  assert.equal(await page.getByRole('combobox', { name: 'Test attempt' }).locator('option').nth(3).getAttribute('disabled'), '', 'Evicted attempt evidence must fail closed as unavailable');
  await page.locator('.operation-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-summary-dark.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Test attempt' }).selectOption('attempt:1');
  await page.getByRole('heading', { name: 'Resisted: Known two-turn probe' }).waitFor();
  await page.getByRole('combobox', { name: 'Test case' }).selectOption('visual-evidence-safe');
  await page.getByRole('heading', { name: 'Resisted: Safe tool boundary' }).waitFor();
  await page.getByRole('combobox', { name: 'Test case' }).selectOption('visual-evidence');
  await page.getByRole('heading', { name: 'Attack succeeded: Known two-turn probe' }).waitFor();
  await page.locator('.operation-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-navigation-dark.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Configure' }).click();
  await page.getByRole('combobox', { name: 'Profile configuration sections' }).selectOption('scenario-tests');
  await page.locator('.scenario-advanced').filter({ hasText: 'Compare & performance' }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.scenario-target-grid fieldset').count(), 2, 'Baseline and candidate targets must both render in the GUI');
  assert.equal(await page.locator('.scenario-budget').evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Performance budgets must not overflow the embedded settings pane');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'scenario-comparison-performance-dark.png') });
  await page.getByRole('combobox', { name: 'Profile configuration sections' }).selectOption('general');
  await page.getByRole('heading', { level: 1, name: 'General' }).waitFor();
  const displayName = page.getByLabel('Display name');
  await displayName.fill('GUI Edited Profile');
  await displayName.blur();
  await page.locator('.mobile-chat-preview__app-header strong').filter({ hasText: 'GUI Edited Profile' }).waitFor();
  assert.deepEqual(await latestProfilePatch(page, 'name'), { path: ['name'], value: 'GUI Edited Profile' }, 'General settings must emit a structured name patch and rehydrate the live Chat surface');
  await displayName.fill('Slow SSE Visual Proof');
  await displayName.blur();
  await page.getByRole('button', { name: 'Open JSONC' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.__turnstageMessages.slice(-2).map((message) => message.type)), ['profile.openAsText', 'profile.validate'], 'Configuration toolbar actions must reach the host protocol');
  await page.locator('.operation-status').filter({ hasText: 'Profile is valid.' }).waitFor();
  await page.getByRole('tab', { name: 'Debug' }).click();
  await page.getByRole('tab', { name: 'Raw Events' }).waitFor();
  assert.equal(await page.locator('[data-message-id="assistant-1"][data-selected="true"]').count(), 1, 'Returning to Debug restores the linked message selection');

  await page.goto(`${url}?preset=chat-only&section=general`);
  await page.getByRole('heading', { level: 1, name: 'General' }).waitFor();
  assert.equal(await page.locator('.preview-pane').count(), 1, 'Configure must open beside Chat even when the profile preview preset is chat-only');
  assert.equal(await page.locator('.debug-pane').count(), 1, 'Configure temporarily exposes the right pane for chat-only profiles');

  await page.goto(`${url}?split=72`);
  await waitForProfile();
  const wideChatWidth = await page.locator('.preview-pane').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(wideChatWidth > 700, 'Wide Chat must use the available pane width');
  assert.equal(await page.locator('.mobile-chat-preview__device').evaluate((element) => getComputedStyle(element).transform), 'none', 'Responsive Chat must never scale the rendered UI');
  assert.equal(await page.getByRole('combobox', { name: 'Viewport preset' }).inputValue(), 'responsive', 'Device toolbar defaults to Responsive');
  assert.equal(await page.locator('[data-viewport-mode="responsive"]').count(), 1, 'Responsive mode must fill the Chat pane');
  assert.ok((await page.getByRole('group', { name: 'Session status and actions' }).innerText()).includes('Ready'), 'Wide Chat keeps session context in the preview toolbar');
  await page.screenshot({ path: resolve(artifactDirectory, 'responsive-wide-chat-dark.png'), fullPage: true });

  await page.goto(`${url}?split=25`);
  await waitForProfile();
  const narrowChatWidth = await page.locator('.preview-pane').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(narrowChatWidth <= 430, 'Narrow Chat must be driven by pane width');
  assert.ok((await page.getByRole('group', { name: 'Session status and actions' }).innerText()).includes('Ready'), 'Narrow Chat keeps session context available in the horizontally scrollable toolbar');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Narrow Chat and Debug split must not overflow horizontally');
  await page.screenshot({ path: resolve(artifactDirectory, 'responsive-narrow-chat-dark.png'), fullPage: true });

  await page.goto(`${url}?device=mobile-m`);
  await waitForProfile();
  assert.equal(await page.getByRole('combobox', { name: 'Viewport preset' }).inputValue(), 'mobile-m');
  assert.equal(await page.getByRole('spinbutton', { name: 'Viewport width' }).inputValue(), '375');
  assert.equal(await page.getByRole('spinbutton', { name: 'Viewport height' }).inputValue(), '667');
  assert.equal(await page.locator('[data-viewport-mode="fixed"]').count(), 1, 'A device preset uses a fixed logical viewport');
  assert.equal(await page.locator('[data-viewport-width="375"]').count(), 1, 'The Chat container receives the preset CSS width');
  assert.equal(await page.locator('.mobile-chat-preview__safe-area').count(), 0, 'Device emulation does not add fake phone chrome');
  await page.getByRole('button', { name: 'Rotate viewport' }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Viewport preset' }).inputValue(), 'custom');
  assert.equal(await page.getByRole('spinbutton', { name: 'Viewport width' }).inputValue(), '667');
  assert.equal(await page.getByRole('spinbutton', { name: 'Viewport height' }).inputValue(), '375');
  await page.screenshot({ path: resolve(artifactDirectory, 'device-toolbar-mobile-landscape-dark.png'), fullPage: true });

  await page.selectOption('[aria-label="Viewport preset"]', 'laptop-l');
  assert.equal(await page.locator('[data-viewport-width="1440"]').count(), 1, 'Laptop L switches the logical viewport to 1440px');
  assert.notEqual(await page.getByLabel('Preview scale').innerText(), '100%', 'Fit reports scaling when the viewport exceeds the pane');
  await page.screenshot({ path: resolve(artifactDirectory, 'device-toolbar-laptop-fit-dark.png'), fullPage: true });

  await page.goto(`${url}?active=true&effect=shimmer&speed=1400&intensity=85&draft=First%20line%0ASecond%20line%20wraps%20inside%20the%20composer%0AThird%20line`);
  await waitForProfile();
  const composer = page.getByRole('textbox', { name: 'Message' });
  const composerSizing = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, minimum: Number.parseFloat(style.minHeight), overflowY: style.overflowY };
  });
  assert.ok(composerSizing.height > composerSizing.minimum, 'Multiline composer must grow beyond its single-line minimum');
  assert.equal(await page.locator('.mobile-chat-preview__stream-indicator[data-effect="shimmer"]').count(), 1, 'Streaming Assistant must render the configured shimmer indicator');
  await page.screenshot({ path: resolve(artifactDirectory, 'streaming-shimmer-multiline-dark.png'), fullPage: true });

  await page.goto(`${url}?draft=First%20line%0ASecond%20line%20wraps%20inside%20the%20composer%0AThird%20line`);
  await waitForProfile();
  const idleComposer = page.getByRole('textbox', { name: 'Message' });
  const composerControl = page.locator('.mobile-chat-preview__composer-control');
  const idleComposerBorder = await composerControl.evaluate((element) => getComputedStyle(element).borderColor);
  await idleComposer.hover();
  assert.equal(await composerControl.evaluate((element) => getComputedStyle(element).borderColor), idleComposerBorder, 'Composer hover must not invent a text-input hover highlight');
  await page.locator('.preview-pane').screenshot({ path: resolve(artifactDirectory, 'input-hover-vscode-dark.png') });
  await idleComposer.focus();
  assert.notEqual(await composerControl.evaluate((element) => getComputedStyle(element).borderColor), idleComposerBorder, 'Composer focus must use the VS Code focus border');
  await page.locator('.preview-pane').screenshot({ path: resolve(artifactDirectory, 'input-focus-vscode-dark.png') });

  await page.goto(`${url}?section=chat-ui&effect=dots&speed=1200&intensity=80`);
  await page.getByRole('heading', { level: 1, name: 'Chat UI' }).waitFor();
  assert.equal(await page.getByText('Loading profile…').count(), 0, 'Chat UI settings must not remain on Loading profile…');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'true', 'A configuration command opens Configure in the right pane');
  assert.equal(await page.locator('.preview-pane').count(), 1, 'A configuration command must not replace the Chat preview');
  assert.equal(await page.getByLabel('Assistant streaming effect').inputValue(), 'dots');
  assert.equal(await page.getByLabel('Assistant streaming animation speed').inputValue(), '1200');
  assert.equal(await page.getByLabel('Assistant streaming intensity').inputValue(), '80');
  await page.getByLabel('Message action toolbar visibility').selectOption('interaction');
  await page.locator('.mobile-chat-preview__message-toolbar--interaction').first().waitFor();
  assert.deepEqual(await latestProfilePatch(page, 'ui.messageActionVisibility'), { path: ['ui', 'messageActionVisibility'], value: 'interaction' }, 'Chat UI settings must patch the profile and update the live message toolbar');
  await page.screenshot({ path: resolve(artifactDirectory, 'chat-ui-streaming-settings-dark.png'), fullPage: true });

  await page.goto(url);
  await waitForProfile();

  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.getByRole('heading', { name: 'Recorded runs' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Import run' }).count(), 1, 'Recorded Runs must expose Import run');
  await page.screenshot({ path: resolve(artifactDirectory, 'recorded-runs-dark.png'), fullPage: true });

  await page.goto(`${url}?tab=Runs&replay=playing&active=true`);
  await waitForProfile();
  const replayOperation = page.locator('.runtime-operation--playing');
  await replayOperation.waitFor();
  assert.ok((await replayOperation.innerText()).includes('3 / 6 events'), 'Active replay progress must remain visible above every right-panel view');
  assert.equal(await replayOperation.getByRole('button', { name: 'Stop replay' }).count(), 1, 'Active replay feedback must expose an immediate stop action');
  await page.screenshot({ path: resolve(artifactDirectory, 'replay-active-dark.png'), fullPage: true });

  await page.reload();
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, 'rehydrated-after-reload.png'), fullPage: true });

  await page.goto(`${url}?rightPane=adversarial&section=test`);
  await waitForProfile();
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'true', 'Saved Webview state must restore the last right-panel tab');
  assert.equal(await page.getByRole('heading', { name: 'Latest adversarial results' }).count(), 1, 'Restored Red Team state must render its result workspace without a host section override');
  await page.screenshot({ path: resolve(artifactDirectory, 'rehydrated-red-team-tab.png'), fullPage: true });

  await page.goto(`${url}?persistState=1&preset=chat-with-metrics`);
  await waitForProfile();
  await page.evaluate(() => globalThis.sessionStorage.removeItem('turnstage.visual.webviewState'));
  await page.reload();
  await waitForProfile();
  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.waitForFunction(() => JSON.parse(globalThis.sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').inspectorTab === 'Runs');
  await page.reload();
  await waitForProfile();
  assert.equal(await page.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected'), 'true', 'A saved inspector tab must win over the Profile initial Metrics tab after Webview recreation');
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.getByRole('tab', { name: 'Red Team' }).click();
  const adversarialTable = page.locator('.adversarial-case-table');
  await adversarialTable.getByRole('button', { name: 'Edit', exact: true }).click();
  await adversarialTable.getByRole('button', { name: 'Close editor', exact: true }).waitFor();
  const appliedRedTeamScroll = await page.locator('.red-team-workspace .settings-main').evaluate((element) => { element.scrollTop = Math.min(560, element.scrollHeight - element.clientHeight); element.dispatchEvent(new globalThis.Event('scroll', { bubbles: true })); return element.scrollTop; });
  assert.ok(appliedRedTeamScroll > 0, 'The representative Red Team viewport must have a real reading position to restore');
  await page.waitForFunction(() => JSON.parse(globalThis.sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').rightPaneMode === 'adversarial');
  await page.waitForFunction(() => Boolean(JSON.parse(globalThis.sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').expandedAdversarialCaseId));
  await page.waitForFunction(() => (JSON.parse(globalThis.sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').scrollPositions?.adversarial ?? 0) > 0);
  const savedRedTeamScroll = await page.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('turnstage.visual.webviewState') ?? '{}').scrollPositions.adversarial);
  await page.reload();
  await waitForProfile();
  assert.equal(await page.getByRole('tab', { name: 'Red Team' }).getAttribute('aria-selected'), 'true', 'The saved right-panel mode must survive recreation');
  assert.equal(await page.locator('.adversarial-case-table').getByRole('button', { name: 'Close editor', exact: true }).count(), 1, 'The expanded adversarial case must survive recreation');
  assert.equal(await page.locator('.red-team-workspace .settings-main').evaluate((element) => element.scrollTop), savedRedTeamScroll, 'The Red Team reading position must survive recreation');

  await page.goto(url);
  await waitForProfile();

  await page.setViewportSize({ width: 760, height: 900 });
  await page.reload();
  await waitForProfile();
  assert.equal(await page.locator('.profile-identity').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Narrow layout must not overflow horizontally');
  await page.screenshot({ path: resolve(artifactDirectory, 'narrow-dark.png'), fullPage: true });

  await page.setViewportSize({ width: 320, height: 900 });
  await page.reload();
  await waitForProfile();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Extra-narrow layout must not overflow horizontally');
  assert.equal(await page.getByRole('region', { name: 'Responsive chat preview' }).count(), 1, 'Extra-narrow workspace keeps the Chat surface available');
  await page.screenshot({ path: resolve(artifactDirectory, 'extra-narrow-dark.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await waitForProfile();
  await page.evaluate(() => {
    const style = document.documentElement.style;
    const lightTheme = {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#1f1f1f',
      '--vscode-editorGroup-border': '#d4d4d4',
      '--vscode-editorGroup-emptyBackground': '#f3f3f3',
      '--vscode-editorWidget-background': '#f3f3f3',
      '--vscode-editorWidget-border': '#c8c8c8',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-descriptionForeground': '#616161',
      '--vscode-input-background': '#ffffff',
      '--vscode-input-foreground': '#1f1f1f',
      '--vscode-input-border': '#cecece',
      '--vscode-input-placeholderForeground': '#767676',
      '--vscode-icon-foreground': '#424242',
      '--vscode-toolbar-hoverBackground': '#e8e8e8',
      '--vscode-list-hoverBackground': '#e8e8e8',
      '--vscode-list-hoverForeground': '#1f1f1f',
      '--vscode-list-activeSelectionBackground': '#0060c0',
      '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-list-inactiveSelectionBackground': '#e4e6f1',
      '--vscode-chat-requestBubbleBackground': '#f3f3f3',
      '--vscode-chat-requestBubbleHoverBackground': '#ededed',
      '--vscode-chat-requestBorder': '#cecece',
      '--vscode-chat-avatarBackground': '#d6d6d6',
      '--vscode-chat-avatarForeground': '#1f1f1f',
      '--vscode-textCodeBlock-background': '#f3f3f3',
      '--vscode-symbolIcon-propertyForeground': '#0451a5',
      '--vscode-symbolIcon-stringForeground': '#a31515',
      '--vscode-symbolIcon-numberForeground': '#098658',
      '--vscode-symbolIcon-booleanForeground': '#0000ff',
      '--vscode-badge-background': '#c4c4c4',
      '--vscode-badge-foreground': '#1f1f1f'
    };
    for (const [token, value] of Object.entries(lightTheme)) style.setProperty(token, value);
    document.body.className = 'vscode-light';
  });
  const lightContrast = await page.evaluate(() => {
    const ratio = (foreground, background) => {
      const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (value) => rgb(value).map((channel) => channel / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    };
    const header = document.querySelector('.mobile-chat-preview__app-header');
    const title = header?.querySelector('strong');
    const composer = document.querySelector('.mobile-chat-preview__composer textarea');
    const composerControl = document.querySelector('.mobile-chat-preview__composer-control');
    return {
      header: ratio(getComputedStyle(title).color, getComputedStyle(header).backgroundColor),
      composer: ratio(getComputedStyle(composer).color, getComputedStyle(composerControl).backgroundColor)
    };
  });
  assert.ok(lightContrast.header >= 4.5, `Light-theme chat header contrast must be at least 4.5:1, received ${lightContrast.header}`);
  assert.ok(lightContrast.composer >= 4.5, `Light-theme composer contrast must be at least 4.5:1, received ${lightContrast.composer}`);
  await page.screenshot({ path: resolve(artifactDirectory, 'wide-light.png'), fullPage: true });

  await page.getByRole('tab', { name: 'Configure' }).click();
  await page.getByRole('combobox', { name: 'Profile configuration sections' }).selectOption('request');
  await page.getByRole('heading', { name: 'Connection Doctor' }).waitFor();
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'connection-doctor-light.png') });

  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'connection-doctor-high-contrast.png') });
  await page.emulateMedia({ forcedColors: 'none' });

  await page.getByRole('tab', { name: 'Red Team' }).click();
  await page.getByRole('heading', { name: 'Latest adversarial results' }).waitFor();
  const lightAdversarialResults = page.locator('.adversarial-result-list');
  await lightAdversarialResults.scrollIntoViewIfNeeded();
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-results-light.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-results-high-contrast.png') });
  await page.emulateMedia({ forcedColors: 'none' });
  await lightAdversarialResults.getByRole('button', { name: 'Open evidence' }).first().click();
  await page.getByRole('heading', { name: 'Attack succeeded: Known two-turn probe' }).waitFor();
  await page.locator('.operation-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-summary-light.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-summary-high-contrast.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });

  const zoomViewport = { width: 720, height: 450 };
  const zoomPage = await browser.newPage({ viewport: zoomViewport, deviceScaleFactor: 2 });
  const zoomScreenshotPath = resolve(artifactDirectory, '200-percent-equivalent.png');
  await zoomPage.goto(url);
  await zoomPage.locator('.mobile-chat-preview__app-header strong').waitFor();
  assert.equal(await zoomPage.evaluate(() => globalThis.devicePixelRatio), 2, '200% evidence must render at a 2x device scale factor');
  assert.deepEqual(await zoomPage.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight })), zoomViewport, '200% evidence must preserve the bounded CSS viewport');
  assert.equal(await zoomPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, '200% layout must not overflow horizontally');
  await zoomPage.screenshot({ path: zoomScreenshotPath });
  await zoomPage.close();
  const zoomScreenshot = await readFile(zoomScreenshotPath);
  assert.equal(zoomScreenshot.readUInt32BE(16), zoomViewport.width * 2, '200% evidence PNG must retain the doubled physical width');
  assert.equal(zoomScreenshot.readUInt32BE(20), zoomViewport.height * 2, '200% evidence PNG must retain the doubled physical height');

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const activeElement = document.activeElement;
    return { tag: activeElement?.tagName, outline: activeElement ? getComputedStyle(activeElement).outlineStyle : 'none' };
  });
  assert.notEqual(focus.tag, 'BODY', 'Keyboard focus must enter the Webview');
  assert.notEqual(focus.outline, 'none', 'Keyboard focus must remain visibly outlined');

  console.log(JSON.stringify({ wide: true, networkTimeoutInspector: true, rightPaneConfiguration: true, connectionDoctor: true, connectionDoctorLight: true, connectionDoctorHighContrast: true, scenarioSettings: true, adversarialSettings: true, adversarialExports: true, adversarialEvidenceLinks: true, adversarialEvidenceSummary: true, adversarialEvidenceNavigation: true, eventTurnGroups: true, adversarialResultsLight: true, adversarialResultsHighContrast: true, adversarialEvidenceSummaryLight: true, adversarialEvidenceSummaryHighContrast: true, chatOnlyConfiguration: true, messageActions: true, messageMetrics: true, eventPayload: true, chatScreenshot: true, screenshotComposerMargins, responsiveWideChat: wideChatWidth, responsiveNarrowChat: narrowChatWidth, deviceToolbar: true, rotation: true, laptopFit: true, streamingComposer: composerSizing, streamingSettings: true, recordedRuns: true, rehydrated: true, narrow: true, extraNarrow: true, light: true, highContrast: true, zoom200Equivalent: { cssViewport: zoomViewport, deviceScaleFactor: 2, physicalPixels: { width: zoomViewport.width * 2, height: zoomViewport.height * 2 } }, keyboardFocus: focus, artifacts: artifactDirectory }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose(undefined)));
}

function contentType(file) {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.ttf': return 'font/ttf';
    default: return 'application/octet-stream';
  }
}

async function latestProfilePatch(page, path) {
  return page.evaluate((expectedPath) => {
    const message = [...globalThis.__turnstageMessages].reverse().find((candidate) => candidate.type === 'profile.patch' && candidate.path.join('.') === expectedPath);
    return message ? { path: message.path, value: message.value } : undefined;
  }, path);
}
