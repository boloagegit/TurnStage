import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaseEditorOverlay } from '../CaseEditorOverlay';
import { formatNumber, t } from '../i18n';
import { applyUpgrade, ARENA, createSurvivor, ORBIT_RADIUS, stepSurvivor, type EnemyKind, type SurvivorState, type UpgradeId } from './survivorEngine';
import './survivorGame.css';

const BEST_KEY = 'turnstage.easterEgg.survivor.best';

const UPGRADE_TEXT: Record<UpgradeId, { name: string; detail: string }> = {
  rate: { name: 'Faster checks', detail: 'Fire 15% more often.' },
  damage: { name: 'Stricter rules', detail: 'Every hit does one more damage.' },
  multishot: { name: 'Parallel requests', detail: 'Fire one more shot each time.' },
  pierce: { name: 'Deep inspection', detail: 'Shots pass through one more attacker.' },
  speed: { name: 'Lower latency', detail: 'Move 12% faster.' },
  regen: { name: 'Self-healing', detail: 'Recover 1 health every second.' },
  vitality: { name: 'More headroom', detail: 'Raise maximum health by 20 and heal 40.' },
  orbit: { name: 'Guardrail', detail: 'Add a shield that circles you and hits attackers.' },
};

const ENEMY_LABEL: Record<EnemyKind, string> = { injection: 'INJ', ratelimit: '429', timeout: 'T/O', hallucination: 'HAL' };

function readBest(): number {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function saveBest(seconds: number): void {
  try { localStorage.setItem(BEST_KEY, String(Math.floor(seconds))); } catch { /* Storage can be unavailable; the best time is only a convenience. */ }
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Theme colors read once from the host, so the arena follows the VS Code or Web theme, including high contrast. */
function palette(element: HTMLElement): Record<string, string> {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--vscode-editor-background', '#1e1e1e'),
    grid: read('--vscode-editorWidget-border', '#444'),
    foreground: read('--vscode-editor-foreground', '#ddd'),
    player: read('--vscode-focusBorder', '#3794ff'),
    injection: read('--vscode-charts-red', '#f14c4c'),
    ratelimit: read('--vscode-charts-yellow', '#cca700'),
    timeout: read('--vscode-charts-purple', '#b180d7'),
    hallucination: read('--vscode-errorForeground', '#f48771'),
    gem: read('--vscode-charts-green', '#89d185'),
  };
}

function draw(context: CanvasRenderingContext2D, state: SurvivorState, colors: Record<string, string>, reducedMotion: boolean): void {
  context.fillStyle = colors.background!;
  context.fillRect(0, 0, ARENA.width, ARENA.height);
  context.strokeStyle = colors.grid!;
  context.globalAlpha = 0.35;
  context.lineWidth = 1;
  for (let x = 40; x < ARENA.width; x += 40) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, ARENA.height); context.stroke(); }
  for (let y = 40; y < ARENA.height; y += 40) { context.beginPath(); context.moveTo(0, y); context.lineTo(ARENA.width, y); context.stroke(); }
  context.globalAlpha = 1;

  context.fillStyle = colors.gem!;
  for (const gem of state.gems) { context.beginPath(); context.moveTo(gem.x, gem.y - 5); context.lineTo(gem.x + 4, gem.y); context.lineTo(gem.x, gem.y + 5); context.lineTo(gem.x - 4, gem.y); context.fill(); }

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const enemy of state.enemies) {
    context.fillStyle = enemy.flash > 0 && !reducedMotion ? colors.foreground! : colors[enemy.kind]!;
    context.beginPath(); context.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2); context.fill();
    context.fillStyle = colors.background!;
    context.font = `600 ${Math.max(8, Math.round(enemy.radius * 0.75))}px system-ui, sans-serif`;
    context.fillText(ENEMY_LABEL[enemy.kind], enemy.x, enemy.y + 0.5);
    if (enemy.kind === 'hallucination') {
      context.fillStyle = colors.grid!; context.fillRect(enemy.x - 36, enemy.y - enemy.radius - 12, 72, 5);
      context.fillStyle = colors.hallucination!; context.fillRect(enemy.x - 36, enemy.y - enemy.radius - 12, 72 * Math.max(0, enemy.hp / enemy.maxHp), 5);
    }
  }

  context.fillStyle = colors.foreground!;
  for (const bullet of state.bullets) { context.beginPath(); context.arc(bullet.x, bullet.y, 3, 0, Math.PI * 2); context.fill(); }

  const { player } = state;
  context.strokeStyle = colors.player!;
  context.lineWidth = 3;
  for (let index = 0; index < state.orbits; index += 1) {
    const angle = state.orbitAngle + (index / state.orbits) * Math.PI * 2;
    context.beginPath(); context.arc(player.x + Math.cos(angle) * ORBIT_RADIUS, player.y + Math.sin(angle) * ORBIT_RADIUS, 8, 0, Math.PI * 2); context.stroke();
  }
  // Blink while invulnerable after a hit; with reduced motion, dim instead of blinking.
  const hurt = player.invulnerable > 0;
  context.globalAlpha = hurt ? (reducedMotion ? 0.5 : Math.floor(player.invulnerable * 20) % 2 ? 0.3 : 1) : 1;
  context.fillStyle = colors.player!;
  context.beginPath(); context.moveTo(player.x, player.y - 14); context.lineTo(player.x + 12, player.y - 6); context.lineTo(player.x + 10, player.y + 8); context.lineTo(player.x, player.y + 14); context.lineTo(player.x - 10, player.y + 8); context.lineTo(player.x - 12, player.y - 6); context.closePath(); context.fill();
  context.globalAlpha = 1;
}

interface Hud { time: number; hp: number; maxHp: number; level: number; xp: number; xpToNext: number; kills: number; phase: SurvivorState['phase']; choices: UpgradeId[] }

function hudOf(state: SurvivorState): Hud {
  return { time: state.time, hp: Math.ceil(state.player.hp), maxHp: state.player.maxHp, level: state.level, xp: state.xp, xpToNext: state.xpToNext, kills: state.kills, phase: state.phase, choices: state.choices };
}

/**
 * Guardrail Survivor, opened with the Konami code. Runs entirely in the Webview: no requests, no Profile access,
 * and only the best time is kept in this Webview's local storage.
 */
export function SurvivorGame({ onClose }: { onClose: () => void }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<SurvivorState>(createSurvivor(Date.now()));
  const keys = useRef(new Set<string>());
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const [hud, setHud] = useState<Hud>(() => hudOf(game.current));
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState(readBest);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const restart = useCallback(() => { game.current = createSurvivor(Date.now()); setPaused(false); setHud(hudOf(game.current)); canvas.current?.focus(); }, []);
  const choose = useCallback((id: UpgradeId) => { applyUpgrade(game.current, id); setHud(hudOf(game.current)); canvas.current?.focus(); }, []);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const colors = palette(element);
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let last = performance.now();
    let hudClock = 0;
    let frame = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const state = game.current;
      if (!pausedRef.current) {
        let x = 0; let y = 0;
        const held = keys.current;
        if (held.has('arrowleft') || held.has('a')) x -= 1;
        if (held.has('arrowright') || held.has('d')) x += 1;
        if (held.has('arrowup') || held.has('w')) y -= 1;
        if (held.has('arrowdown') || held.has('s')) y += 1;
        if (pointer.current && x === 0 && y === 0) {
          const dx = pointer.current.x - state.player.x; const dy = pointer.current.y - state.player.y;
          if (Math.hypot(dx, dy) > 8) { x = dx; y = dy; }
        }
        const before = state.phase;
        stepSurvivor(state, dt, { x, y });
        hudClock += dt;
        if (state.phase !== before || hudClock > 0.1) { hudClock = 0; setHud(hudOf(state)); }
        if (state.phase === 'over' && before !== 'over' && state.time > readBest()) { saveBest(state.time); setBest(Math.floor(state.time)); }
      }
      draw(context, state, colors, reducedMotion);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Leaving the window or tab pauses the run instead of letting attackers pile up unseen.
    const autoPause = () => { if (document.hidden || !document.hasFocus()) setPaused(true); };
    document.addEventListener('visibilitychange', autoPause);
    window.addEventListener('blur', autoPause);
    element.focus();
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', autoPause); window.removeEventListener('blur', autoPause); };
  }, []);

  const toArena = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - box.left) / box.width) * ARENA.width, y: ((event.clientY - box.top) / box.height) * ARENA.height };
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const key = event.key.toLowerCase();
    if (key === 'p') { event.preventDefault(); setPaused((value) => !value); return; }
    if (hud.phase === 'levelup' && ['1', '2', '3'].includes(key)) { const id = hud.choices[Number(key) - 1]; if (id) choose(id); return; }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'w', 'a', 's', 'd'].includes(key)) { event.preventDefault(); keys.current.add(key); }
  };

  const status = hud.phase === 'over'
    ? t('Run over at {time}. {kills} attackers stopped.', { time: clock(hud.time), kills: formatNumber(hud.kills) })
    : hud.phase === 'levelup' ? t('Level {level}. Choose an upgrade.', { level: formatNumber(hud.level) })
      : paused ? t('Paused.') : '';

  return <CaseEditorOverlay title={t('Guardrail Survivor')} className="survivor-game" closeLabel={t('Close game')} onRequestClose={onClose}>
    <div className="survivor-game__hud">
      <span>{t('Time')} <strong>{clock(hud.time)}</strong></span>
      <span className="survivor-game__health">{t('Health')} <meter min={0} max={hud.maxHp} low={hud.maxHp * 0.3} high={hud.maxHp * 0.6} optimum={hud.maxHp} value={hud.hp} aria-label={t('Health')} /> <strong>{formatNumber(hud.hp)}</strong></span>
      <span>{t('Level')} <strong>{formatNumber(hud.level)}</strong> <meter min={0} max={hud.xpToNext} value={hud.xp} aria-label={t('Experience')} /></span>
      <span>{t('Attacks blocked')} <strong>{formatNumber(hud.kills)}</strong></span>
      <span>{t('Best')} <strong>{clock(best)}</strong></span>
      <button type="button" onClick={() => { setPaused((value) => !value); canvas.current?.focus(); }} disabled={hud.phase !== 'playing'}>{paused ? t('Resume') : t('Pause')}</button>
    </div>
    <div className="survivor-game__stage">
      <canvas ref={canvas} width={ARENA.width} height={ARENA.height} tabIndex={0} aria-label={t('Game arena. Move with the arrow keys or WASD; shots fire at the nearest attacker. P pauses.')}
        onKeyDown={onKeyDown} onKeyUp={(event) => keys.current.delete(event.key.toLowerCase())} onBlur={() => keys.current.clear()}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = toArena(event); }}
        onPointerMove={(event) => { if (pointer.current) pointer.current = toArena(event); }}
        onPointerUp={() => { pointer.current = undefined; }} onPointerCancel={() => { pointer.current = undefined; }} />
      {hud.phase === 'levelup' && <div className="survivor-game__panel" role="group" aria-label={t('Choose an upgrade')}>
        <strong>{t('Level {level}', { level: formatNumber(hud.level) })}</strong>
        {hud.choices.map((id, index) => <button key={id} type="button" onClick={() => choose(id)}><kbd>{index + 1}</kbd><span><strong>{t(UPGRADE_TEXT[id].name)}</strong><small>{t(UPGRADE_TEXT[id].detail)}</small></span></button>)}
      </div>}
      {hud.phase === 'over' && <div className="survivor-game__panel">
        <strong>{t('The attackers got through')}</strong>
        <p>{t('You held for {time} and stopped {kills} attackers.', { time: clock(hud.time), kills: formatNumber(hud.kills) })}</p>
        <button type="button" className="primary" onClick={restart}>{t('Play again')}</button>
      </div>}
      {paused && hud.phase === 'playing' && <div className="survivor-game__panel"><strong>{t('Paused')}</strong><button type="button" className="primary" onClick={() => { setPaused(false); canvas.current?.focus(); }}>{t('Resume')}</button></div>}
    </div>
    <p className="survivor-game__help">{t('Move with the arrow keys or WASD, or hold and drag on the arena. Shots fire on their own. P pauses, Esc closes.')}</p>
    <p className="sr-only" role="status">{status}</p>
  </CaseEditorOverlay>;
}
