/**
 * Guardrail Survivor artwork, drawn with canvas paths so it stays sharp at any zoom. Small attackers are drawn once
 * per animation frame into offscreen canvases and stamped each frame; the player and the boss are drawn live.
 * The game keeps its own palette in every theme, like any game, so the characters always read the same.
 */
import type { EnemyKind } from './survivorEngine';

export const COLORS = {
  night: '#0e1324', night2: '#161d35', trace: '#1b2647', node: '#26375f', nodeGlow: '#3bb8dc',
  outline: '#0a0d1a', white: '#f4f8ff',
  guard: '#4c9dff', guardShade: '#2b5fc4', guardLight: '#a6d4ff', visor: '#0c162e', eye: '#66f5ff', antenna: '#ffd166',
  shield: '#ffd36a', shieldShade: '#d6951c',
  ghost: '#a66bff', ghostShade: '#6d36d6', ghostLight: '#d7b8ff', syringe: '#dfe7f2', fluid: '#6cf0a0',
  hornet: '#ff5d73', hornetShade: '#c8344d', stripe: '#ffd23f', wing: 'rgba(205, 238, 255, 0.72)',
  snail: '#82d977', snailShade: '#4ea548', shell: '#ff9f43', shellShade: '#c96714', face: '#fff4dc',
  bolt: '#7af7ff', token: '#ffd166', tokenShade: '#e09a12', danger: '#ff4d6d',
} as const;

export const ENEMY_COLOR: Record<EnemyKind, string> = { injection: COLORS.ghost, ratelimit: COLORS.hornet, timeout: COLORS.shell, hallucination: '#ff7ad9' };

type Context = CanvasRenderingContext2D;

function roundedRect(context: Context, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function outlineAndFill(context: Context, fill: string | CanvasGradient, width = 1.8): void {
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = width;
  context.strokeStyle = COLORS.outline;
  context.stroke();
}

function verticalGradient(context: Context, top: number, bottom: number, stops: string[]): CanvasGradient {
  const gradient = context.createLinearGradient(0, top, 0, bottom);
  stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
  return gradient;
}

function shadow(context: Context, x: number, y: number, width: number): void {
  context.fillStyle = 'rgba(0, 0, 0, 0.35)';
  context.beginPath();
  context.ellipse(x, y, width, width * 0.32, 0, 0, Math.PI * 2);
  context.fill();
}

/** A check-mark shield, used on the player's arm and for the orbiting guardrails. */
export function drawShield(context: Context, x: number, y: number, size: number): void {
  context.save();
  context.translate(x, y);
  context.beginPath();
  context.moveTo(0, -size);
  context.quadraticCurveTo(size * 0.95, -size * 0.85, size * 0.85, -size * 0.2);
  context.quadraticCurveTo(size * 0.7, size * 0.65, 0, size);
  context.quadraticCurveTo(-size * 0.7, size * 0.65, -size * 0.85, -size * 0.2);
  context.quadraticCurveTo(-size * 0.95, -size * 0.85, 0, -size);
  outlineAndFill(context, verticalGradient(context, -size, size, [COLORS.shield, COLORS.shieldShade]), Math.max(1.2, size * 0.16));
  context.strokeStyle = COLORS.white;
  context.lineWidth = Math.max(1.2, size * 0.2);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(-size * 0.38, 0);
  context.lineTo(-size * 0.08, size * 0.3);
  context.lineTo(size * 0.42, -size * 0.3);
  context.stroke();
  context.restore();
}

/** The player: a round guardian robot with a visor, antenna light, and a shield held toward where it is heading. */
export function drawGuardian(context: Context, x: number, y: number, time: number, facing: 1 | -1, moving: boolean, size = 1): void {
  const bob = moving ? Math.sin(time * 14) * 1.6 : Math.sin(time * 3) * 0.8;
  const step = moving ? Math.sin(time * 14) * 2.4 : 0;
  shadow(context, x, y + 17 * size, 13 * size);
  context.save();
  context.translate(x, y + bob * size);
  context.scale(size, size);
  // Feet
  context.fillStyle = COLORS.guardShade;
  for (const [offset, lift] of [[-5.5, step], [5.5, -step]] as const) { roundedRect(context, offset - 3.5, 10 - Math.max(0, lift) * 0.5, 7, 5, 2.4); outlineAndFill(context, COLORS.guardShade, 1.4); }
  // Antenna
  context.strokeStyle = COLORS.outline; context.lineWidth = 1.8;
  context.beginPath(); context.moveTo(0, -14); context.lineTo(0, -20); context.stroke();
  const pulse = 0.55 + Math.sin(time * 5) * 0.25;
  context.fillStyle = `rgba(255, 209, 102, ${pulse * 0.45})`; context.beginPath(); context.arc(0, -21.5, 5.5, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.arc(0, -21.5, 2.8, 0, Math.PI * 2); outlineAndFill(context, COLORS.antenna, 1.3);
  // Body
  roundedRect(context, -12.5, -15, 25, 27, 10);
  outlineAndFill(context, verticalGradient(context, -15, 12, [COLORS.guardLight, COLORS.guard, COLORS.guardShade]), 2);
  context.fillStyle = 'rgba(255, 255, 255, 0.35)';
  roundedRect(context, -8.5, -12.5, 7, 3, 1.5); context.fill();
  // Visor and eyes that look where the robot is heading, with a blink every few seconds.
  roundedRect(context, -9.5, -9.5, 19, 10, 4.5); outlineAndFill(context, COLORS.visor, 1.4);
  const blink = time % 3.2 < 0.12 ? 0.18 : 1;
  context.fillStyle = COLORS.eye;
  for (const eyeX of [-4.2, 4.2]) { context.beginPath(); context.ellipse(eyeX + facing * 1.6, -4.5, 1.9, 2.6 * blink, 0, 0, Math.PI * 2); context.fill(); }
  context.fillStyle = 'rgba(102, 245, 255, 0.18)'; roundedRect(context, -9.5, -9.5, 19, 10, 4.5); context.fill();
  // Chest light
  context.fillStyle = COLORS.antenna; context.beginPath(); context.arc(0, 5, 2.2, 0, Math.PI * 2); context.fill();
  drawShield(context, facing * 13.5, 4, 7.5);
  context.restore();
}

function drawGhost(context: Context, phase: number): void {
  // Prompt injection: a sly purple ghost carrying a syringe.
  const wave = phase * Math.PI * 2;
  shadow(context, 0, 15, 10);
  context.beginPath();
  context.moveTo(-11, 2);
  context.arc(0, -1, 11, Math.PI, 0);
  context.lineTo(11, 11);
  for (let index = 0; index <= 4; index += 1) {
    const x = 11 - index * 5.5;
    context.quadraticCurveTo(x - 2.75, 15 + Math.sin(wave + index * 1.7) * 2.2, x - 5.5, 11);
  }
  context.closePath();
  outlineAndFill(context, verticalGradient(context, -12, 14, [COLORS.ghostLight, COLORS.ghost, COLORS.ghostShade]));
  context.fillStyle = COLORS.white;
  for (const eyeX of [-4.2, 3.6]) { context.beginPath(); context.ellipse(eyeX, -2, 2.8, 3.4, 0, 0, Math.PI * 2); context.fill(); }
  context.fillStyle = COLORS.outline;
  for (const eyeX of [-3.2, 4.6]) { context.beginPath(); context.arc(eyeX, -1.4, 1.5, 0, Math.PI * 2); context.fill(); }
  // A sly, lopsided grin with one fang
  context.strokeStyle = COLORS.outline; context.lineWidth = 1.4; context.lineCap = 'round';
  context.beginPath(); context.moveTo(-4, 4.5); context.quadraticCurveTo(0, 7.5, 5, 3.8); context.stroke();
  context.fillStyle = COLORS.white; context.beginPath(); context.moveTo(1, 5.6); context.lineTo(2.4, 5.2); context.lineTo(1.9, 7.2); context.closePath(); context.fill();
  // Syringe
  context.save();
  context.translate(11.5, 4);
  context.rotate(-0.6 + Math.sin(wave) * 0.15);
  roundedRect(context, -2.2, -7, 4.4, 10, 1.2); outlineAndFill(context, COLORS.syringe, 1.2);
  context.fillStyle = COLORS.fluid; context.fillRect(-1.3, -3, 2.6, 5.4);
  context.strokeStyle = COLORS.outline; context.lineWidth = 1.2;
  context.beginPath(); context.moveTo(0, 3); context.lineTo(0, 8); context.moveTo(-3, -7.5); context.lineTo(3, -7.5); context.stroke();
  context.restore();
}

function drawHornet(context: Context, phase: number): void {
  // 429 Too Many Requests: an angry striped hornet that never stops flapping.
  const flap = 0.35 + Math.abs(Math.sin(phase * Math.PI * 2)) * 0.65;
  shadow(context, 0, 13, 8);
  context.fillStyle = COLORS.wing;
  context.strokeStyle = 'rgba(10, 13, 26, 0.5)'; context.lineWidth = 1;
  for (const [wingX, tilt] of [[-3, -0.5], [3, 0.3]] as const) {
    context.save(); context.translate(wingX, -6); context.rotate(tilt); context.scale(1, flap);
    context.beginPath(); context.ellipse(0, -5, 4.5, 7, 0, 0, Math.PI * 2); context.fill(); context.stroke();
    context.restore();
  }
  context.beginPath(); context.moveTo(-10, 1); context.lineTo(-14.5, 2.5); context.lineTo(-10, 4); context.closePath(); outlineAndFill(context, COLORS.outline, 1);
  context.beginPath(); context.ellipse(0, 2, 10, 7.5, 0, 0, Math.PI * 2);
  context.save(); context.clip();
  context.fillStyle = verticalGradient(context, -6, 10, [COLORS.hornet, COLORS.hornetShade]); context.fillRect(-11, -7, 22, 18);
  context.fillStyle = COLORS.stripe; context.fillRect(-8.5, -7, 3.6, 18); context.fillRect(-2.2, -7, 3.6, 18);
  context.restore();
  context.beginPath(); context.ellipse(0, 2, 10, 7.5, 0, 0, Math.PI * 2); context.lineWidth = 1.8; context.strokeStyle = COLORS.outline; context.stroke();
  // Angry eye and brow facing forward
  context.fillStyle = COLORS.white; context.beginPath(); context.ellipse(5.6, 0.6, 2.6, 2.9, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = COLORS.outline; context.beginPath(); context.arc(6.3, 1.2, 1.3, 0, Math.PI * 2); context.fill();
  context.lineWidth = 1.6; context.beginPath(); context.moveTo(2.8, -3.4); context.lineTo(8.4, -1.6); context.stroke();
}

function drawSnail(context: Context, phase: number): void {
  // Timeout: a snail whose shell is a clock that keeps ticking.
  const stretch = Math.sin(phase * Math.PI * 2) * 1.2;
  shadow(context, 0, 15, 15);
  // Foot and head
  context.beginPath();
  context.moveTo(-16 - stretch, 13);
  context.quadraticCurveTo(-16 - stretch, 7, -8, 7);
  context.lineTo(10, 6);
  context.quadraticCurveTo(15 + stretch, 5, 16 + stretch, -1);
  context.quadraticCurveTo(19 + stretch, 7, 16 + stretch, 13);
  context.closePath();
  outlineAndFill(context, verticalGradient(context, -2, 13, [COLORS.snail, COLORS.snailShade]));
  context.strokeStyle = COLORS.outline; context.lineWidth = 1.5;
  for (const [baseX, tipX, tipY] of [[13, 12, -10], [15.5, 18, -9]] as const) {
    const sway = Math.sin(phase * Math.PI * 2 + tipX) * 1.2;
    context.beginPath(); context.moveTo(baseX + stretch, 0); context.lineTo(tipX + stretch + sway, tipY); context.stroke();
    context.fillStyle = COLORS.white; context.beginPath(); context.arc(tipX + stretch + sway, tipY, 2.2, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = COLORS.outline; context.beginPath(); context.arc(tipX + stretch + sway + 0.6, tipY + 0.3, 1, 0, Math.PI * 2); context.fill();
  }
  // Clock shell
  context.beginPath(); context.arc(-3, -3, 11.5, 0, Math.PI * 2);
  outlineAndFill(context, verticalGradient(context, -14, 8, [COLORS.shell, COLORS.shellShade]), 2);
  context.beginPath(); context.arc(-3, -3, 7.5, 0, Math.PI * 2); outlineAndFill(context, COLORS.face, 1.4);
  context.strokeStyle = COLORS.outline; context.lineWidth = 1.2;
  for (let tick = 0; tick < 4; tick += 1) {
    const angle = tick * Math.PI / 2;
    context.beginPath(); context.moveTo(-3 + Math.cos(angle) * 5.6, -3 + Math.sin(angle) * 5.6); context.lineTo(-3 + Math.cos(angle) * 7, -3 + Math.sin(angle) * 7); context.stroke();
  }
  const hand = phase * Math.PI * 2 - Math.PI / 2;
  context.lineWidth = 1.5; context.lineCap = 'round';
  context.beginPath(); context.moveTo(-3, -3); context.lineTo(-3 + Math.cos(hand) * 5.4, -3 + Math.sin(hand) * 5.4); context.stroke();
  context.strokeStyle = COLORS.danger;
  context.beginPath(); context.moveTo(-3, -3); context.lineTo(-3 + 3.2, -3 - 1.4); context.stroke();
}

const PAINTERS: Partial<Record<EnemyKind, { size: number; draw: (context: Context, phase: number) => void }>> = {
  injection: { size: 40, draw: drawGhost },
  ratelimit: { size: 34, draw: drawHornet },
  timeout: { size: 46, draw: drawSnail },
};

export const FRAMES = 8;

/**
 * Pre-renders each attacker's animation frames at the device pixel ratio, with matching white silhouettes for the
 * flash when a shot lands. Attackers face right in the source frames; the renderer flips them toward the player.
 */
export function buildEnemyFrames(scale: number): Record<'injection' | 'ratelimit' | 'timeout', { size: number; frames: HTMLCanvasElement[]; flashes: HTMLCanvasElement[] }> {
  const result = {} as Record<'injection' | 'ratelimit' | 'timeout', { size: number; frames: HTMLCanvasElement[]; flashes: HTMLCanvasElement[] }>;
  for (const kind of ['injection', 'ratelimit', 'timeout'] as const) {
    const painter = PAINTERS[kind]!;
    const frames: HTMLCanvasElement[] = [];
    const flashes: HTMLCanvasElement[] = [];
    for (let index = 0; index < FRAMES; index += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.ceil(painter.size * scale);
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.scale(scale, scale);
      context.translate(painter.size / 2, painter.size / 2);
      painter.draw(context, index / FRAMES);
      frames.push(canvas);
      const flash = document.createElement('canvas');
      flash.width = flash.height = canvas.width;
      const flashContext = flash.getContext('2d');
      if (flashContext) { flashContext.drawImage(canvas, 0, 0); flashContext.globalCompositeOperation = 'source-in'; flashContext.fillStyle = COLORS.white; flashContext.fillRect(0, 0, flash.width, flash.height); }
      flashes.push(flash);
    }
    result[kind] = { size: painter.size, frames, flashes };
  }
  return result;
}

/** Draws one attacker frame into a small canvas, for the roster on the start screen. */
export function drawRosterIcon(canvas: HTMLCanvasElement, kind: EnemyKind | 'guardian'): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = canvas.width / 48;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(scale, scale);
  context.translate(24, 24);
  if (kind === 'guardian') drawGuardian(context, 0, 2, 0.4, 1, false);
  else if (kind === 'hallucination') { context.scale(0.55, 0.55); drawHallucination(context, 0, 4, 36, 0.6, false); }
  else { if (kind === 'timeout') { context.scale(0.8, 0.8); context.translate(-2, 0); } PAINTERS[kind]!.draw(context, 0.2); }
  context.restore();
}

/** The boss: a shimmering mirage with one great eye and drifting tentacles; it glitches now and then. */
export function drawHallucination(context: Context, x: number, y: number, radius: number, time: number, glitch: boolean): void {
  const hue = (time * 50) % 360;
  shadow(context, x, y + radius + 14, radius * 0.9);
  context.save();
  context.translate(x, y);
  // Tentacles
  context.lineCap = 'round';
  for (let index = 0; index < 7; index += 1) {
    const baseX = -radius * 0.75 + (index / 6) * radius * 1.5;
    const sway = Math.sin(time * 3 + index) * 7;
    context.strokeStyle = `hsla(${(hue + index * 25) % 360}, 90%, 68%, 0.85)`;
    context.lineWidth = 5 - Math.abs(index - 3) * 0.6;
    context.beginPath(); context.moveTo(baseX, radius * 0.35);
    context.bezierCurveTo(baseX + sway, radius * 0.8, baseX - sway, radius * 1.05, baseX + sway * 0.6, radius * 1.35);
    context.stroke();
  }
  // Bell
  const body = context.createRadialGradient(-radius * 0.3, -radius * 0.4, radius * 0.1, 0, 0, radius * 1.1);
  body.addColorStop(0, `hsl(${hue}, 95%, 82%)`);
  body.addColorStop(0.55, `hsl(${(hue + 50) % 360}, 85%, 62%)`);
  body.addColorStop(1, `hsl(${(hue + 100) % 360}, 75%, 38%)`);
  context.beginPath();
  context.moveTo(-radius, radius * 0.35);
  context.bezierCurveTo(-radius * 1.05, -radius * 1.25, radius * 1.05, -radius * 1.25, radius, radius * 0.35);
  for (let index = 0; index < 6; index += 1) {
    const from = radius - (index / 6) * radius * 2;
    context.quadraticCurveTo(from - radius / 6, radius * 0.6, from - radius / 3, radius * 0.35);
  }
  context.closePath();
  outlineAndFill(context, body, 2.4);
  // The eye follows nothing: it is always staring at you.
  context.beginPath(); context.ellipse(0, -radius * 0.18, radius * 0.42, radius * 0.36, 0, 0, Math.PI * 2); outlineAndFill(context, COLORS.white, 2);
  context.fillStyle = `hsl(${(hue + 180) % 360}, 85%, 50%)`; context.beginPath(); context.arc(0, -radius * 0.16, radius * 0.24, 0, Math.PI * 2); context.fill();
  context.fillStyle = COLORS.outline; context.beginPath(); context.arc(0, -radius * 0.16, radius * 0.12, 0, Math.PI * 2); context.fill();
  context.fillStyle = COLORS.white; context.beginPath(); context.arc(radius * 0.08, -radius * 0.25, radius * 0.05, 0, Math.PI * 2); context.fill();
  context.restore();
  if (glitch) {
    // A brief RGB split: the hallucination is not quite there.
    context.save();
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = 0.35;
    context.fillStyle = '#ff2a6d'; context.fillRect(x - radius - 6, y - radius * 0.4, radius * 2, 5);
    context.fillStyle = '#05d9e8'; context.fillRect(x - radius + 6, y + radius * 0.1, radius * 2, 4);
    context.restore();
  }
}

/** Experience: a spinning gold token. */
export function drawToken(context: Context, x: number, y: number, time: number, value: number): void {
  const size = value >= 10 ? 10 : value >= 3 ? 8 : 6.5;
  const spin = Math.abs(Math.cos(time * 4 + x * 0.05));
  context.save();
  context.translate(x, y + Math.sin(time * 5 + y) * 1.2);
  context.scale(0.35 + spin * 0.65, 1);
  context.beginPath();
  for (let side = 0; side < 6; side += 1) { const angle = Math.PI / 6 + side * Math.PI / 3; context[side ? 'lineTo' : 'moveTo'](Math.cos(angle) * size, Math.sin(angle) * size); }
  context.closePath();
  outlineAndFill(context, verticalGradient(context, -size, size, [COLORS.token, COLORS.tokenShade]), 1.2);
  context.fillStyle = 'rgba(255, 255, 255, 0.6)'; context.fillRect(-size * 0.35, -size * 0.55, size * 0.25, size * 0.7);
  context.restore();
}

/** A shot: a short cyan bolt with a soft glow, pointing where it travels. */
export function drawBolt(context: Context, x: number, y: number, vx: number, vy: number): void {
  const angle = Math.atan2(vy, vx);
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.scale(1.3, 1.3);
  context.fillStyle = 'rgba(122, 247, 255, 0.22)';
  context.beginPath(); context.ellipse(-3, 0, 10, 5, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = COLORS.bolt;
  context.beginPath(); context.ellipse(-2, 0, 7, 2.2, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = COLORS.white;
  context.beginPath(); context.ellipse(1, 0, 3, 1.2, 0, 0, Math.PI * 2); context.fill();
  context.restore();
}

/** The arena floor: a dark circuit board with glowing junctions, drawn once per size. */
export function buildBackground(width: number, height: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.scale(scale, scale);
  const floor = context.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, width * 0.7);
  floor.addColorStop(0, COLORS.night2);
  floor.addColorStop(1, COLORS.night);
  context.fillStyle = floor;
  context.fillRect(0, 0, width, height);
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  context.lineCap = 'round';
  for (let trace = 0; trace < 70; trace += 1) {
    let x = Math.round(random() * width / 24) * 24;
    let y = Math.round(random() * height / 24) * 24;
    context.strokeStyle = COLORS.trace;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(x, y);
    for (let leg = 0; leg < 3; leg += 1) {
      const length = (1 + Math.floor(random() * 4)) * 24;
      if (random() < 0.5) x += random() < 0.5 ? -length : length; else y += random() < 0.5 ? -length : length;
      context.lineTo(x, y);
    }
    context.stroke();
    context.fillStyle = random() < 0.2 ? COLORS.nodeGlow : COLORS.node;
    context.globalAlpha = 0.55;
    context.beginPath(); context.arc(x, y, 2.6, 0, Math.PI * 2); context.fill();
    context.globalAlpha = 1;
  }
  const vignette = context.createRadialGradient(width / 2, height / 2, height * 0.35, width / 2, height / 2, width * 0.62);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
  return canvas;
}
