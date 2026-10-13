// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, TurnStageProfile } from '../src/shared/types';
import { FlowEditor } from '../src/webview/configEditors';
import { lastResponseHealth, secondsText, settingsSectionOverview, transportLabel } from '../src/webview/SettingsOverview';
import { SettingsWorkspace, type SettingsSectionId } from '../src/webview/SettingsWorkspace';
import { initialConfigurationOverview, normalizeWebviewState } from '../src/webview/main';

afterEach(cleanup);

const profile: TurnStageProfile = {
  version: 1,
  id: 'overview',
  name: 'Overview profile',
  environment: 'local',
  opening: { mode: 'static', message: 'Hi', starters: [{ id: 's1', label: 'One', prompt: 'One', behavior: 'send' }] },
  conversation: { send: { method: 'POST', url: '${env.baseUrl}/chat', timeoutMs: 30_000, variants: [{ id: 'first-turn', body: {} }] } },
  stream: { transport: 'sse', mappings: [{ id: 'text', match: { event: 'message' }, emit: { type: 'content.text.delta' } }] },
  history: { localRuns: { maxRuns: 50 } },
};

function snapshot(metrics: Partial<SessionSnapshot['metrics']>, errors: SessionSnapshot['errors'] = []): SessionSnapshot {
  return { metrics: { eventCount: 0, parseErrorCount: 0, mappingErrorCount: 0, ...metrics }, errors } as unknown as SessionSnapshot;
}

describe('settings overview', () => {
  it('summarizes what every section is set to now', () => {
    const overview = settingsSectionOverview(profile);
    expect(overview.general.summary).toBe('Overview profile · environment local');
    expect(overview['opening-flow'].summary).toBe('Static opening · 1 starter prompt · 1 request variant');
    expect(overview.request.summary).toBe('POST ${env.baseUrl}/chat · times out after 30 s');
    expect(overview['stream-mapping'].summary).toBe('SSE · 1 mapping rule');
    expect(overview['history-errors'].summary).toBe('Keeps the last 50 runs');
    expect(settingsSectionOverview({ ...profile, history: {} })['history-errors'].summary).toBe('Run history is on, default limit');
    expect(overview.security.summary).toBe('links: HTTPS only · any domain · no commands');
    expect(Object.values(overview).some((item) => item.attention)).toBe(false);
  });

  it('flags sections that will stop or weaken a run', () => {
    const broken: TurnStageProfile = { ...profile, conversation: { send: { method: 'POST', url: ' ' } }, stream: { transport: 'ndjson', mappings: [] } };
    const overview = settingsSectionOverview(broken);
    expect(overview.request.attention).toBe('Request URL is missing');
    expect(overview.request.summary).toContain('times out after 120 s');
    // Profile validation rejects a Profile without variants.
    expect(overview['opening-flow'].attention).toBe('No request variants');
    expect(overview['stream-mapping'].attention).toBe('No mapping rules');
    const insecure: TurnStageProfile = { ...profile, conversation: { send: { ...profile.conversation.send, tls: { allowInvalidCertificates: true } } } };
    expect(settingsSectionOverview(insecure).request.attention).toBe('Certificate checks are off');
    expect(settingsSectionOverview(insecure, undefined, 'web').request.attention).toBeUndefined();
    expect(settingsSectionOverview({ ...profile, security: { allowedUriSchemes: ['https', 'http'], allowedDomains: ['a.test'] } }).security.summary).toBe('links: https, http · 1 allowed domain · no commands');
    expect(settingsSectionOverview(profile, snapshot({ eventCount: 4, mappingErrorCount: 2 }))['stream-mapping'].attention).toBe('2 parse or mapping errors in the last response');
  });

  it('describes what Chat and the host actually do, not just what the Profile spells out', () => {
    // Usage is hidden by default, so a Profile without UI settings still hides one surface.
    expect(settingsSectionOverview(profile)['chat-ui'].summary).toBe('Default message actions · 1 component hidden');
    // Starter prompts appear only with a static opening.
    expect(settingsSectionOverview({ ...profile, opening: { ...profile.opening!, mode: 'disabled' } })['opening-flow'].summary).toBe('No opening · 1 request variant');
    // The browser ignores the allow lists.
    expect(settingsSectionOverview(profile, undefined, 'web').security.summary).toBe('Opens HTTP and HTTPS links; allow lists apply in VS Code');
  });

  it('warns when an empty scheme list blocks every link, unlike a missing list', () => {
    const blocked = settingsSectionOverview({ ...profile, security: { allowedUriSchemes: [] } }).security;
    expect(blocked.summary).toBe('links: none · any domain · no commands');
    expect(blocked.attention).toBe('No link scheme is allowed, so links will not open');
    expect(settingsSectionOverview(profile).security.attention).toBeUndefined();
  });

  it('counts the message actions Chat actually shows', () => {
    const overview = settingsSectionOverview({ ...profile, ui: { messageActions: ['message.copy', 'message.copy', 'message.unknown'] } });
    expect(overview['chat-ui'].summary).toContain('1 message action ·');
  });

  it('describes the last response in one line', () => {
    expect(lastResponseHealth(undefined).tone).toBe('idle');
    expect(lastResponseHealth(snapshot({ eventCount: 6 }))).toEqual({ tone: 'ok', text: 'Last response: 6 events, no errors' });
    expect(lastResponseHealth(snapshot({ eventCount: 6, parseErrorCount: 1 })).tone).toBe('warning');
    expect(lastResponseHealth(snapshot({ eventCount: 3 }, [{ type: 'IdleTimeoutError', message: 'idle' } as SessionSnapshot['errors'][number]])).text).toBe('Latest error: idle');
  });

  it('formats seconds and transports for people', () => {
    expect(secondsText(120_000)).toBe('120');
    expect(secondsText(500)).toBe('0.5');
    expect(transportLabel('sse')).toBe('SSE');
    expect(transportLabel('ndjson')).toBe('NDJSON');
    expect(transportLabel('text-stream')).toBe('Text stream');
  });
});

function OverviewHarness({ post = vi.fn() }: { post?: (message: unknown) => void }): React.JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>('general');
  const [overview, setOverview] = useState(true);
  return <SettingsWorkspace embedded section={section} onSectionChange={setSection} overview={overview} onOverviewChange={setOverview} profile={profile} post={post} />;
}

describe('embedded settings navigation', () => {
  it('opens a section from the overview and returns to it', async () => {
    const user = userEvent.setup();
    render(<OverviewHarness />);
    const nav = screen.getByRole('navigation', { name: 'Profile configuration sections' });
    expect(within(nav).getByRole('button', { name: /Request.*times out after 30 s/u })).toBeTruthy();
    await user.click(within(nav).getByRole('button', { name: /^Security/u }));
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Profile configuration sections' }) as HTMLSelectElement).value).toBe('security');
    await user.click(screen.getByRole('button', { name: 'All settings' }));
    expect(screen.getByRole('navigation', { name: 'Profile configuration sections' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Profile configuration sections' })).toBeNull();
  });

  it('validates the Profile from the header', async () => {
    const post = vi.fn();
    render(<OverviewHarness post={post} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Validate profile' }));
    expect(post).toHaveBeenCalledWith({ type: 'profile.validate' });
  });

  it('edits request timeouts in seconds and stores milliseconds', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={profile} post={post} />);
    const timeout = screen.getByRole('spinbutton', { name: 'Request timeout (seconds)' }) as HTMLInputElement;
    expect(timeout.value).toBe('30');
    await user.clear(timeout);
    await user.type(timeout, '2.5{Enter}');
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['conversation', 'send', 'timeoutMs'], value: 2500 });
    const idle = screen.getByRole('spinbutton', { name: 'Idle timeout (seconds)' }) as HTMLInputElement;
    expect(idle.value).toBe('');
    expect(idle.placeholder).toBe('Off');
  });

  it('treats 0 as "not set" for timeouts instead of storing a 1 ms limit', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, idleTimeoutMs: 30_000 } } }} post={post} />);
    const idle = screen.getByRole('spinbutton', { name: 'Idle timeout (seconds)' }) as HTMLInputElement;
    await user.clear(idle);
    await user.type(idle, '0{Enter}');
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['conversation', 'send', 'idleTimeoutMs'], value: undefined });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ value: 1 }));
    expect(idle.value).toBe('');
  });

  it('shows the stored value after clamping, even when it did not change', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, timeoutMs: 900_000 } } }} post={post} />);
    const timeout = screen.getByRole('spinbutton', { name: 'Request timeout (seconds)' }) as HTMLInputElement;
    await user.clear(timeout);
    await user.type(timeout, '5000{Enter}');
    expect(timeout.value).toBe('900');
  });

  it('restores HTTPS-only links when the scheme list is cleared', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    render(<SettingsWorkspace section="security" onSectionChange={vi.fn()} profile={{ ...profile, security: { allowedUriSchemes: ['https', 'http'] } }} post={post} />);
    const schemes = screen.getByRole('textbox', { name: 'Allowed URI schemes' });
    await user.clear(schemes);
    await user.tab();
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['security', 'allowedUriSchemes'], value: undefined });
  });

  it('keeps retries and certificates collapsed until one of them is changed', () => {
    const { unmount } = render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={profile} post={vi.fn()} />);
    const advanced = screen.getByText('Advanced: retries, redirects, and certificates').closest('details')!;
    expect(advanced.open).toBe(false);
    unmount();
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, reconnect: { maxAttempts: 2 } } } }} post={vi.fn()} />);
    expect(screen.getByText('Advanced: retries, redirects, and certificates').closest('details')!.open).toBe(true);
    expect(screen.getByText('Changed from defaults')).toBeTruthy();
  });

  it('treats values written out at their defaults as defaults', () => {
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, reconnect: { maxAttempts: 0, baseDelayMs: 500, maxDelayMs: 10_000 }, redirectPolicy: 'same-origin', maxRedirects: 5 } } }} post={vi.fn()} />);
    expect(screen.getByText('Advanced: retries, redirects, and certificates').closest('details')!.open).toBe(false);
    expect(screen.getByText('Using defaults')).toBeTruthy();
  });

  it('lists Profile issues in the browser instead of offering a jump it cannot make', () => {
    const diagnostics = [{ severity: 'error' as const, message: 'conversation.send.url is required.', offset: 0, length: 1 }];
    render(<SettingsWorkspace embedded section="general" onSectionChange={vi.fn()} overview onOverviewChange={vi.fn()} profile={profile} post={vi.fn()} diagnostics={diagnostics} vscodeFeatures={false} />);
    expect(screen.getByText('1 Profile issue')).toBeTruthy();
    expect(screen.getByText('conversation.send.url is required.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show first issue' })).toBeNull();
  });

  it('does not warn about intercepted traffic in the browser, which always verifies certificates', () => {
    render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, tls: { allowInvalidCertificates: true } } } }} post={vi.fn()} vscodeFeatures={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain('always verifies server certificates');
  });

  it('says on the browser that the allow lists are enforced only in VS Code', () => {
    render(<SettingsWorkspace section="security" onSectionChange={vi.fn()} profile={profile} post={vi.fn()} vscodeFeatures={false} />);
    expect(screen.getByRole('note').textContent).toContain('enforced by the VS Code extension');
  });

  it('turns remote conversations on before offering their scope', async () => {
    const post = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<SettingsWorkspace section="history-errors" onSectionChange={vi.fn()} profile={profile} post={post} />);
    const enabled = screen.getByRole('checkbox', { name: 'Remember remote conversations' }) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: 'Environment' })).toBeNull();
    await user.click(enabled);
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['history', 'remoteSessions'], value: { mode: 'referenceOnly' } });
    unmount();
    // Without a scope the runtime separates by actor and environment too, so both start checked; Profile is not a choice.
    const { unmount: unmountDefault } = render(<SettingsWorkspace section="history-errors" onSectionChange={vi.fn()} profile={{ ...profile, history: { remoteSessions: { mode: 'referenceOnly' } } }} post={post} />);
    expect((screen.getByRole('checkbox', { name: 'Actor' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Environment' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Profile' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Actor' }));
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['history', 'remoteSessions'], value: { mode: 'referenceOnly', scope: ['profile', 'environment'] } });
    unmountDefault();
    render(<SettingsWorkspace section="history-errors" onSectionChange={vi.fn()} profile={{ ...profile, history: { remoteSessions: { mode: 'referenceOnly', scope: ['profile'] } } }} post={post} />);
    await user.click(screen.getByRole('checkbox', { name: 'Environment' }));
    expect(post).toHaveBeenCalledWith({ type: 'profile.patch', path: ['history', 'remoteSessions'], value: { mode: 'referenceOnly', scope: ['profile', 'environment'] } });
  });

  it('hides remote conversations in the browser, which never stores them', () => {
    render(<SettingsWorkspace section="history-errors" onSectionChange={vi.fn()} profile={profile} post={vi.fn()} vscodeFeatures={false} />);
    expect(screen.queryByRole('checkbox', { name: 'Remember remote conversations' })).toBeNull();
  });

  it('does not collapse Advanced while its last customized value is cleared', () => {
    const customized: TurnStageProfile = { ...profile, conversation: { send: { ...profile.conversation.send, reconnect: { maxAttempts: 2 } } } };
    const { rerender } = render(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={customized} post={vi.fn()} />);
    const advanced = () => screen.getByText('Advanced: retries, redirects, and certificates').closest('details')!;
    expect(advanced().open).toBe(true);
    rerender(<SettingsWorkspace section="request" onSectionChange={vi.fn()} profile={{ ...profile, conversation: { send: { ...profile.conversation.send, reconnect: {} } } }} post={vi.fn()} />);
    expect(advanced().open).toBe(true);
    expect(screen.getByText('Using defaults')).toBeTruthy();
  });

  it('moves keyboard focus into a section and back to its overview row', async () => {
    const user = userEvent.setup();
    render(<OverviewHarness />);
    await user.click(screen.getByRole('button', { name: /^Request/u }));
    expect(document.activeElement?.id).toBe('settings-panel-request');
    await user.click(screen.getByRole('button', { name: 'All settings' }));
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('request');
  });
});

describe('conversation flow editor', () => {
  it('shows the request once and links to where it is edited', async () => {
    const onEditRequest = vi.fn();
    render(<FlowEditor profile={profile} post={vi.fn()} onEditRequest={onEditRequest} />);
    expect(screen.queryByRole('textbox', { name: 'Conversation request URL' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Maximum local runs' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Unexpected stream end policy' })).toBeNull();
    expect(screen.getByText('POST ${env.baseUrl}/chat')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Edit request' }));
    expect(onEditRequest).toHaveBeenCalled();
  });
});

describe('settings state', () => {
  it('opens new states on the overview but returns older states to the section they showed', () => {
    expect(initialConfigurationOverview(undefined)).toBe(true);
    expect(initialConfigurationOverview({ version: 7 })).toBe(true);
    expect(initialConfigurationOverview({ version: 7, configurationOverview: false })).toBe(false);
    expect(initialConfigurationOverview({ version: 7, configurationOverview: true, rightPaneMode: 'configure', configurationSection: 'request' })).toBe(true);
    // Saved before the overview existed while showing Request.
    expect(initialConfigurationOverview({ version: 7, rightPaneMode: 'configure', configurationSection: 'request' })).toBe(false);
    expect(initialConfigurationOverview({ version: 7, section: 'security' })).toBe(false);
    // A section remembered while another pane was showing still starts on the overview.
    expect(initialConfigurationOverview({ version: 7, rightPaneMode: 'debug', configurationSection: 'request' })).toBe(true);
  });

  it('restores the overview choice and a dismissed getting started guide', () => {
    expect(normalizeWebviewState({ version: 4, configurationOverview: false, gettingStartedDismissed: true })).toMatchObject({ configurationOverview: false, gettingStartedDismissed: true });
    const fresh = normalizeWebviewState({ version: 4 });
    expect(fresh?.configurationOverview).toBeUndefined();
    expect(fresh?.gettingStartedDismissed).toBeUndefined();
  });
});
