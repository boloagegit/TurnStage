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

async function assertRedTeamTabVisual(navigation, label) {
  const selected = navigation.getByRole('tab', { selected: true });
  await selected.hover();
  const style = await selected.evaluate((element) => {
    const navigationElement = element.closest('.red-team-section-nav');
    const computed = getComputedStyle(element);
    return {
      appearance: computed.appearance,
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage,
      borderBottomColor: computed.borderBottomColor,
      boxShadow: computed.boxShadow,
      navigationBackgroundColor: navigationElement ? getComputedStyle(navigationElement).backgroundColor : '',
    };
  });
  assert.equal(style.appearance, 'none', `${label}: Red Team tabs must opt out of native button painting`);
  assert.equal(style.backgroundColor, style.navigationBackgroundColor, `${label}: the selected and hovered Red Team tab must use the navigation surface instead of a dark button fill`);
  assert.equal(style.backgroundImage, 'none', `${label}: the selected Red Team tab must not paint a background image`);
  assert.equal(style.boxShadow, 'none', `${label}: the selected Red Team tab must not paint a selection block through a shadow`);
  assert.notEqual(style.borderBottomColor, 'rgba(0, 0, 0, 0)', `${label}: the selected Red Team tab must keep a visible focus underline`);
}

async function assertAdversarialResultLayout(table, label) {
  const rows = await table.locator('tbody > tr').evaluateAll((elements) => elements.map((row) => {
    const cells = [...row.cells];
    const repeatabilityCell = cells[2];
    const actionCell = cells[4];
    const repeatabilityLayout = repeatabilityCell?.querySelector('.adversarial-result-cell-stack');
    const actionLayout = actionCell?.querySelector('.adversarial-result-actions');
    const controls = actionLayout ? [...actionLayout.children].map((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    }) : [];
    const repeatabilityBounds = repeatabilityCell?.getBoundingClientRect();
    const actionBounds = actionCell?.getBoundingClientRect();
    const repeatabilityContent = repeatabilityLayout ? [...repeatabilityLayout.querySelectorAll(':scope > span, :scope > small, :scope > details, :scope > details > summary > span')].map((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    }) : [];
    return {
      firstCellDisplay: cells[0] ? getComputedStyle(cells[0]).display : '',
      repeatabilityCellDisplay: repeatabilityCell ? getComputedStyle(repeatabilityCell).display : '',
      repeatabilityRight: repeatabilityBounds?.right ?? 0,
      repeatabilityOverflow: repeatabilityLayout ? getComputedStyle(repeatabilityLayout).overflow : '',
      repeatabilityContent,
      actionLeft: actionBounds?.left ?? 0,
      actionRight: actionBounds?.right ?? 0,
      actionFits: actionLayout ? actionLayout.scrollWidth <= actionLayout.clientWidth + 1 : false,
      controls,
    };
  }));
  assert.ok(rows.length > 0, `${label}: result layout check requires rendered rows`);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.firstCellDisplay, 'table-cell', `${label}: row ${index + 1} case cell must preserve native table layout`);
    assert.equal(row.repeatabilityCellDisplay, 'table-cell', `${label}: row ${index + 1} repeatability cell must preserve native table layout`);
    assert.ok(row.repeatabilityRight <= row.actionLeft + 1, `${label}: row ${index + 1} repeatability and action columns must not overlap`);
    assert.equal(row.repeatabilityOverflow, 'hidden', `${label}: row ${index + 1} repeatability content must clip at its own column boundary`);
    for (const [contentIndex, content] of row.repeatabilityContent.entries()) {
      assert.ok(content.right <= row.repeatabilityRight + 1, `${label}: row ${index + 1} repeatability item ${contentIndex + 1} must stay inside the Repeatability column`);
    }
    assert.equal(row.actionFits, true, `${label}: row ${index + 1} action layout must fit inside its table cell`);
    for (const [controlIndex, control] of row.controls.entries()) {
      assert.ok(control.left >= row.actionLeft - 1 && control.right <= row.actionRight + 1, `${label}: row ${index + 1} action ${controlIndex + 1} must stay inside the Actions column`);
    }
    const timelineControl = row.controls[1];
    const moreControl = row.controls[2];
    assert.ok(timelineControl && moreControl, `${label}: row ${index + 1} must expose timeline and more-actions controls`);
    assert.ok(Math.abs(timelineControl.top - moreControl.top) <= 1, `${label}: row ${index + 1} secondary actions must share one compact row`);
    const secondaryGap = moreControl.left - timelineControl.right;
    assert.ok(secondaryGap >= -1 && secondaryGap <= 8, `${label}: row ${index + 1} secondary actions must remain a compact group; received ${secondaryGap}px`);
  }
}

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
  const viewportToolbar = page.locator('.mobile-chat-preview__viewport-toolbar');
  const viewportSettings = page.locator('.mobile-chat-preview__viewport-settings');
  assert.equal(await viewportSettings.getAttribute('open'), null, 'Preview size controls must start collapsed to preserve toolbar space');
  assert.equal(await viewportToolbar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Collapsed preview controls must keep every toolbar action visible without horizontal scrolling');
  await viewportSettings.locator('summary').click();
  assert.equal(await viewportSettings.getAttribute('open'), '', 'Preview size settings must expand on demand');
  assert.equal(await viewportSettings.getByRole('combobox', { name: 'Viewport preset' }).count(), 1, 'Expanded preview settings must retain preset selection');
  await viewportToolbar.screenshot({ path: resolve(artifactDirectory, 'preview-size-settings-dark.png') });
  await viewportSettings.locator('summary').click();
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
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-dirty', type: 'profile.editState', dirty: true } })));
  await page.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save Profile' }).isEnabled(), true, 'Configure must expose pushed dirty state and an explicit save action without polling');
  await page.screenshot({ path: resolve(artifactDirectory, 'profile-config-right-pane-dark.png'), fullPage: true });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-saved', type: 'profile.editState', dirty: false } })));
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
  const redTeamNavigation = page.getByRole('tablist', { name: 'Red Team sections' });
  assert.equal(await redTeamNavigation.getByRole('tab').count(), 4, 'Red Team must expose four stable sub-tabs for campaigns, cases, results, and timeline');
  assert.ok((await redTeamNavigation.innerText()).includes('Campaigns') && (await redTeamNavigation.innerText()).includes('Timeline'), 'Red Team landmarks must use recognizable section names');
  await assertRedTeamTabVisual(redTeamNavigation, 'Dark theme');
  await redTeamNavigation.screenshot({ path: resolve(artifactDirectory, 'red-team-section-navigation-dark.png') });
  await redTeamNavigation.getByRole('tab', { name: /Campaigns:/ }).click();
  const campaignCard = page.locator('.campaign-card').filter({ hasText: 'Release safety' });
  await campaignCard.scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('heading', { name: 'Test campaigns' }).count(), 1, 'Scenario configuration must expose bounded test campaigns');
  assert.equal(await campaignCard.getByText('Completed', { exact: true }).count(), 1, 'Campaign status must be visible without opening a detail page');
  assert.equal(await campaignCard.getByRole('spinbutton', { name: 'Concurrent cases' }).inputValue(), '2', 'Campaigns must expose their bounded case-level concurrency in the GUI');
  assert.equal(await campaignCard.getByText('Concurrency 2 / 8', { exact: true }).count(), 1, 'Campaign history must show the concurrency used by the run');
  assert.equal(await campaignCard.getByText('1 regression', { exact: true }).count(), 1, 'Campaign baseline regressions must be visible at a glance');
  assert.equal(await campaignCard.getByText(/Resisted.*Attack succeeded/i).count(), 1, 'Campaign regression must explain the baseline-to-current transition');
  assert.equal(await campaignCard.getByRole('button', { name: 'Preview plan' }).count(), 1, 'Campaign preview must remain distinct from execution');
  assert.equal(await campaignCard.getByRole('button', { name: 'Run', exact: true }).count(), 1, 'Campaign execution must expose one clear primary action');
  await campaignCard.getByText('More', { exact: true }).click();
  assert.equal(await campaignCard.getByRole('button', { name: 'Export results JSONL' }).count(), 1, 'Campaign history must expose bulk machine-readable export');
  assert.equal(await campaignCard.getByRole('button', { name: 'Summarize with Copilot' }).count(), 1, 'Copilot analysis must stay a distinct advisory action');
  assert.equal(await campaignCard.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Campaign controls must not overflow the settings pane');
  await campaignCard.screenshot({ path: resolve(artifactDirectory, 'campaign-regression-dark.png') });
  await redTeamNavigation.getByRole('tab', { name: /Results:/ }).click();
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-test-run', type: 'test.operation', operation: { action: 'runAll', state: 'running', progress: { totalCases: 100, completedCases: 24, totalAttempts: 125, completedAttempts: 31, maxConcurrency: 3, activeCaseNames: ['Prompt boundary', 'Tool policy'] } } } })));
  const activeTestRun = page.locator('.test-operation-status--running');
  await activeTestRun.waitFor();
  assert.ok((await activeTestRun.innerText()).includes('24 / 100 cases · 31 / 125 attempts'), 'Run all feedback must expose measurable case and attempt progress');
  assert.ok((await activeTestRun.innerText()).includes('Concurrency: 2 active · limit 3 / 8'), 'Run all feedback must expose active workers and the configured concurrency limit');
  assert.equal(await activeTestRun.getByRole('progressbar').getAttribute('value'), '24', 'Run all feedback must use a determinate progress value after planning');
  assert.equal(await page.getByRole('button', { name: 'Running all…' }).isDisabled(), true, 'An active Red Team run must disable duplicate starts');
  assert.equal(await page.getByRole('button', { name: 'Stop test run' }).locator('.codicon-debug-stop').count(), 1, 'An active Red Team run must expose a distinct stop action');
  await activeTestRun.screenshot({ path: resolve(artifactDirectory, 'adversarial-run-active-dark.png') });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-test-run-complete', type: 'test.operation', operation: { action: 'runAll', state: 'completed' } } })));
  await redTeamNavigation.getByRole('tab', { name: /Cases:/ }).click();
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
  await page.getByText('31 of 31 cases', { exact: true }).waitFor();
  const adversarialCaseTable = page.locator('.adversarial-case-table');
  assert.equal(await adversarialCaseTable.locator('tbody > tr').count(), 25, 'The unified catalog must mount only the first page for a large case list');
  assert.equal(await page.getByText('Page 1 of 2', { exact: true }).count(), 1, 'Large case catalogs must expose their current page');
  await page.getByRole('button', { name: 'Next page' }).click();
  assert.equal(await adversarialCaseTable.getByText('Linked case 30', { exact: true }).count(), 1, 'The next page must expose later linked cases');
  await page.locator('.adversarial-case-collection').screenshot({ path: resolve(artifactDirectory, 'adversarial-case-catalog-page-2-dark.png') });
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.getByRole('searchbox', { name: 'Search adversarial cases' }).fill('linked-case-30');
  await page.getByText('1 of 31 cases', { exact: true }).waitFor();
  assert.equal(await page.getByText('1 of 31 cases', { exact: true }).count(), 1, 'Case search must narrow the full unified catalog');
  assert.equal(await adversarialCaseTable.locator('tbody > tr').count(), 1, 'A filtered catalog must mount only matching rows');
  await adversarialCaseTable.getByRole('button', { name: 'Edit', exact: true }).click();
  const linkedCaseEditor = page.locator('.linked-case-editor');
  await linkedCaseEditor.getByLabel('Scenario name').waitFor();
  assert.equal(await linkedCaseEditor.getByLabel('Scenario ID').isEditable(), false, 'Linked case identity must remain stable in the bounded UI editor');
  assert.equal(await linkedCaseEditor.locator('.scenario-step').count(), 1, 'Linked case editor must load only the selected case from disk');
  await linkedCaseEditor.getByLabel('Scenario name').fill('Linked case 30 edited');
  await linkedCaseEditor.getByLabel('Scenario name').press('Tab');
  await linkedCaseEditor.getByRole('button', { name: 'Save linked case' }).waitFor({ state: 'visible' });
  assert.equal(await linkedCaseEditor.getByRole('button', { name: 'Save linked case' }).isEnabled(), true, 'Linked case save must become available after a structured edit');
  await linkedCaseEditor.getByRole('button', { name: 'Save linked case' }).click();
  await linkedCaseEditor.getByText('Linked case saved and verified from disk.').waitFor();
  assert.equal((await page.evaluate(() => globalThis.__turnstageMessages.findLast((message) => message.type === 'adversarial.case.save'))).scenario.name, 'Linked case 30 edited', 'Linked editor must save the structured case with its source revision');
  await linkedCaseEditor.screenshot({ path: resolve(artifactDirectory, 'linked-case-editor-dark.png') });
  await linkedCaseEditor.getByRole('button', { name: 'Open source' }).click();
  assert.equal((await page.evaluate(() => globalThis.__turnstageMessages.findLast((message) => message.type === 'adversarial.openLinkedSuite'))).path, '.vscode/turnstage/tests/security-regression.adversarial.csv', 'Linked catalog rows must open their exact source');
  await page.locator('.adversarial-case-collection').screenshot({ path: resolve(artifactDirectory, 'adversarial-case-catalog-search-dark.png') });
  await page.getByRole('searchbox', { name: 'Search adversarial cases' }).fill('');
  const runningPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await runningPage.goto(`${url}?section=scenario-tests&campaignStatus=running`);
  await runningPage.getByRole('tab', { name: 'Red Team' }).click();
  await runningPage.getByRole('tab', { name: /Campaigns:/ }).click();
  const runningCampaign = runningPage.locator('.campaign-card').filter({ hasText: 'Release safety' });
  await runningCampaign.waitFor();
  assert.equal(await runningCampaign.getByText('Running', { exact: true }).count(), 1, 'A running campaign must expose its current state');
  assert.equal(await runningCampaign.getByRole('button', { name: 'Run', exact: true }).isDisabled(), true, 'A running campaign must prevent duplicate execution');
  assert.equal(await runningCampaign.getByRole('button', { name: 'Cancel run' }).count(), 1, 'A running campaign must expose a distinct cancellation action');
  await runningCampaign.screenshot({ path: resolve(artifactDirectory, 'campaign-running-dark.png') });
  await runningPage.close();
  assert.equal(await page.getByRole('table').count(), 1, 'Red Team must present case settings in a compact table');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  assert.equal(await page.locator('.adversarial-case-editor').count(), 1, 'Adversarial configuration must expose its bounded case editor');
  assert.equal(await page.locator('.scenario-step').count(), 2, 'The expanded adversarial row must expose both configured turns');
  assert.equal(await page.getByRole('spinbutton', { name: 'Repetitions', exact: true }).inputValue(), '5', 'Adversarial configuration must expose the case repetition count');
  assert.equal(await page.getByRole('checkbox', { name: 'Stop remaining turns after an attack succeeds' }).isChecked(), true, 'Turn-level stopping must remain distinct from repetition fail-fast');
  assert.equal(await page.getByRole('checkbox', { name: 'Stop remaining repetitions after an attack succeeds (incomplete sample)' }).isChecked(), false, 'Repetition fail-fast must remain explicit and off unless configured');
  await page.getByRole('spinbutton', { name: 'Repetitions', exact: true }).scrollIntoViewIfNeeded();
  const settingsMainScroll = await page.locator('.settings-main').evaluate((element) => ({ scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, panelWidth: element.querySelector('.settings-panel')?.getBoundingClientRect().width, tableWrapWidth: element.querySelector('.adversarial-case-table-wrap')?.getBoundingClientRect().width }));
  assert.equal(settingsMainScroll.scrollLeft, 0, `Focusing a wide adversarial table field must not horizontally shift the entire settings pane: ${JSON.stringify(settingsMainScroll)}`);
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-repetitions-dark.png') });
  await redTeamNavigation.getByRole('tab', { name: /Results:/ }).click();
  assert.equal(await page.getByRole('heading', { name: 'Latest adversarial results' }).count(), 1, 'Scenario configuration must expose the compact latest-result list');
  const adversarialResults = page.locator('.adversarial-result-table');
  assert.equal(await adversarialResults.getByText('Attack succeeded', { exact: true }).count(), 1, 'Latest results must distinguish an attack from resistance');
  assert.equal(await adversarialResults.getByText('3/5 resisted · 5 attempts', { exact: true }).count(), 1, 'Latest results must expose the repeated-run sample at a glance');
  assert.equal(await adversarialResults.getByText('Unstable result', { exact: true }).count(), 1, 'Latest results must expose whether repeated outcomes are stable');
  assert.equal(await adversarialResults.getByRole('button', { name: 'Open evidence' }).count(), 2, 'Every latest result must expose one clear primary evidence action');
  assert.equal(await adversarialResults.getByRole('button', { name: /Review timeline|Timeline selected/ }).count(), 2, 'Every latest result must keep timeline review as the single secondary action');
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
  assert.equal(await adversarialResults.locator('tbody > tr').count(), 2, 'Latest results must render one compact semantic row per result');
  assert.equal(await adversarialResults.getByRole('columnheader', { name: 'Case' }).count(), 1, 'The result table must label its case column');
  assert.equal(await adversarialResults.getByRole('columnheader', { name: 'Outcome' }).count(), 1, 'The result table must label its outcome column');
  assert.equal(await adversarialResults.getByRole('columnheader', { name: 'Repeatability' }).count(), 1, 'The result table must explain repeated-run samples with a named column');
  await assertAdversarialResultLayout(adversarialResults, 'Dark theme');
  await adversarialResults.screenshot({ path: resolve(artifactDirectory, 'adversarial-results-dark.png') });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.MessageEvent('message', { data: { protocolVersion: 1, editorInstanceId: 'visual-harness', requestId: 'visual-export', type: 'test.exported', kind: 'report', path: 'turnstage-report.html', artifactId: 'artifact-1' } })));
  const exportNotice = page.locator('.operation-status').filter({ hasText: 'Test report exported' });
  await exportNotice.waitFor();
  assert.equal(await exportNotice.getByRole('button', { name: 'Open' }).count(), 1, 'Export completion must offer a direct open action');
  assert.equal(await exportNotice.getByRole('button', { name: 'Reveal in file explorer' }).count(), 1, 'Export completion must offer a reveal action');
  assert.equal(await exportNotice.getByRole('button', { name: 'Copy path' }).count(), 1, 'Export completion must offer a copy-path action');
  assert.equal(await exportNotice.evaluate((element) => getComputedStyle(element).position), 'relative', 'Operation feedback must reserve layout space instead of overlaying controls');
  await page.screenshot({ path: resolve(artifactDirectory, 'export-actions-dark.png'), fullPage: true });
  await exportNotice.getByRole('button', { name: 'Dismiss notification' }).click();
  const attackResult = adversarialResults.getByRole('row').filter({ hasText: 'Known two-turn probe' });
  await attackResult.getByRole('button', { name: /Review timeline|Timeline selected/ }).click();
  const findingTimelineAction = page.getByRole('button', { name: 'Open Forbidden URL observed evidence at 1,840 ms' });
  await findingTimelineAction.waitFor();
  assert.equal(await findingTimelineAction.count(), 1, 'Red Team timeline must make the failure point directly navigable');
  const adversarialTimeline = page.locator('.adversarial-timeline-card');
  assert.equal(await adversarialTimeline.getByText('Evidence trail', { exact: true }).count(), 1, 'Timeline must identify itself as a chronological evidence trail');
  assert.equal(await adversarialTimeline.getByText('Decisive evidence', { exact: true }).count(), 1, 'Timeline must call out the event that determined the result');
  assert.ok((await adversarialTimeline.innerText()).includes('Request') && (await adversarialTimeline.innerText()).includes('Stream') && (await adversarialTimeline.innerText()).includes('Decision'), 'Timeline must group events into recognizable stages');
  await adversarialTimeline.screenshot({ path: resolve(artifactDirectory, 'adversarial-timeline-dark.png') });
  await page.setViewportSize({ width: 720, height: 900 });
  assert.equal(await adversarialTimeline.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Timeline must not overflow a narrow Red Team pane');
  const narrowTimelineEntryHeights = await adversarialTimeline.locator('.causal-timeline__entry').evaluateAll((entries) => entries.map((entry) => entry.getBoundingClientRect().height));
  assert.ok(narrowTimelineEntryHeights.every((height) => height >= 42 && height < 100), `Narrow timeline entries must remain compact and scannable: ${JSON.stringify(narrowTimelineEntryHeights)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await redTeamNavigation.getByRole('tab', { name: /Results:/ }).click();
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
  await page.setViewportSize({ width: 720, height: 900 });
  const compactEvidenceSelects = page.locator('.evidence-review__navigator select');
  assert.equal(await compactEvidenceSelects.count(), 2, 'Compact Evidence Review must preserve both selectors');
  for (let index = 0; index < await compactEvidenceSelects.count(); index += 1) {
    const bounds = await compactEvidenceSelects.nth(index).boundingBox();
    assert.ok(bounds && bounds.height >= 30, 'Compact Evidence Review selectors must keep an unclipped control height');
  }
  assert.equal(await page.locator('.evidence-review').evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'Compact Evidence Review must not overflow horizontally');
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-navigation-narrow-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Close evidence review' }).click();
  await page.locator('.evidence-review').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#right-pane-debug-tab').getAttribute('aria-selected'), 'true', 'Closing Evidence Review must preserve the current Debug context');
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-closed-dark.png'), fullPage: true });
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
  assert.equal(await page.locator('[aria-label="Viewport preset"]').inputValue(), 'responsive', 'Device toolbar defaults to Responsive');
  assert.equal(await page.locator('[data-viewport-mode="responsive"]').count(), 1, 'Responsive mode must fill the Chat pane');
  assert.ok((await page.getByRole('group', { name: 'Session status and actions' }).innerText()).includes('Ready'), 'Wide Chat keeps session context in the preview toolbar');
  await page.screenshot({ path: resolve(artifactDirectory, 'responsive-wide-chat-dark.png'), fullPage: true });

  await page.goto(`${url}?split=25`);
  await waitForProfile();
  const narrowChatWidth = await page.locator('.preview-pane').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(narrowChatWidth <= 430, 'Narrow Chat must be driven by pane width');
  assert.ok((await page.getByRole('group', { name: 'Session status and actions' }).innerText()).includes('Ready'), 'Narrow Chat keeps session context available beside the collapsed preview settings');
  assert.equal(await page.locator('.mobile-chat-preview__viewport-toolbar').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'Narrow Chat toolbar must not require horizontal scrolling');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Narrow Chat and Debug split must not overflow horizontally');
  await page.screenshot({ path: resolve(artifactDirectory, 'responsive-narrow-chat-dark.png'), fullPage: true });

  await page.goto(`${url}?device=mobile-m`);
  await waitForProfile();
  assert.equal(await page.locator('[aria-label="Viewport preset"]').inputValue(), 'mobile-m');
  assert.equal(await page.locator('[aria-label="Viewport width"]').inputValue(), '375');
  assert.equal(await page.locator('[aria-label="Viewport height"]').inputValue(), '667');
  assert.equal(await page.locator('[data-viewport-mode="fixed"]').count(), 1, 'A device preset uses a fixed logical viewport');
  assert.equal(await page.locator('[data-viewport-width="375"]').count(), 1, 'The Chat container receives the preset CSS width');
  assert.equal(await page.locator('.mobile-chat-preview__safe-area').count(), 0, 'Device emulation does not add fake phone chrome');
  await page.locator('.mobile-chat-preview__viewport-settings > summary').click();
  await page.getByRole('button', { name: 'Rotate viewport' }).click();
  assert.equal(await page.locator('[aria-label="Viewport preset"]').inputValue(), 'custom');
  assert.equal(await page.locator('[aria-label="Viewport width"]').inputValue(), '667');
  assert.equal(await page.locator('[aria-label="Viewport height"]').inputValue(), '375');
  await page.screenshot({ path: resolve(artifactDirectory, 'device-toolbar-mobile-landscape-dark.png'), fullPage: true });

  await page.selectOption('[aria-label="Viewport preset"]', 'laptop-l');
  assert.equal(await page.locator('[data-viewport-width="1440"]').count(), 1, 'Laptop L switches the logical viewport to 1440px');
  assert.notEqual(await page.getByLabel('Preview scale').innerText(), '100%', 'Fit reports scaling when the viewport exceeds the pane');
  await page.screenshot({ path: resolve(artifactDirectory, 'device-toolbar-laptop-fit-dark.png'), fullPage: true });

  await page.goto(`${url}?active=true&indicator=shimmer&reveal=adaptive&pace=balanced&maxVisualLag=1200&largeChunk=true&speed=1400&intensity=85&draft=First%20line%0ASecond%20line%20wraps%20inside%20the%20composer%0AThird%20line`);
  await waitForProfile();
  const composer = page.getByRole('textbox', { name: 'Message' });
  const composerSizing = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, minimum: Number.parseFloat(style.minHeight), overflowY: style.overflowY };
  });
  assert.ok(composerSizing.height > composerSizing.minimum, 'Multiline composer must grow beyond its single-line minimum');
  assert.equal(await page.locator('.mobile-chat-preview__stream-indicator[data-effect="shimmer"]').count(), 1, 'Streaming Assistant must render the configured shimmer indicator');
  const adaptiveText = page.locator('[data-reveal-mode="adaptive"]').last();
  assert.equal((await adaptiveText.innerText()).includes('END_OF_LARGE_EVENT'), false, 'A large single event must begin with a progressive visual reveal');
  await page.screenshot({ path: resolve(artifactDirectory, 'streaming-shimmer-multiline-dark.png'), fullPage: true });
  await page.waitForTimeout(1350);
  assert.equal((await adaptiveText.innerText()).includes('END_OF_LARGE_EVENT'), true, 'Adaptive reveal must catch up within the configured visual lag');
  await page.screenshot({ path: resolve(artifactDirectory, 'streaming-adaptive-complete-dark.png'), fullPage: true });

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

  await page.goto(`${url}?section=chat-ui&indicator=dots&reveal=adaptive&pace=fast&maxVisualLag=500&speed=1200&intensity=80`);
  await page.getByRole('heading', { level: 1, name: 'Chat UI' }).waitFor();
  assert.equal(await page.getByText('Loading profile…').count(), 0, 'Chat UI settings must not remain on Loading profile…');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'true', 'A configuration command opens Configure in the right pane');
  assert.equal(await page.locator('.preview-pane').count(), 1, 'A configuration command must not replace the Chat preview');
  assert.equal(await page.getByLabel('Assistant content reveal', { exact: true }).inputValue(), 'adaptive');
  assert.equal(await page.getByLabel('Assistant content reveal pace').inputValue(), 'fast');
  assert.equal(await page.getByLabel('Assistant maximum visual lag').inputValue(), '500');
  assert.equal(await page.getByLabel('Assistant streaming indicator').inputValue(), 'dots');
  assert.equal(await page.getByLabel('Assistant streaming animation speed').inputValue(), '1200');
  assert.equal(await page.getByLabel('Assistant streaming intensity').inputValue(), '80');
  await page.getByLabel('Message action toolbar visibility').selectOption('interaction');
  await page.locator('.mobile-chat-preview__message-toolbar--interaction').first().waitFor();
  assert.deepEqual(await latestProfilePatch(page, 'ui.messageActionVisibility'), { path: ['ui', 'messageActionVisibility'], value: 'interaction' }, 'Chat UI settings must patch the profile and update the live message toolbar');
  await page.getByLabel('Assistant streaming indicator').scrollIntoViewIfNeeded();
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
  await page.getByRole('tab', { name: /Cases:/ }).click();
  const adversarialTable = page.locator('.adversarial-case-table');
  await adversarialTable.getByRole('button', { name: 'Edit', exact: true }).first().click();
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
  assert.equal(await page.getByRole('tab', { name: /Cases:/ }).getAttribute('aria-selected'), 'true', 'The saved Red Team sub-tab must survive recreation');
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
  await page.getByRole('tab', { name: /Results:/ }).click();
  await page.getByRole('heading', { name: 'Latest adversarial results' }).waitFor();
  const lightAdversarialResults = page.locator('.adversarial-result-table');
  await lightAdversarialResults.scrollIntoViewIfNeeded();
  await assertRedTeamTabVisual(page.getByRole('tablist', { name: 'Red Team sections' }), 'Light theme');
  await assertAdversarialResultLayout(lightAdversarialResults, 'Light theme');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-results-light.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  await assertRedTeamTabVisual(page.getByRole('tablist', { name: 'Red Team sections' }), 'High contrast theme');
  await assertAdversarialResultLayout(lightAdversarialResults, 'High contrast theme');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'adversarial-results-high-contrast.png') });
  await page.emulateMedia({ forcedColors: 'none' });
  await lightAdversarialResults.getByRole('button', { name: 'Open evidence' }).first().click();
  await page.getByRole('heading', { name: 'Attack succeeded: Known two-turn probe' }).waitFor();
  await page.locator('.operation-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-summary-light.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: resolve(artifactDirectory, 'adversarial-evidence-summary-high-contrast.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });

  const deltaPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await deltaPage.goto(url);
  await deltaPage.locator('.mobile-chat-preview__app-header strong').waitFor();
  await deltaPage.evaluate(() => {
    const { snapshot, dispatch } = globalThis.__turnstageHarness;
    const { messages, rawEvents, normalizedEvents, ...core } = snapshot;
    void rawEvents;
    void normalizedEvents;
    dispatch(JSON.parse(JSON.stringify({
      type: 'session.delta',
      delta: {
        baseSessionId: snapshot.sessionId,
        core: { ...core, turnState: 'streaming', metrics: { ...core.metrics, eventCount: 7 } },
        rawEvents: { retainFromSequence: 1, append: [{ sequence: 7, turnId: 'visual-turn-2', turnIndex: 1, turnSequence: 4, receivedAt: 5_000, elapsedMs: 4_000, protocol: 'sse', sse: { event: 'message' }, raw: 'event: message', data: { text: 'Incremental stream update.' } }] },
        normalizedEvents: { retainFromSequence: 1, append: [{ version: 1, type: 'content.text.delta', sequence: 7, rawSequence: 7, turnId: 'visual-turn-2', turnIndex: 1, turnSequence: 4, receivedAt: 5_000, text: 'Incremental stream update.' }] },
        messages: { removeIds: [], upsert: [{ ...messages.at(-1), status: 'streaming', completedAt: undefined, parts: [{ type: 'text', text: 'Incremental stream update.' }] }] },
      },
    })));
  });
  await deltaPage.getByText('Incremental stream update.', { exact: true }).waitFor();
  assert.equal(await deltaPage.locator('[data-message-id="assistant-1"][data-status="streaming"]').count(), 1, 'A session delta must update the existing streamed message without remounting the full session');
  await deltaPage.close();

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

  console.log(JSON.stringify({ wide: true, networkTimeoutInspector: true, rightPaneConfiguration: true, connectionDoctor: true, connectionDoctorLight: true, connectionDoctorHighContrast: true, scenarioSettings: true, adversarialSettings: true, adversarialExports: true, adversarialEvidenceLinks: true, adversarialEvidenceSummary: true, adversarialEvidenceNavigation: true, eventTurnGroups: true, sessionDelta: true, adversarialResultsLight: true, adversarialResultsHighContrast: true, adversarialEvidenceSummaryLight: true, adversarialEvidenceSummaryHighContrast: true, chatOnlyConfiguration: true, messageActions: true, messageMetrics: true, eventPayload: true, chatScreenshot: true, screenshotComposerMargins, responsiveWideChat: wideChatWidth, responsiveNarrowChat: narrowChatWidth, deviceToolbar: true, rotation: true, laptopFit: true, streamingComposer: composerSizing, streamingSettings: true, recordedRuns: true, rehydrated: true, narrow: true, extraNarrow: true, light: true, highContrast: true, zoom200Equivalent: { cssViewport: zoomViewport, deviceScaleFactor: 2, physicalPixels: { width: zoomViewport.width * 2, height: zoomViewport.height * 2 } }, keyboardFocus: focus, artifacts: artifactDirectory }, null, 2));
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
