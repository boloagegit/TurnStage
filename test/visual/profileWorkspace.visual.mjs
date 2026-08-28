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
    await page.locator('.profile-identity').waitFor();
    assert.equal(await page.getByText('Loading profile…').count(), 0, 'The recreated Webview must not remain on Loading profile…');
    assert.ok((await page.locator('.profile-identity').innerText()).includes('Slow SSE Visual Proof'));
    assert.ok(!(await page.locator('.profile-identity').innerText()).includes('.jsonc'));
  };

  await page.goto(url);
  await waitForProfile();
  assert.equal(await page.getByRole('tab', { name: 'Debug' }).getAttribute('aria-selected'), 'true', 'Debug is the default right-panel mode');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'false', 'Configure remains directly available beside Debug');
  await page.getByRole('tab', { name: 'Debug' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Configure' }).getAttribute('aria-selected'), 'true', 'Right Arrow switches to Configure');
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
  assert.ok(networkHeaders.includes('Bearer •••••••') && networkHeaders.includes('••••••••'), 'Header view must redact authorization and cookies');
  await page.locator('.debug-pane').screenshot({ path: resolve(artifactDirectory, 'network-timeout-dark.png') });
  await page.getByRole('tab', { name: 'Raw Events' }).click();
  const screenshotButton = page.getByRole('button', { name: 'Copy chat screenshot' });
  await page.keyboard.press('Tab');
  await screenshotButton.focus();
  assert.equal(await screenshotButton.evaluate((element) => element.matches(':focus-visible')), true, 'Screenshot button must expose keyboard focus');
  await screenshotButton.click();
  await page.waitForFunction(() => Array.isArray(globalThis.__turnstageClipboardItems) && globalThis.__turnstageClipboardItems.length === 1);
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
  assert.equal(await page.getByRole('region', { name: 'Opening' }).getByRole('heading', { name: 'Opening' }).count(), 1, 'Opening content must be explicitly labelled');
  const assistantMessage = page.locator('[data-message-id="assistant-1"]');
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
  const firstEventRow = page.getByRole('listbox', { name: 'Raw Events' }).getByRole('option').first();
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
  assert.equal(await page.locator('[data-message-id="assistant-1"][data-selected="true"]').count(), 0, 'Configure must hide Debug message selection styling');
  await page.screenshot({ path: resolve(artifactDirectory, 'profile-config-right-pane-dark.png'), fullPage: true });
  const displayName = page.getByLabel('Display name');
  await displayName.fill('GUI Edited Profile');
  await displayName.blur();
  await page.locator('.profile-identity__primary strong').filter({ hasText: 'GUI Edited Profile' }).waitFor();
  assert.deepEqual(await latestProfilePatch(page, 'name'), { path: ['name'], value: 'GUI Edited Profile' }, 'General settings must emit a structured name patch and rehydrate the live Chat surface');
  await displayName.fill('Slow SSE Visual Proof');
  await displayName.blur();
  await page.getByRole('button', { name: 'Open JSONC' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.__turnstageMessages.slice(-2).map((message) => message.type)), ['profile.openAsText', 'profile.validate'], 'Configuration toolbar actions must reach the host protocol');
  await page.locator('.sr-status').filter({ hasText: 'Profile is valid.' }).waitFor();
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
  assert.notEqual(await page.locator('.mobile-chat-preview__app-heading span').evaluate((element) => getComputedStyle(element).display), 'none', 'Wide Chat keeps secondary header context');
  await page.screenshot({ path: resolve(artifactDirectory, 'responsive-wide-chat-dark.png'), fullPage: true });

  await page.goto(`${url}?split=25`);
  await waitForProfile();
  const narrowChatWidth = await page.locator('.preview-pane').evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(narrowChatWidth <= 430, 'Narrow Chat must be driven by pane width');
  assert.equal(await page.locator('.mobile-chat-preview__app-heading span').evaluate((element) => getComputedStyle(element).display), 'none', 'Narrow Chat progressively hides secondary header context');
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

  await page.reload();
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, 'rehydrated-after-reload.png'), fullPage: true });

  await page.setViewportSize({ width: 760, height: 900 });
  await page.reload();
  await waitForProfile();
  assert.equal(await page.locator('.profile-identity__meta').evaluate((element) => getComputedStyle(element).display), 'none');
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

  await page.emulateMedia({ forcedColors: 'active' });
  await page.screenshot({ path: resolve(artifactDirectory, 'high-contrast.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });

  await page.setViewportSize({ width: 720, height: 450 });
  await page.reload();
  await waitForProfile();
  await page.screenshot({ path: resolve(artifactDirectory, '200-percent-equivalent.png'), fullPage: true });

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const activeElement = document.activeElement;
    return { tag: activeElement?.tagName, outline: activeElement ? getComputedStyle(activeElement).outlineStyle : 'none' };
  });
  assert.notEqual(focus.tag, 'BODY', 'Keyboard focus must enter the Webview');
  assert.notEqual(focus.outline, 'none', 'Keyboard focus must remain visibly outlined');

  console.log(JSON.stringify({ wide: true, networkTimeoutInspector: true, rightPaneConfiguration: true, chatOnlyConfiguration: true, messageActions: true, messageMetrics: true, eventPayload: true, chatScreenshot: true, screenshotComposerMargins, responsiveWideChat: wideChatWidth, responsiveNarrowChat: narrowChatWidth, deviceToolbar: true, rotation: true, laptopFit: true, streamingComposer: composerSizing, streamingSettings: true, recordedRuns: true, rehydrated: true, narrow: true, extraNarrow: true, light: true, highContrast: true, zoom200Equivalent: true, keyboardFocus: focus, artifacts: artifactDirectory }, null, 2));
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
