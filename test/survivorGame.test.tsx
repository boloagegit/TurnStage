// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceKonami, useKonamiCode } from '../src/webview/easterEgg/konami';
import { applyUpgrade, ARENA, createSurvivor, rollChoices, stepSurvivor } from '../src/webview/easterEgg/survivorEngine';

afterEach(cleanup);

const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

function run(keys: string[]): number { return keys.reduce((progress, key) => advanceKonami(progress, key), 0); }

describe('Konami code', () => {
  it('completes on the classic sequence, case-insensitively, after extra opening arrows', () => {
    expect(run(CODE)).toBe(10);
    expect(run(CODE.map((key) => key.toUpperCase()))).toBe(10);
    expect(run(['ArrowUp', ...CODE])).toBe(10);
    expect(run(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowUp', ...CODE.slice(1)])).toBe(10);
    expect(run(CODE.slice(0, 9).concat('x'))).toBe(0);
  });

  function Harness({ onUnlock }: { onUnlock: () => void }) { useKonamiCode(onUnlock); return <input aria-label="Composer" />; }

  it('unlocks from the page but not while typing in a field', () => {
    const onUnlock = vi.fn();
    render(<Harness onUnlock={onUnlock} />);
    for (const key of CODE) fireEvent.keyDown(screen.getByRole('textbox', { name: 'Composer' }), { key });
    expect(onUnlock).not.toHaveBeenCalled();
    for (const key of CODE) fireEvent.keyDown(document.body, { key });
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});

describe('Guardrail Survivor engine', () => {
  it('is reproducible for a seed and keeps the player inside the arena', () => {
    const a = createSurvivor(42);
    const b = createSurvivor(42);
    for (let frame = 0; frame < 600; frame += 1) { stepSurvivor(a, 1 / 60, { x: -1, y: -1 }); stepSurvivor(b, 1 / 60, { x: -1, y: -1 }); }
    expect(a.enemies.map((enemy) => [enemy.kind, Math.round(enemy.x)])).toEqual(b.enemies.map((enemy) => [enemy.kind, Math.round(enemy.x)]));
    expect(a.player.x).toBeGreaterThanOrEqual(12);
    expect(a.player.y).toBeGreaterThanOrEqual(12);
    expect(a.time).toBeCloseTo(10, 5);
  });

  it('shoots the nearest attacker, collects experience, and stops to offer upgrades', () => {
    const state = createSurvivor(7);
    state.enemies.push({ id: 999, kind: 'injection', x: state.player.x + 80, y: state.player.y, hp: 1, maxHp: 1, radius: 11, speed: 0, damage: 10, xp: 5, orbitCooldown: 0, flash: 0 });
    state.spawnBudget = -1e9;
    for (let frame = 0; frame < 120 && state.phase === 'playing'; frame += 1) stepSurvivor(state, 1 / 60, { x: 1, y: 0 });
    expect(state.kills).toBe(1);
    expect(state.phase).toBe('levelup');
    expect(state.level).toBe(2);
    expect(new Set(state.choices).size).toBe(3);
    const time = state.time;
    stepSurvivor(state, 1, { x: 0, y: 0 });
    expect(state.time).toBe(time);
    applyUpgrade(state, state.choices.includes('multishot') ? 'multishot' : state.choices[0]!);
    expect(state.phase).toBe('playing');
  });

  it('ends the run when health runs out and never offers maxed upgrades', () => {
    const state = createSurvivor(3);
    state.spawnBudget = -1e9;
    state.enemies.push({ id: 1, kind: 'timeout', x: state.player.x, y: state.player.y, hp: 999, maxHp: 999, radius: 17, speed: 0, damage: 200, xp: 0, orbitCooldown: 0, flash: 0 });
    stepSurvivor(state, 1 / 60, { x: 0, y: 0 });
    expect(state.phase).toBe('over');
    expect(state.player.hp).toBe(0);
    const maxed = createSurvivor(5);
    maxed.upgrades = { rate: 8, damage: 8, multishot: 6, pierce: 4, speed: 5, regen: 4, vitality: 6 };
    expect(rollChoices(maxed)).toEqual(['orbit']);
  });

  it('sends a boss at two minutes that breaks into smaller attackers', () => {
    const state = createSurvivor(11);
    state.spawnBudget = -1e9;
    state.time = 119.99;
    state.player.hp = 1e9;
    stepSurvivor(state, 0.02, { x: 0, y: 0 });
    const boss = state.enemies.find((enemy) => enemy.kind === 'hallucination')!;
    expect(boss).toBeDefined();
    boss.hp = 1;
    boss.x = state.player.x + 60; boss.y = state.player.y;
    state.weapon.cooldown = 0;
    for (let frame = 0; frame < 30 && state.enemies.includes(boss); frame += 1) stepSurvivor(state, 1 / 60, { x: 0, y: 0 });
    expect(state.enemies.includes(boss)).toBe(false);
    expect(state.enemies.filter((enemy) => enemy.kind === 'injection').length).toBeGreaterThanOrEqual(6);
    expect(ARENA.width / ARENA.height).toBeCloseTo(1.6);
  });
});
