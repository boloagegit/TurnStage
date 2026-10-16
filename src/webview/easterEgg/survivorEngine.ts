/**
 * Guardrail Survivor: a top-down survival shooter hidden behind the Konami code. The engine is pure and seeded so
 * it can be stepped in tests; rendering and input live in SurvivorGame.tsx. Coordinates are arena units.
 */

export const ARENA = { width: 960, height: 600 } as const;

export type EnemyKind = 'injection' | 'ratelimit' | 'timeout' | 'hallucination';
export type UpgradeId = 'rate' | 'damage' | 'multishot' | 'pierce' | 'speed' | 'regen' | 'vitality' | 'orbit';
export type Phase = 'playing' | 'levelup' | 'over';

export interface Enemy { id: number; kind: EnemyKind; x: number; y: number; hp: number; maxHp: number; radius: number; speed: number; damage: number; xp: number; orbitCooldown: number; flash: number; hits: number }
export interface Bullet { x: number; y: number; vx: number; vy: number; damage: number; pierce: number; life: number; hit: number[] }
export interface Gem { x: number; y: number; value: number }

export interface SurvivorState {
  phase: Phase;
  time: number;
  kills: number;
  level: number;
  xp: number;
  xpToNext: number;
  player: { x: number; y: number; hp: number; maxHp: number; speed: number; invulnerable: number };
  weapon: { interval: number; cooldown: number; damage: number; shots: number; pierce: number; speed: number; range: number };
  magnet: number;
  /** Health restored per second. */
  regen: number;
  orbits: number;
  orbitAngle: number;
  enemies: Enemy[];
  bullets: Bullet[];
  gems: Gem[];
  /** Upgrades offered at the current level-up. */
  choices: UpgradeId[];
  upgrades: Partial<Record<UpgradeId, number>>;
  nextBossAt: number;
  spawnBudget: number;
  nextId: number;
  seed: number;
}

export interface Input { x: number; y: number }

const ENEMY_STATS: Record<EnemyKind, { radius: number; hp: number; speed: number; damage: number; xp: number }> = {
  injection: { radius: 11, hp: 2, speed: 60, damage: 8, xp: 1 },
  ratelimit: { radius: 9, hp: 1, speed: 118, damage: 5, xp: 1 },
  timeout: { radius: 17, hp: 8, speed: 38, damage: 14, xp: 3 },
  hallucination: { radius: 36, hp: 200, speed: 52, damage: 22, xp: 30 },
};

const UPGRADE_LIMITS: Record<UpgradeId, number> = { rate: 8, damage: 8, multishot: 6, pierce: 4, speed: 5, regen: 4, vitality: 6, orbit: 4 };
const MAX_ENEMIES = 300;
const MAX_BULLETS = 320;
const BOSS_INTERVAL = 120;
export const ORBIT_RADIUS = 58;

export function createSurvivor(seed = 1): SurvivorState {
  return {
    phase: 'playing', time: 0, kills: 0, level: 1, xp: 0, xpToNext: 3,
    player: { x: ARENA.width / 2, y: ARENA.height / 2, hp: 100, maxHp: 100, speed: 200, invulnerable: 0 },
    weapon: { interval: 0.42, cooldown: 0, damage: 1, shots: 1, pierce: 0, speed: 440, range: 400 },
    magnet: 110, regen: 0, orbits: 0, orbitAngle: 0,
    enemies: [], bullets: [], gems: [], choices: [], upgrades: {},
    nextBossAt: BOSS_INTERVAL, spawnBudget: 0, nextId: 1, seed: seed >>> 0 || 1,
  };
}

/** Mulberry32: small, fast, and reproducible for a given seed. */
function random(state: SurvivorState): number {
  state.seed = (state.seed + 0x6d2b79f5) >>> 0;
  let value = state.seed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function spawnEnemy(state: SurvivorState, kind: EnemyKind, at?: { x: number; y: number }): void {
  if (state.enemies.length >= MAX_ENEMIES && kind !== 'hallucination') return;
  const stats = ENEMY_STATS[kind];
  // Enemies get tougher as the run goes on, so upgrades keep mattering.
  const toughness = 1 + state.time / 120 + (state.time / 150) ** 2;
  const hp = Math.round(stats.hp * (kind === 'hallucination' ? 1 + (state.nextBossAt / BOSS_INTERVAL - 1) * 0.75 : toughness));
  let position = at;
  if (!position) {
    const edge = Math.floor(random(state) * 4);
    const along = random(state);
    const margin = stats.radius + 8;
    position = edge === 0 ? { x: along * ARENA.width, y: -margin }
      : edge === 1 ? { x: ARENA.width + margin, y: along * ARENA.height }
        : edge === 2 ? { x: along * ARENA.width, y: ARENA.height + margin }
          : { x: -margin, y: along * ARENA.height };
  }
  state.enemies.push({ id: state.nextId++, kind, x: position.x, y: position.y, hp, maxHp: hp, radius: stats.radius, speed: stats.speed, damage: stats.damage, xp: stats.xp, orbitCooldown: 0, flash: 0, hits: 0 });
}

function pickSpawnKind(state: SurvivorState): EnemyKind {
  const roll = random(state);
  if (state.time > 75 && roll < 0.18) return 'timeout';
  if (state.time > 40 && roll < 0.42) return 'ratelimit';
  return 'injection';
}

function nearestEnemy(state: SurvivorState): Enemy | undefined {
  let best: Enemy | undefined;
  let bestDistance = state.weapon.range * state.weapon.range;
  for (const enemy of state.enemies) {
    const dx = enemy.x - state.player.x;
    const dy = enemy.y - state.player.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { best = enemy; bestDistance = distance; }
  }
  return best;
}

function fire(state: SurvivorState): void {
  const target = nearestEnemy(state);
  if (!target) return;
  const base = Math.atan2(target.y - state.player.y, target.x - state.player.x);
  const { shots, speed, damage, pierce } = state.weapon;
  for (let index = 0; index < shots && state.bullets.length < MAX_BULLETS; index += 1) {
    const angle = base + (index - (shots - 1) / 2) * 0.16;
    state.bullets.push({ x: state.player.x, y: state.player.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, damage, pierce, life: 1.2, hit: [] });
  }
}

function kill(state: SurvivorState, enemy: Enemy): void {
  state.kills += 1;
  state.gems.push({ x: enemy.x, y: enemy.y, value: enemy.xp });
  // A defeated hallucination breaks into smaller false claims.
  if (enemy.kind === 'hallucination') for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    spawnEnemy(state, 'injection', { x: enemy.x + Math.cos(angle) * 40, y: enemy.y + Math.sin(angle) * 40 });
  }
}

function damageEnemy(state: SurvivorState, enemy: Enemy, amount: number): void {
  enemy.hp -= amount;
  enemy.flash = 0.08;
  enemy.hits += 1;
  if (enemy.hp <= 0) kill(state, enemy);
}

/** Three distinct upgrades that have not reached their limit; fewer when most are maxed. */
export function rollChoices(state: SurvivorState): UpgradeId[] {
  const available = (Object.keys(UPGRADE_LIMITS) as UpgradeId[]).filter((id) => (state.upgrades[id] ?? 0) < UPGRADE_LIMITS[id]);
  const choices: UpgradeId[] = [];
  while (choices.length < 3 && available.length) choices.push(available.splice(Math.floor(random(state) * available.length), 1)[0]!);
  return choices;
}

export function applyUpgrade(state: SurvivorState, id: UpgradeId): void {
  if (state.phase !== 'levelup' || !state.choices.includes(id)) return;
  state.upgrades[id] = (state.upgrades[id] ?? 0) + 1;
  if (id === 'rate') state.weapon.interval *= 0.85;
  if (id === 'damage') state.weapon.damage += 1;
  if (id === 'multishot') state.weapon.shots += 1;
  if (id === 'pierce') state.weapon.pierce += 1;
  if (id === 'speed') state.player.speed *= 1.12;
  if (id === 'regen') state.regen += 1;
  if (id === 'vitality') { state.player.maxHp += 20; state.player.hp = Math.min(state.player.maxHp, state.player.hp + 40); }
  if (id === 'orbit') state.orbits += 1;
  state.choices = [];
  state.phase = 'playing';
  // Several levels can be earned at once; offer the next choice straight away.
  if (state.xp >= state.xpToNext) levelUp(state);
}

function levelUp(state: SurvivorState): void {
  state.xp -= state.xpToNext;
  state.level += 1;
  state.xpToNext = 4 + state.level * 3;
  state.choices = rollChoices(state);
  if (state.choices.length) state.phase = 'levelup';
}

/** The longest single engine step, so fast attackers cannot pass through bullets or the player. */
const MAX_STEP = 0.05;

/**
 * Advance the run by a whole frame of `elapsed` seconds in steps of at most MAX_STEP, so a slow
 * frame still counts in full. Stops early when the phase changes (a level-up or the end of the run).
 * `afterStep` runs after each step, for callers that turn engine changes into effects.
 */
export function advanceSurvivor(state: SurvivorState, elapsed: number, input: Input, afterStep?: () => void): void {
  const phase = state.phase;
  for (let remaining = Math.max(0, elapsed); remaining > 1e-9 && state.phase === phase; remaining -= MAX_STEP) {
    stepSurvivor(state, Math.min(MAX_STEP, remaining), input);
    afterStep?.();
  }
}

/** Advance the run by `dt` seconds (at most MAX_STEP). Nothing moves outside the playing phase. */
export function stepSurvivor(state: SurvivorState, dt: number, input: Input): void {
  if (state.phase !== 'playing') return;
  const delta = Math.min(Math.max(dt, 0), MAX_STEP);
  state.time += delta;
  const { player } = state;

  const length = Math.hypot(input.x, input.y);
  if (length > 0) {
    player.x = Math.min(ARENA.width - 12, Math.max(12, player.x + (input.x / Math.max(1, length)) * player.speed * delta));
    player.y = Math.min(ARENA.height - 12, Math.max(12, player.y + (input.y / Math.max(1, length)) * player.speed * delta));
  }
  player.invulnerable = Math.max(0, player.invulnerable - delta);
  player.hp = Math.min(player.maxHp, player.hp + state.regen * delta);

  state.spawnBudget += delta * Math.min(26, 0.8 + state.time / 30 + (state.time / 120) ** 2);
  while (state.spawnBudget >= 1) { state.spawnBudget -= 1; spawnEnemy(state, pickSpawnKind(state)); }
  if (state.time >= state.nextBossAt) { spawnEnemy(state, 'hallucination'); state.nextBossAt += BOSS_INTERVAL; }

  state.weapon.cooldown -= delta;
  if (state.weapon.cooldown <= 0) { fire(state); state.weapon.cooldown = state.weapon.interval; }

  for (const bullet of state.bullets) {
    bullet.x += bullet.vx * delta;
    bullet.y += bullet.vy * delta;
    bullet.life -= delta;
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0 || bullet.life <= 0 || bullet.hit.includes(enemy.id)) continue;
      if ((enemy.x - bullet.x) ** 2 + (enemy.y - bullet.y) ** 2 > (enemy.radius + 4) ** 2) continue;
      damageEnemy(state, enemy, bullet.damage);
      bullet.hit.push(enemy.id);
      if (bullet.pierce-- <= 0) bullet.life = 0;
    }
  }
  state.bullets = state.bullets.filter((bullet) => bullet.life > 0 && bullet.x > -20 && bullet.x < ARENA.width + 20 && bullet.y > -20 && bullet.y < ARENA.height + 20);

  state.orbitAngle += delta * 3.2;
  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) continue;
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    enemy.x += (dx / distance) * enemy.speed * delta;
    enemy.y += (dy / distance) * enemy.speed * delta;
    enemy.flash = Math.max(0, enemy.flash - delta);
    enemy.orbitCooldown = Math.max(0, enemy.orbitCooldown - delta);
    if (state.orbits && enemy.orbitCooldown === 0) {
      for (let index = 0; index < state.orbits; index += 1) {
        const angle = state.orbitAngle + (index / state.orbits) * Math.PI * 2;
        const ox = player.x + Math.cos(angle) * ORBIT_RADIUS;
        const oy = player.y + Math.sin(angle) * ORBIT_RADIUS;
        if ((enemy.x - ox) ** 2 + (enemy.y - oy) ** 2 <= (enemy.radius + 9) ** 2) { damageEnemy(state, enemy, 2 + (state.upgrades.damage ?? 0)); enemy.orbitCooldown = 0.45; break; }
      }
    }
    if (enemy.hp > 0 && player.invulnerable === 0 && distance <= enemy.radius + 12) {
      player.hp -= enemy.damage;
      player.invulnerable = 0.8;
    }
  }
  state.enemies = state.enemies.filter((enemy) => enemy.hp > 0);

  for (const gem of state.gems) {
    const dx = player.x - gem.x;
    const dy = player.y - gem.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 16) { state.xp += gem.value; gem.value = 0; continue; }
    // Experience drifts to the player on its own and rushes in once it is close, so standing still still levels up.
    const pull = distance < state.magnet ? 420 : 160;
    gem.x += (dx / distance) * pull * delta; gem.y += (dy / distance) * pull * delta;
  }
  state.gems = state.gems.filter((gem) => gem.value > 0).slice(-400);

  if (player.hp <= 0) { player.hp = 0; state.phase = 'over'; return; }
  if (state.xp >= state.xpToNext) levelUp(state);
}
