import React from 'react';
import type { SessionSnapshot, TurnStageProfile } from '../shared/types';
import { ProductIcon } from './Icon';
import { formatNumber, t } from './i18n';

/** Conversation requests time out after this long when the Profile does not set timeoutMs. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** The display name of a stream transport; protocol acronyms stay upper case. */
export function transportLabel(transport: string): string {
  if (transport === 'text-stream') return t('Text stream');
  if (transport === 'fixture') return t('Fixture');
  return transport.toUpperCase();
}

/** Seconds for display, without trailing zeros: 120000 → "120", 500 → "0.5". */
export function secondsText(ms: number): string {
  return formatNumber(Math.round(ms) / 1000);
}

export interface SettingsSectionOverview {
  /** One line describing what the section is set to now. */
  summary: string;
  /** Something in the section that will stop or weaken a run. */
  attention?: string;
}

/**
 * A one-line, current-value summary for each settings section, so the overview
 * answers "what is this Profile set to?" without opening every section.
 */
export function settingsSectionOverview(profile: TurnStageProfile, snapshot?: SessionSnapshot): Record<string, SettingsSectionOverview> {
  const send = profile.conversation.send;
  const variants = send.variants?.length ?? 0;
  const starters = profile.opening?.starters?.length ?? 0;
  const openingMode = profile.opening?.mode ?? 'disabled';
  const mappings = profile.stream.mappings.length;
  const mappingProblems = (snapshot?.metrics.parseErrorCount ?? 0) + (snapshot?.metrics.mappingErrorCount ?? 0);
  const localRuns = profile.history?.localRuns;
  const maxRuns = localRuns?.maxRuns ?? 20;
  const schemes = profile.security?.allowedUriSchemes ?? [];
  const domains = profile.security?.allowedDomains?.length ?? 0;
  const commands = profile.security?.allowedCommands?.length ?? 0;
  const hiddenComponents = Object.values(profile.ui?.components ?? {}).filter((component) => component.visible === false).length;
  const actions = profile.ui?.messageActions?.length;
  const inlineCases = profile.tests?.scenarios?.length ?? 0;
  const suites = (profile.tests?.contractSuites?.length ?? 0) + (profile.tests?.adversarialSuites?.length ?? 0);
  const reportFormats = profile.tests?.reporting?.formats ?? [];

  const openingText = openingMode === 'static' ? t('Static opening') : openingMode === 'request' ? t('Opening request') : t('No opening');
  const timeout = send.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    general: { summary: [profile.name || t('Untitled profile'), profile.environment ? t('environment {id}', { id: profile.environment }) : t('default environment')].join(' · ') },
    'opening-flow': {
      summary: [openingText, t(starters === 1 ? '{count} starter prompt' : '{count} starter prompts', { count: formatNumber(starters) }), t(variants === 1 ? '{count} request variant' : '{count} request variants', { count: formatNumber(variants) })].join(' · '),
    },
    request: {
      summary: [`${send.method} ${send.url || '—'}`, t('times out after {seconds} s', { seconds: secondsText(timeout) })].join(' · '),
      attention: !send.url.trim() ? t('Request URL is missing') : send.tls?.allowInvalidCertificates ? t('Certificate checks are off') : undefined,
    },
    'stream-mapping': {
      summary: [transportLabel(profile.stream.transport), t(mappings === 1 ? '{count} mapping rule' : '{count} mapping rules', { count: formatNumber(mappings) })].join(' · '),
      attention: mappings === 0 ? t('No mapping rules') : mappingProblems ? t(mappingProblems === 1 ? '{count} parse or mapping error in the last response' : '{count} parse or mapping errors in the last response', { count: formatNumber(mappingProblems) }) : undefined,
    },
    'chat-ui': {
      summary: [
        actions === undefined ? t('Default message actions') : t(actions === 1 ? '{count} message action' : '{count} message actions', { count: formatNumber(actions) }),
        hiddenComponents ? t(hiddenComponents === 1 ? '{count} component hidden' : '{count} components hidden', { count: formatNumber(hiddenComponents) }) : t('All components shown'),
      ].join(' · '),
    },
    'scenario-tests': {
      summary: [
        t(inlineCases === 1 ? '{count} case in this Profile' : '{count} cases in this Profile', { count: formatNumber(inlineCases) }),
        suites ? t(suites === 1 ? '{count} linked file' : '{count} linked files', { count: formatNumber(suites) }) : undefined,
        reportFormats.length ? t('reports: {formats}', { formats: reportFormats.join(', ') }) : undefined,
      ].filter(Boolean).join(' · '),
    },
    'history-errors': {
      summary: localRuns?.enabled === false ? t('Run history is off') : t(maxRuns === 1 ? 'Keeps the last {count} run' : 'Keeps the last {count} runs', { count: formatNumber(maxRuns) }),
    },
    security: {
      summary: [
        schemes.length ? t('links: {schemes}', { schemes: schemes.join(', ') }) : t('links: HTTPS only'),
        domains ? t(domains === 1 ? '{count} allowed domain' : '{count} allowed domains', { count: formatNumber(domains) }) : t('any domain'),
        commands ? t(commands === 1 ? '{count} allowed command' : '{count} allowed commands', { count: formatNumber(commands) }) : t('no commands'),
      ].join(' · '),
    },
  };
}

/** What the last response says about the connection, in one line. */
export function lastResponseHealth(snapshot?: SessionSnapshot): { tone: 'ok' | 'warning' | 'idle'; text: string } {
  if (!snapshot || !snapshot.metrics.eventCount && !snapshot.errors.length) return { tone: 'idle', text: t('No response yet. Send a message to check the connection.') };
  const problems = snapshot.metrics.parseErrorCount + snapshot.metrics.mappingErrorCount;
  if (snapshot.errors.length) return { tone: 'warning', text: t('Last response failed: {error}', { error: snapshot.errors[snapshot.errors.length - 1]!.message }) };
  if (problems) return { tone: 'warning', text: t('Last response: {events} events, {problems} parse or mapping errors', { events: formatNumber(snapshot.metrics.eventCount), problems: formatNumber(problems) }) };
  return { tone: 'ok', text: t('Last response: {events} events, no errors', { events: formatNumber(snapshot.metrics.eventCount) }) };
}

export function SettingsOverview<Section extends string>({ sections, profile, snapshot, diagnosticsCount, onOpen, onShowFirstIssue }: {
  sections: ReadonlyArray<{ id: Section; label: string }>;
  profile: TurnStageProfile;
  snapshot?: SessionSnapshot;
  diagnosticsCount: number;
  onOpen: (section: Section) => void;
  onShowFirstIssue: () => void;
}): React.JSX.Element {
  const overview = settingsSectionOverview(profile, snapshot);
  const health = lastResponseHealth(snapshot);
  return <div className="settings-overview">
    <section className="settings-health" aria-label={t('Profile health')}>
      <p className={`settings-health__row is-${diagnosticsCount ? 'warning' : 'ok'}`}>
        <ProductIcon name={diagnosticsCount ? 'warning' : 'check'} />
        <span>{diagnosticsCount ? t(diagnosticsCount === 1 ? '{count} Profile issue' : '{count} Profile issues', { count: formatNumber(diagnosticsCount) }) : t('No Profile issues')}</span>
        {diagnosticsCount > 0 && <button type="button" className="settings-inline-action" onClick={onShowFirstIssue}>{t('Show first issue')}</button>}
      </p>
      <p className={`settings-health__row is-${health.tone}`}>
        <ProductIcon name={health.tone === 'warning' ? 'warning' : health.tone === 'ok' ? 'check' : 'info'} />
        <span>{health.text}</span>
      </p>
    </section>
    <nav aria-label={t('Profile configuration sections')}>
      <ul className="settings-overview__list">
        {sections.map((section) => {
          const item = overview[section.id];
          return <li key={section.id}>
            <button type="button" data-settings-section={section.id} onClick={() => onOpen(section.id)}>
              <span className="settings-overview__text">
                <strong>{t(section.label)}</strong>
                <span>{item?.summary}</span>
                {item?.attention && <span className="settings-overview__attention"><ProductIcon name="warning" />{item.attention}</span>}
              </span>
              <ProductIcon name="chevron-right" />
            </button>
          </li>;
        })}
      </ul>
    </nav>
  </div>;
}
