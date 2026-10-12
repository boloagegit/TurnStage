import React from 'react';
import { IconButton, ProductIcon } from './Icon';
import { formatNumber, t } from './i18n';

export interface GettingStartedStep {
  id: 'send' | 'save' | 'run';
  title: string;
  detail: string;
  done: boolean;
  action: { label: string; run: () => void; disabled?: boolean };
}

/** Which first-run steps are done, from what the workspace already knows; no separate progress is stored. */
export function gettingStartedProgress(input: { sentMessage: boolean; capturedCase: boolean; recordedRun: boolean }): Record<GettingStartedStep['id'], boolean> {
  return { send: input.sentMessage, save: input.capturedCase, run: input.recordedRun };
}

/**
 * The product's core loop as three steps: talk to the backend, keep a reply as a test, and run it.
 * Only the next unfinished step offers an action, so the guide always points one way.
 */
export function GettingStarted({ steps, onDismiss }: { steps: readonly GettingStartedStep[]; onDismiss: () => void }): React.JSX.Element {
  const next = steps.find((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;
  return <section className="getting-started" aria-labelledby="getting-started-title">
    <header>
      <div>
        <h2 id="getting-started-title">{t('Your first test in three steps')}</h2>
        <p>{t('{done} of {total} done', { done: formatNumber(doneCount), total: formatNumber(steps.length) })}</p>
      </div>
      <IconButton type="button" icon="close" label={t('Hide the getting started steps')} onClick={onDismiss} />
    </header>
    <ol>
      {steps.map((step, index) => <li key={step.id} className={`getting-started__step${step.done ? ' is-done' : ''}${step === next ? ' is-next' : ''}`} aria-current={step === next ? 'step' : undefined}>
        <span className="getting-started__mark" aria-hidden="true">{step.done ? <ProductIcon name="check" /> : formatNumber(index + 1)}</span>
        <div>
          <strong>{step.title}{step.done && <span className="sr-only">, {t('done')}</span>}</strong>
          <span>{step.detail}</span>
        </div>
        {step === next && <button type="button" className="primary" disabled={step.action.disabled} onClick={step.action.run}>{step.action.label}</button>}
      </li>)}
    </ol>
  </section>;
}
