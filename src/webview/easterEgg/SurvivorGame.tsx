import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaseEditorOverlay } from '../CaseEditorOverlay';
import { formatNumber, t } from '../i18n';
import { applyUpgrade, ARENA, createSurvivor, ORBIT_RADIUS, stepSurvivor, type EnemyKind, type SurvivorState, type UpgradeId } from './survivorEngine';
import { buildBackground, buildEnemyFrames, COLORS, drawBolt, drawGuardian, drawHallucination, drawRosterIcon, drawShield, drawToken, ENEMY_COLOR, FRAMES } from './sprites';
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

const ROSTER: Array<{ kind: EnemyKind | 'guardian'; name: string; detail: string }> = [
  { kind: 'guardian', name: 'You: the Guardian', detail: 'Fires at the nearest attacker on its own.' },
  { kind: 'injection', name: 'Prompt injection', detail: 'Sneaks in with a syringe of instructions.' },
  { kind: 'ratelimit', name: '429 hornet', detail: 'Fast, fragile, and always in a swarm.' },
  { kind: 'timeout', name: 'Timeout snail', detail: 'Slow, tough, and hits hard.' },
  { kind: 'hallucination', name: 'Hallucination', detail: 'A boss every two minutes. It splits when it falls.' },
];

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

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; ring: boolean }

/** Visual effects that the engine does not need to know about: sparks, pops, and screen shake. */
interface Effects { particles: Particle[]; seen: Map<number, { x: number; y: number; kind: EnemyKind }>; shake: number; lastHp: number; lastLevel: number; facing: 1 | -1 }

function burst(effects: Effects, x: number, y: number, color: string, count: number, speed: number, reducedMotion: boolean): void {
  const total = reducedMotion ? Math.ceil(count / 3) : count;
  for (let index = 0; index < total; index += 1) {
    const angle = (index / total) * Math.PI * 2 + Math.random() * 0.6;
    const velocity = speed * (0.5 + Math.random() * 0.7);
    effects.particles.push({ x, y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity, life: 0.45, max: 0.45, color, size: 2 + Math.random() * 2, ring: false });
  }
}

function ring(effects: Effects, x: number, y: number, color: string, size: number): void {
  effects.particles.push({ x, y, vx: 0, vy: 0, life: 0.4, max: 0.4, color, size, ring: true });
}

/** Turns what changed in the engine since the last frame into effects. */
function collectEffects(effects: Effects, state: SurvivorState, reducedMotion: boolean): void {
  const alive = new Set<number>();
  for (const enemy of state.enemies) {
    alive.add(enemy.id);
    effects.seen.set(enemy.id, { x: enemy.x, y: enemy.y, kind: enemy.kind });
    if (enemy.flash > 0.07) burst(effects, enemy.x, enemy.y, COLORS.white, 3, 90, reducedMotion);
  }
  for (const [id, last] of effects.seen) {
    if (alive.has(id)) continue;
    effects.seen.delete(id);
    burst(effects, last.x, last.y, ENEMY_COLOR[last.kind], last.kind === 'hallucination' ? 28 : 9, last.kind === 'hallucination' ? 260 : 150, reducedMotion);
    ring(effects, last.x, last.y, ENEMY_COLOR[last.kind], last.kind === 'hallucination' ? 70 : 22);
  }
  if (state.player.hp < effects.lastHp - 0.5) { effects.shake = reducedMotion ? 0 : 0.25; burst(effects, state.player.x, state.player.y, COLORS.danger, 8, 140, reducedMotion); }
  effects.lastHp = state.player.hp;
  if (state.level > effects.lastLevel) ring(effects, state.player.x, state.player.y, COLORS.token, 90);
  effects.lastLevel = state.level;
}

function draw(context: CanvasRenderingContext2D, state: SurvivorState, art: Art, effects: Effects, time: number, dt: number, moving: boolean, reducedMotion: boolean): void {
  context.save();
  if (effects.shake > 0) { context.translate((Math.random() - 0.5) * 8 * effects.shake / 0.25, (Math.random() - 0.5) * 8 * effects.shake / 0.25); effects.shake = Math.max(0, effects.shake - dt); }
  context.drawImage(art.background, 0, 0, ARENA.width, ARENA.height);

  for (const gem of state.gems) drawToken(context, gem.x, gem.y, time, gem.value);

  // Painter's order: things lower on screen are drawn in front.
  const enemies = [...state.enemies].sort((a, b) => a.y - b.y);
  for (const enemy of enemies) {
    const facing = state.player.x < enemy.x ? -1 : 1;
    if (enemy.kind === 'hallucination') {
      drawHallucination(context, enemy.x, enemy.y, enemy.radius * 1.25, time, !reducedMotion && time % 1.4 < 0.08);
      const width = 90;
      context.fillStyle = 'rgba(10, 13, 26, 0.75)'; context.fillRect(enemy.x - width / 2 - 2, enemy.y - enemy.radius * 1.35 - 16, width + 4, 9);
      context.fillStyle = '#ff7ad9'; context.fillRect(enemy.x - width / 2, enemy.y - enemy.radius * 1.35 - 14, width * Math.max(0, enemy.hp / enemy.maxHp), 5);
      continue;
    }
    const sprite = art.enemies[enemy.kind];
    const frame = Math.floor((time * 8 + enemy.id * 0.37) % FRAMES);
    const image = enemy.flash > 0 ? sprite.flashes[frame] : sprite.frames[frame];
    if (!image) continue;
    // Sprites are drawn a little larger than the hit circle so they read as characters, not dots.
    const size = enemy.radius * 5;
    context.save();
    context.translate(enemy.x, enemy.y);
    if (facing < 0) context.scale(-1, 1);
    context.drawImage(image, -size / 2, -size / 2, size, size);
    context.restore();
  }

  for (const bullet of state.bullets) drawBolt(context, bullet.x, bullet.y, bullet.vx, bullet.vy);

  const { player } = state;
  if (state.orbits) {
    context.strokeStyle = 'rgba(255, 211, 106, 0.18)'; context.lineWidth = 2; context.setLineDash([4, 6]);
    context.beginPath(); context.arc(player.x, player.y, ORBIT_RADIUS, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
    for (let index = 0; index < state.orbits; index += 1) {
      const angle = state.orbitAngle + (index / state.orbits) * Math.PI * 2;
      drawShield(context, player.x + Math.cos(angle) * ORBIT_RADIUS, player.y + Math.sin(angle) * ORBIT_RADIUS, 11);
    }
  }
  // Blink while invulnerable after a hit; with reduced motion, dim instead of blinking.
  context.globalAlpha = player.invulnerable > 0 ? (reducedMotion ? 0.55 : Math.floor(player.invulnerable * 20) % 2 ? 0.35 : 1) : 1;
  drawGuardian(context, player.x, player.y, time, effects.facing, moving, 1.5);
  context.globalAlpha = 1;

  for (const particle of effects.particles) {
    particle.life -= dt;
    particle.x += particle.vx * dt; particle.y += particle.vy * dt;
    particle.vx *= 0.9; particle.vy *= 0.9;
    const fade = Math.max(0, particle.life / particle.max);
    context.globalAlpha = fade;
    if (particle.ring) {
      context.strokeStyle = particle.color; context.lineWidth = 3 * fade;
      context.beginPath(); context.arc(particle.x, particle.y, particle.size * (1.2 - fade * 0.7), 0, Math.PI * 2); context.stroke();
    } else {
      context.fillStyle = particle.color;
      context.fillRect(particle.x - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
    }
  }
  context.globalAlpha = 1;
  effects.particles = effects.particles.filter((particle) => particle.life > 0).slice(-500);
  // Low health tints the edges red.
  if (player.hp / player.maxHp < 0.3 && state.phase === 'playing') {
    const warning = context.createRadialGradient(ARENA.width / 2, ARENA.height / 2, ARENA.height * 0.4, ARENA.width / 2, ARENA.height / 2, ARENA.width * 0.62);
    warning.addColorStop(0, 'rgba(255, 77, 109, 0)');
    warning.addColorStop(1, `rgba(255, 77, 109, ${reducedMotion ? 0.25 : 0.18 + Math.sin(time * 6) * 0.1})`);
    context.fillStyle = warning; context.fillRect(0, 0, ARENA.width, ARENA.height);
  }
  context.restore();
}

interface Art { background: HTMLCanvasElement; enemies: ReturnType<typeof buildEnemyFrames> }

interface Hud { time: number; hp: number; maxHp: number; level: number; xp: number; xpToNext: number; kills: number; phase: SurvivorState['phase']; choices: UpgradeId[] }

function hudOf(state: SurvivorState): Hud {
  return { time: state.time, hp: Math.ceil(state.player.hp), maxHp: state.player.maxHp, level: state.level, xp: state.xp, xpToNext: state.xpToNext, kills: state.kills, phase: state.phase, choices: state.choices };
}

function RosterIcon({ kind }: { kind: EnemyKind | 'guardian' }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawRosterIcon(ref.current, kind); }, [kind]);
  return <canvas ref={ref} width={96} height={96} aria-hidden="true" />;
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
  const effects = useRef<Effects>({ particles: [], seen: new Map(), shake: 0, lastHp: 100, lastLevel: 1, facing: 1 });
  const [hud, setHud] = useState<Hud>(() => hudOf(game.current));
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState(readBest);
  const running = useRef(false);
  running.current = started && !paused;

  const focusArena = () => canvas.current?.focus();
  const start = useCallback(() => { setStarted(true); setPaused(false); canvas.current?.focus(); }, []);
  const restart = useCallback(() => {
    game.current = createSurvivor(Date.now());
    effects.current = { particles: [], seen: new Map(), shake: 0, lastHp: 100, lastLevel: 1, facing: 1 };
    setPaused(false); setHud(hudOf(game.current)); canvas.current?.focus();
  }, []);
  const choose = useCallback((id: UpgradeId) => { applyUpgrade(game.current, id); setHud(hudOf(game.current)); canvas.current?.focus(); }, []);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    // Draw at the device pixel ratio so the artwork stays sharp on high-density screens.
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    element.width = ARENA.width * scale;
    element.height = ARENA.height * scale;
    const art: Art = { background: buildBackground(ARENA.width, ARENA.height, scale), enemies: buildEnemyFrames(scale) };
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let last = performance.now();
    let hudClock = 0;
    let frame = 0;
    let time = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const state = game.current;
      let moving = false;
      if (running.current) {
        time += dt;
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
        moving = (x !== 0 || y !== 0) && state.phase === 'playing';
        if (x !== 0) effects.current.facing = x < 0 ? -1 : 1;
        const before = state.phase;
        stepSurvivor(state, dt, { x, y });
        collectEffects(effects.current, state, reducedMotion);
        hudClock += dt;
        if (state.phase !== before || hudClock > 0.1) { hudClock = 0; setHud(hudOf(state)); }
        if (state.phase === 'over' && before !== 'over' && state.time > readBest()) { saveBest(state.time); setBest(Math.floor(state.time)); }
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      draw(context, state, art, effects.current, time, running.current ? dt : 0, moving, reducedMotion);
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
    if (!started && (key === 'enter' || key === ' ')) { event.preventDefault(); start(); return; }
    if (key === 'p' && started) { event.preventDefault(); setPaused((value) => !value); return; }
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
      <button type="button" onClick={() => { setPaused((value) => !value); focusArena(); }} disabled={!started || hud.phase !== 'playing'}>{paused ? t('Resume') : t('Pause')}</button>
    </div>
    <div className="survivor-game__stage">
      <canvas ref={canvas} width={ARENA.width} height={ARENA.height} tabIndex={0} aria-label={t('Game arena. Move with the arrow keys or WASD; shots fire at the nearest attacker. P pauses.')}
        onKeyDown={onKeyDown} onKeyUp={(event) => keys.current.delete(event.key.toLowerCase())} onBlur={() => keys.current.clear()}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = toArena(event); }}
        onPointerMove={(event) => { if (pointer.current) pointer.current = toArena(event); }}
        onPointerUp={() => { pointer.current = undefined; }} onPointerCancel={() => { pointer.current = undefined; }} />
      {!started && <div className="survivor-game__panel survivor-game__intro">
        <strong className="survivor-game__title">{t('Guardrail Survivor')}</strong>
        <p>{t('Attacks pour in from every side. Hold the line as long as you can.')}</p>
        <ul className="survivor-game__roster">
          {ROSTER.map((entry) => <li key={entry.kind}><RosterIcon kind={entry.kind} /><span><strong>{t(entry.name)}</strong><small>{t(entry.detail)}</small></span></li>)}
        </ul>
        <button type="button" className="primary" onClick={start}>{t('Start')}</button>
      </div>}
      {hud.phase === 'levelup' && <div className="survivor-game__panel" role="group" aria-label={t('Choose an upgrade')}>
        <strong>{t('Level {level}', { level: formatNumber(hud.level) })}</strong>
        {hud.choices.map((id, index) => <button key={id} type="button" onClick={() => choose(id)}><kbd>{index + 1}</kbd><span><strong>{t(UPGRADE_TEXT[id].name)}</strong><small>{t(UPGRADE_TEXT[id].detail)}</small></span></button>)}
      </div>}
      {hud.phase === 'over' && <div className="survivor-game__panel">
        <strong>{t('The attackers got through')}</strong>
        <p>{t('You held for {time} and stopped {kills} attackers.', { time: clock(hud.time), kills: formatNumber(hud.kills) })}</p>
        <button type="button" className="primary" onClick={restart}>{t('Play again')}</button>
      </div>}
      {started && paused && hud.phase === 'playing' && <div className="survivor-game__panel"><strong>{t('Paused')}</strong><button type="button" className="primary" onClick={() => { setPaused(false); focusArena(); }}>{t('Resume')}</button></div>}
    </div>
    <p className="survivor-game__help">{t('Move with the arrow keys or WASD, or hold and drag on the arena. Shots fire on their own. P pauses, Esc closes.')}</p>
    <p className="sr-only" role="status">{status}</p>
  </CaseEditorOverlay>;
}
