import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { requestEasterEgg } from './konami';
import { drawRosterIcon } from './sprites';

const CLICKS_TO_OPEN = 5;

/**
 * The game's guardian, peeking out of an empty view. Hovering it whispers the code; clicking it a few times opens the
 * game, so the egg can also be found without a keyboard.
 */
export function PeekingGuardian(): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [clicks, setClicks] = useState(0);
  useEffect(() => { if (canvas.current) drawRosterIcon(canvas.current, 'guardian'); }, []);
  const hint = t('Psst… ↑↑↓↓←→←→BA');
  // Alternating class names restart the wiggle on every poke without remounting the button (which would drop focus).
  return <button type="button" className={`peeking-guardian${clicks ? (clicks % 2 ? ' is-poked-a' : ' is-poked-b') : ''}`} title={hint} aria-label={`${hint} ${t('Or click the robot a few times.')}`}
    onClick={() => { const next = clicks + 1; if (next >= CLICKS_TO_OPEN) { setClicks(0); requestEasterEgg(); } else setClicks(next); }}>
    <canvas ref={canvas} width={96} height={96} aria-hidden="true" />
  </button>;
}
